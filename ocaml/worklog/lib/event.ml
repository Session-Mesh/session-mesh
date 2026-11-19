(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

type t = {
  ts : int;
  task : string;
  typ : string;
  data : (string * Yojson.Safe.t) list;
  host : string;
  file : string;
  line : int;
}

let get ev key =
  List.fold_left (fun acc (k, v) -> if k = key then Some v else acc) None ev.data

let get_string ev key =
  match get ev key with Some (`String s) -> Some s | _ -> None

let compare a b =
  let c = Int.compare a.ts b.ts in
  if c <> 0 then c
  else
    let c = String.compare a.host b.host in
    if c <> 0 then c
    else
      let c = String.compare a.file b.file in
      if c <> 0 then c else Int.compare a.line b.line

let where ev = Printf.sprintf "%s:%d" ev.file ev.line

let starts_with ~prefix s =
  String.length s >= String.length prefix
  && String.sub s 0 (String.length prefix) = prefix

let last_string fields key =
  List.fold_left
    (fun acc (k, v) -> if k = key then Some v else acc)
    None fields

let required_string fields key =
  match last_string fields key with
  | Some (`String s) -> Ok s
  | _ -> Error (Printf.sprintf "missing or non-string %S" key)

(* Yojson also reads comments, tuples, variants and quote forms that Python's
   json.loads refuses. Outside strings, valid JSON only holds structure
   characters, digits, number signs, letters of true/false/null/NaN/Infinity
   and blanks, and a string holds no raw control character; anything else is
   malformed, as `wl` reports it. *)
let extension_outside_strings raw =
  let n = String.length raw in
  let rec go i in_string =
    if i >= n then false
    else
      let c = raw.[i] in
      if in_string then
        (* json.loads (strict) refuses a raw control character inside a string. *)
        if c < ' ' then true
        else if c = '\\' then go (i + 2) true
        else go (i + 1) (c <> '"')
      else if c = '"' then go (i + 1) true
      else if
        String.contains "{}[]:,+-.eE \t\r\n" c
        || (c >= '0' && c <= '9')
        || (c >= 'a' && c <= 'z')
        || (c >= 'A' && c <= 'Z')
      then go (i + 1) false
      else true
  in
  go 0 false

let parse_fields raw =
  if extension_outside_strings raw then Error "invalid JSON (not strict JSON)"
  else
  match Yojson.Safe.from_string raw with
  | `Assoc fields -> Ok fields
  | _ -> Error "not a JSON object"
  | exception Yojson.Json_error _ -> Error "invalid JSON"

let check_envelope fields =
  let ( let* ) = Result.bind in
  let* ts = required_string fields "ts" in
  let* _ = required_string fields "task" in
  let* _ = required_string fields "type" in
  match Tstamp.parse ts with
  | Some seconds -> Ok (fields, seconds)
  | None -> Error (Printf.sprintf "bad ts %S" ts)

let prefilter raw =
  let n = String.length raw in
  if String.trim raw = "" then Some "blank line"
  else if starts_with ~prefix:"\xef\xbb\xbf" raw then Some "byte order mark (BOM)"
  else if raw.[n - 1] = '\r' then Some "CRLF line ending"
  else if Textcheck.code_points raw = None then Some "not valid UTF-8"
  else if
    List.exists (fun prefix -> starts_with ~prefix raw) [ "<<<<<<<"; "======="; ">>>>>>>" ]
  then Some "merge conflict marker"
  else None

let classify raw =
  match prefilter raw with
  | Some reason -> Error reason
  | None -> Result.bind (parse_fields raw) check_envelope

let encode ~ts ~task ~typ fields =
  Yojson.Safe.to_string
    (`Assoc
      (("ts", `String (Tstamp.format ts))
      :: ("task", `String task) :: ("type", `String typ) :: fields))
