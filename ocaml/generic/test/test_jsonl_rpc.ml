(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

module Envelope = Mesh_jsonl_rpc_envelope

(* Serve [input] with [handler] on in-memory flows and return the output
   lines, decoded as frames. *)
let exchange ?(config = Mesh_jsonl_rpc.config ()) handler input =
  let output = Buffer.create 256 in
  Eio_mock.Backend.run (fun () ->
      Mesh_jsonl_rpc.serve config handler (Eio.Flow.string_source input)
        (Eio.Flow.buffer_sink output));
  Buffer.contents output |> String.split_on_char '\n'
  |> List.filter (fun line -> line <> "")
  |> List.map (fun line ->
         match Envelope.decode_frame Mesh_jsonl_value.default_limits line with
         | Ok frame -> (line, frame)
         | Error problem -> Alcotest.failf "undecodable frame %s: %s" line problem.message)

let echo : Mesh_jsonl_rpc.handler =
 fun request ~emit ->
  match request.op with
  | "echo" -> Ok [ ("fields", `Int (List.length request.fields)) ]
  | "stream" ->
      ignore (emit "row" [ ("n", `Int 1) ]);
      ignore (emit "row" [ ("n", `Int 2); ("ok", `Bool false) ]);
      Ok [ ("done", `Bool true) ]
  | "big" -> Ok [ ("blob", `String (String.make 200 'b')) ]
  | "big-event" -> (
      match emit "row" [ ("blob", `String (String.make 200 'b')) ] with
      | Error `Too_large -> Ok [ ("refused", `Bool true) ]
      | Error `Not_json | Ok () -> Ok [ ("refused", `Bool false) ])
  | "nan-event" -> (
      match emit "row" [ ("x", `Float Float.nan) ] with
      | Error `Not_json -> Ok [ ("refused", `Bool true) ]
      | Error `Too_large | Ok () -> Ok [ ("refused", `Bool false) ])
  | "nan" -> Ok [ ("x", `Float Float.nan) ]
  | "not-utf8" -> Ok [ ("s", `String "\xff") ]
  | "raise" -> failwith "/private/path"
  | "busy" -> Error { Envelope.code = Code "busy"; message = "later" }
  | other -> Error { Envelope.code = Unknown_op; message = other }

let code_of = function
  | Envelope.Final { result = Error problem; _ } -> Envelope.code_to_string problem.code
  | Final { result = Ok _; _ } -> "ok"
  | Event { name; _ } -> "event:" ^ name

let req_of = function
  | Envelope.Final { req; _ } | Event { req; _ } -> Option.map Yojson.Safe.to_string req

let contains text fragment =
  let length = String.length fragment in
  let rec from index =
    index + length <= String.length text
    && (String.sub text index length = fragment || from (index + 1))
  in
  from 0

let summary frames = List.map (fun (_, frame) -> (code_of frame, req_of frame)) frames
let summaries = Alcotest.(list (pair string (option string)))

let test_requests_and_errors () =
  let input =
    String.concat "\n"
      [
        {|{"req":1,"op":"echo","x":2}|};
        "not json";
        "[1]";
        {|{"req":"r","op":""}|};
        {|{"req":3,"v":2,"op":"echo"}|};
        {|{"req":4,"op":"nope"}|};
        "   ";
        {|{"req":5,"op":"busy"}|};
        {|{"req":6,"op":"raise"}|};
        {|{"req":[[[[[[[[1]]]]]]]],"op":"echo"}|};
      ]
  in
  let config = Mesh_jsonl_rpc.config ~max_depth:4 ~max_in_flight:1 () in
  let frames = exchange ~config echo input in
  Alcotest.check summaries "one answer per request, req echoed when readable"
    [
      ("ok", Some "1");
      ("bad_request", None);
      ("bad_request", None);
      ("bad_request", Some {|"r"|});
      ("unsupported_version", Some "3");
      ("unknown_op", Some "4");
      ("busy", Some "5");
      ("internal", Some "6");
      ("bad_request", None);
    ]
    (summary frames);
  let raised = List.nth frames 7 |> fst in
  Alcotest.(check bool) "no exception text in the answer" false
    (contains raised "/private/path");
  Alcotest.(check bool) "every frame is versioned" true
    (List.for_all (fun (line, _) -> contains line {|"v":1|}) frames)

let test_stream () =
  let frames = exchange echo {|{"req":"s","op":"stream"}|} in
  Alcotest.check summaries "events then the final answer"
    [ ("event:row", Some {|"s"|}); ("event:row", Some {|"s"|}); ("ok", Some {|"s"|}) ]
    (summary frames);
  match List.map snd frames with
  | [ _; Event { fields; _ }; Final { result = Ok final; _ } ] ->
      Alcotest.(check bool) "reserved key dropped from an event" true
        (fields = [ ("n", `Int 2) ]);
      Alcotest.(check bool) "final fields" true (final = [ ("done", `Bool true) ])
  | _ -> Alcotest.fail "unexpected frames"

let test_bounds () =
  let config = Mesh_jsonl_rpc.config ~max_request_bytes:64 ~max_response_bytes:120 () in
  let long_request = Printf.sprintf {|{"req":1,"op":"echo","pad":"%s"}|} (String.make 100 'p') in
  let input =
    String.concat "\n"
      [ long_request; {|{"req":2,"op":"big"}|}; {|{"req":3,"op":"big-event"}|}; {|{"req":4,"op":"echo"}|} ]
  in
  let frames = exchange ~config echo input in
  Alcotest.check summaries "bounded in both directions, serving goes on"
    [ ("bad_request", None); ("too_large", Some "2"); ("ok", Some "3"); ("ok", Some "4") ]
    (summary frames);
  match snd (List.nth frames 2) with
  | Final { result = Ok fields; _ } ->
      Alcotest.(check bool) "oversized event refused to the handler" true
        (fields = [ ("refused", `Bool true) ])
  | _ -> Alcotest.fail "unexpected frame"

(* No input line stops the server: each gets a final frame, and the request
   after it is still answered. *)
let test_hostile_lines () =
  let deep_behind_comment = {|/*"*/{"req":7,"op":"echo","x":[[[[[[[[1]]]]]]]]}|} in
  let input =
    String.concat "\n"
      [
        deep_behind_comment;
        {|{"req":NaN,"op":"x"}|};
        {|{"req":Infinity}|};
        {|{"req":1,"op":"nan"}|};
        {|{"req":2,"op":"not-utf8"}|};
        {|{"req":3,"op":"nan-event"}|};
        "{\"req\":4,\"op\":\"echo\",\"s\":\"\xff\"}";
        "{\"req\":5,\"op\":\"echo\",\"s\":\"\001\"}";
        {|{"req":6,"op":"echo"}|};
      ]
  in
  let config = Mesh_jsonl_rpc.config ~max_depth:4 ~max_in_flight:1 () in
  let frames = exchange ~config echo input in
  Alcotest.check summaries "an error frame each, then service goes on"
    [
      ("bad_request", None);
      ("bad_request", None);
      ("bad_request", None);
      ("internal", Some "1");
      ("internal", Some "2");
      ("ok", Some "3");
      ("bad_request", None);
      ("bad_request", None);
      ("ok", Some "6");
    ]
    (summary frames);
  match snd (List.nth frames 5) with
  | Final { result = Ok fields; _ } ->
      Alcotest.(check bool) "a non-finite event refused to the handler" true
        (fields = [ ("refused", `Bool true) ])
  | _ -> Alcotest.fail "unexpected frame"

let test_last_line_without_newline () =
  let frames = exchange echo {|{"req":1,"op":"echo"}|} in
  Alcotest.check summaries "answered" [ ("ok", Some "1") ] (summary frames)

let test_concurrent_requests () =
  (* The first request waits for the second: answering both requires two
     requests in progress at once. *)
  let release, resolver = Eio.Promise.create () in
  let handler : Mesh_jsonl_rpc.handler =
   fun request ~emit:_ ->
    match request.op with
    | "wait" ->
        Eio.Promise.await release;
        Ok []
    | _ ->
        Eio.Promise.resolve resolver ();
        Ok []
  in
  let config = Mesh_jsonl_rpc.config ~max_in_flight:2 () in
  let frames = exchange ~config handler "{\"req\":1,\"op\":\"wait\"}\n{\"req\":2,\"op\":\"go\"}\n" in
  Alcotest.check summaries "second answered first" [ ("ok", Some "2"); ("ok", Some "1") ] (summary frames)

(* A [req] that holds an escaped lone surrogate is echoed as it was sent:
   the U+FFFD that replaces it in the other fields would not match it. *)
let test_req_with_lone_surrogate () =
  let requests = [ {|"a\ud800b"|}; {|{"k":["\udc00",1]}|}; {|"\\ud800"|} ] in
  let input = String.concat "" (List.map (fun req -> Printf.sprintf {|{"req":%s,"op":"stream"}|} req ^ "\n") requests) in
  let frames = exchange echo input in
  Alcotest.(check int) "every frame answered" 9 (List.length frames);
  List.iteri
    (fun index req ->
      let lines = List.map fst (List.filteri (fun position _ -> position / 3 = index) frames) in
      Alcotest.(check bool) ("echoed as sent: " ^ req) true (List.for_all (fun line -> contains line ({|"req":|} ^ req)) lines))
    requests

(* A [req] with a lone surrogate and a non-finite number has no strict JSON
   form: it is refused, and every frame stays strict JSON. *)
let test_req_with_lone_surrogate_not_finite () =
  let requests = [ {|["\ud800",NaN]|}; {|["\ud800",Infinity]|}; {|{"k":"\udc00","n":-Infinity}|} ] in
  let input = String.concat "" (List.map (fun req -> Printf.sprintf {|{"req":%s,"op":"echo"}|} req ^ "\n") requests) in
  let frames = exchange echo input in
  Alcotest.check summaries "refused, without the req"
    [ ("bad_request", None); ("bad_request", None); ("bad_request", None) ]
    (summary frames);
  List.iter
    (fun (line, _) ->
      (* The decoder reads a NaN or an infinity as Python does; the encoder
         refuses them. *)
      let strict =
        Result.is_ok
          (Result.bind (Mesh_jsonl_value.decode Mesh_jsonl_value.default_limits line)
             (Mesh_jsonl_value.encode ~max_bytes:max_int))
      in
      Alcotest.(check bool) ("strict JSON: " ^ line) true strict)
    frames

let test_envelope_round_trip () =
  let frame = Envelope.request ~req:(`Int 9) "describe" [ ("pids", `List [ `Int 1 ]); ("op", `String "x") ] in
  match Envelope.decode_request Mesh_jsonl_value.default_limits (Yojson.Safe.to_string frame) with
  | Error _ -> Alcotest.fail "request did not decode"
  | Ok request ->
      Alcotest.(check string) "op not overridden by a field" "describe" request.op;
      Alcotest.(check int) "version" 1 request.request_version;
      Alcotest.(check bool) "req" true (request.req = Some (`Int 9));
      Alcotest.(check string) "codes round trip" "busy"
        (Envelope.code_to_string (Envelope.code_of_string "busy"))

let () =
  Alcotest.run "mesh_jsonl_rpc"
    [
      ( "rpc",
        [
          Alcotest.test_case "requests and errors" `Quick test_requests_and_errors;
          Alcotest.test_case "streamed events" `Quick test_stream;
          Alcotest.test_case "line bounds" `Quick test_bounds;
          Alcotest.test_case "hostile lines" `Quick test_hostile_lines;
          Alcotest.test_case "last line without newline" `Quick test_last_line_without_newline;
          Alcotest.test_case "requests in parallel" `Quick test_concurrent_requests;
          Alcotest.test_case "envelope round trip" `Quick test_envelope_round_trip;
          Alcotest.test_case "req with a lone surrogate" `Quick test_req_with_lone_surrogate;
          Alcotest.test_case "req with a lone surrogate and NaN" `Quick test_req_with_lone_surrogate_not_finite;
        ] );
    ]
