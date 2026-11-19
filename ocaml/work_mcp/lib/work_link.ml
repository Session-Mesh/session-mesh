(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

module W = Mesh_worklog

let report = function
  | Ok _ -> ()
  | Error (e : W.Err.t) -> Work_repo.warn ("session link failed: " ^ (Work_err.of_worklog e).message)

let task ctx id =
  let who = Work_identity.current () in
  if Work_identity.has_session_id who then report (W.Write_task.link ctx ?session:who.session ~task:id ())

let canonical_task ctx id =
  let open Work_err in
  let* snap = lift (W.Reader.snapshot ctx) in
  lift (W.Refs.task snap.loaded.world id)
