(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(* mesh-platform: print platform facts as JSON. Exit codes:
   - 0 on success;
   - 1 on platform error (with {"kind": "...", "error": "..."} on stdout; kind
     is unsupported, not_found, denied, malformed or runtime_dir), and on any
     unexpected exception;
   - 2 on usage error only (including an unknown FEATURE for [require]);
   - 78 (EX_CONFIG) when [require FEATURE] is refused: stdout carries
     {"kind": "unavailable", "feature": "...", "available": false, "error": "..."} and stderr the
     same sentence. Success prints {"feature": "...", "available": true}.
   Streams: stdout alone carries the JSON value and stderr carries the human
   sentence. [snapshot] also notes on stderr how many processes exist but could
   not be read (and are missing from the list), when there are any. A caller
   that parses the JSON must not merge them with 2>&1.
   An unexpected exception exits 1 with {"kind": "internal", "error": "..."} on
   stdout and "mesh-platform: internal error: ..." on stderr.
   The exit code is the one [run] decided, whatever happens to stdout and
   stderr: closed (EBADF), full (ENOSPC), failing (EIO), non-blocking and full
   (EAGAIN), or a pipe without reader while SIGPIPE is ignored (EPIPE). On
   EAGAIN a write waits for the descriptor to become writable, at most
   [max_wait_seconds] in total per write call, so a slow but live reader gets
   the whole output. The output is truncated or missing only after that wait
   expires or on any other error; the code is not changed.
   One exception, which this program does not alter: with the default SIGPIPE
   disposition, writing to a pipe without reader kills the process with
   SIGPIPE. It then has no exit code (a shell reports 141). This is never 0,
   so a failure cannot be read as a success, but a success is reported as a
   failure. A caller that needs the codes above with such a pipe must ignore
   SIGPIPE.
   [update-check] always exits 0 once its options are valid: it prints
   {"status": ...} (see [update_check]), or with --line one English sentence
   when an update is available and nothing otherwise. *)

module P = Mesh_platform

let usage =
  "usage: mesh-platform capabilities | runtime-dir | snapshot | process PID | \
   command-line PID | require isolated-agent|demo-sandbox | update-check \
   [--refresh] [--cache-only] [--line] [--debug] [--release-dir DIR]"

let ex_config = 78

(* Output goes straight to the file descriptor, without Stdlib channels, and
   every write error is ignored: the exit code is decided by [run], never by
   printing. A channel would keep the unwritten text in its buffer after a
   failed flush; [Stdlib.exit] then flushes it again and the second failure
   ends the process with code 2 (seen with stdout on /dev/full). A direct
   write leaves nothing behind to flush. *)
(* Longest total wait for a non-blocking descriptor to accept more bytes,
   per write call. *)
let max_wait_seconds = 2.0

(* Wait until [descriptor] is writable or [deadline] passes; [false] on timeout
   or on any error. An interrupted wait counts as "try again". *)
let wait_writable descriptor deadline =
  let remaining = deadline -. Unix.gettimeofday () in
  remaining > 0.
  &&
  match Unix.select [] [ descriptor ] [] remaining with
  | _, [], _ -> false
  | _ -> true
  | exception Unix.Unix_error (Unix.EINTR, _, _) -> true
  | exception Unix.Unix_error _ -> false

let rec write_until deadline descriptor text offset =
  let remaining = String.length text - offset in
  if remaining > 0 then
    match Unix.single_write_substring descriptor text offset remaining with
    | 0 -> ()
    | written -> write_until deadline descriptor text (offset + written)
    | exception Unix.Unix_error (Unix.EINTR, _, _) ->
        write_until deadline descriptor text offset
    | exception Unix.Unix_error ((Unix.EAGAIN | Unix.EWOULDBLOCK), _, _) ->
        if wait_writable descriptor deadline then
          write_until deadline descriptor text offset
    | exception Unix.Unix_error _ -> ()

let write_from descriptor text offset =
  write_until (Unix.gettimeofday () +. max_wait_seconds) descriptor text offset

(* Kernel strings (comm, argv) need not be UTF-8, and a raw invalid byte makes
   strict JSON decoders reject the whole output. This program replaces each
   invalid sequence with U+FFFD; the PTY host's [processes] operation keeps
   the raw bytes instead, for a client that decodes them itself. *)
let valid_utf_8 text =
  if String.is_valid_utf_8 text then text
  else
    let buffer = Buffer.create (String.length text) in
    let rec copy index =
      if index < String.length text then (
        let decoded = String.get_utf_8_uchar text index in
        Buffer.add_utf_8_uchar buffer (Uchar.utf_decode_uchar decoded);
        copy (index + Uchar.utf_decode_length decoded))
    in
    copy 0;
    Buffer.contents buffer

let rec valid_json = function
  | `String text -> `String (valid_utf_8 text)
  | `List items -> `List (List.map valid_json items)
  | `Assoc fields ->
      `Assoc
        (List.map
           (fun (key, value) -> (valid_utf_8 key, valid_json value))
           fields)
  | other -> other

let print_json json =
  write_from Unix.stdout (Yojson.Safe.to_string (valid_json json) ^ "\n") 0

let print_error text = write_from Unix.stderr (text ^ "\n") 0

let capabilities_json (c : P.capabilities) =
  `Assoc
    [
      ("platform", `String (P.platform_name P.platform));
      ("process_table", `Bool c.process_table);
      ("foreground_agent", `Bool c.foreground_agent);
      ("open_file_paths", `Bool c.open_file_paths);
      ("isolated_agent", `Bool c.isolated_agent);
      ("demo_sandbox", `Bool c.demo_sandbox);
    ]

let source_name = function
  | P.Xdg_runtime_dir -> "xdg_runtime_dir"
  | P.Mesh_runtime_dir -> "mesh_runtime_dir"
  | P.Run_user_guess -> "run_user_guess"
  | P.Macos_default -> "macos_default"

let runtime_dir_json (dir : P.runtime_dir) =
  `Assoc
    [
      ("path", `String dir.path);
      ("source", `String (source_name dir.source));
      ("socket_path", `String (P.socket_path dir));
      ("max_socket_path", `Int P.max_socket_path);
    ]

let process_json (p : P.process) =
  `Assoc
    [
      ("pid", `Int p.pid);
      ("ppid", `Int p.ppid);
      ("pgrp", `Int p.pgrp);
      ("sid", `Int p.sid);
      ("tpgid", `Int p.tpgid);
      ("comm", `String p.comm);
      ("state", `String (String.make 1 p.state));
      ("incarnation", `String (Int64.to_string p.incarnation));
    ]

let error_kind = function
  | P.Unsupported _ -> "unsupported"
  | P.Not_found -> "not_found"
  | P.Denied -> "denied"
  | P.Malformed _ -> "malformed"

(* Print [Ok] as JSON and return 0, or the error object ({"kind", "error"}) and
   return 1. *)
let report encode = function
  | Ok value ->
      print_json (encode value);
      0
  | Error (kind, message) ->
      print_json (`Assoc [ ("kind", `String kind); ("error", `String message) ]);
      1

let platform_report encode result =
  report encode
    (Result.map_error (fun e -> (error_kind e, P.error_to_string e)) result)

let runtime_dir_report encode result =
  report encode
    (Result.map_error (fun message -> ("runtime_dir", message)) result)

(* Decimal digits only: [int_of_string] alone would also take "0x1", "+1" or
   "1_". *)
let decimal text =
  text <> ""
  && String.length text <= 10
  && String.for_all (function '0' .. '9' -> true | _ -> false) text

let with_pid text run =
  match if decimal text then int_of_string_opt text else None with
  | Some pid when pid > 0 -> run pid
  | _ ->
      print_error usage;
      2

let require_feature name feature =
  match P.require feature with
  | Ok () ->
      print_json
        (`Assoc [ ("feature", `String name); ("available", `Bool true) ]);
      0
  | Error message ->
      print_error message;
      print_json
        (`Assoc
           [
             ("kind", `String "unavailable");
             ("feature", `String name);
             ("available", `Bool false);
             ("error", `String message);
           ]);
      ex_config

let with_feature text run =
  match P.feature_of_string text with
  | Some feature -> run feature
  | None ->
      print_error usage;
      2

(* The JSON list stays the whole stdout; processes the scan left out (refused
   or unparsable entries) are counted on stderr, so the list is not mistaken
   for the whole table. *)
let snapshot () =
  platform_report
    (fun (scan : P.process_scan) ->
      if scan.skipped > 0 then
        print_error
          (Printf.sprintf
             "mesh-platform: %d process(es) could not be read and are not \
              listed"
             scan.skipped);
      `List (List.map process_json scan.processes))
    (P.scan ())

type update_options = {
  refresh : bool;
  cache_only : bool;
  as_line : bool;
  debug : bool;
  release_dir : string option;
}

let rec update_options options = function
  | [] -> Some options
  | "--refresh" :: rest -> update_options { options with refresh = true } rest
  | "--cache-only" :: rest ->
      update_options { options with cache_only = true } rest
  | "--line" :: rest -> update_options { options with as_line = true } rest
  | "--debug" :: rest -> update_options { options with debug = true } rest
  | "--release-dir" :: dir :: rest when options.release_dir = None ->
      update_options { options with release_dir = Some dir } rest
  | _ -> None

(* The installation's release is the one this program runs from, or the
   directory --release-dir names (for a caller that runs another copy). *)
let update_check arguments =
  let none =
    { refresh = false; cache_only = false; as_line = false; debug = false; release_dir = None }
  in
  match update_options none arguments with
  | None ->
      print_error usage;
      2
  | Some options ->
      let module R = Mesh_update_report in
      let installation =
        match options.release_dir with
        | Some dir -> R.installation_of_release_dir dir
        | None -> R.installation_of_executable Sys.executable_name
      in
      let getenv, settings_problem = R.with_settings Sys.getenv_opt in
      let outcome, problem =
        R.check ~getenv ~installation
          ~request:(not options.cache_only) ~force:options.refresh
          ~now:(Unix.gettimeofday ()) ~fetch:(R.curl_fetch_in_cache getenv)
      in
      let problem =
        match settings_problem with Some _ -> settings_problem | None -> problem
      in
      (match problem with
      | Some text when options.debug ->
          print_error ("mesh-platform: update-check: " ^ text)
      | _ -> ());
      let home = Sys.getenv_opt "HOME" in
      if options.as_line then
        Option.iter
          (fun text -> write_from Unix.stdout (text ^ "\n") 0)
          (R.line ~home outcome)
      else print_json (R.to_json ~home outcome);
      0

let run = function
  | "update-check" :: options -> update_check options
  | [ "require"; name ] -> with_feature name (require_feature name)
  | [ "capabilities" ] -> report capabilities_json (Ok (P.capabilities ()))
  | [ "runtime-dir" ] -> runtime_dir_report runtime_dir_json (P.runtime_dir ())
  | [ "snapshot" ] -> snapshot ()
  | [ "process"; pid ] ->
      with_pid pid (fun pid -> platform_report process_json (P.process pid))
  | [ "command-line"; pid ] ->
      with_pid pid (fun pid ->
          platform_report
            (fun argv -> `List (List.map (fun arg -> `String arg) argv))
            (P.command_line pid))
  | _ ->
      print_error usage;
      2

let arguments () =
  match Array.to_list Sys.argv with [] -> [] | _program :: rest -> rest

(* An exception [run] did not foresee is a failure of this program, not a
   usage error: it maps to 1, where the runtime's own handler would exit 2.
   It is reported on both streams, through the writers that never raise. *)
let exit_code () =
  try run (arguments ())
  with exn ->
    let message = Printexc.to_string exn in
    print_error ("mesh-platform: internal error: " ^ message);
    print_json
      (`Assoc [ ("kind", `String "internal"); ("error", `String message) ]);
    1

(* [Unix._exit] ends the process without running [at_exit] functions, so no
   later flush can replace the code decided above. Nothing is lost: this
   program writes nothing through channels (see [write_from]). *)
let () = Unix._exit (exit_code ())
