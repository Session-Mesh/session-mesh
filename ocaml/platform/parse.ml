(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(* Pure parsers for kernel process data. No I/O; compiled on every platform. *)

open Types

let malformed fmt = Printf.ksprintf (fun msg -> Error (Malformed msg)) fmt
let ( let* ) = Result.bind

let split_stat_fields rest =
  String.split_on_char ' ' (String.trim rest) |> List.filter (( <> ) "")

let parse_int what text =
  match int_of_string_opt text with
  | Some value -> Ok value
  | None -> malformed "stat: %s is not an integer: %S" what text

(* [fields] start at the state field (index 0); starttime is index 19. *)
let build_stat_process ~pid ~comm fields =
  match fields with
  | state :: ppid :: pgrp :: session :: _tty :: tpgid :: _
    when List.length fields > 19 -> (
      let* ppid = parse_int "ppid" ppid in
      let* pgrp = parse_int "pgrp" pgrp in
      let* sid = parse_int "session" session in
      let* tpgid = parse_int "tpgid" tpgid in
      let starttime = List.nth fields 19 in
      match (String.length state, Int64.of_string_opt starttime) with
      | 1, Some incarnation ->
          Ok
            {
              pid;
              ppid;
              pgrp;
              sid;
              tpgid;
              comm;
              state = state.[0];
              incarnation;
            }
      | 1, None -> malformed "stat: starttime is not an integer: %S" starttime
      | _ -> malformed "stat: state is not one character: %S" state)
  | _ -> malformed "stat: too few fields after comm"

let linux_stat line =
  match (String.index_opt line '(', String.rindex_opt line ')') with
  | Some open_paren, Some close_paren when open_paren < close_paren -> (
      let pid_text = String.trim (String.sub line 0 open_paren) in
      let comm =
        String.sub line (open_paren + 1) (close_paren - open_paren - 1)
      in
      let rest =
        String.sub line (close_paren + 1) (String.length line - close_paren - 1)
      in
      match int_of_string_opt pid_text with
      | None -> malformed "stat: pid is not an integer: %S" pid_text
      | Some pid -> build_stat_process ~pid ~comm (split_stat_fields rest))
  | _ -> malformed "stat: no (comm) field"

let linux_cmdline contents =
  match List.rev (String.split_on_char '\000' contents) with
  | "" :: reversed_rest -> List.rev reversed_rest
  | reversed -> List.rev reversed

let max_darwin_argc = 65536

let rec skip_nuls buffer position =
  if position < String.length buffer && buffer.[position] = '\000' then
    skip_nuls buffer (position + 1)
  else position

let read_argv buffer ~argc ~start =
  let rec loop remaining position acc =
    if remaining = 0 then Ok (List.rev acc, position)
    else if position >= String.length buffer then
      malformed "procargs2: argv truncated (%d of %d strings)"
        (argc - remaining) argc
    else
      match String.index_from_opt buffer position '\000' with
      | None -> malformed "procargs2: unterminated argv string"
      | Some stop ->
          loop (remaining - 1) (stop + 1)
            (String.sub buffer position (stop - position) :: acc)
  in
  loop argc start []

(* Limitation: after the exec path the kernel pads with NUL bytes, and those
   are skipped to find argv[0]. A leading empty argv[0] is a single NUL string
   and is therefore indistinguishable from that padding: it is lost, and the
   next argument is returned as argv[0]. *)
let darwin_procargs2_parts buffer =
  if String.length buffer < 4 then
    malformed "procargs2: buffer shorter than 4 bytes"
  else
    let argc = Int32.to_int (String.get_int32_le buffer 0) in
    if argc < 0 || argc > max_darwin_argc then
      malformed "procargs2: absurd argc %d" argc
    else
      match String.index_from_opt buffer 4 '\000' with
      | None -> malformed "procargs2: unterminated exec path"
      | Some path_end ->
          read_argv buffer ~argc ~start:(skip_nuls buffer (path_end + 1))

let darwin_procargs2 buffer =
  Result.map fst (darwin_procargs2_parts buffer)

let darwin_selected_environment ?(title_padding = false) buffer names =
  let selected = List.map (fun name -> (name, name ^ "=")) names in
  let matching_key item =
    List.find_opt (fun (_, prefix) -> String.starts_with ~prefix item) selected
  in
  let rec scan position seen =
    if position = String.length buffer then Ok seen
    else if buffer.[position] = '\000' then
      (* Darwin can return data after an empty entry. Keep checking for
         selected keys and duplicates until the entire buffer is consumed. *)
      scan (skip_nuls buffer position) seen
    else
      match String.index_from_opt buffer position '\000' with
      | None -> malformed "procargs2: unterminated environment string"
      | Some stop ->
          let item = String.sub buffer position (stop - position) in
          match matching_key item with
          | None -> scan (stop + 1) seen
          | Some (name, _) when List.mem_assoc name seen ->
              malformed "procargs2: duplicate environment key"
          | Some (name, prefix) ->
              let length = String.length prefix in
              let value = String.sub item length (String.length item - length) in
              scan (stop + 1) ((name, value) :: seen)
  in
  match darwin_procargs2_parts buffer with
  | Error error -> Error error
  | Ok ([], _) -> malformed "procargs2: missing argv"
  | Ok (argv, position) ->
      (* An empty argv[0] can shift the first environment entry into argv.
         Do not infer absence from that ambiguous buffer. *)
      if List.exists (fun item -> Option.is_some (matching_key item)) argv then
        malformed "procargs2: selected environment key in argument vector"
      else
        (* A rewritten process title can leave zero padding before the
           inherited environment. *)
        let next = skip_nuls buffer position in
        if not title_padding && next <> position && next < String.length buffer then
          malformed "procargs2: data after leading environment padding"
        else scan next []

let darwin_environment_matches ?(unset = []) buffer ~key ~expected =
  let title_padding =
    key = "CLAUDE_CONFIG_DIR"
    || (key = "HOME" && List.mem "CLAUDE_CONFIG_DIR" unset)
  in
  Result.map
    (fun selected ->
      List.assoc_opt key selected = Some expected
      && List.for_all
           (fun name -> Option.value ~default:"" (List.assoc_opt name selected) = "")
           unset)
    (darwin_selected_environment ~title_padding buffer (key :: unset))

(* [tpgid] is <= 0 when the process has no controlling terminal (Linux reports
   -1; 0 can appear on other kernels). Handing that back as a group id would
   let a caller's kill(-pgid) signal its own group or pid 1. *)
let foreground_group tpgid = if tpgid > 0 then Ok tpgid else Error Not_found

(* [/proc/net/unix] lists one socket per line: seven fields ("Num:" first,
   the inode last, padded on the left with spaces), then, for a bound
   socket, one space and the path, which may itself contain spaces. The path
   is the rest of the line after that space, compared whole: a socket bound
   at a relative path such as "x /run/a.sock" must not match "/run/a.sock". *)
let skip_spaces line index =
  let rec go index =
    if index < String.length line && line.[index] = ' ' then go (index + 1)
    else index
  in
  go index

let skip_field line index =
  let rec go index =
    if index < String.length line && line.[index] <> ' ' then go (index + 1)
    else index
  in
  go (skip_spaces line index)

let socket_path_field line =
  let first_end = skip_field line 0 in
  if first_end = 0 || line.[first_end - 1] <> ':' then None
  else
    let rec after_fields index remaining =
      if remaining = 0 then index
      else after_fields (skip_field line index) (remaining - 1)
    in
    let fields_end = after_fields first_end 6 in
    if fields_end < String.length line && line.[fields_end] = ' ' then
      Some
        (String.sub line (fields_end + 1) (String.length line - fields_end - 1))
    else None

let linux_unix_socket_bound table path =
  List.exists
    (fun line -> socket_path_field line = Some path)
    (String.split_on_char '\n' table)

(* macOS process status (p_stat / pbi_status, sys/proc.h) onto the Linux
   letters, as BSD ps prints them: SIDL (1, being created by fork) and SRUN (2)
   are R, SSLEEP (3) is S (macOS does not separate an uninterruptible sleep at
   this level, so D never appears), SSTOP (4) is T, SZOMB (5) is Z. Any other
   value is unknown: [None]. The kernel keeps SRUN for most live processes; the
   backend turns it into SSLEEP when none of the threads of one of the caller's
   own processes is running, and leaves it SRUN for other users' processes. *)
let darwin_state = function
  | 1 | 2 -> Some 'R'
  | 3 -> Some 'S'
  | 4 -> Some 'T'
  | 5 -> Some 'Z'
  | _ -> None
