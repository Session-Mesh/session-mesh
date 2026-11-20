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

let list_cap = 100
let section_cap = 25

let filter_of args =
  let* product = Work_args.opt_string args "product" in
  let* project = Work_args.opt_string args "project" in
  let* status = Work_args.strings args "status" in
  let* include_closed = Work_args.opt_bool args "include_closed" in
  let* track = Work_args.opt_string args "track" in
  let* owner = Work_args.opt_string args "owner" in
  let* session = Work_args.opt_string args "session" in
  let* category = Work_args.opt_string args "category" in
  Ok
    {
      W.Query.product;
      project;
      status;
      include_closed = Option.value ~default:false include_closed;
      track;
      owner;
      session;
      category;
    }

let task_filter_properties =
  [
    ("product", T.string ~description:"A product; its descendants are included." ());
    ("project", T.string ~description:"A project id (P-...)." ());
    ("status", Mcp_kit.Schema.array ~max_items:7 (T.enum W.Fields.statuses));
    ("include_closed", T.boolean ~description:"With no status, also done and dropped tasks." ());
    ("track", T.string ());
    ("owner", T.string ());
    ("session", T.string ~description:"Tasks linked to this session name." ());
    ("category", T.string ());
  ]

let row_json (row : W.Resume.row) =
  let base = match R.task_row ?project_title:row.project_title row.task with `Assoc l -> l | _ -> [] in
  `Assoc
    (base
    @ [ ("days_since_activity", `Int row.days) ]
    @ R.opt "here_tier" (fun n -> `Int n) row.tier
    @ (if row.open_blockers = [] then []
       else [ ("blockers", `List (List.map R.blocker_json row.open_blockers)) ])
    @ if row.unblock then [ ("all_blocked_by_tasks_finished", `Bool true) ] else [])

let section name rows = R.capped name section_cap (List.map row_json rows)

let where_of (ctx : W.Ctx.t) (id : Work_identity.t) : W.Resume.where =
  let s = id.session in
  {
    host = ctx.host;
    cwd = id.cwd;
    home = Sys.getenv_opt "HOME";
    session = Work_identity.session_id id;
    repo = Option.bind s (fun (s : W.Session.t) -> s.repo);
    branch = Option.bind s (fun (s : W.Session.t) -> s.branch);
  }

(* This session's questions: the open ones first (newest first), then the ones
   answered in the last [answered_days] days, ten at most. A session name the
   Mesh reuses therefore does not inherit old answered questions, and an old
   unanswered question is never pushed out by newer answered ones. *)
let answered_days = 14
let max_own_questions = 10

(* Slots kept for answered questions (the briefing exists to bring answers
   back), even when more than ten are open: 6 open and 4 answered, newest
   first; a group that fills fewer slots leaves them to the other. *)
let answered_reserved = 4

type own = { shown : Work_questions.question list; open_omitted : int; answered_omitted : int }

let own_questions ~now (id : Work_identity.t) questions =
  match Work_identity.session_id id with
  | None -> { shown = []; open_omitted = 0; answered_omitted = 0 }
  | Some name ->
      let mine = List.filter (fun (q : Work_questions.question) -> q.session = Some name) questions |> List.rev in
      let recent (q : Work_questions.question) =
        match List.rev q.answers with
        | a :: _ -> now - a.Work_questions.answered_at <= answered_days * 86_400
        | [] -> false
      in
      let opened = List.filter Work_questions.is_open mine and answered = List.filter recent mine in
      let reserved = min (List.length answered) answered_reserved in
      let open_shown, open_omitted = R.cap (max_own_questions - reserved) opened in
      let answered_shown, answered_omitted = R.cap (max_own_questions - List.length open_shown) answered in
      { shown = open_shown @ answered_shown; open_omitted; answered_omitted }

let resume args =
  let* filter = filter_of args in
  let* stale_days = Work_args.opt_int args "stale_days" in
  let* show_all = Work_args.opt_bool args "show_all" in
  let* ctx = Work_repo.context () in
  let id = Work_identity.current () in
  let* report, warnings =
    Work_err.lift (W.Reader.resume ctx ~where:(where_of ctx id) ?stale_days ?show_all ~filter ())
  in
  let* questions, collisions = Work_questions.load_report ctx in
  let open_count = List.length (List.filter Work_questions.is_open questions) in
  let mine = own_questions ~now:(ctx.now ()) id questions in
  let count key n = if n > 0 then [ (key, `Int n) ] else [] in
  Ok
    (`Assoc
      (section "here" report.here @ section "in_progress" report.in_progress
      @ section "blocked_or_waiting" report.blocked @ section "stale" report.stale
      @ section "due_within_7_days" report.due @ section "todo" report.todo
      @ [
          ("open_questions", `Int open_count);
          ("my_questions", `List (List.map R.question_json mine.shown));
        ]
      @ count "my_questions_omitted" (mine.open_omitted + mine.answered_omitted)
      @ count "my_open_questions_omitted" mine.open_omitted
      @ count "my_answered_questions_omitted" mine.answered_omitted
      @ R.warnings_json (warnings @ collisions)))

let resume_tool =
  T.make ~name:"work_resume"
    ~description:
      "Start-of-session briefing: tasks here (linked to this session or folder), in progress, \
       blocked or waiting, stale (5 days without activity), due within 7 days; also this \
       session's questions with any answers. Call it at the start of a session."
    ~input_schema:
      (T.object_ ~required:[]
         (List.filter (fun (k, _) -> List.mem k [ "product"; "project"; "track"; "owner" ])
            task_filter_properties
         @ [
             ("stale_days", T.integer ~minimum:1. ~maximum:365. ());
             ("show_all", T.boolean ~description:"Add the todo tasks." ());
           ]))
    resume

let list_tasks args =
  let* filter = filter_of args in
  let* limit = Work_args.limit args ~default:50 ~max:list_cap in
  let* ctx = Work_repo.context () in
  let* tasks, warnings = Work_err.lift (W.Reader.list_tasks ctx filter) in
  let* attempts, attempt_warnings = Work_attempts.load_report ctx in
  Ok
    (`Assoc
      (R.capped "tasks" limit (List.map (fun t -> R.with_attempts attempts t (R.task_row t)) tasks)
      @ [ ("total", `Int (List.length tasks)) ]
      @ R.warnings_json (warnings @ attempt_warnings)))

let list_tasks_tool =
  T.make ~name:"work_list_tasks"
    ~description:
      "List tasks, ordered by priority; done and dropped are hidden unless include_closed or \
       a status is given. Filters: product (with descendants), project, status, track, owner, \
       session, category."
    ~input_schema:(T.object_ ~required:[] (task_filter_properties @ [ T.limit_property ~max:list_cap ]))
    list_tasks

let has_prefix p s = String.length s >= 2 && String.lowercase_ascii (String.sub s 0 2) = p

let max_item_questions = 20

(* The questions about a task or project, newest first, bounded. *)
let questions_about id questions =
  List.filter (fun (q : Work_questions.question) -> q.about = Some id) questions
  |> List.rev |> List.map R.question_json
  |> R.capped "questions" max_item_questions

let get_task ctx id =
  let* view, warnings = Work_err.lift (W.Reader.get_task ctx id) in
  let* questions, collisions = Work_questions.load_report ctx in
  let* attempts, attempt_warnings = Work_attempts.load_report ctx in
  let t = view.task in
  let timeline = List.rev t.timeline |> List.map R.event_json in
  Ok
    (`Assoc
      ([
         ("kind", `String "task");
         ("task", R.task_full ?project_title:view.project_title t);
         ("notes", `String (R.trunc ~max:8000 view.notes));
       ]
      @ R.capped "open_blockers" 20 (List.map R.blocker_json view.open_blockers)
      @ R.capped "blockers_all" 20 (List.map R.blocker_json t.blockers)
      @ R.capped "sessions" 20 (List.map R.link_json t.sessions)
      @ R.capped "timeline_newest_first" 40 timeline
      @ questions_about t.id questions
      @ [ ("attempts", R.attempts_json (Work_attempts.summary (Work_attempts.of_task t.id attempts))) ]
      @ R.warnings_json (warnings @ view.warnings @ collisions @ attempt_warnings)))

let get_project ctx id =
  let* row, tasks, warnings = Work_err.lift (W.Reader.get_project ctx id) in
  let* questions, collisions = Work_questions.load_report ctx in
  let* attempts, attempt_warnings = Work_attempts.load_report ctx in
  let p = row.project in
  Ok
    (`Assoc
      ([ ("kind", `String "project"); ("project", R.project_json row) ]
      @ R.capped "tasks" 60 (List.map (fun t -> R.with_attempts attempts t (R.task_row t)) tasks)
      @ R.capped "timeline_newest_first" 30 (List.rev p.timeline_p |> List.map R.event_json)
      @ questions_about p.pid questions
      @ R.warnings_json (warnings @ collisions @ attempt_warnings)))

let get args =
  let* id = Work_args.string args "id" in
  let* ctx = Work_repo.context () in
  if has_prefix "t-" id then get_task ctx id
  else if has_prefix "p-" id then get_project ctx id
  else Error (invalid "id must start with T- (a task) or P- (a project)")

let get_tool =
  T.make ~name:"work_get"
    ~description:
      "One task (T-...) or project (P-...) by id or unique id prefix: fields, blockers, linked \
       sessions, notes or tasks, newest events, questions and, for a task, its attempts summary."
    ~input_schema:(T.object_ ~required:[ "id" ] [ ("id", T.string ~max:40 ()) ])
    get

let list_projects args =
  let* product = Work_args.opt_string args "product" in
  let* status = Work_args.opt_strings args "status" in
  let* quarter = Work_args.opt_string args "quarter" in
  let* include_closed = Work_args.opt_bool args "include_closed" in
  let* limit = Work_args.limit args ~default:50 ~max:list_cap in
  let* ctx = Work_repo.context () in
  let* rows, warnings =
    Work_err.lift (W.Reader.list_projects ctx ?product ?status ?quarter ?include_closed ())
  in
  Ok
    (`Assoc
      (R.capped "projects" limit (List.map R.project_json rows)
      @ [ ("total", `Int (List.length rows)) ]
      @ R.warnings_json warnings))

let list_projects_tool =
  T.make ~name:"work_list_projects"
    ~description:"List projects with progress (done over total tasks); active ones by default."
    ~input_schema:
      (T.object_ ~required:[]
         [
           ("product", T.string ());
           ("status", Mcp_kit.Schema.array ~max_items:3 (T.enum W.Fields.project_statuses));
           ("quarter", T.string ~max:10 ());
           ("include_closed", T.boolean ());
           T.limit_property ~max:list_cap;
         ])
    list_projects

let product_json (snap : W.Reader.snapshot) (id, parent, _category) =
  let open_tasks =
    W.Model.Smap.fold
      (fun _ (t : W.Model.task) n ->
        if t.product = id && t.status <> "done" && t.status <> "dropped" then n + 1 else n)
      snap.loaded.world.tasks 0
  in
  `Assoc ([ ("id", `String id) ] @ R.opt_str "parent" parent @ [ ("open_tasks", `Int open_tasks) ])

let list_products _args =
  let* ctx = Work_repo.context () in
  let* snap = Work_err.lift (W.Reader.snapshot ctx) in
  match snap.taxonomy with
  | None -> Error (make "repository" "taxonomy.yaml cannot be read")
  | Some tax ->
      let category (c : W.Taxonomy.category) =
        let products = List.filter (fun (_, _, k) -> k = c.key) tax.entries in
        `Assoc
          [
            ("key", `String c.key);
            ("name", `String c.name);
            ("products", `List (List.map (product_json snap) products));
          ]
      in
      Ok (`Assoc ([ ("categories", `List (List.map category tax.categories)) ] @ R.warnings_json snap.warnings))

let list_products_tool =
  T.make ~name:"work_list_products"
    ~description:"The product tree: categories, products with their parent and open task counts."
    ~input_schema:(T.object_ ~required:[] []) list_products

let tools = [ resume_tool; list_tasks_tool; get_tool; list_projects_tool; list_products_tool ]
