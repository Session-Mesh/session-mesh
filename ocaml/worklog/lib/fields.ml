(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

let statuses =
  [ "inbox"; "todo"; "in_progress"; "blocked"; "waiting"; "done"; "dropped" ]

let priorities = [ "P0"; "P1"; "P2"; "P3" ]
let blocker_kinds = [ "external"; "dependency"; "decision"; "tooling"; "review"; "other" ]
let task_kinds = [ "decision"; "learning"; "risk"; "metric"; "mentoring"; "shipped" ]
let prov_values = [ "stated"; "inferred"; "confirmed" ]
let sizes = [ "S"; "M"; "L" ]
let origins = [ "planned"; "assigned"; "reactive"; "self" ]
let project_statuses = [ "active"; "done"; "dropped" ]

let task_scalars =
  [ "status"; "priority"; "due"; "title"; "product"; "project"; "track"; "owner";
    "eta"; "size"; "origin" ]

let project_scalars = [ "title"; "product"; "quarter"; "owner"; "hlp"; "goal"; "status" ]
let task_list_fields = [ "tags"; "links"; "blocked_by"; "also" ]
let project_list_fields = [ "milestones"; "risks" ]
let task_clearable = [ "due"; "eta"; "track"; "size"; "origin"; "project"; "owner" ]
let project_clearable = [ "quarter"; "owner"; "hlp"; "goal" ]

let hex_id prefix ~min s =
  let n = String.length s in
  n >= 2 + min
  && String.sub s 0 2 = prefix
  && String.for_all
       (fun c -> (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))
       (String.sub s 2 (n - 2))

let valid_task_id = hex_id "T-" ~min:4
let valid_project_id = hex_id "P-" ~min:4
let valid_blocker_id = hex_id "B-" ~min:1

let valid_quarter s =
  String.length s = 6
  && String.for_all (fun c -> c >= '0' && c <= '9') (String.sub s 0 4)
  && s.[4] = 'Q'
  && s.[5] >= '1'
  && s.[5] <= '4'

let enum_error field value allowed =
  if List.mem value allowed then None
  else Some (Printf.sprintf "%s must be one of %s" field (String.concat ", " allowed))

let date_error field value =
  if Tstamp.valid_date value then None
  else Some (field ^ " must be a date YYYY-MM-DD")

(* Checks of the string forms of a scalar; [shared] covers both entities. *)
let task_string_error field value =
  match field with
  | "status" -> enum_error field value statuses
  | "priority" -> enum_error field value priorities
  | "size" -> enum_error field value sizes
  | "origin" -> enum_error field value origins
  | "due" | "eta" -> date_error field value
  | "title" -> Textcheck.title_error value
  | "project" ->
      if valid_project_id value then None
      else Some "project must be a project id P-<hex>"
  | _ -> Textcheck.text_error ~field ~limit:100 value

let task_scalar_error field (v : Yojson.Safe.t) =
  if not (List.mem field task_scalars) then
    Some (Printf.sprintf "unknown scalar field %S" field)
  else
    match v with
    | `Null when List.mem field task_clearable -> None
    | `String s -> task_string_error field s
    | _ -> Some (field ^ " must be a string")

let project_string_error field value =
  match field with
  | "status" -> enum_error field value project_statuses
  | "quarter" ->
      if valid_quarter value then None else Some "quarter must be YYYYQ1..Q4"
  | "title" -> Textcheck.title_error value
  | "hlp" | "goal" -> Textcheck.text_error ~field ~limit:500 value
  | _ -> Textcheck.text_error ~field ~limit:100 value

let project_scalar_error field (v : Yojson.Safe.t) =
  if not (List.mem field project_scalars) then
    Some (Printf.sprintf "unknown scalar field %S" field)
  else
    match v with
    | `Null when List.mem field project_clearable -> None
    | `String s -> project_string_error field s
    | _ -> Some (field ^ " must be a string")

let task_item_error field (v : Yojson.Safe.t) =
  match v with
  | `String s when field = "also" ->
      if Textcheck.valid_name s then None else Some "also value must be a product name"
  | `String s ->
      if Textcheck.is_blank s then Some (field ^ " value must be a non-empty string")
      else if Textcheck.has_control s then
        Some (field ^ " value must not contain control characters")
      else if Textcheck.length s > 500 then
        Some (field ^ " value must be at most 500 characters")
      else None
  | _ ->
      if field = "also" then Some "also value must be a product name"
      else Some (field ^ " value must be a non-empty string")

let project_item_error field (v : Yojson.Safe.t) =
  match v with
  | `String s -> Textcheck.text_error ~field:(field ^ " value") ~limit:500 s
  | _ -> Some (field ^ " value must be a string")

let kind_error ~kind ~(text : Yojson.Safe.t option) ~(date : Yojson.Safe.t option) =
  match text with
  | Some (`String t) when not (Textcheck.is_blank t) -> (
      if kind <> "shipped" then None
      else
        match date with
        | Some (`String d) when Tstamp.valid_date d -> None
        | _ -> Some "date must be a date YYYY-MM-DD")
  | _ -> Some "text must be a non-empty string"
