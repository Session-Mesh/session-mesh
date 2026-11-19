(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

open Model

let str s : Yojson.Safe.t = `String s
let item_event typ id field value = (id, typ, [ ("field", str field); ("value", str value) ])
let lower = String.lowercase_ascii

let hex_of id = lower (String.sub id 2 (String.length id - 2))

let taken_project_ids (tx : Txn.t) =
  let world = tx.loaded.world in
  Smap.fold (fun id _ acc -> hex_of id :: acc) world.projects []
  @ Smap.fold
      (fun _ (t : task) acc -> match t.project_id with Some p -> hex_of p :: acc | None -> acc)
      world.tasks []

let check_scalars scalars =
  List.filter_map
    (fun (field, v) ->
      Option.map
        (fun v ->
          Validate.check (Fields.project_scalar_error field (str v));
          (field, v))
        v)
    scalars

let check_items field items =
  List.map
    (fun v ->
      let v = Textcheck.strip v in
      Validate.check (Fields.project_item_error field (str v));
      v)
    items

let refuse_duplicate (tx : Txn.t) ~product ~title =
  Smap.iter
    (fun _ (p : project) ->
      if p.product_p = product && lower p.title_p = lower title then
        Err.usage "project %s %S already exists in product %s" p.pid p.title_p product)
    tx.loaded.world.projects

let add ctx ?session ~title ~product ?quarter ?owner ?hlp ?goal ?(milestones = []) ?(risks = []) () =
  Txn.run ctx ?session (fun tx ->
      let title = Textcheck.strip title in
      Validate.check (Textcheck.title_error title);
      Validate.check (Fields.project_scalar_error "product" (str product));
      let scalars =
        check_scalars [ ("quarter", quarter); ("owner", owner); ("hlp", hlp); ("goal", goal) ]
      in
      let milestones = check_items "milestones" milestones and risks = check_items "risks" risks in
      let category = Validate.product_category ctx product in
      refuse_duplicate tx ~product ~title;
      let id = Ids.project ctx.rng ~taken:(taken_project_ids tx) in
      let items =
        [ (id, "project_created", [ ("title", str title); ("product", str product); ("category", str category) ]) ]
        @ List.map (fun (f, v) -> (id, "set", [ ("field", str f); ("to", str v) ])) scalars
        @ List.map (item_event "add" id "milestones") milestones
        @ List.map (item_event "add" id "risks") risks
      in
      Txn.append tx items;
      Txn.commit tx ~cmd:"project add" ~subject:(Some id);
      id)

let current_scalar (p : project) = function
  | "title" -> Some p.title_p
  | "product" -> Some p.product_p
  | "quarter" -> p.quarter
  | "owner" -> p.owner_p
  | "hlp" -> p.hlp
  | "goal" -> p.goal
  | _ -> Some p.status_p

let project_of tx reference =
  let world = tx.Txn.loaded.world in
  Smap.find (Err.unwrap (Refs.project world reference)) world.projects

let clearable = [ "quarter"; "owner"; "hlp"; "goal" ]

let set ctx ?session ~project ~field ~value () =
  Txn.run ctx ?session (fun tx ->
      if not (List.mem field Fields.project_scalars) then Err.usage "unknown project field %S" field;
      let value = if field = "title" then Option.map Textcheck.strip value else value in
      if value = None && not (List.mem field clearable) then Err.usage "%s cannot be cleared" field;
      let json = Validate.json_of_option value in
      Validate.check (Fields.project_scalar_error field json);
      let extra =
        if field = "product" then begin
          let p = Option.get value in
          if not (Textcheck.valid_name p) then Err.usage "invalid product name %S" p;
          [ ("category", str (Validate.product_category ctx p)) ]
        end
        else []
      in
      let p = project_of tx project in
      if current_scalar p field = value then (p.pid, Write_task.Unchanged)
      else begin
        Txn.append tx [ (p.pid, "set", [ ("field", str field); ("to", json) ] @ extra) ];
        Txn.commit tx ~cmd:"project set" ~subject:(Some p.pid);
        (p.pid, Write_task.Changed)
      end)

let current_list (p : project) = function "milestones" -> p.milestones | _ -> p.risks

let prepare_item field value =
  if not (List.mem field Fields.project_list_fields) then Err.usage "unknown list field %S" field;
  let value = Textcheck.strip value in
  Validate.check (Fields.project_item_error field (str value));
  value

let add_item ctx ?session ~project ~field ~value () =
  Txn.run ctx ?session (fun tx ->
      let value = prepare_item field value in
      let p = project_of tx project in
      if List.mem value (current_list p field) then (p.pid, Write_task.Unchanged)
      else begin
        Txn.append tx [ item_event "add" p.pid field value ];
        Txn.commit tx ~cmd:"project add-item" ~subject:(Some p.pid);
        (p.pid, Write_task.Changed)
      end)

let remove_item ctx ?session ~project ~field ~value () =
  Txn.run ctx ?session (fun tx ->
      let value = prepare_item field value in
      let p = project_of tx project in
      if not (List.mem value (current_list p field)) then
        Err.usage "%S is not in %s of %s" value field p.pid;
      Txn.append tx [ item_event "remove" p.pid field value ];
      Txn.commit tx ~cmd:"project rm-item" ~subject:(Some p.pid);
      p.pid)
