(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

module A = Work_attempts
module T = Work_tool
open Work_err

let needs_session id request_id =
  if request_id <> None && not (Work_identity.has_session_id id) then
    Error (invalid "request_id needs a session identity (MESH_SESSION): no session is known")
  else Ok ()

let result_json task (r : A.recorded) =
  `Assoc
    ([
       ("id", `String r.attempt_id);
       ("task", `String task);
       ("n", `Int r.number);
       ("consecutive_failures", `Int r.task_summary.consecutive_failures);
       ("needs_reframe", `Bool (A.needs_reframe r.task_summary));
     ]
    @ if r.duplicate then [ ("duplicate", `Bool true) ] else [])

let attempt args =
  let* task = Work_args.string args "task" in
  let* outcome = Work_args.string args "outcome" in
  let* reason = Work_args.opt_string args "reason" in
  let* text = Work_args.opt_string args "text" in
  let* links = Work_args.strings args "links" in
  let* started = Work_args.opt_string args "started" in
  let* ended = Work_args.opt_string args "ended" in
  let* ref_ = Work_args.opt_string args "ref" in
  let* request_id = Work_request.of_args args in
  let* ctx = Work_repo.context () in
  let id = Work_identity.current () in
  Work_identity.warn_if_unresolved id;
  let* () = needs_session id request_id in
  let* task = Work_link.canonical_task ctx task in
  let* recorded =
    lift
      (A.record ctx ?session:id.session ~task ~outcome ?reason ?text ~links ?started ?ended ?ref_ ?request_id ())
  in
  if not recorded.duplicate then Work_link.task ctx task;
  Ok (result_json task recorded)

let attempt_tool =
  T.make ~name:"work_attempt"
    ~description:
      "Record the end of an attempt (a pass of work) on a task (T-...): outcome success, failure \
       or abandoned; reason (ci_failure, review_nogo, test_red, environment, external, other) is \
       required on a failure and not allowed on a success; optional short one-line text, links \
       (PR, CI run), started and ended (UTC, 2026-11-20T10:00:00Z), ref (an external id such as \
       a Roster attempt id) and request_id. Call it when a pass ends in a failure you will \
       retry, is abandoned, or succeeds after failures; not for every failed command. The \
       attempt number is derived, never given. A failure that stops the work is a work_block, \
       not an attempt. Returns the attempt id, its number, the task's consecutive failures and \
       needs_reframe (3 in a row)."
    ~input_schema:
      (T.object_ ~required:[ "task"; "outcome" ]
         [
           ("task", T.string ~max:40 ());
           ("outcome", T.enum A.outcomes);
           ("reason", T.enum A.reasons);
           ("text", T.string ~max:(4 * A.max_text) ());
           ("links", T.strings ~max_items:A.max_links ~max:(4 * A.max_link) ());
           ("started", T.string ~max:40 ());
           ("ended", T.string ~max:40 ());
           ("ref", T.string ~max:A.max_ref ());
           ( "request_id",
             T.string ~max:Work_request.max_length
               ~description:
                 "Optional retry key (A-Z a-z 0-9 _ . : -): a repeated call of the same session with \
                  the same request_id on the same task returns the first attempt with duplicate=true."
               () );
         ])
    attempt

let tools = [ attempt_tool ]
