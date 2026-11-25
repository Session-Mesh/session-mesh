(* SPDX-License-Identifier: AGPL-3.0-or-later *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech> *)

(* Only the server writes these projections after a successful operation.
   They deliberately contain no message text, credentials or MCP arguments. *)
let capacity = 1024
let field name fields = List.assoc_opt name fields

let fields_are keys fields =
  List.sort String.compare (List.map fst fields) = List.sort String.compare keys

let identifier max s =
  String.length s > 0
  && String.length s <= max
  && String.for_all
       (function
         | 'a' .. 'z' | 'A' .. 'Z' | '0' .. '9' | '_' | '-' -> true | _ -> false)
       s

let finite = function
  | `Int n -> n >= 0
  | `Float f -> Float.is_finite f && f >= 0.
  | _ -> false

let identity = function
  | `Assoc fields when fields_are [ "id"; "created"; "agent" ] fields -> (
      match
        (field "id" fields, field "created" fields, field "agent" fields)
      with
      | Some (`String id), Some created, Some (`String agent) ->
          identifier 48 id && finite created && identifier 32 agent
      | _ -> false)
  | _ -> false

let valid = function
  | `Assoc fields
    when fields_are [ "id"; "kind"; "time"; "source"; "target" ] fields -> (
      match
        ( field "id" fields,
          field "kind" fields,
          field "time" fields,
          field "source" fields,
          field "target" fields )
      with
      | ( Some (`String id),
          Some (`String kind),
          Some time,
          Some source,
          Some target ) ->
          identifier 64 id
          && (kind = "message" || kind = "create")
          && finite time && identity source && identity target
          && source <> target
      | _ -> false)
  | _ -> false

let empty =
  (`Assoc [ ("events", `List []); ("truncated", `Bool false) ] : Yojson.Safe.t)

let state = function
  | `Assoc fields when fields_are [ "events"; "truncated" ] fields -> (
      match (field "events" fields, field "truncated" fields) with
      | Some (`List events), Some (`Bool truncated)
        when List.length events <= capacity && List.for_all valid events ->
          (events, truncated)
      | _ -> failwith "invalid flow journal")
  | _ -> failwith "invalid flow journal"

let private_file fd path =
  let opened = Unix.fstat fd and named = Unix.lstat path in
  if
    opened.st_kind <> Unix.S_REG
    || named.st_kind <> Unix.S_REG
    || opened.st_dev <> named.st_dev
    || opened.st_ino <> named.st_ino
    || opened.st_uid <> Unix.geteuid ()
    || opened.st_nlink <> 1
    || opened.st_perm land 0o077 <> 0
  then failwith "flow journal is not private"

let with_lock directory f =
  let path = Filename.concat directory "flow-events.lock" in
  let fd = Unix.openfile path [ Unix.O_RDWR; Unix.O_CREAT; Unix.O_NONBLOCK ] 0o600 in
  Fun.protect
    ~finally:(fun () -> Unix.close fd)
    (fun () ->
      private_file fd path;
      Unix.lockf fd Unix.F_LOCK 0;
      Fun.protect ~finally:(fun () -> Unix.lockf fd Unix.F_ULOCK 0) f)

let read_unlocked directory =
  let path = Filename.concat directory "flow-events.json" in
  match Unix.openfile path [ Unix.O_RDONLY; Unix.O_NONBLOCK ] 0 with
  | fd ->
      Fun.protect
        ~finally:(fun () -> Unix.close fd)
        (fun () ->
          private_file fd path;
          if (Unix.fstat fd).st_size > 2_000_000 then
            failwith "flow journal too large";
          let input = Unix.in_channel_of_descr (Unix.dup fd) in
          Fun.protect
            ~finally:(fun () -> close_in_noerr input)
            (fun () ->
              let data = Yojson.Safe.from_channel input in
              ignore (state data);
              data))
  | exception Unix.Unix_error (Unix.ENOENT, _, _) -> empty

let read directory = with_lock directory (fun () -> read_unlocked directory)

let write directory event =
  if not (valid event) then invalid_arg "invalid flow event";
  with_lock directory (fun () ->
      let events, truncated = state (read_unlocked directory) in
      let id = Yojson.Safe.Util.(event |> member "id") in
      match
        List.find_opt (fun e -> Yojson.Safe.Util.(e |> member "id") = id) events
      with
      | Some e when e = event -> ()
      | Some _ -> failwith "conflicting flow event id"
      | None ->
          let events = events @ [ event ] in
          let events, truncated =
            if List.length events > capacity then (List.tl events, true)
            else (events, truncated)
          in
          let path, output =
            Filename.open_temp_file ~temp_dir:directory ".flow-events-" ".tmp"
          in
          Fun.protect
            ~finally:(fun () ->
              close_out_noerr output;
              if Sys.file_exists path then Sys.remove path)
            (fun () ->
              Yojson.Safe.to_channel output
                (`Assoc
                   [ ("events", `List events); ("truncated", `Bool truncated) ]);
              output_char output '\n';
              flush output;
              Unix.fsync (Unix.descr_of_out_channel output);
              close_out output;
              Unix.rename path (Filename.concat directory "flow-events.json")))
