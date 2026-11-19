(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

module W = Mesh_worklog

type t = { cwd : string; session : W.Session.t option; problem : string option }

let non_empty getenv name = match getenv name with Some "" | None -> None | Some v -> Some v

let first_set getenv pairs =
  List.find_map (fun (name, agent) -> Option.map (fun _ -> agent) (non_empty getenv name)) pairs

(* The agent kind. The Mesh sets no variable for it, so it is read from the
   markers the agents leave in their own environment; WL_AGENT (read by the
   library) wins when set. *)
let agent_kind getenv =
  if non_empty getenv "WL_AGENT" <> None then None
  else
    match
      first_set getenv
        [
          ("CLAUDECODE", "claude");
          ("CLAUDE_CODE_ENTRYPOINT", "claude");
          ("CLAUDE_CODE_SESSION_ID", "claude");
          ("OPENCODE_SESSION_ID", "opencode");
          ("CODEX_THREAD_ID", "codex");
        ]
    with
    | Some a -> Some a
    | None -> if non_empty getenv "MESH_SESSION" <> None then Some "agent" else None

let real_cwd () = try Unix.realpath (Sys.getcwd ()) with Unix.Unix_error _ | Sys_error _ -> Sys.getcwd ()

(* A MESH_SESSION the library refuses is not replaced by another variable
   (WL_SESSION, CLAUDE_CODE_SESSION_ID, ...): the session is then unknown and
   nothing is linked or attributed to it. *)
let resolve_session getenv cwd =
  let attempt session =
    W.Session.resolve ~getenv ?agent:(agent_kind getenv) ?session ~cwd ()
  in
  let result =
    match non_empty getenv "MESH_SESSION" with Some name -> attempt (Some name) | None -> attempt None
  in
  match result with Ok s -> (s, None) | Error (e : W.Err.t) -> (None, Some e.message)

let of_env ?(getenv = Sys.getenv_opt) () =
  let cwd = real_cwd () in
  let session, problem = resolve_session getenv cwd in
  { cwd; session; problem }

(* A write made without the identity the environment asked for says so: the
   event carries no session and no agent, and nothing is linked. *)
let warn_if_unresolved t =
  Option.iter
    (fun why ->
      Work_repo.warn
        ("the session identity was not resolved (" ^ why
       ^ "): this write carries no session and no agent, and no session is linked"))
    t.problem

let current_value = lazy (of_env ())
let current () = Lazy.force current_value

let session_id t = Option.bind t.session (fun (s : W.Session.t) -> s.session)

let has_session_id t = session_id t <> None

(* The Mesh session token is never read by the server, and the library runs
   git with the whole environment: the variable is emptied once at start so
   no subprocess inherits it. *)
let scrub_environment () = Unix.putenv "MESH_SESSION_TOKEN" ""
