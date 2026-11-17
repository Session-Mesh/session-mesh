(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(* Closed authored metadata codec. Values are retained in full for typed patches. *)
exception Invalid of string

let fail s = raise (Invalid s)
let config_bytes = 2097152
let request_bytes = 131072
let reply_bytes = 196608

let operations =
  [
    "project_capabilities";
    "project_list";
    "project_read";
    "project_create";
    "project_settings";
    "project_status";
  ]

let is_operation s = List.mem s operations
let obj = function `Assoc a -> a | _ -> fail "invalid-request"

let get a k =
  match List.assoc_opt k a with Some v -> v | None -> fail "invalid-request"

let keys a allowed =
  let names = List.map fst a in
  if List.length names <> List.length (List.sort_uniq String.compare names) then
    fail "invalid-request";
  if List.exists (fun k -> not (List.mem k allowed)) names then
    fail "unsupported-feature"

let valid_utf8 text =
  let rec loop offset =
    if offset < String.length text then (
      let decoded = String.get_utf_8_uchar text offset in
      if not (Uchar.utf_decode_is_valid decoded) then fail "invalid-request";
      loop (offset + Uchar.utf_decode_length decoded))
  in loop 0

let rec strict = function
  | `Assoc a ->
      keys a (List.map fst a);
      List.iter (fun (k, v) -> valid_utf8 k; strict v) a
  | `List a -> List.iter strict a
  | `String text -> valid_utf8 text
  | _ -> ()

let utf16_length s =
  let n = String.length s in
  let rec loop i total =
    if i = n then total
    else
      let decoded = String.get_utf_8_uchar s i in
      if not (Uchar.utf_decode_is_valid decoded) then fail "invalid-request";
      let width = Uchar.utf_decode_length decoded
      and v = Uchar.to_int (Uchar.utf_decode_uchar decoded) in
      if (v < 32 && not (List.mem v [ 9; 10; 13 ])) || v = 127 then
        fail "invalid-request";
      loop (i + width) (total + if v > 65535 then 2 else 1)
  in
  loop 0 0

let whitespace v =
  (v >= 9 && v <= 13)
  || List.mem v
       [ 0x20; 0xa0; 0x1680; 0x2028; 0x2029; 0x202f; 0x205f; 0x3000; 0xfeff ]
  || (v >= 0x2000 && v <= 0x200a)

let trim s =
  let first = ref (String.length s) and last = ref 0 in
  let rec loop i =
    if i < String.length s then (
      let decoded = String.get_utf_8_uchar s i in
      if not (Uchar.utf_decode_is_valid decoded) then fail "invalid-request";
      let next = i + Uchar.utf_decode_length decoded in
      if not (whitespace (Uchar.to_int (Uchar.utf_decode_uchar decoded))) then (
        first := min !first i;
        last := next);
      loop next)
  in
  loop 0;
  if !last = 0 then "" else String.sub s !first (!last - !first)

let text ?(empty = false) max = function
  | `String s when (empty || s <> "") && utf16_length s <= max -> s
  | _ -> fail "invalid-request"

let opaque max v =
  let s = text max v in
  if String.exists (fun c -> Char.code c < 32) s then fail "invalid-request";
  s

let id v =
  let s = opaque 80 v in
  if
    not
      (String.for_all
         (function
           | 'a' .. 'z' | 'A' .. 'Z' | '0' .. '9' | '_' | '-' -> true
           | _ -> false)
         s)
  then fail "invalid-request";
  s

let uuid v =
  let s = opaque 36 v in
  if
    String.length s <> 36
    || (not
          (String.for_all
             (function '0' .. '9' | 'a' .. 'f' | '-' -> true | _ -> false)
             s))
    || List.exists (fun i -> s.[i] <> '-') [ 8; 13; 18; 23 ]
    || List.exists
         (fun i -> (not (List.mem i [ 8; 13; 18; 23 ])) && s.[i] = '-')
         (List.init 36 Fun.id)
  then fail "invalid-request";
  s

let choice allowed v =
  let s = opaque 240 v in
  if not (List.mem s allowed) then fail "invalid-request";
  s

let list max f = function
  | `List xs when List.length xs <= max -> List.map f xs
  | _ -> fail "invalid-request"

let unique key xs =
  let names = List.map key xs in
  if List.length names <> List.length (List.sort_uniq String.compare names) then
    fail "invalid-request"

let opt a key f = Option.iter (fun v -> ignore (f v)) (List.assoc_opt key a)

let path v =
  let s = opaque 4096 v in
  if not (String.starts_with ~prefix:"/" s) then fail "invalid-request";
  s

let url v =
  let s = opaque 4096 v in
  let rec check_spaces i =
    if i < String.length s then (
      let decoded = String.get_utf_8_uchar s i in
      if whitespace (Uchar.to_int (Uchar.utf_decode_uchar decoded)) then
        fail "invalid-request";
      check_spaces (i + Uchar.utf_decode_length decoded))
  in
  check_spaces 0;
  let u =
    try Uri.of_string s
    with Invalid_argument _ | Failure _ -> fail "invalid-request"
  in
  if
    (not (List.mem (Uri.scheme u) [ Some "https"; Some "http" ]))
    || Uri.userinfo u <> None
    || Uri.host u = None
    || Uri.host u = Some ""
  then fail "invalid-request";
  s

let kinds =
  [ "roster"; "slack"; "teams"; "linear"; "github"; "gitlab"; "other" ]

let session v =
  let a = obj v in
  keys a [ "name"; "created"; "machine_id" ];
  ignore (text 240 (get a "name"));
  (match get a "created" with
  | `Int n when n >= 0 -> ()
  | `Float n when Float.is_finite n && n >= 0. -> ()
  | _ -> fail "invalid-request");
  opt a "machine_id" id

let label v =
  let s = opaque 240 v in
  if trim s = "" then fail "invalid-request";
  s

let channel v =
  let a = obj v in
  keys a [ "id"; "label"; "tenant_id"; "workspace_id"; "native_id"; "url" ];
  ignore (id (get a "id"));
  ignore (label (get a "label"));
  List.iter
    (fun k -> opt a k (opaque 240))
    [ "tenant_id"; "workspace_id"; "native_id" ];
  opt a "url" url

let source ~modern v =
  let a = obj v in
  keys a
    ([
       "id";
       "kind";
       "label";
       "url";
       "board_path";
       "pipeline_root";
       "pipeline_task";
     ]
    @ if modern then [ "channels" ] else []);
  let sid = id (get a "id") in
  if modern && sid = "mesh" then fail "invalid-request";
  let kind = choice kinds (get a "kind") in
  ignore (text 240 (get a "label"));
  opt a "url" url;
  List.iter (fun k -> opt a k path) [ "board_path"; "pipeline_root" ];
  opt a "pipeline_root" (opaque 2000);
  opt a "pipeline_task" (fun v ->
      let s = opaque 120 v in
      if
        List.exists (( = ) "") (String.split_on_char '-' s)
        || not
             (String.for_all
                (function 'a' .. 'z' | '0' .. '9' | '-' -> true | _ -> false)
                s)
      then fail "invalid-request";
      s);
  let has k = List.mem_assoc k a in
  if
    kind <> "roster"
    && List.exists has [ "board_path"; "pipeline_root"; "pipeline_task" ]
    || has "pipeline_root" <> has "pipeline_task"
    || (has "pipeline_root" && has "board_path")
  then fail "invalid-request";
  opt a "channels" (fun v ->
      let xs =
        list 20
          (fun v ->
            channel v;
            v)
          v
      in
      unique (fun x -> id (get (obj x) "id")) xs;
      xs)

let repository ~modern v =
  let a = obj v in
  keys a
    ([ "url"; "branch"; "readme_url" ]
    @ if modern then [ "local_path"; "primary_ref" ] else []);
  ignore (url (get a "url"));
  opt a "branch" (text 240);
  opt a "readme_url" url;
  opt a "local_path" path;
  opt a "primary_ref" (fun v ->
      let s = opaque 240 v in
      if
        not
          ((String.starts_with ~prefix:"refs/heads/" s && String.length s > 11)
          || String.starts_with ~prefix:"refs/remotes/" s
             && String.length s > 13)
      then fail "invalid-request";
      s)

let participation v =
  let a = obj v in
  keys a
    [ "id"; "label"; "recorded_relation"; "target"; "role_label"; "work_refs" ];
  ignore (id (get a "id"));
  List.iter (fun k -> opt a k label) [ "label"; "role_label" ];
  ignore
    (choice [ "active"; "saved"; "historical" ] (get a "recorded_relation"));
  let t = obj (get a "target") in
  (match get t "kind" with
  | `String "mesh" ->
      keys t [ "kind"; "name"; "created"; "machine_id" ];
      session (`Assoc (List.remove_assoc "kind" t));
      ignore (opaque 240 (get t "name"))
  | `String "history" ->
      keys t [ "kind"; "agent"; "conversation_id" ];
      ignore (choice [ "claude"; "codex"; "pi" ] (get t "agent"));
      ignore (opaque 240 (get t "conversation_id"))
  | _ -> fail "invalid-request");
  opt a "work_refs" (fun value ->
      let refs =
        list 20
          (fun v ->
            let r = obj v in
            keys r [ "source_id"; "kind"; "native_id"; "instance_id" ];
            List.iter (fun k -> ignore (id (get r k))) [ "source_id"; "kind" ];
            ignore (opaque 240 (get r "native_id"));
            opt r "instance_id" (opaque 240);
            v)
          value
      in
      unique
        (fun v ->
          let a = obj v in
          Yojson.Basic.to_string
            (`List
               (List.map
                  (fun k -> Option.value ~default:`Null (List.assoc_opt k a))
                  [ "source_id"; "kind"; "native_id"; "instance_id" ])))
        refs;
      refs)

let receipt v =
  let a = obj v in
  keys a [ "request_id"; "sha256" ];
  ignore (uuid (get a "request_id"));
  let s = opaque 64 (get a "sha256") in
  if
    String.length s <> 64
    || not
         (String.for_all
            (function '0' .. '9' | 'a' .. 'f' -> true | _ -> false)
            s)
  then fail "invalid-request"

let folders v =
  let xs = list 100 path v in
  unique Fun.id xs;
  xs

let selector value =
  match value with
  | `Null -> []
  | value ->
      let a = obj value in
      (match get a "kind" with
      | `String "board" ->
          keys a [ "kind"; "path" ];
          ignore (path (get a "path"));
          [ ("board_path", get a "path") ]
      | `String "pipeline" ->
          keys a [ "kind"; "root"; "task" ];
          let fields = [ ("pipeline_root", get a "root"); ("pipeline_task", get a "task") ] in
          source ~modern:true (`Assoc ([ ("id", `String "validation"); ("kind", `String "roster"); ("label", `String "Validation") ] @ fields));
          fields
      | _ -> fail "invalid-request")

let observation project value =
  let a = obj value in
  keys a [ "repository"; "source_ids" ];
  let repository_enabled = match get a "repository" with `Bool b -> b | _ -> fail "invalid-request" in
  let ids = list 20 id (get a "source_ids") in
  unique Fun.id ids;
  if repository_enabled then (
    let repo = obj (get project "repository") in
    ignore (path (get repo "local_path")));
  let sources = match List.assoc_opt "sources" project with Some (`List xs) -> xs | _ -> [] in
  List.iter (fun sid ->
      match List.find_opt (fun v -> get (obj v) "id" = `String sid) sources with
      | None -> fail "invalid-request"
      | Some v -> let s = obj v in
          if get s "kind" <> `String "roster" || not (List.mem_assoc "board_path" s || List.mem_assoc "pipeline_root" s) then fail "invalid-request") ids
