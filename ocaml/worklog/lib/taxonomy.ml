(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

type category = {
  key : string;
  name : string;
  products : string list;
  uses_projects_key : bool;
}

type t = {
  categories : category list;
  entries : (string * string option * string) list;
}

exception Invalid of string

let invalid fmt = Printf.ksprintf (fun m -> raise (Invalid m)) fmt

(* A product id: a string scalar with the name rules, not typed by YAML. *)
let id_of_scalar ~category = function
  | Yaml_lite.Scalar { text; quoted } ->
      if (quoted || Yaml_lite.is_plain_string text) && Textcheck.valid_name text then text
      else invalid "bad product id %S in category %S" text category
  | _ -> invalid "bad product id in category %S" category

let children_of_item ~category = function
  | Yaml_lite.Seq children ->
      List.map
        (function
          | Yaml_lite.Scalar _ as s -> id_of_scalar ~category s
          | _ -> invalid "product tree in %S is deeper than 2 levels" category)
        children
  | _ -> invalid "children in %S must be a list" category

(* (id, parent, category) entries of one list item: roots, then their children. *)
let entries_of_item ~category = function
  | Yaml_lite.Scalar _ as s -> [ (id_of_scalar ~category s, None, category) ]
  | Yaml_lite.Map { fields = [ (root, sub) ]; typed_keys } ->
      let root =
        id_of_scalar ~category (Yaml_lite.Scalar { text = root; quoted = not (List.mem root typed_keys) })
      in
      (root, None, category)
      :: List.map (fun c -> (c, Some root, category)) (children_of_item ~category sub)
  | Yaml_lite.Map _ -> invalid "product item in %S must have exactly one key" category
  | _ -> invalid "bad product item in %S" category

let category_name ~key = function
  | Yaml_lite.Scalar { text; quoted } when String.trim text <> "" && (quoted || Yaml_lite.is_plain_string text) -> text
  | _ -> invalid "category %S needs a non-empty 'name'" key

let parse_category key body =
  if not (Textcheck.valid_name key) then invalid "bad category key %S" key;
  let fields = match body with Yaml_lite.Map { fields; _ } -> fields | _ -> invalid "category %S must be a mapping" key in
  let name = category_name ~key (Option.value (List.assoc_opt "name" fields) ~default:Yaml_lite.Null) in
  let products = List.assoc_opt "products" fields and projects = List.assoc_opt "projects" fields in
  let list, uses_projects_key =
    match (products, projects) with
    | Some _, Some _ -> invalid "category %S has both 'projects' and 'products'" key
    | Some l, None -> (l, false)
    | None, Some l -> (l, true)
    | None, None -> invalid "category %S needs a 'projects' or 'products' list" key
  in
  let items = match list with Yaml_lite.Seq l -> l | _ -> invalid "category %S needs a list of products" key in
  if uses_projects_key && List.exists (function Yaml_lite.Map _ -> true | _ -> false) items then
    invalid "legacy 'projects' list of %S holds a mapping" key;
  let entries = List.concat_map (entries_of_item ~category:key) items in
  let roots = List.filter_map (fun (id, parent, _) -> if parent = None then Some id else None) entries in
  let kids = List.filter_map (fun (id, parent, _) -> if parent <> None then Some id else None) entries in
  ({ key; name; products = roots @ kids; uses_projects_key }, entries)

let check_unique entries =
  let seen = Hashtbl.create 32 in
  List.iter
    (fun (id, _, category) ->
      match Hashtbl.find_opt seen id with
      | Some other -> invalid "product %S is in both %S and %S" id other category
      | None -> Hashtbl.add seen id category)
    entries

let build doc =
  let top = match doc with Yaml_lite.Map { fields; _ } -> fields | _ -> invalid "expected a top-level 'categories:' mapping" in
  let categories =
    match List.assoc_opt "categories" top with
    | Some (Yaml_lite.Map { fields; typed_keys }) ->
        List.iter (fun k -> invalid "bad category key %S" k) typed_keys;
        fields
    | Some _ -> invalid "'categories' must be a mapping"
    | None -> invalid "expected a top-level 'categories:' mapping"
  in
  let parsed = List.map (fun (key, body) -> parse_category key body) categories in
  let entries = List.concat_map snd parsed in
  check_unique entries;
  { categories = List.map fst parsed; entries }

let of_string text =
  match Yaml_lite.parse text with
  | Error why -> Error ("not valid YAML: " ^ why)
  | Ok doc -> ( try Ok (build doc) with Invalid why -> Error why)

let read_file path =
  match Safefs.read_file_following ~limit:Safefs.max_taxonomy_bytes path with
  | text -> text
  | exception Unix.Unix_error ((Unix.ENOENT | Unix.ENOTDIR), _, _) ->
      Err.fail Err.Repo ("taxonomy.yaml not found: " ^ path)

let load path =
  Err.protect (fun () ->
      match of_string (read_file path) with
      | Ok t -> t
      | Error why -> Err.usage "invalid taxonomy %s: %s" path why)

let entry t id = List.find_opt (fun (i, _, _) -> i = id) t.entries
let category_of t id = Option.map (fun (_, _, c) -> c) (entry t id)
let parent_of t id = Option.bind (entry t id) (fun (_, p, _) -> p)
let has_product t id = entry t id <> None
let products t = List.map (fun (id, _, _) -> id) t.entries

let root_of t id =
  match entry t id with Some (_, parent, _) -> Some (Option.value parent ~default:id) | None -> None

let children_of t id =
  List.filter_map (fun (c, parent, _) -> if parent = Some id then Some c else None) t.entries

let descendants t id = if has_product t id then id :: children_of t id else []
