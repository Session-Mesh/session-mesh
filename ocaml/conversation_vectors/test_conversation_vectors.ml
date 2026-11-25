(* SPDX-License-Identifier: AGPL-3.0-or-later
   Copyright (c) 2026 Atacama <contact@atacama.tech> *)

module Codec = Conversation_codec
module Json = Yojson.Safe.Util

let read path = In_channel.with_open_bin path In_channel.input_all

let write path contents =
  Out_channel.with_open_bin path (fun channel -> output_string channel contents)

let with_registry contents run =
  let directory = Filename.temp_file "mesh-conversation-vectors" "" in
  Sys.remove directory;
  Unix.mkdir directory 0o700;
  Fun.protect
    ~finally:(fun () ->
      Array.iter
        (fun name -> Sys.remove (Filename.concat directory name))
        (Sys.readdir directory);
      Unix.rmdir directory)
    (fun () ->
      let path = Filename.concat directory "names.json" in
      write path contents;
      run path)

let rec sort_fields = function
  | `Assoc fields ->
      fields
      |> List.map (fun (key, value) -> (key, sort_fields value))
      |> List.sort (fun (left, _) (right, _) -> String.compare left right)
      |> fun fields -> `Assoc fields
  | `List values -> `List (List.map sort_fields values)
  | value -> value

let canonical value = Yojson.Safe.to_string (sort_fields value)

let check_json message expected actual =
  Alcotest.(check string) message (canonical expected) (canonical actual)

let version = ("version", `Int 1)

let request ~path ~at op fields =
  let request =
    `Assoc (version :: ("op", `String op) :: ("clock_now", at) :: fields)
  in
  Yojson.Safe.to_string ~std:true request
  |> Conversation_protocol.handle ~path
  |> Codec.parse_json

let protocol_fields step call args =
  let kwargs = Json.(step |> member "kwargs" |> to_assoc) in
  match (call, args) with
  | "snapshot", [] -> (call, kwargs)
  | "active_aliases", [ sessions ] ->
      ("observe", [ ("listed", `Bool false); ("sessions", sessions) ])
  | "observe", [ sessions ] ->
      (call, ("sessions", sessions) :: ("project", `Bool false) :: kwargs)
  | "rename", [ name; created; old_label; new_label ] ->
      ( call,
        [
          ("name", name);
          ("created", created);
          ("old", old_label);
          ("new", new_label);
        ] )
  | "close", [ name; created ] ->
      (call, [ ("name", name); ("created", created) ])
  | ("forget" | "last_label"), [ agent; sid ] ->
      (call, [ ("agent", agent); ("sid", sid) ])
  | "enrich", [ item ] ->
      ( call,
        [ ("agent", Json.member "agent" item); ("id", Json.member "id" item) ]
      )
  | _ -> Alcotest.failf "Unsupported reference call or arguments for %s" call

let project_result call args result =
  match (call, args) with
  | "enrich", [ item ] -> `Assoc (Json.to_assoc item @ Json.to_assoc result)
  | "active_aliases", [ `List sessions ] ->
      `List
        (List.map2
           (fun session aliases ->
             `Assoc (("aliases", aliases) :: Json.to_assoc session))
           sessions (Json.to_list result))
  | _ -> result

let replay_step ~path index step =
  let call = Json.(step |> member "call" |> to_string) in
  let message = Printf.sprintf "step %d (%s)" (index + 1) call in
  let args = Json.(step |> member "args" |> to_list) in
  let at = Json.member "at" step in
  let operation, fields = protocol_fields step call args in
  let before = read path in
  let response = request ~path ~at operation fields in
  let mutated = Json.member "registry_bytes_changed" step in
  let expect_result expected =
    check_json message (`Assoc [ version; ("result", expected) ]) response
  in
  (if mutated = `Null then (
      let project_field = function
        | "result", result -> ("result", project_result call args result)
        | field -> field
      in
      check_json message
        (`Assoc [ version; ("result", Json.member "expected" step) ])
        (`Assoc (List.map project_field (Json.to_assoc response))))
  else (
      expect_result `Null;
      check_json (message ^ " snapshot")
        (`Assoc [ version; ("result", Json.member "expected" step) ])
        (request ~path ~at "snapshot" [])));
  let changed = mutated <> `Null && Json.to_bool mutated in
  Alcotest.(check bool)
    (message ^ " registry bytes changed")
    changed
    (before <> read path)

let test_case case =
  let id = Json.(case |> member "id" |> to_string) in
  Alcotest.test_case id `Quick (fun () ->
      let contents =
        match Json.member "registry_json" case with
        | `String raw -> raw
        | _ -> Yojson.Safe.to_string ~std:true (Json.member "registry_rows" case)
      in
      with_registry contents (fun path ->
          List.iteri (replay_step ~path)
            Json.(case |> member "steps" |> to_list)))

let () =
  let vectors = Codec.parse_json (read "fixtures/vectors.json") in
  Alcotest.run "legacy conversation registry"
    [
      ( "golden vectors",
        [
          Alcotest.test_case "fixture schema" `Quick (fun () ->
              Alcotest.(check int)
                "version" 1
                Json.(vectors |> member "version" |> to_int));
        ]
        @ List.map test_case Json.(vectors |> member "cases" |> to_list) );
    ]
