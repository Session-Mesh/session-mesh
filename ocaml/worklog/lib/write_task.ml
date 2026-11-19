(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

open Model

type outcome = Changed | Unchanged

let str s : Yojson.Safe.t = `String s
let set_event id field value = (id, "set", [ ("field", str field); ("to", value) ])
let list_event typ id field value = (id, typ, [ ("field", str field); ("value", str value) ])
let session_id (tx : Txn.t) = Option.bind tx.session (fun (s : Session.t) -> s.session)

(* ---- add --------------------------------------------------------------- *)

let strip_field field v =
  if field = "title" || field = "track" || field = "owner" then Textcheck.strip v else v

(* The optional scalars of a new task, validated, in event order. *)
let new_scalars ~track ~owner ~eta ~size ~origin =
  List.filter_map
    (fun (field, v) ->
      Option.map
        (fun v ->
          let v = strip_field field v in
          Validate.check (Fields.task_scalar_error field (str v));
          (field, v))
        v)
    [ ("track", track); ("owner", owner); ("eta", eta); ("size", size); ("origin", origin) ]

let dedupe l = List.fold_left (fun acc x -> if List.mem x acc then acc else acc @ [ x ]) [] l

let taken_task_ids ctx (tx : Txn.t) =
  Store.task_file_hex_ids ctx
  @ List.filter_map
      (fun (e : Event.t) ->
        if e.typ = "created" && String.length e.task > 2 then
          Some (String.lowercase_ascii (String.sub e.task 2 (String.length e.task - 2)))
        else None)
      tx.loaded.events

let created_items ~id ~title ~product ~category ~priority ~status =
  [ ( id, "created",
      [ ("title", str title); ("project", str product); ("category", str category);
        ("priority", str priority); ("status", str status) ] ) ]

let add ctx ?session ~title ~product ?(priority = "P2") ?(status = "todo") ?due ?(tags = [])
    ?(links = []) ?project ?track ?owner ?eta ?size ?origin ?(also = []) ?notes () =
  Txn.run ctx ?session (fun tx ->
      let title = Textcheck.strip title in
      Validate.check (Textcheck.title_error title);
      Validate.check (Fields.task_scalar_error "priority" (str priority));
      Validate.check (Fields.task_scalar_error "status" (str status));
      Option.iter (fun d -> Validate.check (Fields.task_scalar_error "due" (str d))) due;
      let scalars = new_scalars ~track ~owner ~eta ~size ~origin in
      let also = dedupe also in
      List.iter (fun a -> Validate.check (Fields.task_item_error "also" (str a))) also;
      List.iter (fun v -> Validate.check (Fields.task_item_error "tags" (str v))) tags;
      List.iter (fun v -> Validate.check (Fields.task_item_error "links" (str v))) links;
      let notes = match notes with Some n -> Validate.text ~what:"notes" n | None -> "" in
      let category = Validate.product_category ctx product in
      List.iter (fun a -> ignore (Validate.product_category ctx a)) also;
      let project_id = Option.map (Validate.project_id tx) project in
      let id = Ids.task ctx.rng ~taken:(taken_task_ids ctx tx) in
      let slug = Textcheck.slugify title in
      let name = if slug = "" then id ^ ".md" else Printf.sprintf "%s-%s.md" id slug in
      let path = Filename.concat (Filename.concat (Ctx.tasks_dir ctx) product) name in
      let content =
        Store.render_task_file ~id ~product ~category ~created:(Tstamp.format tx.now) ~notes
      in
      let items =
        created_items ~id ~title ~product ~category ~priority ~status
        @ (match due with Some d -> [ set_event id "due" (str d) ] | None -> [])
        @ (match project_id with Some p -> [ set_event id "project" (str p) ] | None -> [])
        @ List.map (fun (f, v) -> set_event id f (str v)) scalars
        @ List.map (list_event "add" id "tags") tags
        @ List.map (list_event "add" id "links") links
        @ List.map (list_event "add" id "also") also
      in
      let write_events = Txn.prepare tx items in
      Appendfile.create_exclusive ~root:ctx.root path content;
      Txn.touch tx path;
      write_events ();
      Txn.commit tx ~cmd:"add" ~subject:(Some id);
      id)

(* ---- set --------------------------------------------------------------- *)

let current_scalar (t : task) = function
  | "status" -> Some t.status
  | "priority" -> Some t.priority
  | "title" -> Some t.title
  | "due" -> t.due
  | "product" -> Some t.product
  | "project" -> t.project_id
  | "track" -> t.track
  | "owner" -> Some t.owner
  | "eta" -> t.eta
  | "size" -> t.size
  | _ -> t.origin

let nullable = [ "due"; "project"; "track"; "owner"; "eta"; "size"; "origin" ]

(* The validated target of a [set]: the JSON value, the value to compare with
   the current one, and extra event fields (the category of a product). *)
let set_target ctx tx ~field ~value =
  if not (List.mem field Fields.task_scalars) then Err.usage "unknown field %S" field;
  let value = Option.map (strip_field field) value in
  if value = None && not (List.mem field nullable) then Err.usage "%s cannot be cleared" field;
  let value =
    match (field, value) with
    | "project", Some r -> Some (Validate.project_id tx r)
    | _ -> value
  in
  let extra =
    if field = "product" then begin
      let p = Option.get value in
      if not (Textcheck.valid_name p) then Err.usage "invalid product name %S" p;
      [ ("category", str (Validate.product_category ctx p)) ]
    end
    else []
  in
  let json = Validate.json_of_option value in
  Validate.check (Fields.task_scalar_error field json);
  ((json, (if field = "owner" && value = None then Some "me" else value)), extra)

let command_of_field = function "status" -> "status" | "priority" -> "priority" | _ -> "set"

let set ctx ?session ~task ~field ~value () =
  Txn.run ctx ?session (fun tx ->
      let (json, effective), extra = set_target ctx tx ~field ~value in
      let t = Validate.task tx task in
      if current_scalar t field = effective then (t.id, Unchanged)
      else begin
        Txn.append tx [ (t.id, "set", [ ("field", str field); ("to", json) ] @ extra) ];
        Txn.commit tx ~cmd:(command_of_field field) ~subject:(Some t.id);
        (t.id, Changed)
      end)

(* ---- list items -------------------------------------------------------- *)

let current_list (t : task) = function
  | "tags" -> t.tags
  | "links" -> t.links
  | "blocked_by" -> t.blocked_by
  | _ -> t.also

let check_list_field field =
  if not (List.mem field Fields.task_list_fields) then Err.usage "unknown list field %S" field

let item_value ctx tx (t : task) ~field ~adding value =
  let value = Textcheck.strip value in
  match field with
  | "blocked_by" -> (
      match Refs.task tx.Txn.loaded.world value with
      | Ok id ->
          if adding && id = t.id then Err.usage "a task cannot be blocked_by itself";
          id
      | Error _ when not adding -> value
      | Error e -> raise (Err.E e))
  | "also" ->
      Validate.check (Fields.task_item_error field (str value));
      if adding then ignore (Validate.product_category ctx value);
      value
  | _ ->
      Validate.check (Fields.task_item_error field (str value));
      value

let add_item ctx ?session ~task ~field ~value () =
  Txn.run ctx ?session (fun tx ->
      check_list_field field;
      let t = Validate.task tx task in
      let value = item_value ctx tx t ~field ~adding:true value in
      if List.mem value (current_list t field) then (t.id, Unchanged)
      else begin
        Txn.append tx [ list_event "add" t.id field value ];
        Txn.commit tx ~cmd:"add-item" ~subject:(Some t.id);
        (t.id, Changed)
      end)

let remove_item ctx ?session ~task ~field ~value () =
  Txn.run ctx ?session (fun tx ->
      check_list_field field;
      let t = Validate.task tx task in
      let value = item_value ctx tx t ~field ~adding:false value in
      if not (List.mem value (current_list t field)) then
        Err.usage "%S is not in %s of %s" value field t.id;
      Txn.append tx [ list_event "remove" t.id field value ];
      Txn.commit tx ~cmd:"rm-item" ~subject:(Some t.id);
      t.id)

(* ---- text events, blockers, sessions ----------------------------------- *)

let link_event (tx : Txn.t) id (s : Session.t) =
  ( id, "session_linked",
    [ ("agent", str s.agent);
      ("session", Validate.json_of_option s.session);
      ("cwd", Validate.json_of_option s.cwd);
      ("host", str tx.ctx.host);
      ("repo", Validate.json_of_option s.repo);
      ("branch", Validate.json_of_option s.branch) ] )

let is_linked (t : task) (s : Session.t) =
  List.exists (fun (l : session_link) -> l.agent = s.agent && Some l.session = s.session) t.sessions

let auto_link tx (t : task) =
  match tx.Txn.session with
  | Some s when s.session <> None && not (is_linked t s) -> [ link_event tx t.id s ]
  | _ -> []

let log_payload tx ~kind ~date ~prov text =
  if date <> None && kind <> "shipped" then Err.usage "date applies only to the shipped kind";
  Option.iter (fun d -> Validate.check (if Tstamp.valid_date d then None else Some "date must be a date YYYY-MM-DD")) date;
  let date_field =
    if kind = "shipped" then [ ("date", str (Option.value date ~default:(Validate.today tx))) ] else []
  in
  [ ("text", str text) ] @ date_field @ Validate.prov prov

let log ctx ?session ~task ?(kind = "progress") ?date ?prov text =
  Txn.run ctx ?session (fun tx ->
      let text = Validate.text ~what:"text" text in
      if not (List.mem kind ("progress" :: Fields.task_kinds)) then Err.usage "unknown kind %S" kind;
      let payload = log_payload tx ~kind ~date ~prov text in
      let t = Validate.task tx task in
      Txn.append tx (auto_link tx t @ [ (t.id, kind, payload) ]);
      Txn.commit tx ~cmd:"log" ~subject:(Some t.id);
      t.id)

let note ctx ?session ~task ?prov text =
  Txn.run ctx ?session (fun tx ->
      let text = Validate.text ~what:"text" text in
      let payload = [ ("text", str text) ] @ Validate.prov prov in
      let t = Validate.task tx task in
      Txn.append tx [ (t.id, "note", payload) ];
      Txn.commit tx ~cmd:"note" ~subject:(Some t.id);
      t.id)

let existing_blocker_ids (tx : Txn.t) =
  List.filter_map
    (fun (e : Event.t) ->
      match (e.typ, Event.get_string e "id") with
      | "blocker", Some id when String.length id > 2 ->
          Some (String.lowercase_ascii (String.sub id 2 (String.length id - 2)))
      | _ -> None)
    tx.loaded.events

let block ctx ?session ~task ?(kind = "other") ?on text =
  Txn.run ctx ?session (fun tx ->
      let text = Validate.text ~what:"text" text in
      let on = Option.map (Validate.text ~what:"on") on in
      if not (List.mem kind Fields.blocker_kinds) then
        Err.usage "kind must be one of %s" (String.concat ", " Fields.blocker_kinds);
      let t = Validate.task tx task in
      let bid = Ids.blocker ctx.rng ~taken:(existing_blocker_ids tx) in
      let on_field = match on with Some o -> [ ("on", str o) ] | None -> [] in
      Txn.append tx
        [ (t.id, "blocker", [ ("id", str bid); ("kind", str kind) ] @ on_field @ [ ("text", str text) ]) ];
      Txn.commit tx ~cmd:"blocker" ~subject:(Some t.id);
      bid)

let unblock ctx ?session ~task ?blocker ?text () =
  Txn.run ctx ?session (fun tx ->
      let text = Option.map (Validate.text ~what:"text") text in
      let t = Validate.task tx task in
      let target = Err.unwrap (Refs.open_blocker t blocker) in
      let text_field = match text with Some x -> [ ("text", str x) ] | None -> [] in
      Txn.append tx [ (t.id, "unblocked", ("blocker", str target.blocker_id) :: text_field) ];
      Txn.commit tx ~cmd:"unblock" ~subject:(Some t.id);
      target.blocker_id)

let link ctx ?session ~task () =
  Txn.run ctx ?session (fun tx ->
      let s =
        match tx.session with
        | Some s when s.session <> None -> s
        | _ -> Err.usage "no session to link: pass an agent and a session id"
      in
      let t = Validate.task tx task in
      if is_linked t s then (t.id, Unchanged)
      else begin
        Txn.append tx [ link_event tx t.id s ];
        Txn.commit tx ~cmd:"link" ~subject:(Some t.id);
        (t.id, Changed)
      end)
