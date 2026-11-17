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
      | Some h when h <> "" -> Filename.concat (Filename.concat h ".cache") "session-mesh"
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

let () =
  (* The index holds prompts and replies: private to the user, WAL files too. *)
  ignore (Unix.umask 0o077);
  Sys.set_signal Sys.sigpipe Sys.Signal_ignore;
  let protocol =
    Mesh_history_protocol.create ~open_store:(open_store (database_path ()))
  in
  Mesh_history_protocol.serve protocol stdin stdout
