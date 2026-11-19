(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

type t = {
  agent : string;
  session : string option;
  cwd : string option;
  repo : string option;
  branch : string option;
}

let agent_ok a =
  a <> ""
  && String.for_all
       (fun c -> (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c = '_' || c = '-')
       a

let session_ok s =
  let first_ok c =
    (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')
    || c = '_' || c = '.' || c = ':'
  in
  s <> "" && first_ok s.[0] && String.for_all (fun c -> first_ok c || c = '-') s

(* Caller input (an MCP client passes these through): single-line and bounded,
   they reach every renderer of the timeline. *)
let path_limit = 4096
let branch_limit = 255

let check_text (field, limit, value) =
  Option.iter
    (fun v ->
      if v <> "" then
        match Textcheck.text_error ~field ~limit v with
        | Some why -> Err.usage "%s" why
        | None -> ())
    value

let make ~agent ?session ?cwd ?repo ?branch () =
  Err.protect (fun () ->
      if not (agent_ok agent) then
        Err.usage "invalid agent %S (allowed: a-z 0-9 _ -)" agent;
      Option.iter
        (fun s ->
          if not (session_ok s) then
            Err.usage "invalid session id %S (allowed: A-Z a-z 0-9 _ . : -, not starting with -)" s)
        session;
      List.iter check_text
        [ ("cwd", path_limit, cwd); ("repo", path_limit, repo); ("branch", branch_limit, branch) ];
      { agent; session; cwd; repo; branch })

let non_empty = function Some "" | None -> None | Some v -> Some v

let env_session getenv =
  List.find_map
    (fun (var, agent) -> Option.map (fun v -> (v, agent)) (non_empty (getenv var)))
    [ ("CLAUDE_CODE_SESSION_ID", "claude"); ("OPENCODE_SESSION_ID", "opencode") ]

let resolve ?(getenv = Sys.getenv_opt) ?agent ?session ?cwd () =
  let session_arg = non_empty session in
  let from_wl = match session_arg with Some s -> Some s | None -> non_empty (getenv "WL_SESSION") in
  let session, inferred =
    match from_wl with
    | Some s -> (Some s, None)
    | None -> (
        match env_session getenv with Some (s, a) -> (Some s, Some a) | None -> (None, None))
  in
  let agent =
    match non_empty agent with
    | Some a -> Some a
    | None -> ( match non_empty (getenv "WL_AGENT") with Some a -> Some a | None -> inferred)
  in
  match (agent, session) with
  | None, Some _ -> Error (Err.make Err.Usage "session id given but agent unknown; pass an agent or set WL_AGENT")
  | None, None -> Ok None
  | Some agent, session -> (
      (* [cwd] is validated before it reaches any git call. *)
      let cwd = non_empty cwd in
      let from_git () =
        Option.iter
          (fun d ->
            check_text ("cwd", path_limit, Some d);
            if Filename.is_relative d then Err.usage "cwd %S must be an absolute path" d)
          cwd;
        match cwd with Some d -> Gitrun.context d | None -> (None, None)
      in
      match Err.protect from_git with
      | Error e -> Error e
      | Ok (repo, branch) -> Result.map Option.some (make ~agent ?session ?cwd ?repo ?branch ()))
