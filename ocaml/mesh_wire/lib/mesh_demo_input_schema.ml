(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

type t = string
type error = Too_large | Malformed | Noncanonical | Invalid_schema

let max_encoded_bytes = 8 * 1024
let safe_int value = value >= -1_000_000 && value <= 1_000_000

let printable value =
  value <> ""
  && String.length value <= 128
  &&
  let decoder = Uutf.decoder ~encoding:`UTF_8 (`String value) in
  let rec loop () =
    match Uutf.decode decoder with
    | `End -> true
    | `Malformed _ -> false
    | `Await -> assert false
    | `Uchar u ->
        let c = Uucp.Gc.general_category u in
        c <> `Cc && c <> `Cf && c <> `Zl && c <> `Zp && loop ()
  in
  loop ()

let valid_id value =
  let n = String.length value in
  n >= 1 && n <= 32
  && (match value.[0] with 'A' .. 'Z' | 'a' .. 'z' -> true | _ -> false)
  && String.for_all
       (function
         | 'A' .. 'Z' | 'a' .. 'z' | '0' .. '9' | '_' | '-' -> true | _ -> false)
       value

let decode bytes =
  if String.length bytes > max_encoded_bytes then Error Too_large
  else
    try
      let json = Yojson.Safe.from_string bytes in
      if Yojson.Safe.to_string json <> bytes then Error Noncanonical
      else
        match json with
        | `Assoc
            [
              ("format", `String "mesh-input-schema-v1");
              ("controls", `List controls);
            ]
          when List.length controls >= 1 && List.length controls <= 16 ->
            let ids = Hashtbl.create 16 and option_count = ref 0 in
            let common id label =
              valid_id id && (not (Hashtbl.mem ids id)) && printable label
            in
            let rec loop = function
              | [] -> Ok bytes
              | `Assoc fields :: rest ->
                  let accepted =
                    match fields with
                    | [
                     ("type", `String "range");
                     ("id", `String id);
                     ("label", `String label);
                     ("min", `Int min);
                     ("max", `Int max);
                     ("step", `Int step);
                     ("initial", `Int initial);
                    ] ->
                        common id label
                        && List.for_all safe_int [ min; max; step; initial ]
                        && step > 0 && min <= max && initial >= min
                        && initial <= max
                        && (initial - min) mod step = 0
                        && (max - min) mod step = 0
                    | [
                        ("type", `String "toggle");
                        ("id", `String id);
                        ("label", `String label);
                        ("initial", `Bool _);
                      ]
                    | [
                        ("type", `String "action");
                        ("id", `String id);
                        ("label", `String label);
                        ("initial", `Int 0);
                      ] ->
                        common id label
                    | [
                     ("type", `String "choice");
                     ("id", `String id);
                     ("label", `String label);
                     ("options", `List values);
                     ("initial", `String initial);
                    ] ->
                        let strings =
                          List.filter_map
                            (function `String s -> Some s | _ -> None)
                            values
                        in
                        common id label
                        && List.length strings = List.length values
                        && List.length strings >= 2
                        && List.length strings <= 16
                        && List.length (List.sort_uniq String.compare strings)
                           = List.length strings
                        && List.for_all printable strings
                        && List.mem initial strings
                        && !option_count + List.length strings <= 64
                    | _ -> false
                  in
                  if not accepted then Error Invalid_schema
                  else
                    let id =
                      match List.assoc "id" fields with
                      | `String s -> s
                      | _ -> assert false
                    in
                    Hashtbl.add ids id ();
                    (match List.assoc "type" fields with
                    | `String "choice" -> (
                        option_count :=
                          !option_count
                          +
                          match List.assoc "options" fields with
                          | `List xs -> List.length xs
                          | _ -> 0)
                    | _ -> ());
                    loop rest
              | _ -> Error Invalid_schema
            in
            loop controls
        | _ -> Error Invalid_schema
    with Yojson.Json_error _ | Stack_overflow -> Error Malformed

let bytes value = value
