(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

open Model

type warn = string -> unit

let json_string (ev : Event.t) key =
  match Event.get ev key with Some (`String s) -> Some s | _ -> None

let opt_of_json : Yojson.Safe.t -> string option = function
  | `String s -> Some s
  | _ -> None

let valid_name_field ev key =
  match json_string ev key with Some s -> Textcheck.valid_name s | None -> false

let of_created (ev : Event.t) warn =
  let problem =
    if not (Fields.valid_project_id ev.task) then Some "project id is not P-<hex>"
    else
      match
        Fields.project_scalar_error "title"
          (Option.value (Event.get ev "title") ~default:`Null)
      with
      | Some why -> Some why
      | None ->
          List.find_map
            (fun key ->
              if valid_name_field ev key then None
              else Some (key ^ " must be a name (letters, digits, . _ -)"))
            [ "product"; "category" ]
  in
  match problem with
  | None ->
      let get key = Option.value (json_string ev key) ~default:"" in
      Some
        {
          pid = ev.task; title_p = get "title"; product_p = get "product";
          category_p = get "category"; created_p = get "ts"; status_p = "active";
          quarter = None; owner_p = None; hlp = None; goal = None;
          milestones = []; risks = []; last_ts_p = None; timeline_p = [];
        }
  | Some why ->
      warn
        (Printf.sprintf "%s: ignoring invalid project_created event for %s: %s"
           (Event.where ev) ev.task why);
      None

let reset p (ev : Event.t) =
  let get key = Option.value (json_string ev key) ~default:"" in
  p.title_p <- get "title";
  p.product_p <- get "product";
  p.category_p <- get "category";
  p.status_p <- "active";
  p.quarter <- None;
  p.owner_p <- None;
  p.hlp <- None;
  p.goal <- None;
  p.milestones <- [];
  p.risks <- []

let set_scalar p field value =
  let required () = Option.value value ~default:"" in
  match field with
  | "title" -> p.title_p <- required ()
  | "status" -> p.status_p <- required ()
  | "quarter" -> p.quarter <- value
  | "owner" -> p.owner_p <- value
  | "hlp" -> p.hlp <- value
  | _ -> p.goal <- value

let apply_set p (ev : Event.t) warn =
  let field = Option.value (json_string ev "field") ~default:"" in
  let to_ = Option.value (Event.get ev "to") ~default:`Null in
  let refuse why =
    warn (Printf.sprintf "%s: ignoring set %s on project %s: %s" (Event.where ev) field p.pid why)
  in
  if field = "product" then
    match
      ( Fields.project_scalar_error "product" to_,
        valid_name_field ev "to" && valid_name_field ev "category" )
    with
    | Some why, _ -> refuse why
    | None, false -> refuse "product and category must be names"
    | None, true ->
        p.product_p <- Option.value (opt_of_json to_) ~default:p.product_p;
        p.category_p <- Option.value (json_string ev "category") ~default:p.category_p
  else if not (List.mem field Fields.project_scalars) then
    warn
      (Printf.sprintf "%s: ignoring set of unregistered project field %S"
         (Event.where ev) field)
  else
    match Fields.project_scalar_error field to_ with
    | Some why -> refuse why
    | None -> set_scalar p field (opt_of_json to_)

let apply_list p (ev : Event.t) warn =
  let field = Option.value (json_string ev "field") ~default:"" in
  let value = Option.value (Event.get ev "value") ~default:`Null in
  if field = "linear" then ()
  else
    let error =
      if List.mem field Fields.project_list_fields then
        Fields.project_item_error field value
      else Some "unknown list field"
    in
    match (error, opt_of_json value) with
    | Some why, _ ->
        warn
          (Printf.sprintf "%s: ignoring %s %s on project %s: %s" (Event.where ev)
             ev.typ field p.pid why)
    | None, None -> ()
    | None, Some v ->
        let change =
          if ev.typ = "add" then Fold_task.list_add v else Fold_task.list_remove v
        in
        if field = "milestones" then p.milestones <- change p.milestones
        else p.risks <- change p.risks

let apply p (ev : Event.t) warn =
  if ev.typ = "set" then apply_set p ev warn else apply_list p ev warn
