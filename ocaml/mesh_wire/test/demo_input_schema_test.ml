(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

let () =
  let path = Sys.getenv "MESH_DEMO_INPUT_SCHEMA_VECTORS" in
  let json = Yojson.Safe.from_file path in
  let vectors =
    match json with
    | `Assoc [ ("vectors", `List xs) ] -> xs
    | _ -> failwith "vectors"
  in
  List.iter
    (function
      | `Assoc fields ->
          let name =
            match List.assoc "name" fields with
            | `String x -> x
            | _ -> assert false
          in
          let make_controls count =
            List.init count (fun i ->
                `Assoc
                  [
                    ("type", `String "toggle");
                    ("id", `String ("c" ^ string_of_int i));
                    ("label", `String ("C" ^ string_of_int i));
                    ("initial", `Bool false);
                  ])
          in
          let make_choices count =
            let rec loop at control acc =
              if at = count then List.rev acc
              else
                let n = min 16 (count - at) in
                let options =
                  List.init n (fun i -> "o" ^ string_of_int (at + i))
                in
                let value =
                  `Assoc
                    [
                      ("type", `String "choice");
                      ("id", `String ("c" ^ string_of_int control));
                      ("label", `String ("C" ^ string_of_int control));
                      ("options", `List (List.map (fun s -> `String s) options));
                      ("initial", `String (List.hd options));
                    ]
                in
                loop (at + n) (control + 1) (value :: acc)
            in
            loop 0 0 []
          in
          let encode controls =
            Yojson.Safe.to_string
              (`Assoc
                 [
                   ("format", `String "mesh-input-schema-v1");
                   ("controls", `List controls);
                 ])
          in
          let bytes =
            match List.assoc_opt "bytes" fields with
            | Some (`String x) -> x
            | _ -> begin
                let count =
                  match List.assoc "count" fields with
                  | `Int n -> n
                  | _ -> assert false
                in
                match List.assoc "fixture" fields with
                | `String "controls" -> encode (make_controls count)
                | `String "label" ->
                    let label =
                      String.concat "" (List.init (count / 2) (fun _ -> "é"))
                      ^ if count mod 2 = 0 then "" else "x"
                    in
                    encode
                      [
                        `Assoc
                          [
                            ("type", `String "toggle");
                            ("id", `String "x");
                            ("label", `String label);
                            ("initial", `Bool false);
                          ];
                      ]
                | `String "id" ->
                    encode
                      [
                        `Assoc
                          [
                            ("type", `String "toggle");
                            ("id", `String (String.make count 'a'));
                            ("label", `String "X");
                            ("initial", `Bool false);
                          ];
                      ]
                | `String "choice-options" ->
                    let options =
                      List.init count (fun i -> "o" ^ string_of_int i)
                    in
                    encode
                      [
                        `Assoc
                          [
                            ("type", `String "choice");
                            ("id", `String "x");
                            ("label", `String "X");
                            ( "options",
                              `List (List.map (fun x -> `String x) options) );
                            ( "initial",
                              `String
                                (match options with x :: _ -> x | [] -> "o0") );
                          ];
                      ]
                | `String (("options" | "bytes") as kind) ->
                    let controls =
                      make_choices (if kind = "bytes" then 64 else count)
                    in
                    if kind = "options" then encode controls
                    else
                      let needed =
                        ref (count - String.length (encode controls))
                      in
                      let controls =
                        List.map
                          (function
                            | `Assoc fields ->
                                let fields =
                                  List.map
                                    (function
                                      | "options", `List values ->
                                          let index = ref 0 in
                                          let values =
                                            List.map
                                              (function
                                                | `String s ->
                                                    let add =
                                                      if !index = 0 then 0
                                                      else
                                                        min
                                                          (128 - String.length s)
                                                          !needed
                                                    in
                                                    incr index;
                                                    needed := !needed - add;
                                                    `String
                                                      (s ^ String.make add 'x')
                                                | value -> value)
                                              values
                                          in
                                          ("options", `List values)
                                      | field -> field)
                                    fields
                                in
                                let initial =
                                  match List.assoc "options" fields with
                                  | `List (`String first :: _) -> `String first
                                  | _ -> assert false
                                in
                                `Assoc
                                  (List.map
                                     (fun (key, value) ->
                                       if key = "initial" then (key, initial)
                                       else (key, value))
                                     fields)
                            | value -> value)
                          controls
                      in
                      Alcotest.(check int)
                        (name ^ " fixture capacity")
                        0 !needed;
                      encode controls
                | _ -> assert false
              end
          in
          let expected =
            match List.assoc "valid" fields with
            | `Bool x -> x
            | _ -> assert false
          in
          let actual = Result.is_ok (Mesh_demo_input_schema.decode bytes) in
          Alcotest.(check bool) name expected actual
      | _ -> failwith "vector")
    vectors
