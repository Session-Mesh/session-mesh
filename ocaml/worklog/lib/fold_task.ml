(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

open Model

type warn = string -> unit

let list_add v l = if List.mem v l then l else List.sort String.compare (v :: l)
let list_remove v l = List.filter (fun x -> x <> v) l

let json_string ev key =
  match Event.get ev key with Some (`String s) -> Some s | _ -> None

let of_created (ev : Event.t) warn =
  let str key = json_string ev key in
  let nonempty key = match str key with Some s when s <> "" -> Some s | _ -> None in
  let scalar key =
    let v = Option.value (Event.get ev key) ~default:`Null in
    Fields.task_scalar_error key v
  in
  let problem =
    match (nonempty "project", nonempty "category") with
    | None, _ -> Some "project missing"
    | _, None -> Some "category missing"
    | Some name, Some _ ->
        if not (Fields.valid_task_id ev.task) then Some "task id is not T-<hex>"
        else if not (Textcheck.name_chars_ok name) then
          Some "project name has unsafe characters"
        else if not (Textcheck.valid_name name) then
          Some "project name is longer than 100 characters"
        else List.find_map scalar [ "title"; "priority"; "status" ]
  in
  match (problem, nonempty "project", nonempty "category") with
  | None, Some product, Some category ->
      let get key = Option.value (str key) ~default:"" in
      Some
        {
          id = ev.task; home_product = product; home_category = category;
          created = get "ts"; product; category; title = get "title";
          status = get "status"; priority = get "priority"; due = None;
          tags = []; links = []; blocked_by = []; also = []; project_id = None;
          track = None; owner = "me"; eta = None; size = None; origin = None;
          last_ts = None; last_note = None; sessions = []; blockers = [];
          timeline = [];
        }
  | _ ->
      warn
        (Printf.sprintf "%s: ignoring invalid created event for %s: %s"
           (Event.where ev) ev.task
           (Option.value problem ~default:"invalid"));
      None

let reset t (ev : Event.t) =
  let get key = Option.value (json_string ev key) ~default:"" in
  t.title <- get "title";
  t.status <- get "status";
  t.priority <- get "priority";
  t.due <- None;
  t.tags <- [];
  t.links <- [];
  t.blocked_by <- [];
  t.also <- [];
  t.product <- t.home_product;
  t.category <- t.home_category;
  t.project_id <- None;
  t.track <- None;
  t.owner <- "me";
  t.eta <- None;
  t.size <- None;
  t.origin <- None

let opt_of_json : Yojson.Safe.t -> string option = function
  | `String s -> Some s
  | _ -> None

let set_scalar t field (to_ : Yojson.Safe.t) =
  let value = opt_of_json to_ in
  let required () = Option.value value ~default:"" in
  match field with
  | "status" -> t.status <- required ()
  | "priority" -> t.priority <- required ()
  | "title" -> t.title <- required ()
  | "due" -> t.due <- value
  | "project" -> t.project_id <- value
  | "track" -> t.track <- value
  | "owner" -> t.owner <- Option.value value ~default:"me"
  | "eta" -> t.eta <- value
  | "size" -> t.size <- value
  | _ -> t.origin <- value

let settable = [ "status"; "priority"; "due"; "title"; "project"; "track"; "owner"; "eta"; "size"; "origin" ]

let name_pair_error (ev : Event.t) =
  let ok key =
    match json_string ev key with Some s -> Textcheck.valid_name s | None -> false
  in
  if not (ok "to") then Some "product must be a name (letters, digits, . _ -)"
  else if not (ok "category") then Some "product needs a category name"
  else None

let apply_set t (ev : Event.t) warn =
  let field = Option.value (json_string ev "field") ~default:"" in
  let to_ = Option.value (Event.get ev "to") ~default:`Null in
  let refuse why = warn (Printf.sprintf "%s: ignoring set %s: %s" (Event.where ev) field why) in
  if field = "product" then
    match
      (Fields.task_scalar_error "product" to_, name_pair_error ev)
    with
    | Some why, _ | None, Some why -> refuse why
    | None, None ->
        t.product <- Option.value (opt_of_json to_) ~default:t.product;
        t.category <- Option.value (json_string ev "category") ~default:t.category
  else if not (List.mem field settable) then
    warn
      (Printf.sprintf "%s: ignoring set of unregistered field %S" (Event.where ev) field)
  else
    match Fields.task_scalar_error field to_ with
    | Some why -> refuse why
    | None -> set_scalar t field to_

let apply_list t (ev : Event.t) warn =
  let field = Option.value (json_string ev "field") ~default:"" in
  let value = Option.value (Event.get ev "value") ~default:`Null in
  if field = "linear" then () (* Linear refs are not part of this library *)
  else if not (List.mem field Fields.task_list_fields) then
    warn
      (Printf.sprintf "%s: ignoring %s of unregistered field %S" (Event.where ev)
         ev.typ field)
  else
    match (Fields.task_item_error field value, opt_of_json value) with
    | Some why, _ ->
        warn (Printf.sprintf "%s: ignoring %s %s: %s" (Event.where ev) ev.typ field why)
    | None, None -> ()
    | None, Some v ->
        let change = if ev.typ = "add" then list_add v else list_remove v in
        (match field with
        | "tags" -> t.tags <- change t.tags
        | "links" -> t.links <- change t.links
        | "blocked_by" -> t.blocked_by <- change t.blocked_by
        | _ -> t.also <- change t.also)

let apply_link t (ev : Event.t) warn =
  match (json_string ev "agent", json_string ev "session") with
  | Some agent, Some session ->
      if not (List.exists (fun (s : session_link) -> s.agent = agent && s.session = session) t.sessions)
      then
        t.sessions <-
          {
            agent; session; cwd = json_string ev "cwd";
            link_host = json_string ev "host"; repo = json_string ev "repo";
            branch = json_string ev "branch"; linked_at = ev.ts;
          }
          :: t.sessions
  | _ ->
      warn
        (Printf.sprintf "%s: ignoring session_linked without agent and session"
           (Event.where ev))

let apply_blocker t (ev : Event.t) warn =
  let ignore_ why = warn (Printf.sprintf "%s: ignoring blocker %s" (Event.where ev) why) in
  let bid = json_string ev "id" and kind = json_string ev "kind" in
  match (bid, kind, json_string ev "text") with
  | Some id, _, _ when not (Fields.valid_blocker_id id) -> ignore_ ("with bad id " ^ id)
  | Some id, Some k, _ when not (List.mem k Fields.blocker_kinds) ->
      ignore_ (id ^ " with bad kind " ^ k)
  | Some id, _, (None | Some "") -> ignore_ (id ^ " without text")
  | Some id, Some k, Some text when not (Textcheck.is_blank text) ->
      if List.exists (fun b -> b.blocker_id = id) t.blockers then
        ignore_ ("duplicate id " ^ id)
      else
        t.blockers <-
          {
            blocker_id = id; kind = k; on = json_string ev "on"; text;
            opened = ev.ts; resolved = None; resolution = None;
          }
          :: t.blockers
  | _ -> ignore_ "with a missing or blank field"

let apply_unblocked t (ev : Event.t) warn =
  let reference = json_string ev "blocker" in
  match List.find_opt (fun b -> Some b.blocker_id = reference) t.blockers with
  | None ->
      warn
        (Printf.sprintf "%s: ignoring unblocked of unknown blocker %s on %s"
           (Event.where ev)
           (Option.value reference ~default:"?")
           t.id)
  | Some b when b.resolved = None ->
      b.resolved <- Some ev.ts;
      b.resolution <- json_string ev "text"
  | Some _ -> ()

let apply t (ev : Event.t) warn =
  match ev.typ with
  | "set" -> apply_set t ev warn
  | "add" | "remove" -> apply_list t ev warn
  | "session_linked" -> apply_link t ev warn
  | "blocker" -> apply_blocker t ev warn
  | "unblocked" -> apply_unblocked t ev warn
  | "progress" | "note" -> (
      match json_string ev "text" with Some s -> t.last_note <- Some s | None -> ())
  | _ -> ()
