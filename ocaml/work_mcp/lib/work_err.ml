(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

module W = Mesh_worklog

type t = { code : string; message : string }

let make code message = { code; message }
let invalid fmt = Printf.ksprintf (fun message -> { code = "invalid_input"; message }) fmt
let not_found fmt = Printf.ksprintf (fun message -> { code = "not_found"; message }) fmt

let code_of_kind = function
  | W.Err.Usage -> "invalid_input"
  | W.Err.Not_found -> "not_found"
  | W.Err.Malformed -> "malformed_data"
  | W.Err.Lock_timeout -> "lock_timeout"
  | W.Err.Repo -> "repository"
  | W.Err.Other -> "io_error"

(* Messages leave the server through tool results that other agents and the
   owner's interface read: no absolute path or home directory goes out. The
   text is cut into tokens at spaces, ASCII and typographic quotes, brackets
   and punctuation (no-break spaces and guillemets included). A token that is
   an absolute path, a [~] path, a flag glued to a path ([-C/srv/x]) or a
   relative path of two or more components ([x/srv/y]) becomes [<path>]. A
   URL ([scheme://...]) stays readable, except [file://]: its path is
   replaced. *)
let ascii_delimiters = " \t\r\n\"'()[]<>,;`|={}"

let utf8_delimiters =
  [ "\xC2\xA0"; "\xC2\xAB"; "\xC2\xBB"; "\xE2\x80\x98"; "\xE2\x80\x99"; "\xE2\x80\x9A";
    "\xE2\x80\x9B"; "\xE2\x80\x9C"; "\xE2\x80\x9D"; "\xE2\x80\x9E"; "\xE2\x80\xB9";
    "\xE2\x80\xBA"; "\xE2\x80\xAF"; "\xE2\x81\x9F"; "\xE3\x80\x80" ]
  @ List.init 11 (fun k -> "\xE2\x80" ^ String.make 1 (Char.chr (0x80 + k)))

let has_at s i sub =
  let n = String.length sub in
  i + n <= String.length s && String.sub s i n = sub

let delimiter_length ~colon s i =
  let c = s.[i] in
  if String.contains ascii_delimiters c || (colon && c = ':') then 1
  else if Char.code c < 0x80 then 0
  else match List.find_opt (has_at s i) utf8_delimiters with Some d -> String.length d | None -> 0

let token_end ~colon s i =
  let rec go j = if j < String.length s && delimiter_length ~colon s j = 0 then go (j + 1) else j in
  go i

let count_slashes s = String.fold_left (fun n c -> if c = '/' then n + 1 else n) 0 s
let is_flag prefix = String.length prefix >= 2 && String.length prefix <= 3 && prefix.[0] = '-'

let split_trailing_dots token =
  let n = ref (String.length token) in
  while !n > 0 && token.[!n - 1] = '.' do
    decr n
  done;
  (String.sub token 0 !n, String.sub token !n (String.length token - !n))

(* The token, or [<path>] in its place; trailing dots (a sentence's end) stay. *)
let hide_path token =
  let core, dots = split_trailing_dots token in
  match String.index_opt core '/' with
  | None -> token
  | Some 0 when String.length core = 1 -> token
  | Some k ->
      let prefix = String.sub core 0 k in
      if prefix = "" || prefix.[0] = '~' then "<path>" ^ dots
      else if is_flag prefix then prefix ^ "<path>" ^ dots
      else if count_slashes core >= 2 then "<path>" ^ dots
      else token

let is_letter c = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
let is_scheme_char c = is_letter c || (c >= '0' && c <= '9') || String.contains "+.-" c

(* The end of a [scheme://] prefix starting at [i], if there is one. *)
let url_prefix_end s i =
  let rec scheme j = if j < String.length s && is_scheme_char s.[j] then scheme (j + 1) else j in
  if i < String.length s && is_letter s.[i] then
    let j = scheme i in
    if has_at s j "://" then Some (j + 3) else None
  else None

let sanitise message =
  let n = String.length message in
  let b = Buffer.create n in
  let url i k =
    let j = token_end ~colon:false message i in
    let prefix = String.sub message i (k - i) in
    let whole = String.sub message i (j - i) in
    let _, dots = split_trailing_dots whole in
    Buffer.add_string b (if String.lowercase_ascii prefix = "file://" then prefix ^ "<path>" ^ dots else whole);
    j
  in
  let rec go i =
    if i < n then
      let d = delimiter_length ~colon:true message i in
      if d > 0 then begin
        Buffer.add_string b (String.sub message i d);
        go (i + d)
      end
      else
        match url_prefix_end message i with
        | Some k -> go (url i k)
        | None ->
            let j = token_end ~colon:true message i in
            Buffer.add_string b (hide_path (String.sub message i (j - i)));
            go j
  in
  go 0;
  Buffer.contents b

let has_control = Work_text.has_control
let strip_controls = Work_text.strip_controls

(* Invalid UTF-8 is repaired first, so the scanner reads characters; then
   control, bidirectional, zero-width and tag characters are removed. *)
let safe_text message = Work_text.clean (sanitise (Work_text.repair message))

let debug_detail code raw =
  if Sys.getenv_opt "WORK_MCP_DEBUG" <> None then prerr_endline ("work-mcp: " ^ code ^ ": " ^ raw)

let repository_text =
  "the worklog data repository is missing, invalid or ambiguous; check WL_HOME (the location is not returned)"

let io_text = "an input/output error occurred in the data repository (the detail is not returned)"
let internal_text = "unexpected internal error (the detail is not returned)"

let of_worklog (e : W.Err.t) =
  let code = code_of_kind e.kind in
  debug_detail code e.message;
  match e.kind with
  | W.Err.Repo -> { code; message = repository_text }
  | W.Err.Other -> { code; message = io_text }
  | _ -> { code; message = safe_text e.message }

let internal raw =
  debug_detail "internal" raw;
  { code = "internal"; message = internal_text }

let to_json e =
  `Assoc [ ("error", `Assoc [ ("code", `String e.code); ("message", `String (safe_text e.message)) ]) ]

let ( let* ) = Result.bind

let lift r = Result.map_error of_worklog r
