(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(* mesh-history: the History index helper, driven over stdin/stdout by
   server.py. The database path is MESH_HISTORY_DB, else history.sqlite in
   MESH_CACHE_DIR, else ~/.cache/session-mesh. See Mesh_history_protocol. *)

let cache_dir () =
  match Sys.getenv_opt "MESH_CACHE_DIR" with
  | Some d when d <> "" -> d
  | _ -> (
      match Sys.getenv_opt "HOME" with
      | Some h when h <> "" ->
          Filename.concat (Filename.concat h ".cache") "session-mesh"
      | _ ->
          prerr_endline "mesh-history: HOME is not set";
          exit 78)

let database_path () =
  match Sys.getenv_opt "MESH_HISTORY_DB" with
  | Some p when p <> "" -> p
  | _ -> Filename.concat (cache_dir ()) "history.sqlite"

let rec mkdir_private dir =
  if not (Sys.file_exists dir) then begin
    mkdir_private (Filename.dirname dir);
    try Unix.mkdir dir 0o700 with Unix.Unix_error (Unix.EEXIST, _, _) -> ()
  end

let open_store path () =
  (try mkdir_private (Filename.dirname path) with Unix.Unix_error _ -> ());
  Mesh_history_store.open_ ~path ()

let serve_history () =
  (* The index holds prompts and replies: private to the user, WAL files too. *)
  ignore (Unix.umask 0o077);
  Sys.set_signal Sys.sigpipe Sys.Signal_ignore;
  let protocol =
    Mesh_history_protocol.create ~open_store:(open_store (database_path ()))
  in
  Mesh_history_protocol.serve protocol stdin stdout

let registry_path () =
  let dir =
    match Sys.getenv_opt "MESH_CONF_DIR" with
    | Some d when d <> "" ->
        if Filename.is_relative d then invalid_arg "MESH_CONF_DIR must be absolute";
        d
    | _ ->
        let home = match Sys.getenv_opt "HOME" with
          | Some d when d <> "" -> d
          | _ -> (Unix.getpwuid (Unix.getuid ())).pw_dir
        in
        Filename.concat home ".config/session-mesh"
  in
  Filename.concat dir "conversation-names.json"

let read_registry_frame () =
  let frame = In_channel.input_all stdin in
  let length = String.length frame in
  if length = 0 || String.index_opt frame '\n' <> Some (length - 1) then
    invalid_arg "expected one newline-terminated frame";
  String.sub frame 0 (length - 1)

let serve_registry () =
  try
    let request = read_registry_frame () in
    let response = Conversation_protocol.handle ~path:(registry_path ()) request in
    print_endline response
  with
  | Invalid_argument _ ->
      prerr_endline "mesh-history: invalid conversation-name invocation or frame";
      exit 64
  | Mesh_conversation_store.Parent_exited -> exit 75

let () =
  match Array.to_list Sys.argv with
  | [ _; "--conversation-names" ] -> serve_registry ()
  | [ _; "--flow-read" ] -> Mesh_flow_cli.run "read"
  | [ _; "--flow-write" ] -> Mesh_flow_cli.run "write"
  | _ -> serve_history ()
