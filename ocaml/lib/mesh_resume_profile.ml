(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

type kind = Claude | Codex
type error = Invalid

type t = {
  kind : kind;
  sid : string;
  arguments : string list;
  fingerprint : string;
}

let kind t = t.kind
let conversation_id t = t.sid
let arguments t = t.arguments
let fingerprint t = t.fingerprint

let selector t ~source ~receipt ~cwd =
  let encoded =
    Yojson.Basic.to_string
      (`Assoc
         [
           ("cwd", `String cwd);
           ("profile", `String t.fingerprint);
           ("receipt", `String receipt);
           ("source", `String source);
         ])
  in
  "resume-" ^ Digestif.SHA256.(to_hex (digest_string encoded))

let name = function Claude -> "claude" | Codex -> "codex"

let canonical_id sid =
  String.length sid = 36
  && List.for_all (fun i -> sid.[i] = '-') [ 8; 13; 18; 23 ]
  && String.exists (function '1' .. '9' | 'a' .. 'f' -> true | _ -> false) sid
  && String.for_all
       (function '0' .. '9' | 'a' .. 'f' | '-' -> true | _ -> false)
       sid
  && String.length (String.concat "" (String.split_on_char '-' sid)) = 32

let canonical kind sid arguments =
  `Assoc
    [
      ("arguments", `List (List.map (fun x -> `String x) arguments));
      ("conversationId", `String sid);
      ("kind", `String (name kind));
      ("version", `Int 1);
    ]

let to_json t =
  match canonical t.kind t.sid t.arguments with
  | `Assoc fields -> `Assoc (fields @ [ ("fingerprint", `String t.fingerprint) ])
  | _ -> assert false

let of_json value =
  try
    match value with
    | `Assoc fields
      when List.sort String.compare (List.map fst fields)
           = [ "arguments"; "conversationId"; "fingerprint"; "kind"; "version" ]
      ->
        let member n = List.assoc n fields in
        let kind =
          match member "kind" with
          | `String "claude" -> Claude
          | `String "codex" -> Codex
          | _ -> raise Exit
        in
        let sid = Yojson.Basic.Util.to_string (member "conversationId") in
        let arguments =
          List.map Yojson.Basic.Util.to_string
            (Yojson.Basic.Util.to_list (member "arguments"))
        in
        let fingerprint = Yojson.Basic.Util.to_string (member "fingerprint") in
        let prefix =
          match kind with Claude -> "--resume" | Codex -> "resume"
        in
        if
          member "version" <> `Int 1
          || (not (canonical_id sid))
          || List.length arguments > 256
          || (not
                (List.for_all
                   (fun a ->
                     String.length a <= 16384 && not (String.contains a '\000'))
                   arguments))
          ||
          match arguments with
          | first :: id :: _ -> first <> prefix || id <> sid
          | _ -> true
        then Error Invalid
        else
          let encoded = Yojson.Basic.to_string (canonical kind sid arguments) in
          if
            String.length encoded > 1048576
            || Digestif.SHA256.(to_hex (digest_string encoded)) <> fingerprint
          then Error Invalid
          else Ok { kind; sid; arguments; fingerprint }
    | _ -> Error Invalid
  with Yojson.Basic.Util.Type_error _ | Exit -> Error Invalid

let new_claude ~conversation_id =
  let body = canonical Claude conversation_id [ "--resume"; conversation_id ] in
  let fingerprint =
    Digestif.SHA256.(to_hex (digest_string (Yojson.Basic.to_string body)))
  in
  match body with
  | `Assoc fields ->
      of_json (`Assoc (fields @ [ ("fingerprint", `String fingerprint) ]))
  | _ -> Error Invalid
