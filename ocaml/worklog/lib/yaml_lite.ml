(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

type t =
  | Null
  | Scalar of { text : string; quoted : bool }
  | Seq of t list
  | Map of { fields : (string * t) list; typed_keys : string list }

exception Bad of int * string

let bad line why = raise (Bad (line, why))

(* ---- scalars ----------------------------------------------------------- *)

let is_plain_string = Yaml_scalar.is_plain_string
let is_conservative_string = Yaml_scalar.is_conservative_string

let plain text = Scalar { text; quoted = false }

(* A quoted scalar starting at [i] of [s]; returns its text and the next index. *)
let quoted_at line s i =
  let quote = s.[i] in
  let buf = Buffer.create 16 in
  let n = String.length s in
  let rec go j =
    if j >= n then bad line "unterminated quoted scalar"
    else if s.[j] = quote then
      if quote = '\'' && j + 1 < n && s.[j + 1] = '\'' then (Buffer.add_char buf '\''; go (j + 2))
      else j + 1
    else if quote = '"' && s.[j] = '\\' then begin
      if j + 1 >= n then bad line "unterminated escape";
      (match s.[j + 1] with
      | 'n' -> Buffer.add_char buf '\n'
      | 't' -> Buffer.add_char buf '\t'
      | '"' | '\\' | '/' as c -> Buffer.add_char buf c
      | _ -> bad line "unsupported escape in a double-quoted scalar");
      go (j + 2)
    end
    else (Buffer.add_char buf s.[j]; go (j + 1))
  in
  let next = go (i + 1) in
  (Buffer.contents buf, next)

(* ---- flow collections ------------------------------------------------- *)

let skip_ws s i =
  let n = String.length s in
  let rec go i = if i < n && (s.[i] = ' ' || s.[i] = '\t') then go (i + 1) else i in
  go i

let flow_plain line s i =
  let n = String.length s in
  let rec go j =
    if j >= n then j
    else
      match s.[j] with
      | ',' | ']' | '}' -> j
      | ':' when j + 1 >= n || s.[j + 1] = ' ' || s.[j + 1] = ',' || s.[j + 1] = ']' || s.[j + 1] = '}' -> j
      | '#' when j > 0 && s.[j - 1] = ' ' -> j
      | _ -> go (j + 1)
  in
  let j = go i in
  if j = i then bad line "empty flow item";
  (String.trim (String.sub s i (j - i)), j)

(* Nesting deeper than this is refused, so hostile input cannot overflow the stack. *)
let max_depth = 64

let enter line depth =
  if depth >= max_depth then bad line (Printf.sprintf "nesting deeper than %d levels" max_depth)

(* [acc] lists (key, value, typed) newest first; [typed] marks a plain key that a
   YAML 1.1 loader would read as a non-string (a number, a boolean, null). *)
let finish_map acc =
  let ordered = List.rev acc in
  Map
    {
      fields = List.map (fun (k, v, _) -> (k, v)) ordered;
      typed_keys = List.filter_map (fun (k, _, typed) -> if typed then Some k else None) ordered;
    }

let rec flow_value line depth s i =
  let i = skip_ws s i in
  if i >= String.length s then bad line "unterminated flow collection"
  else
    match s.[i] with
    | '[' -> enter line depth; flow_seq line (depth + 1) s (i + 1)
    | '{' -> enter line depth; flow_map line (depth + 1) s (i + 1)
    | '"' | '\'' ->
        let text, next = quoted_at line s i in
        (Scalar { text; quoted = true }, next)
    | '&' | '*' | '!' | '|' | '>' -> bad line "anchors, tags and block scalars are not supported"
    | _ ->
        let text, next = flow_plain line s i in
        (plain text, next)

and flow_seq line depth s i =
  let rec go i acc =
    let i = skip_ws s i in
    if i >= String.length s then bad line "unterminated flow sequence"
    else if s.[i] = ']' then (Seq (List.rev acc), i + 1)
    else
      let v, j = flow_value line depth s i in
      let j = skip_ws s j in
      if j < String.length s && s.[j] = ',' then go (j + 1) (v :: acc)
      else if j < String.length s && s.[j] = ']' then (Seq (List.rev (v :: acc)), j + 1)
      else bad line "expected , or ] in a flow sequence"
  in
  go i []

and flow_map line depth s i =
  let rec go i acc =
    let i = skip_ws s i in
    if i >= String.length s then bad line "unterminated flow mapping"
    else if s.[i] = '}' then (finish_map acc, i + 1)
    else
      let key, j = flow_value line depth s i in
      let key, typed =
        match key with
        | Scalar { text; quoted } -> (text, (not quoted) && not (is_plain_string text))
        | _ -> bad line "flow mapping key must be a scalar"
      in
      let j = skip_ws s j in
      let value, j =
        if j < String.length s && s.[j] = ':' then flow_value line depth s (j + 1) else (Null, j)
      in
      let j = skip_ws s j in
      let acc = (key, value, typed) :: List.filter (fun (k, _, _) -> k <> key) acc in
      if j < String.length s && s.[j] = ',' then go (j + 1) acc
      else if j < String.length s && s.[j] = '}' then (finish_map acc, j + 1)
      else bad line "expected , or } in a flow mapping"
  in
  go i []

(* A plain block scalar cannot hold ": " or end with ':' (a mapping value is not
   allowed there; PyYAML refuses it as well). *)
let check_plain_block line s =
  let n = String.length s in
  let rec go i =
    if i >= n then ()
    else if s.[i] = ':' && (i + 1 = n || s.[i + 1] = ' ') then
      bad line "mapping values are not allowed in this context"
    else go (i + 1)
  in
  go 0

(* An inline value: flow collection, quoted or plain scalar, ending the line. *)
let inline_value line depth s =
  let s = String.trim s in
  if s = "" then Null
  else
    match s.[0] with
    | '[' | '{' ->
        let v, next = flow_value line depth s 0 in
        if skip_ws s next <> String.length s then bad line "unexpected text after a flow collection";
        v
    | '"' | '\'' ->
        let text, next = quoted_at line s 0 in
        if skip_ws s next <> String.length s then bad line "unexpected text after a quoted scalar";
        Scalar { text; quoted = true }
    | '&' | '*' | '!' | '|' | '>' | '%' | '@' | '`' ->
        bad line "anchors, tags and block scalars are not supported"
    | ',' | ']' | '}' -> bad line "a plain value cannot start with an indicator character"
    | ('-' | '?' | ':') when String.length s = 1 || s.[1] = ' ' || s.[1] = '\t' ->
        bad line "a plain value cannot start with an indicator character"
    | _ ->
        check_plain_block line s;
        plain s

(* ---- block structure --------------------------------------------------- *)

type row = { no : int; indent : int; text : string }

(* Remove a trailing comment: a '#' at the start or after whitespace, outside quotes. *)
let strip_comment s =
  let n = String.length s in
  let rec go i quote =
    if i >= n then s
    else
      let c = s.[i] in
      match quote with
      | Some q -> go (i + 1) (if c = q then None else quote)
      | None ->
          if (c = '"' || c = '\'') && (i = 0 || s.[i - 1] = ' ' || s.[i - 1] = '[' || s.[i - 1] = '{' || s.[i - 1] = ',' || s.[i - 1] = ':') then go (i + 1) (Some c)
          else if c = '#' && (i = 0 || s.[i - 1] = ' ' || s.[i - 1] = '\t') then String.sub s 0 i
          else go (i + 1) None
  in
  go 0 None

let row_of_line i raw =
  let raw =
    if raw <> "" && raw.[String.length raw - 1] = '\r' then
      String.sub raw 0 (String.length raw - 1)
    else raw
  in
  let body = strip_comment raw in
  if String.trim body = "" then None
  else begin
    let n = String.length body in
    (* PyYAML refuses a line that ends in a tab, with or without a comment after it. *)
    if body.[n - 1] = '\t' then bad (i + 1) "a tab at the end of a line, or before a comment";
    let k = ref 0 in
    while !k < n && body.[!k] = ' ' do incr k done;
    if !k < n && body.[!k] = '\t' then bad (i + 1) "tab in indentation";
    let content = String.trim (String.sub body !k (n - !k)) in
    if content = "---" || content = "..." then
      bad (i + 1) "document markers are not supported";
    Some { no = i + 1; indent = !k; text = content }
  end

let rows_of text =
  List.filter_map Fun.id (List.mapi row_of_line (String.split_on_char '\n' text))

let is_dash r = r.text = "-" || (String.length r.text >= 2 && String.sub r.text 0 2 = "- ")

(* Split "key: rest" at the first ': ' (or trailing ':') outside quotes. *)
let split_key row =
  let s = row.text in
  let n = String.length s in
  if n > 0 && (s.[0] = '"' || s.[0] = '\'') then begin
    let key, next = quoted_at row.no s 0 in
    if next < n && s.[next] = ':' && (next + 1 = n || s.[next + 1] = ' ') then
      Some (key, String.sub s (next + 1) (n - next - 1))
    else None
  end
  else begin
    let rec go i =
      if i >= n then None
      else if s.[i] = ':' && (i + 1 = n || s.[i + 1] = ' ') then
        Some (String.sub s 0 i, String.sub s (i + 1) (n - i - 1))
      else go (i + 1)
    in
    match go 0 with
    | Some (key, rest) when key <> "" && key.[0] <> '[' && key.[0] <> '{' -> Some (String.trim key, rest)
    | _ -> None
  end

let key_is_typed row key =
  row.text <> "" && row.text.[0] <> '"' && row.text.[0] <> '\'' && not (is_plain_string key)

let rec block depth rows =
  match rows with
  | [] -> (Null, [])
  | r :: _ when is_dash r -> block_seq depth rows r.indent
  | r :: _ -> (
      match split_key r with
      | Some _ -> block_map depth rows r.indent
      | None -> (inline_value r.no depth r.text, List.tl rows))

(* The value of "key:" or "-" that has nothing on its own line. *)
and nested depth rows ~parent ~allow_same_indent_seq =
  match rows with
  | r :: _ when r.indent > parent -> block depth rows
  | r :: _ when allow_same_indent_seq && r.indent = parent && is_dash r -> block_seq depth rows parent
  | _ -> (Null, rows)

and block_map depth rows ind =
  (match rows with r :: _ -> enter r.no depth | [] -> ());
  let rec go rows acc =
    match rows with
    | r :: rest when r.indent = ind && not (is_dash r) -> (
        match split_key r with
        | None -> bad r.no "expected a 'key: value' line"
        | Some (key, tail) ->
            let value, rows' =
              if String.trim tail = "" then nested (depth + 1) rest ~parent:ind ~allow_same_indent_seq:true
              else (inline_value r.no (depth + 1) tail, rest)
            in
            go rows' (set_key key (key_is_typed r key) value acc))
    | r :: _ when r.indent > ind -> bad r.no "unexpected indentation"
    | _ -> (finish_map acc, rows)
  in
  go rows []

and set_key key typed value acc =
  if List.exists (fun (k, _, _) -> k = key) acc then
    List.map (fun (k, v, t) -> if k = key then (k, value, typed) else (k, v, t)) acc
  else (key, value, typed) :: acc

and block_seq depth rows ind =
  (match rows with r :: _ -> enter r.no depth | [] -> ());
  let rec go rows acc =
    match rows with
    | r :: rest when r.indent = ind && is_dash r ->
        let item_text = String.trim (String.sub r.text 1 (String.length r.text - 1)) in
        let item, rows' =
          if item_text = "" then nested (depth + 1) rest ~parent:ind ~allow_same_indent_seq:false
          else begin
            let col = ind + (String.length r.text - String.length item_text) in
            let inner = { r with indent = col; text = item_text } in
            if is_dash inner then block_seq (depth + 1) (inner :: rest) col
            else block (depth + 1) (inner :: rest)
          end
        in
        go rows' (item :: acc)
    | r :: _ when r.indent > ind -> bad r.no "unexpected indentation"
    | _ -> (Seq (List.rev acc), rows)
  in
  go rows []

let parse text =
  try
    let rows = rows_of text in
    let value, rest = block 0 rows in
    match rest with
    | [] -> Ok value
    | r :: _ -> Error (Printf.sprintf "line %d: unexpected content" r.no)
  with Bad (line, why) -> Error (Printf.sprintf "line %d: %s" line why)
