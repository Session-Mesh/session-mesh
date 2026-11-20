(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

module W = Mesh_worklog
module E = Work_mcp.Work_err
module Q = Work_mcp.Work_questions
open E

type t = {
  ctx : W.Ctx.t;
  snapshot : W.Reader.snapshot;
  questions : Q.question list;
  attempts : Work_mcp.Work_attempts.attempt list;
  warnings : string list;
}

let load ?(getenv = Sys.getenv_opt) () =
  let* ctx = Result.map_error of_worklog (W.Ctx.of_env ~getenv ~commit:false ~warn:ignore ()) in
  let* snapshot = lift (W.Reader.snapshot ctx) in
  let questions, collisions = Q.of_events_report snapshot.loaded.events in
  let attempts, attempt_warnings = Work_mcp.Work_attempts.of_events_report snapshot.loaded.events in
  Ok { ctx; snapshot; questions; attempts; warnings = snapshot.warnings @ collisions @ attempt_warnings }

let world t = t.snapshot.loaded.world
let warnings_json t = Work_mcp.Work_render.warnings_json t.warnings
