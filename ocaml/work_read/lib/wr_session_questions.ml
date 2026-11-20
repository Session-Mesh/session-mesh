(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

module W = Mesh_worklog
module R = Work_mcp.Work_render
module Q = Work_mcp.Work_questions

let max_sessions = 500
let max_questions = 20
let add_unique x l = if List.mem x l then l else x :: l

(* The names of the sessions linked to some task of each project. *)
let project_sessions (world : W.Model.world) =
  let table = Hashtbl.create 16 in
  W.Model.Smap.iter
    (fun _ (t : W.Model.task) ->
      match t.project_id with
      | None -> ()
      | Some p ->
          let names = Option.value ~default:[] (Hashtbl.find_opt table p) in
          Hashtbl.replace table p
            (List.fold_left
               (fun acc (l : W.Model.session_link) -> add_unique l.session acc)
               names t.sessions))
    world.tasks;
  table

(* The project a question is about (directly, or through its task) and the
   sessions it belongs to: its asker, the sessions linked to its task, the
   sessions linked to a task of the project it is about. *)
let resolve (world : W.Model.world) projects (q : Q.question) =
  let asker = Option.to_list q.session in
  let of_project p = Option.value ~default:[] (Hashtbl.find_opt projects p) in
  match q.about with
  | Some id when W.Model.Smap.mem id world.tasks ->
      let t = W.Model.Smap.find id world.tasks in
      ( t.project_id,
        asker
        @ List.map (fun (l : W.Model.session_link) -> l.session) t.sessions )
  | Some id when W.Model.Smap.mem id world.projects ->
      (Some id, asker @ of_project id)
  | _ -> (None, asker)

type entry = { newest : int; questions : Yojson.Safe.t list (* newest last *) }

let question_json (q : Q.question) project =
  `Assoc
    ([ ("id", R.tstr ~max:40 q.id) ]
    @ R.opt_tstr ~max:40 "about" q.about
    @ R.opt_tstr ~max:40 "project" project)

(* Every open question, newest first, added once to each of its sessions. *)
let collect (loaded : Wr_load.t) opened =
  let world = Wr_load.world loaded in
  let projects = project_sessions world and table = Hashtbl.create 16 in
  List.iter
    (fun (q : Q.question) ->
      let project, names = resolve world projects q in
      let item = question_json q project in
      List.iter
        (fun name ->
          match Hashtbl.find_opt table name with
          | None ->
              Hashtbl.replace table name
                { newest = q.asked_at; questions = [ item ] }
          | Some e ->
              Hashtbl.replace table name
                { e with questions = item :: e.questions })
        (List.sort_uniq compare names))
    (Wr_questions.ordered opened);
  Hashtbl.fold (fun name e acc -> (name, e) :: acc) table []
  |> List.sort (fun (a, ea) (b, eb) -> compare (eb.newest, a) (ea.newest, b))

let session_json (name, e) =
  let questions = List.rev e.questions in
  `Assoc
    ([
       ("name", R.tstr ~max:100 name);
       ("open_questions", `Int (List.length questions));
     ]
    @ Wr_out.list "questions" max_questions questions)

let run (loaded : Wr_load.t) =
  let opened = List.filter Q.is_open loaded.questions in
  let sessions = collect loaded opened in
  Ok
    (Wr_out.document "session-questions"
       ([ ("open_questions", `Int (List.length opened)) ]
       @ Wr_out.list "sessions" max_sessions (List.map session_json sessions)
       @ [ ("total", `Int (List.length sessions)) ]
       @ Wr_load.warnings_json loaded))
