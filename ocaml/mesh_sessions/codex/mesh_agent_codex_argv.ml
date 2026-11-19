(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

let hex = function '0' .. '9' | 'a' .. 'f' -> true | _ -> false

let thread_id word =
  String.length word = 36
  && List.for_all (fun index -> word.[index] = '-') [ 8; 13; 18; 23 ]
  && String.for_all hex (String.concat "" (String.split_on_char '-' word))
  && List.length (String.split_on_char '-' word) = 5

(* [os.path.basename]: what follows the last slash. *)
let basename word =
  match String.rindex_opt word '/' with
  | Some index -> String.sub word (index + 1) (String.length word - index - 1)
  | None -> word

let node_entry script =
  let parts = String.split_on_char '/' script in
  let length = List.length parts in
  String.starts_with ~prefix:"/" script
  && length >= 4
  && List.filteri (fun index _ -> index >= length - 4) parts = [ "@openai"; "codex"; "bin"; "codex.js" ]

let package = "@openai/codex"

let version_char = function '0' .. '9' | 'A' .. 'Z' | 'a' .. 'z' | '.' | '_' | '-' -> true | _ -> false

let is_package spec =
  spec = package
  ||
  let prefix = package ^ "@" in
  String.starts_with ~prefix spec
  && String.length spec > String.length prefix
  && String.for_all version_char (String.sub spec (String.length prefix) (String.length spec - String.length prefix))

let rec drop_runner_flags = function ("-y" | "--yes") :: rest -> drop_runner_flags rest | rest -> rest

let entry_args = function
  | [] -> None
  | first :: rest -> (
      match (basename first, rest) with
      | "codex", _ -> Some rest
      | ("node" | "nodejs"), script :: after when node_entry script -> Some after
      | ("npx" | "bunx"), _ -> (
          match drop_runner_flags rest with spec :: after when is_package spec -> Some after | _ -> None)
      | _ -> None)

(* [_CODEX] without [restrictive]: whether each known option takes a value. *)
let takes_value =
  [ "--model"; "-m"; "--config"; "-c"; "--profile"; "-p"; "--sandbox"; "-s"; "--ask-for-approval"; "-a"; "--cd";
    "-C"; "--add-dir"; "--enable"; "--disable"; "--local-provider"; "--remote"; "--remote-auth-token-env";
    "--image"; "-i" ]

let flags =
  [ "--yolo"; "--dangerously-bypass-approvals-and-sandbox"; "--full-auto"; "--search"; "--oss"; "--approve-for-me";
    "--no-daemon"; "--strict-config"; "--dangerously-bypass-hook-trust"; "--no-alt-screen"; "--last"; "--worktree" ]

let category name =
  if List.mem name takes_value then Some true else if List.mem name flags then Some false else None

(* [_short_option]: [-Xrest] where [-X] is a known short option. *)
let short_option arg =
  if String.length arg < 3 || arg.[0] <> '-' || arg.[1] = '-' || arg.[2] = '=' then None
  else
    let name = String.sub arg 0 2 in
    if category name <> None then Some name else None

let option_name arg = match String.index_opt arg '=' with Some index -> String.sub arg 0 index | None -> arg

let rec scan = function
  | [] -> None
  | "resume" :: rest -> ( match rest with following :: _ when thread_id following -> Some following | _ -> None)
  | arg :: _ when (not (String.starts_with ~prefix:"-" arg)) || arg = "-" || arg = "--" -> None
  | arg :: rest -> (
      let short = short_option arg in
      match category (match short with Some name -> name | None -> option_name arg) with
      | None -> None
      | Some value ->
          let attached = short <> None || String.contains arg '=' in
          if value && not attached then match rest with _ :: rest -> scan rest | [] -> None else scan rest)

let resumed_id words = Option.bind (entry_args words) scan

(* The code points of UTF-8 text; [None] when it is not valid UTF-8. *)
let decode text =
  let rec loop index acc =
    if index >= String.length text then Some (Array.of_list (List.rev acc))
    else
      let decoded = String.get_utf_8_uchar text index in
      if Uchar.utf_decode_is_valid decoded then loop (index + Uchar.utf_decode_length decoded) (Uchar.utf_decode_uchar decoded :: acc)
      else None
  in
  loop 0 []

(* CPython's [handle_capital_sigma]: a capital sigma after a cased letter
   and not before one (case-ignorable code points skipped) is final. *)
let final_sigma chars index =
  let rec skip step j =
    if j >= 0 && j < Array.length chars && Uucp.Case.is_case_ignorable chars.(j) then skip step (j + step) else j
  in
  let before = skip (-1) (index - 1) and after = skip 1 (index + 1) in
  before >= 0 && Uucp.Case.is_cased chars.(before) && (after = Array.length chars || not (Uucp.Case.is_cased chars.(after)))

let lower_char chars buffer index char =
  if Uchar.to_int char = 0x3A3 then Buffer.add_utf_8_uchar buffer (Uchar.of_int (if final_sigma chars index then 0x3C2 else 0x3C3))
  else
    match Uucp.Case.Map.to_lower char with
    | `Self -> Buffer.add_utf_8_uchar buffer char
    | `Uchars chars -> List.iter (Buffer.add_utf_8_uchar buffer) chars

let python_lower text =
  if String.for_all (fun char -> Char.code char < 0x80) text then Some (String.lowercase_ascii text)
  else
    Option.map
      (fun chars ->
        let buffer = Buffer.create (String.length text) in
        Array.iteri (lower_char chars buffer) chars;
        Buffer.contents buffer)
      (decode text)

let may_name words id =
  let named =
    match Option.bind id python_lower with
    | Some id -> List.exists (fun word -> python_lower word = Some id) words
    | None -> false
  in
  named || (List.mem "resume" words && resumed_id words = None)
