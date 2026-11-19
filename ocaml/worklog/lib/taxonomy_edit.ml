(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

exception Unsupported of string

let unsupported fmt = Printf.ksprintf (fun m -> raise (Unsupported m)) fmt

type child = { cid : string; cindent : int }

type item = {
  id : string;
  line : int;
  indent : int;
  key_col : int;  (** column of the id token *)
  scalar_end : int;  (** column right after the id token *)
  is_map : bool;
  mutable children : child list;  (** in file order *)
  mutable last_line : int;  (** last line of the item, children included *)
}

type cat = {
  key : string;
  list_key : string;
  cat_indent : int;
  list_indent : int;
  item_indent : int;
  items : item list;
  list_last_line : int;
}

type row = { idx : int; indent : int; body : string }

type layout = { lines : string list; eol : string; cats : cat list }

(* ---- tokens ------------------------------------------------------------ *)

let name_char c =
  (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c = '.' || c = '_' || c = '-'

(* An id token at [pos], plain or quoted: (value, next index). *)
let scalar_at body pos =
  let n = String.length body in
  let run from =
    let j = ref from in
    while !j < n && name_char body.[!j] do incr j done;
    !j
  in
  if pos >= n then None
  else if body.[pos] = '"' || body.[pos] = '\'' then begin
    let j = run (pos + 1) in
    if j < n && body.[j] = body.[pos] && j > pos + 1 then Some (String.sub body (pos + 1) (j - pos - 1), j + 1)
    else None
  end
  else
    let j = run pos in
    if j > pos && (body.[pos] <> '-' && body.[pos] <> '.' && body.[pos] <> '_') then Some (String.sub body pos (j - pos), j)
    else None

let rest_ok body pos =
  let n = String.length body in
  let rest = String.sub body pos (n - pos) in
  let t = String.trim rest in
  t = "" || (t.[0] = '#' && rest <> "" && rest.[0] = ' ')

let split_lines text =
  let n = String.length text in
  let rec go start acc =
    if start >= n then List.rev acc
    else
      match String.index_from_opt text start '\n' with
      | Some i -> go (i + 1) (String.sub text start (i + 1 - start) :: acc)
      | None -> List.rev (String.sub text start (n - start) :: acc)
  in
  go 0 []

let body_of line =
  let n = String.length line in
  let n = if n > 0 && line.[n - 1] = '\n' then n - 1 else n in
  let n = if n > 0 && line.[n - 1] = '\r' then n - 1 else n in
  String.sub line 0 n

let indent_of body =
  let k = ref 0 in
  while !k < String.length body && body.[!k] = ' ' do incr k done;
  !k

let is_filler body = String.trim body = "" || (String.trim body).[0] = '#'

let check_encoding text =
  if Textcheck.code_points text = None then unsupported "not UTF-8";
  if String.length text >= 3 && String.sub text 0 3 = "\xef\xbb\xbf" then unsupported "byte order mark";
  if String.contains text '\t' then unsupported "tab character";
  let crlf = ref 0 and lf = ref 0 and cr = ref 0 in
  String.iteri
    (fun i c ->
      if c = '\n' then (if i > 0 && text.[i - 1] = '\r' then incr crlf else incr lf)
      else if c = '\r' then incr cr)
    text;
  if !cr <> !crlf then unsupported "bare carriage return";
  if !crlf > 0 && !lf > 0 then unsupported "mixed line endings";
  List.iter
    (fun sep -> if Textcheck.code_points text |> Option.get |> List.mem sep then unsupported "exotic line separator")
    [ 0x85; 0x2028; 0x2029; 0xfeff ];
  if !crlf > 0 then "\r\n" else "\n"

(* ---- scanning ---------------------------------------------------------- *)

let dash_item body =
  (* "- id", "- id:" at the line's indent: (id, key_col, scalar_end, is_map) *)
  let ind = indent_of body in
  if String.length body > ind + 1 && body.[ind] = '-' && body.[ind + 1] = ' ' then begin
    let col = ref (ind + 1) in
    while !col < String.length body && body.[!col] = ' ' do incr col done;
    match scalar_at body !col with
    | None -> None
    | Some (id, after) ->
        let is_map = after < String.length body && body.[after] = ':' in
        let tail = if is_map then after + 1 else after in
        if rest_ok body tail then Some (id, !col, after, is_map) else None
  end
  else None

let is_dash body = let ind = indent_of body in String.length body > ind && body.[ind] = '-'

let scan_item (r : row) =
  match dash_item r.body with
  | None -> unsupported "list item not supported (line %d)" (r.idx + 1)
  | Some (id, key_col, scalar_end, is_map) ->
      { id; line = r.idx; indent = r.indent; key_col; scalar_end; is_map; children = []; last_line = r.idx }

let add_child (items : item list) (r : row) =
  match List.rev items with
  | parent :: _ when parent.is_map -> (
      match dash_item r.body with
      | Some (cid, _, _, false) ->
          if r.indent < parent.key_col then unsupported "children indented less than their parent";
          (match parent.children with
          | first :: _ when first.cindent <> r.indent -> unsupported "non-uniform children indentation"
          | _ -> ());
          parent.children <- parent.children @ [ { cid; cindent = r.indent } ];
          parent.last_line <- r.idx
      | _ -> unsupported "child item not supported (line %d)" (r.idx + 1))
  | _ -> unsupported "nested line without a mapping parent (line %d)" (r.idx + 1)

type step = Stop | Item | Child

(* What a row of a list is: the end of the list, a new item, or a child of the last item. *)
let step ~i2 i3 (r : row) =
  let dash = is_dash r.body in
  match i3 with
  | None -> if r.indent < i2 || not dash then Stop else Item
  | Some ind3 ->
      if r.indent = ind3 && dash then Item
      else if r.indent > ind3 then Child
      else if r.indent = i2 && ind3 >= i2 then Stop
      else unsupported "unexpected line in a list (line %d)" (r.idx + 1)

(* Rows of one list; returns the item indent, the items and the rows left after the list. *)
let scan_list ~i2 rows =
  let i3 = ref None and items = ref [] in
  let rec go = function
    | [] -> []
    | (r : row) :: rest as all -> (
        match step ~i2 !i3 r with
        | Stop -> all
        | Item ->
            if !i3 = None then i3 := Some r.indent;
            items := !items @ [ scan_item r ];
            go rest
        | Child ->
            add_child !items r;
            go rest)
  in
  let left = go rows in
  (!i3, !items, left)

let has_prefix ~prefix s =
  String.length s >= String.length prefix && String.sub s 0 (String.length prefix) = prefix

let list_key_at ~i2 (r : row) =
  List.find_opt
    (fun k ->
      let head = String.make i2 ' ' ^ k ^ ":" in
      has_prefix ~prefix:head r.body && rest_ok r.body (String.length head))
    [ "products"; "projects" ]

let category_key (head : row) =
  match scalar_at head.body head.indent with
  | Some (k, after)
    when after < String.length head.body && head.body.[after] = ':' && rest_ok head.body (after + 1) ->
      k
  | _ -> unsupported "category line not recognised (line %d)" (head.idx + 1)

let build_cat ~key ~i1 ~i2 ~list_key (i3, items) =
  match (i3, List.rev items) with
  | Some item_indent, last :: _ ->
      { key; list_key; cat_indent = i1; list_indent = i2; item_indent; items; list_last_line = last.last_line }
  | _ -> unsupported "list of %S is empty or null" key

let rec scan_body ~key ~i1 ~i2 rows found =
  match rows with
  | [] -> found
  | (r : row) :: rest -> (
      if r.indent <> i2 then unsupported "unexpected indentation in category %S" key;
      match (list_key_at ~i2 r, found) with
      | Some list_key, None ->
          let i3, items, left = scan_list ~i2 rest in
          scan_body ~key ~i1 ~i2 left (Some (build_cat ~key ~i1 ~i2 ~list_key (i3, items)))
      | Some _, Some _ -> unsupported "category %S has two lists" key
      | None, _ ->
          if has_prefix ~prefix:(String.make i2 ' ' ^ "name:") r.body then scan_body ~key ~i1 ~i2 rest found
          else unsupported "line not recognised in category %S (line %d)" key (r.idx + 1))

let scan_category ~i1 (block : row list) =
  match block with
  | [] -> unsupported "empty category"
  | head :: body -> (
      let key = category_key head in
      let i2 = match body with r :: _ -> r.indent | [] -> unsupported "category %S has no body" key in
      match scan_body ~key ~i1 ~i2 body None with
      | Some cat -> cat
      | None -> unsupported "category %S has no list" key)

let scan text =
  let eol = check_encoding text in
  let lines = split_lines text in
  let rows =
    List.filter_map Fun.id
      (List.mapi
         (fun idx line ->
           let body = body_of line in
           if is_filler body then None else Some { idx; indent = indent_of body; body })
         lines)
  in
  match rows with
  | [] -> unsupported "empty file"
  | top :: rest ->
      if top.indent <> 0 || not (String.length top.body >= 11 && String.sub top.body 0 11 = "categories:" && rest_ok top.body 11) then
        unsupported "expected `categories:` as the first key";
      if rest = [] || List.exists (fun r -> r.indent = 0) rest then unsupported "no categories or unexpected top-level content";
      let i1 = (List.hd rest).indent in
      let blocks =
        List.fold_left
          (fun acc (r : row) ->
            if r.indent < i1 then unsupported "inconsistent category indentation"
            else if r.indent = i1 then [ r ] :: acc
            else match acc with b :: tl -> (b @ [ r ]) :: tl | [] -> [])
          [] rest
      in
      { lines; eol; cats = List.rev_map (scan_category ~i1) blocks }

let layout_entries layout =
  List.concat_map
    (fun c ->
      List.concat_map
        (fun it -> (it.id, None, c.key) :: List.map (fun ch -> (ch.cid, Some it.id, c.key)) it.children)
        c.items)
    layout.cats

(* ---- insertion --------------------------------------------------------- *)

let insert_after lines idx text eol =
  List.concat
    (List.mapi
       (fun i l ->
         if i <> idx then [ l ]
         else if String.length l > 0 && l.[String.length l - 1] = '\n' then [ l; text ^ eol ]
         else [ l ^ eol; text ])
       lines)

let child_delta layout cat =
  let from_map =
    List.find_map
      (fun c ->
        List.find_map
          (fun it -> match (it.is_map, it.children) with true, ch :: _ -> Some (ch.cindent - it.indent) | _ -> None)
          c.items)
      layout.cats
  in
  match from_map with Some d -> d | None -> cat.list_indent - cat.cat_indent + 2

let insert_text layout ~id ~category ~parent =
  let cat =
    match List.find_opt (fun c -> c.key = category) layout.cats with
    | Some c -> c
    | None -> unsupported "category %S not found" category
  in
  match parent with
  | None -> insert_after layout.lines cat.list_last_line (String.make cat.item_indent ' ' ^ "- " ^ id) layout.eol
  | Some par -> (
      if cat.list_key <> "products" then unsupported "legacy `projects:` categories take no parent";
      match List.find_opt (fun it -> it.id = par) cat.items with
      | None -> unsupported "parent %S is not a root item of %S" par category
      | Some it when it.is_map ->
          insert_after layout.lines it.last_line (String.make (List.hd it.children).cindent ' ' ^ "- " ^ id) layout.eol
      | Some it ->
          let line = List.nth layout.lines it.line in
          let body = body_of line in
          let edited = String.sub body 0 it.scalar_end ^ ":" ^ String.sub body it.scalar_end (String.length body - it.scalar_end) ^ String.sub line (String.length body) (String.length line - String.length body) in
          let lines = List.mapi (fun i l -> if i = it.line then edited else l) layout.lines in
          let indent = max (it.indent + child_delta layout cat) it.key_col in
          insert_after lines it.line (String.make indent ' ' ^ "- " ^ id) layout.eol)

(* ---- verification and checks ------------------------------------------- *)

let expected_entries (old : Taxonomy.t) ~id ~category ~parent =
  let entries = old.entries in
  let in_cat = List.filter (fun (_, _, c) -> c = category) entries in
  let anchor =
    match parent with
    | None -> List.nth in_cat (List.length in_cat - 1)
    | Some p ->
        List.nth
          (List.filter (fun (i, par, _) -> i = p || par = Some p) in_cat)
          (List.length (List.filter (fun (i, par, _) -> i = p || par = Some p) in_cat) - 1)
  in
  List.concat_map (fun e -> if e == anchor then [ e; (id, parent, category) ] else [ e ]) entries

let reserved_looking id =
  String.length id >= 3
  && String.contains "tpqbTPQB" id.[0]
  && id.[1] = '-'
  && String.for_all (fun c -> (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')) (String.sub id 2 (String.length id - 2))

let check_id id =
  if not (Textcheck.valid_name id) || String.length id > 64 then
    Error (Printf.sprintf "invalid product id %S: use [A-Za-z0-9][A-Za-z0-9._-]*, at most 64 characters" id)
  else if reserved_looking id then Error (Printf.sprintf "invalid product id %S: looks like a task, project, proposal or blocker id" id)
  else if not (Yaml_lite.is_conservative_string id) || List.mem (String.lowercase_ascii id) [ "y"; "n" ] then
    Error (Printf.sprintf "invalid product id %S: YAML would read it as a boolean, null or number" id)
  else Ok ()

let check_placement (old : Taxonomy.t) ~id ~category ~parent =
  if Taxonomy.has_product old id then Error (Printf.sprintf "product %S already exists" id)
  else if not (List.exists (fun (c : Taxonomy.category) -> c.key = category) old.categories) then
    Error (Printf.sprintf "unknown category %S" category)
  else
    match parent with
    | None -> Ok ()
    | Some p when not (Taxonomy.has_product old p) -> Error (Printf.sprintf "unknown parent product %S" p)
    | Some p when Taxonomy.category_of old p <> Some category -> Error (Printf.sprintf "parent %S is not in category %S" p category)
    | Some p when Taxonomy.parent_of old p <> None -> Error (Printf.sprintf "parent %S is itself a child: the tree has two levels" p)
    | Some _ -> Ok ()

let insert text ~id ~category ~parent =
  let ( let* ) = Result.bind in
  let* () = check_id id in
  let* old = Taxonomy.of_string text in
  let* () = check_placement old ~id ~category ~parent in
  try
    let layout = scan text in
    if layout_entries layout <> old.entries then unsupported "the layout is not read the same way by the loader";
    let cat = List.find (fun c -> c.key = category) layout.cats in
    if parent <> None && cat.list_key <> "products" then unsupported "a category using the legacy 'projects:' list takes no parent";
    let edited = String.concat "" (insert_text layout ~id ~category ~parent) in
    let* fresh = Taxonomy.of_string edited in
    if fresh.entries = expected_entries old ~id ~category ~parent && List.map (fun (c : Taxonomy.category) -> (c.key, c.name)) fresh.categories = List.map (fun (c : Taxonomy.category) -> (c.key, c.name)) old.categories
    then Ok edited
    else Error "post-edit verification failed: the edited file does not read as the old taxonomy plus the new product"
  with Unsupported why -> Error ("taxonomy layout not supported; edit by hand (" ^ why ^ ")")

(* ---- the operation ----------------------------------------------------- *)

let write_temp dir content mode =
  let path = Filename.temp_file ~temp_dir:dir ".taxonomy." ".tmp" in
  let oc = open_out_bin path in
  Fun.protect ~finally:(fun () -> close_out_noerr oc) (fun () -> output_string oc content; flush oc);
  let fd = Unix.openfile path [ Unix.O_RDONLY ] 0 in
  Fun.protect ~finally:(fun () -> Unix.close fd) (fun () -> Unix.fsync fd);
  Unix.chmod path mode;
  path

let add_product (ctx : Ctx.t) ~id ~category ?parent () =
  Err.protect (fun () ->
      Lock.with_lock ~path:(Ctx.lock_path ctx) ~timeout:ctx.lock_timeout (fun () ->
          let target = Safefs.resolve_inside ~root:ctx.root (Ctx.taxonomy_path ctx) in
          let read () = Safefs.read_file_following ~limit:Safefs.max_taxonomy_bytes target in
          let original = read () in
          let edited = match insert original ~id ~category ~parent with Ok e -> e | Error why -> Err.usage "%s" why in
          let tmp = write_temp (Filename.dirname target) edited (Unix.stat target).Unix.st_perm in
          Fun.protect
            ~finally:(fun () -> if Sys.file_exists tmp then Sys.remove tmp)
            (fun () ->
              if read () <> original then
                Err.usage "taxonomy.yaml changed during the edit; retry";
              (match Taxonomy.load tmp with
              | Ok _ -> ()
              | Error e -> Err.fail Err.Malformed ("post-edit verification failed, nothing written: " ^ e.message));
              Unix.rename tmp target);
          if ctx.commit then
            match Gitrun.commit_paths ~root:ctx.root ~paths:[ target ] ~message:("wl: product add " ^ id) with
            | Ok _ -> ()
            | Error why -> ( try ctx.warn why with e -> Err.reraise_fatal e)))
