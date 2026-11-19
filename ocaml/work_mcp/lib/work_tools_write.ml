(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

module W = Mesh_worklog
module T = Work_tool
module S = Mcp_kit.Schema
open Work_err

(* The identity of a write: one that the environment asked for and that could
   not be resolved is reported in [write_warnings]. *)
let session () =
  let who = Work_identity.current () in
  Work_identity.warn_if_unresolved who;
  who.session

let link = Work_link.task

let id_json ?(extra = []) key id = `Assoc ((key, `String id) :: extra)

let short = T.string ~max:200 ()
let text_schema = T.string ~max:8000 ()
let request_id_schema = T.string ~max:Work_request.max_length ~description:"Optional retry key (A-Z a-z 0-9 _ . : -). A repeated call of the same session with the same request_id on the same target returns the first result with duplicate=true and writes nothing." ()
let id_schema = T.string ~max:40 ()

let result_id = function
  | `Assoc fields -> ( match List.assoc_opt "id" fields with Some (`String id) -> id | _ -> "")
  | _ -> ""

let add_task args =
  let* title = Work_args.string args "title" in
  let* product = Work_args.string args "product" in
  let* priority = Work_args.opt_string args "priority" in
  let* status = Work_args.opt_string args "status" in
  let* due = Work_args.opt_string args "due" in
  let* tags = Work_args.strings args "tags" in
  let* links = Work_args.strings args "links" in
  let* project = Work_args.opt_string args "project" in
  let* track = Work_args.opt_string args "track" in
  let* owner = Work_args.opt_string args "owner" in
  let* eta = Work_args.opt_string args "eta" in
  let* size = Work_args.opt_string args "size" in
  let* origin = Work_args.opt_string args "origin" in
  let* also = Work_args.strings args "also" in
  let* notes = Work_args.opt_string args "notes" in
  let* request_id = Work_request.of_args args in
  let* ctx = Work_repo.context () in
  let write () =
    let* id =
      lift
        (W.Write_task.add ctx ?session:(session ()) ~title ~product ?priority ?status ?due ~tags
           ~links ?project ?track ?owner ?eta ?size ?origin ~also ?notes ())
    in
    link ctx id;
    Ok (id_json "id" id)
  in
  Work_request.once ctx ~tool:"work_add_task" ~request_id ~session:(session ()) ~target:product
    ~task_of:result_id write

let add_task_tool =
  T.make ~name:"work_add_task"
    ~description:
      "Create a task in a product and return its id (T-...). notes is the body of the task file, \
       written once at creation; later additions go through work_log. The calling session is \
       linked to the task."
    ~input_schema:
      (T.object_ ~required:[ "title"; "product" ]
         [
           ("title", short);
           ("product", short);
           ("priority", T.enum W.Fields.priorities);
           ("status", T.enum W.Fields.statuses);
           ("due", T.string ~max:10 ~description:"YYYY-MM-DD" ());
           ("tags", T.strings ~max_items:20 ~max:100 ());
           ("links", T.strings ~max_items:20 ~max:500 ());
           ("project", id_schema);
           ("track", short);
           ("owner", short);
           ("eta", T.string ~max:10 ());
           ("size", T.enum W.Fields.sizes);
           ("origin", T.enum W.Fields.origins);
           ("also", T.strings ~max_items:20 ~max:100 ());
           ("notes", T.string ~max:20000 ());
           ("request_id", request_id_schema);
         ])
    add_task

let add_project args =
  let* title = Work_args.string args "title" in
  let* product = Work_args.string args "product" in
  let* quarter = Work_args.opt_string args "quarter" in
  let* owner = Work_args.opt_string args "owner" in
  let* hlp = Work_args.opt_string args "hlp" in
  let* goal = Work_args.opt_string args "goal" in
  let* milestones = Work_args.strings args "milestones" in
  let* risks = Work_args.strings args "risks" in
  let* ctx = Work_repo.context () in
  let* id =
    lift
      (W.Write_project.add ctx ?session:(session ()) ~title ~product ?quarter ?owner ?hlp ?goal
         ~milestones ~risks ())
  in
  Ok (id_json "id" id)

let add_project_tool =
  T.make ~name:"work_add_project"
    ~description:
      "Create a project (the objective that groups tasks, id P-...) in a product. A project \
       can group tasks of several products."
    ~input_schema:
      (T.object_ ~required:[ "title"; "product" ]
         [
           ("title", short);
           ("product", short);
           ("quarter", T.string ~max:10 ~description:"For example 2026Q4." ());
           ("owner", short);
           ("hlp", T.string ~max:500 ~description:"A link." ());
           ("goal", T.string ~max:500 ());
           ("milestones", T.strings ~max_items:20 ~max:500 ());
           ("risks", T.strings ~max_items:20 ~max:500 ());
         ])
    add_project

let add_product args =
  let* id = Work_args.string args "id" in
  let* category = Work_args.string args "category" in
  let* parent = Work_args.opt_string args "parent" in
  let* ctx = Work_repo.context () in
  let* () = lift (W.Taxonomy_edit.add_product ctx ~id ~category ?parent ()) in
  Ok (id_json "id" id)

let add_product_tool =
  T.make ~name:"work_add_product"
    ~description:
      "Add a product to a category of taxonomy.yaml, optionally under a root product (two levels \
       at most). Products are never renamed, moved or deleted."
    ~input_schema:
      (T.object_ ~required:[ "id"; "category" ]
         [ ("id", T.string ~max:64 ()); ("category", short); ("parent", T.string ~max:100 ()) ])
    add_product

let unique l = List.sort_uniq String.compare l
let scalar_fields = unique (W.Fields.task_scalars @ W.Fields.project_scalars)
let list_fields = unique (W.Fields.task_list_fields @ W.Fields.project_list_fields)

type target = Task of string | Project of string

let target_of id =
  let lower = String.lowercase_ascii id in
  if String.length id > 2 && String.sub lower 0 2 = "t-" then Ok (Task id)
  else if String.length id > 2 && String.sub lower 0 2 = "p-" then Ok (Project id)
  else Error (invalid "id must start with T- (a task) or P- (a project)")

let scalar_value field = function
  | `String s -> Ok (Some s)
  | `Null -> Ok None
  | _ -> Error (invalid "set.%s must be a string or null" field)

type op = Set of string * string option | Add of string * string | Remove of string * string

let ops_of args =
  let* sets = Work_args.opt_assoc args "set" in
  let* adds = Work_args.opt_assoc args "add" in
  let* removes = Work_args.opt_assoc args "remove" in
  let items make members =
    List.fold_left
      (fun acc (field, v) ->
        let* acc = acc in
        let* values = Work_args.strings_of field v in
        Ok (acc @ List.map (make field) values))
      (Ok []) members
  in
  let* sets =
    List.fold_left
      (fun acc (field, v) ->
        let* acc = acc in
        let* value = scalar_value field v in
        Ok (acc @ [ Set (field, value) ]))
      (Ok []) sets
  in
  let* adds = items (fun f v -> Add (f, v)) adds in
  let* removes = items (fun f v -> Remove (f, v)) removes in
  match sets @ adds @ removes with
  | [] -> Error (invalid "give at least one of set, add, remove")
  | ops -> Ok ops

let describe = function
  | Set (f, _) -> "set " ^ f
  | Add (f, _) -> "add " ^ f
  | Remove (f, _) -> "remove " ^ f

let outcome_name = function W.Write_task.Changed -> "changed" | W.Write_task.Unchanged -> "unchanged"

let apply_one ctx target op =
  let session = session () in
  let with_outcome = Result.map (fun (id, o) -> (id, outcome_name o)) in
  let removed = Result.map (fun id -> (id, "changed")) in
  match (target, op) with
  | Task task, Set (field, value) -> with_outcome (W.Write_task.set ctx ?session ~task ~field ~value ())
  | Task task, Add (field, value) -> with_outcome (W.Write_task.add_item ctx ?session ~task ~field ~value ())
  | Task task, Remove (field, value) -> removed (W.Write_task.remove_item ctx ?session ~task ~field ~value ())
  | Project project, Set (field, value) ->
      with_outcome (W.Write_project.set ctx ?session ~project ~field ~value ())
  | Project project, Add (field, value) ->
      with_outcome (W.Write_project.add_item ctx ?session ~project ~field ~value ())
  | Project project, Remove (field, value) ->
      removed (W.Write_project.remove_item ctx ?session ~project ~field ~value ())

let change_json op outcome = `Assoc [ ("op", `String (describe op)); ("result", `String outcome) ]

(* Operations are applied one after the other, each under the repository
   lock; one that fails stops the sequence and the error lists what was
   already applied. *)
let apply_all ctx target ops =
  let rec go applied canonical = function
    | [] -> Ok (canonical, List.rev applied)
    | op :: rest -> (
        match apply_one ctx target op with
        | Ok (id, outcome) -> go (change_json op outcome :: applied) id rest
        | Error e ->
            let done_ = List.length applied in
            let e = of_worklog e in
            Error { e with message = Printf.sprintf "%s (failed at %s; %d change(s) applied before)" e.message (describe op) done_ })
  in
  go [] "" ops

let update args =
  let* id = Work_args.string args "id" in
  let* target = target_of id in
  let* ops = ops_of args in
  let* ctx = Work_repo.context () in
  let* canonical, changes = apply_all ctx target ops in
  (match target with Task _ -> link ctx canonical | Project _ -> ());
  Ok (id_json "id" canonical ~extra:[ ("changes", `List changes) ])

let update_tool =
  let scalars = List.map (fun f -> (f, S.nullable (T.string ~max:500 ()))) scalar_fields in
  let lists = List.map (fun f -> (f, T.strings ~max_items:20 ~max:500 ())) list_fields in
  T.make ~name:"work_update"
    ~description:
      "Change a task (T-...) or project (P-...). set: scalar fields (status, priority, title, \
       due, track, owner, eta, size, origin, product, project; for a project title, product, \
       quarter, owner, hlp, goal, status), null clears where allowed. add / remove: list fields \
       (tags, links, blocked_by, also; for a project milestones, risks). Applied in order set, \
       add, remove; the first failure stops the rest. There is no deletion: set status to \
       dropped."
    ~input_schema:
      (T.object_ ~required:[ "id" ]
         [
           ("id", id_schema);
           ("set", T.object_ ~required:[] scalars);
           ("add", T.object_ ~required:[] lists);
           ("remove", T.object_ ~required:[] lists);
         ])
    update

let log_kinds = "progress" :: "note" :: W.Fields.task_kinds

let log args =
  let* id = Work_args.string args "id" in
  let* text = Work_args.string args "text" in
  let* kind = Work_args.opt_string args "kind" in
  let* date = Work_args.opt_string args "date" in
  let* prov = Work_args.opt_string args "prov" in
  let kind = Option.value ~default:"progress" kind in
  let* () =
    if List.mem kind log_kinds then Ok () else Error (invalid "kind must be one of %s" (String.concat ", " log_kinds))
  in
  let* request_id = Work_request.of_args args in
  let* ctx = Work_repo.context () in
  let* target = Work_link.canonical_task ctx id in
  let session = session () in
  let write () =
    let* task =
      lift
        (if kind = "note" then W.Write_task.note ctx ?session ~task:target ?prov text
         else W.Write_task.log ctx ?session ~task:target ~kind ?date ?prov text)
    in
    link ctx task;
    Ok (id_json "id" task ~extra:[ ("kind", `String kind) ])
  in
  Work_request.once ctx ~tool:"work_log" ~request_id ~session ~target ~task_of:result_id write

let log_tool =
  T.make ~name:"work_log"
    ~description:
      "Append to a task: progress (default), note, decision, learning, risk, metric, mentoring or \
       shipped (with a date). Entries are never edited. prov says how sure the fact is: stated \
       (default), inferred or confirmed. The calling session is linked to the task."
    ~input_schema:
      (T.object_ ~required:[ "id"; "text" ]
         [
           ("id", id_schema);
           ("text", text_schema);
           ("kind", T.enum log_kinds);
           ("date", T.string ~max:10 ~description:"YYYY-MM-DD, for shipped." ());
           ("prov", T.enum W.Fields.prov_values);
           ("request_id", request_id_schema);
         ])
    log

let block args =
  let* id = Work_args.string args "id" in
  let* text = Work_args.string args "text" in
  let* kind = Work_args.opt_string args "kind" in
  let* on = Work_args.opt_string args "on" in
  let* ctx = Work_repo.context () in
  let* task = Work_link.canonical_task ctx id in
  let* blocker = lift (W.Write_task.block ctx ?session:(session ()) ~task ?kind ?on text) in
  link ctx task;
  Ok (id_json "blocker" blocker ~extra:[ ("task", `String task) ])

let block_tool =
  T.make ~name:"work_block"
    ~description:
      "Open a blocker on a task and return its id (B-...). The task status does not change; set \
       it to blocked with work_update if it is."
    ~input_schema:
      (T.object_ ~required:[ "id"; "text" ]
         [
           ("id", id_schema);
           ("text", T.string ~max:500 ());
           ("kind", T.enum W.Fields.blocker_kinds);
           ("on", short);
         ])
    block

let unblock args =
  let* id = Work_args.string args "id" in
  let* blocker = Work_args.opt_string args "blocker" in
  let* text = Work_args.opt_string args "text" in
  let* ctx = Work_repo.context () in
  let* task = Work_link.canonical_task ctx id in
  let* resolved = lift (W.Write_task.unblock ctx ?session:(session ()) ~task ?blocker ?text ()) in
  link ctx task;
  Ok (id_json "blocker" resolved ~extra:[ ("task", `String task) ])

let unblock_tool =
  T.make ~name:"work_unblock"
    ~description:
      "Resolve a blocker of a task. Without blocker, the only open one; with several open, \
       the call fails and lists them."
    ~input_schema:
      (T.object_ ~required:[ "id" ]
         [ ("id", id_schema); ("blocker", T.string ~max:20 ()); ("text", T.string ~max:500 ()) ])
    unblock

let tools =
  [ add_task_tool; add_project_tool; add_product_tool; update_tool; log_tool; block_tool; unblock_tool ]
