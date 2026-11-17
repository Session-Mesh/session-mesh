(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(* Test-only adapter: the HPKE laboratory seals the exact OCaml content object,
   instead of maintaining a second Python encoder for the artifact shape. *)
module A = Mesh_demo_artifact
module T = Mesh_runner_target

let fail () = failwith "invalid demo artifact fixture input"
let ok = function Ok value -> value | Error _ -> fail ()

let key =
  T.resource_key
    ~runner:(ok (T.Runner_id.of_string "runner-opaque-01"))
    ~resource:(ok (T.Resource_id.of_string "resource-opaque-01"))
    ~incarnation:
      (ok (T.Incarnation.of_string "11111111111111111111111111111111"))

let exact_fields fields =
  List.sort String.compare (List.map fst fields)
  = [ "content_b64"; "format"; "revision" ]

let decode_content encoded =
  match Base64.decode ~pad:false ~alphabet:Base64.uri_safe_alphabet encoded with
  | Error _ -> fail ()
  | Ok content ->
      if
        Base64.encode_string ~pad:false ~alphabet:Base64.uri_safe_alphabet
          content
        <> encoded
      then fail ();
      content

let artifact = function
  | `Assoc fields when exact_fields fields -> begin
      match
        ( List.assoc "revision" fields,
          List.assoc "format" fields,
          List.assoc "content_b64" fields )
      with
      | `Int revision, `String format, `String encoded ->
          let format =
            match format with
            | "mesh-scene-v0" -> A.Scene_v0
            | "tsx-quickjs-v0" -> A.Tsx_quickjs_v0
            | _ -> fail ()
          in
          let content = decode_content encoded in
          let value = ok (A.create ~key ~revision ~format ~content) in
          `String (A.encode value)
      | _ -> fail ()
    end
  | _ -> fail ()

let () =
  let input = input_line stdin in
  if String.length input > 5 * A.max_encoded_bytes then fail ();
  let entries =
    match Yojson.Safe.from_string input with
    | `List entries when List.length entries <= 6 -> entries
    | _ -> fail ()
  in
  print_endline (Yojson.Safe.to_string (`List (List.map artifact entries)))
