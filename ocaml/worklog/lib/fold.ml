(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

open Model

type warn = string -> unit

let common = [ "ts"; "task"; "type"; "agent"; "session"; "prov"; "proposal" ]

let known_fields = function
  | "created" -> [ "title"; "project"; "category"; "priority"; "status" ]
  | "set" -> [ "field"; "to"; "category" ]
  | "add" | "remove" -> [ "field"; "value" ]
  | "progress" | "note" | "decision" | "learning" | "risk" | "metric"
  | "mentoring" -> [ "text" ]
  | "shipped" -> [ "text"; "date" ]
  | "session_linked" -> [ "cwd"; "host"; "repo"; "branch" ]
  | "blocker" -> [ "id"; "kind"; "on"; "text" ]
  | "unblocked" -> [ "blocker"; "text" ]
  | "project_created" -> [ "title"; "product"; "category" ]
  | _ -> []

let task_types =
  [ "created"; "set"; "add"; "remove"; "progress"; "note"; "session_linked";
    "blocker"; "unblocked" ]
  @ Fields.task_kinds

let proposal_types = [ "proposed"; "accepted"; "rejected"; "amended" ]

let starts_with prefix s =
  String.length s >= String.length prefix
  && String.sub s 0 (String.length prefix) = prefix

(* Warnings common to every applied event: unknown fields (once per file and
   key) and an invalid provenance. *)
let note_event reported warn (ev : Event.t) =
  let allowed = common @ known_fields ev.typ in
  List.iter
    (fun (key, _) ->
      if (not (List.mem key allowed)) && not (Hashtbl.mem reported (ev.file, key)) then begin
        Hashtbl.add reported (ev.file, key) ();
        warn
          (Printf.sprintf "%s: ignoring unknown field %S on %s events" (Event.where ev) key
             ev.typ)
      end)
    (List.sort_uniq (fun (a, _) (b, _) -> String.compare a b) ev.data);
  match Event.get ev "prov" with
  | Some (`String p) when List.mem p Fields.prov_values -> ()
  | None -> ()
  | Some v ->
      warn
        (Printf.sprintf "%s: invalid prov %s on %s event; read as 'stated'"
           (Event.where ev) (Yojson.Safe.to_string v) ev.typ)

let touch_task (t : task) (ev : Event.t) =
  t.timeline <- ev :: t.timeline;
  match t.last_ts with
  | Some last when last >= ev.ts -> ()
  | _ -> t.last_ts <- Some ev.ts

let touch_project (p : project) (ev : Event.t) =
  p.timeline_p <- ev :: p.timeline_p;
  match p.last_ts_p with
  | Some last when last >= ev.ts -> ()
  | _ -> p.last_ts_p <- Some ev.ts

type state = {
  tasks : (string, task) Hashtbl.t;
  projects : (string, project) Hashtbl.t;
  task_winner : (string, Event.t) Hashtbl.t;
  project_winner : (string, Event.t) Hashtbl.t;
  reported : (string * string, unit) Hashtbl.t;
  warn : warn;
}

(* Pass 1: the earliest valid [created] / [project_created] per id. *)
let define st (ev : Event.t) =
  let duplicate = Printf.sprintf "%s: DUPLICATE_ID %s: later %s event ignored" in
  match ev.typ with
  | "created" ->
      if Hashtbl.mem st.tasks ev.task then st.warn (duplicate (Event.where ev) ev.task ev.typ)
      else
        Option.iter
          (fun t ->
            Hashtbl.replace st.tasks ev.task t;
            Hashtbl.replace st.task_winner ev.task ev)
          (Fold_task.of_created ev st.warn)
  | "project_created" ->
      if Hashtbl.mem st.projects ev.task then st.warn (duplicate (Event.where ev) ev.task ev.typ)
      else
        Option.iter
          (fun p ->
            Hashtbl.replace st.projects ev.task p;
            Hashtbl.replace st.project_winner ev.task ev)
          (Fold_project.of_created ev st.warn)
  | _ -> ()

let apply_project_event st (ev : Event.t) =
  match Hashtbl.find_opt st.projects ev.task with
  | None ->
      st.warn (Printf.sprintf "%s: event for unknown project %s ignored" (Event.where ev) ev.task)
  | Some p ->
      if List.mem ev.typ [ "set"; "add"; "remove" ] then begin
        note_event st.reported st.warn ev;
        touch_project p ev;
        Fold_project.apply p ev st.warn
      end
      else if List.mem ev.typ task_types then
        st.warn (Printf.sprintf "%s: ignoring %s on project %s" (Event.where ev) ev.typ ev.task)
      else
        st.warn (Printf.sprintf "%s: ignoring unknown event type %S" (Event.where ev) ev.typ)

let apply_project_created st (ev : Event.t) =
  match (Hashtbl.find_opt st.projects ev.task, Hashtbl.find_opt st.project_winner ev.task) with
  | Some p, Some winner when winner == ev ->
      Fold_project.reset p ev;
      note_event st.reported st.warn ev;
      touch_project p ev
  | _ -> ()

let apply_task_event st (t : task) (ev : Event.t) =
  let usable =
    if ev.typ = "created" then
      match Hashtbl.find_opt st.task_winner ev.task with
      | Some winner -> winner == ev
      | None -> false
    else if List.mem ev.typ Fields.task_kinds then
      match
        Fields.kind_error ~kind:ev.typ ~text:(Event.get ev "text") ~date:(Event.get ev "date")
      with
      | None -> true
      | Some why ->
          st.warn
            (Printf.sprintf "%s: ignoring %s on %s: %s" (Event.where ev) ev.typ t.id why);
          false
    else true
  in
  if usable then begin
    if ev.typ = "created" then Fold_task.reset t ev;
    note_event st.reported st.warn ev;
    touch_task t ev;
    Fold_task.apply t ev st.warn
  end

let apply_event st (ev : Event.t) =
  let silent_prefix = starts_with "Q-" ev.task || starts_with "product:" ev.task in
  if List.mem ev.typ proposal_types || silent_prefix then ()
  else if ev.typ = "project_created" then
    if starts_with "P-" ev.task then apply_project_created st ev
    else
      st.warn
        (Printf.sprintf "%s: ignoring project_created on task id %s" (Event.where ev) ev.task)
  else if starts_with "P-" ev.task then (if ev.typ <> "created" then apply_project_event st ev)
  else
    match Hashtbl.find_opt st.tasks ev.task with
    | None ->
        if ev.typ <> "created" then
          st.warn
            (Printf.sprintf "%s: event for unknown task %s ignored" (Event.where ev) ev.task)
    | Some t ->
        if List.mem ev.typ task_types then apply_task_event st t ev
        else
          st.warn (Printf.sprintf "%s: ignoring unknown event type %S" (Event.where ev) ev.typ)

let finish st =
  let tasks =
    Hashtbl.fold
      (fun id (t : task) acc ->
        t.timeline <- List.rev t.timeline;
        t.sessions <- List.rev t.sessions;
        t.blockers <- List.rev t.blockers;
        Smap.add id t acc)
      st.tasks Smap.empty
  in
  let projects =
    Hashtbl.fold
      (fun id (p : project) acc ->
        p.timeline_p <- List.rev p.timeline_p;
        Smap.add id p acc)
      st.projects Smap.empty
  in
  { tasks; projects }

let fold events warn =
  let st =
    {
      tasks = Hashtbl.create 64; projects = Hashtbl.create 16;
      task_winner = Hashtbl.create 64; project_winner = Hashtbl.create 16;
      reported = Hashtbl.create 16; warn;
    }
  in
  let ordered = List.stable_sort Event.compare events in
  List.iter (define st) ordered;
  List.iter (apply_event st) ordered;
  finish st
