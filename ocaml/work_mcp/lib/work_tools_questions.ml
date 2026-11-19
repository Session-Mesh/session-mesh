(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

module W = Mesh_worklog
module R = Work_render
module T = Work_tool
open Work_err

let max_questions = 50

let needs_session id request_id =
  if request_id <> None && not (Work_identity.has_session_id id) then
    Error (invalid "request_id needs a session identity (MESH_SESSION): no session is known")
  else Ok ()

(* A question about a task links the asking session to it; a failed link is a
   warning of the call. *)
let link_task ctx about =
  match about with
  | Some a when String.length a > 1 && Char.lowercase_ascii a.[0] = 't' -> Work_link.task ctx a
  | _ -> ()

let state_of ctx qid =
  let* questions = Work_questions.load ctx in
  Ok
    (match List.find_opt (fun (q : Work_questions.question) -> q.id = qid) questions with
    | Some q when not (Work_questions.is_open q) -> "answered"
    | _ -> "open")

let ask args =
  let* text = Work_args.string args "text" in
  let* options = Work_args.strings args "options" in
  let* assumption = Work_args.opt_string args "assumption" in
  let* about = Work_args.opt_string args "task" in
  let* request_id = Work_request.of_args args in
  let* ctx = Work_repo.context () in
  let id = Work_identity.current () in
  Work_identity.warn_if_unresolved id;
  let* () = needs_session id request_id in
  let* qid, duplicate =
    lift (Work_questions.ask ctx ?session:id.session ~text ~options ?assumption ?about ?request_id ())
  in
  if not duplicate then link_task ctx about;
  let* state = if duplicate then state_of ctx qid else Ok "open" in
  Ok (`Assoc ([ ("id", `String qid); ("state", `String state) ] @ if duplicate then [ ("duplicate", `Bool true) ] else []))

let ask_tool =
  T.make ~name:"work_ask"
    ~description:
      "Record a non-blocking question and carry on: state in assumption what you adopt meanwhile. \
       Optional task (T-... or P-...) the question is about, and options (answer choices). The \
       owner answers later, in this session's conversation: record that answer with \
       work_answer. Read answers with work_resume or work_list_questions. For a question that \
       truly blocks (a permission, an irreversible action) ask directly instead."
    ~input_schema:
      (T.object_ ~required:[ "text" ]
         [
           ("text", T.string ~max:Work_questions.max_text ());
           ("options", T.strings ~max_items:Work_questions.max_options ~max:Work_questions.max_option ());
           ("assumption", T.string ~max:Work_questions.max_assumption ());
           ("task", T.string ~max:40 ());
           ("request_id", T.string ~max:Work_request.max_length ~description:"Optional retry key (A-Z a-z 0-9 _ . : -): a repeated call of the same session with the same request_id on the same task returns the first question with duplicate=true." ());
         ])
    ask

let max_by = Work_questions.max_option

let answer_result = function
  | Work_questions.Recorded qid -> Ok (`Assoc [ ("id", `String qid); ("state", `String "answered") ])
  | Work_questions.Same_answer qid ->
      Ok (`Assoc [ ("id", `String qid); ("state", `String "answered"); ("duplicate", `Bool true) ])
  | Work_questions.Already_answered qid ->
      Error
        (make "already_answered"
           (Printf.sprintf
              "question %s already has a different answer; an answer is never replaced. If the owner \
               changed their mind, record it with work_log or ask a new question"
              qid))

let answer args =
  let* question = Work_args.string args "question" in
  let* text = Work_args.string args "text" in
  let* by = Work_args.opt_string args "answered_by" in
  let* () =
    if Work_questions.valid_id question then Ok ()
    else Error (invalid "question must be a question id: N- and 8 lowercase hex digits")
  in
  let* ctx = Work_repo.context () in
  let id = Work_identity.current () in
  Work_identity.warn_if_unresolved id;
  let* () =
    if Work_identity.has_session_id id then Ok ()
    else Error (invalid "work_answer needs a session identity (MESH_SESSION): no session is known")
  in
  let by = Option.value ~default:"owner" by in
  let* outcome = lift (Work_questions.answer_once ctx ?session:id.session ~question ~text ~by ()) in
  answer_result outcome

let answer_tool =
  T.make ~name:"work_answer"
    ~description:
      "Relay the OWNER's answer to a question recorded with work_ask: when the owner answers in \
       this conversation, record the owner's words here (question: the N-... id from work_ask, \
       work_list_questions or work_get; text: what the owner said). answered_by defaults to \
       owner. Never use it to answer a question yourself, yours or another agent's, without \
       the owner: an unanswered question stays open. A question has one answer: a second, \
       different one is refused with already_answered; repeating the same answer returns \
       duplicate=true and writes nothing."
    ~input_schema:
      (T.object_ ~required:[ "question"; "text" ]
         [
           ("question", T.string ~max:40 ());
           ("text", T.string ~max:Work_questions.max_text ());
           ("answered_by", T.string ~max:max_by ~description:"Who gave the answer; default owner." ());
         ])
    answer

let normalise_about ctx about =
  let* snap = lift (W.Reader.snapshot ctx) in
  let world = snap.loaded.world in
  if String.length about > 1 && Char.lowercase_ascii about.[0] = 'p' then lift (W.Refs.project world about)
  else lift (W.Refs.task world about)

let state_filter = function
  | "open" -> Ok Work_questions.is_open
  | "answered" -> Ok (fun q -> not (Work_questions.is_open q))
  | "all" -> Ok (fun _ -> true)
  | other -> Error (invalid "state must be open, answered or all, not %s" other)

let scope_filter scope about =
  match (scope, about) with
  | "all", _ -> Ok (fun _ -> true)
  | "with_task", _ -> Ok (fun (q : Work_questions.question) -> q.about <> None)
  | "without_task", None -> Ok (fun (q : Work_questions.question) -> q.about = None)
  | "without_task", Some _ -> Error (invalid "scope without_task cannot be combined with task")
  | other, _ -> Error (invalid "scope must be all, with_task or without_task, not %s" other)

let list_questions args =
  let* state = Work_args.opt_string args "state" in
  let* keep_state = state_filter (Option.value ~default:"all" state) in
  let* about = Work_args.opt_string args "task" in
  let* session = Work_args.opt_string args "session" in
  let* scope = Work_args.opt_string args "scope" in
  let* keep_scope = scope_filter (Option.value ~default:"all" scope) about in
  let* limit = Work_args.limit args ~default:20 ~max:max_questions in
  let* ctx = Work_repo.context () in
  let* about = match about with None -> Ok None | Some a -> Result.map Option.some (normalise_about ctx a) in
  let* all, collisions = Work_questions.load_report ctx in
  let keep (q : Work_questions.question) =
    keep_state q
    && keep_scope q
    && (about = None || q.about = about)
    && (session = None || q.session = session)
  in
  let shown = List.filter keep all |> List.rev in
  Ok
    (`Assoc
      (R.capped "questions" limit (List.map R.question_json shown)
      @ [
          ("total", `Int (List.length shown));
          ("open_total", `Int (List.length (List.filter Work_questions.is_open all)));
        ]
      @ R.warnings_json collisions))

let list_questions_tool =
  T.make ~name:"work_list_questions"
    ~description:
      "Questions with their answers, newest first. state: open, answered or all (default). \
       Filter by the task or project they are about, by scope (with_task, without_task: the \
       questions about no task or project) or by the asking session."
    ~input_schema:
      (T.object_ ~required:[]
         [
           ("state", T.enum [ "open"; "answered"; "all" ]);
           ("task", T.string ~max:40 ());
           ("session", T.string ~max:200 ());
           ("scope", T.enum [ "all"; "with_task"; "without_task" ]);
           T.limit_property ~max:max_questions;
         ])
    list_questions

let views = [ "resume"; "board"; "timeline"; "dependencies"; "questions" ]

let open_view args =
  let* target = Work_args.string args "target" in
  let* view = Work_args.opt_string args "view" in
  let* () =
    match view with
    | Some v when not (List.mem v views) -> Error (invalid "view must be one of %s" (String.concat ", " views))
    | _ -> Ok ()
  in
  let* ctx = Work_repo.context () in
  let* snap = lift (W.Reader.snapshot ctx) in
  let known_product = match snap.taxonomy with Some t -> W.Taxonomy.has_product t target | None -> false in
  let* () =
    if known_product then Ok ()
    else if String.length target > 1 && Char.lowercase_ascii target.[0] = 'p' then
      Result.map ignore (lift (W.Refs.project snap.loaded.world target))
    else Result.map ignore (lift (W.Refs.task snap.loaded.world target))
  in
  Ok (`Assoc [ ("opened", `Bool false); ("reason", `String "not available until the interface slice") ])

let open_view_tool =
  T.make ~name:"work_open_view"
    ~description:
      "Ask the Mesh to show the project view next to the terminal, on a task (T-...), project \
       (P-...) or product, in a view. Not available yet: it validates its input and answers \
       opened=false."
    ~input_schema:
      (T.object_ ~required:[ "target" ]
         [ ("target", T.string ~max:100 ()); ("view", T.enum views) ])
    open_view

let tools = [ ask_tool; answer_tool; list_questions_tool; open_view_tool ]
