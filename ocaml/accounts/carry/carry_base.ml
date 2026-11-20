(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(* What the carry modules share: the refusal and its message, the limits, the
   name rules, and lstat and readdir that turn a system error into a
   refusal. *)

type error = { code : string; message : string }
type limits = { max_files : int; max_bytes : int; free_margin : int }

let mib = 1024 * 1024

let default_limits =
  { max_files = 5_000; max_bytes = 2 * 1024 * mib; free_margin = 512 * mib }

(* Bounds on the walk of a conversation's folder. *)
let max_entries = 20_000
let max_depth = 8
let chunk = 65536
let fail code message = Error { code; message }
let ( let* ) = Result.bind

(* ----------------------------------------------------------- messages *)

(* A message names no absolute path and holds no control character: an
   absolute path (a word starting with "/") becomes "<path>", a control
   character "?". *)
let sanitize message =
  let length = String.length message in
  let buffer = Buffer.create length in
  let rec skip_path index =
    if index < length && message.[index] <> ' ' && message.[index] <> ':' then
      skip_path (index + 1)
    else index
  in
  let rec copy index =
    if index < length then
      let character = message.[index] in
      if character = '/' && (index = 0 || message.[index - 1] = ' ') then begin
        Buffer.add_string buffer "<path>";
        copy (skip_path index)
      end
      else begin
        Buffer.add_char buffer
          (if Char.code character < 0x20 || Char.code character = 0x7f then '?'
           else character);
        copy (index + 1)
      end
  in
  copy 0;
  Buffer.contents buffer

let sanitized result =
  Result.map_error
    (fun error -> { error with message = sanitize error.message })
    result

(* --------------------------------------------------------------- names *)

(* Names never carried, compared ignoring ASCII case: login, settings and key
   files. A safety net (an agent can already paste its credentials into a
   transcript), not a boundary. *)
type pattern = Exact of string | Prefix of string | Suffix of string

let login_patterns =
  [
    Exact ".credentials.json";
    Exact "credentials.json";
    Exact "auth.json";
    Exact "config.toml";
    Exact ".env";
    Prefix ".claude.json";
    Prefix ".credentials";
    Prefix ".env.";
    Prefix "id_rsa";
    Prefix "id_dsa";
    Prefix "id_ecdsa";
    Prefix "id_ed25519";
    Suffix ".pem";
    Suffix ".key";
  ]

let is_login_file name =
  let name = String.lowercase_ascii name in
  String.starts_with ~prefix:"settings" name
  && String.ends_with ~suffix:".json" name
  || List.exists
       (function
         | Exact exact -> name = exact
         | Prefix prefix -> String.starts_with ~prefix name
         | Suffix suffix -> String.ends_with ~suffix name)
       login_patterns

let is_hex = function
  | '0' .. '9' | 'a' .. 'f' | 'A' .. 'F' -> true
  | _ -> false

let is_digit = function '0' .. '9' -> true | _ -> false

(* [text] has the [shape]: 'd' a digit, 'x' a hexadecimal digit, any other
   character itself. *)
let has_shape shape text =
  String.length shape = String.length text
  && List.for_all
       (fun index ->
         match shape.[index] with
         | 'd' -> is_digit text.[index]
         | 'x' -> is_hex text.[index]
         | other -> text.[index] = other)
       (List.init (String.length shape) Fun.id)

let valid_uuid = has_shape "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"

(* [.<base>.carry-<tag>-<16 lowercase hexadecimal digits>], tag "new" or
   "old": the temporary files of a carry next to the file <base>;
   [Some (base, tag)]. *)
let carry_temporary name =
  let length = String.length name in
  if length < 29 || name.[0] <> '.' then None
  else
    let token = String.sub name (length - 16) 16 in
    let marker = String.sub name (length - 27) 11 in
    let base = String.sub name 1 (length - 28) in
    let lowercase_hex = function
      | '0' .. '9' | 'a' .. 'f' -> true
      | _ -> false
    in
    if not (String.for_all lowercase_hex token) then None
    else if marker = ".carry-new-" then Some (base, "new")
    else if marker = ".carry-old-" then Some (base, "old")
    else None

(* ------------------------------------------------------------- checks *)

let lstat_opt path =
  match Unix.lstat path with
  | stats -> Ok (Some stats)
  | exception Unix.Unix_error (Unix.ENOENT, _, _) -> Ok None
  | exception Unix.Unix_error (error, _, _) ->
      fail "carry_failed" (Unix.error_message error)

let readdir path =
  match Sys.readdir path with
  | names -> Ok (List.sort String.compare (Array.to_list names))
  | exception Sys_error _ -> fail "carry_failed" "a folder could not be read"

(* A folder below an account folder: not a link, the operator's, and neither
   group nor others can write it. *)
let private_folder ~uid relative (stats : Unix.stats) =
  if stats.st_kind <> Unix.S_DIR then
    fail "unsafe_entry" (relative ^ " is not a plain folder")
  else if stats.st_uid <> uid then
    fail "unsafe_entry" (relative ^ " is not the operator's")
  else if stats.st_perm land 0o022 <> 0 then
    fail "unsafe_entry" (relative ^ " can be written by other users")
  else Ok ()

let join folder relative = folder ^ "/" ^ relative
let quietly f = try f () with Unix.Unix_error _ | Sys_error _ -> ()

(* The folders above [relative], outermost first: "a/b/c" gives "a", "a/b". *)
let parents relative =
  let rec build prefix = function
    | [] | [ _ ] -> []
    | component :: rest ->
        let path =
          if prefix = "" then component else prefix ^ "/" ^ component
        in
        path :: build path rest
  in
  build "" (String.split_on_char '/' relative)
