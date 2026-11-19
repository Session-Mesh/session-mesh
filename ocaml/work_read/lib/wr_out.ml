(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

module E = Work_mcp.Work_err
module R = Work_mcp.Work_render
module T = Work_mcp.Work_text

let max_output_bytes = 1_000_000
let schema_version = 1
let truncated = ref false
let reset () = truncated := false
let mark_truncated () = truncated := true

let list key n items =
  let kept, omitted = R.cap n items in
  if omitted > 0 then mark_truncated ();
  (key, `List kept) :: (if omitted > 0 then [ (key ^ "_omitted", `Int omitted) ] else [])

let text ~max s =
  let cleaned = T.clean s in
  if String.length cleaned > max then mark_truncated ();
  `String (R.trunc ~max s)

let document command fields =
  `Assoc
    ((("schema", `Int schema_version) :: ("command", `String command) :: fields)
    @ [ ("truncated", `Bool !truncated) ])

let error_document (e : E.t) =
  `Assoc [ ("error", `Assoc [ ("code", `String e.code); ("message", `String (E.safe_text e.message)) ]) ]

let exit_code (e : E.t) =
  match e.code with
  | "invalid_input" -> 2
  | "not_found" -> 3
  | "malformed_data" -> 4
  | "lock_timeout" -> 5
  | "repository" -> 6
  | "internal" -> 7
  | _ -> 1

let rec scrub = function
  | `String s -> `String (T.clean s)
  | `List l -> `List (List.map scrub l)
  | `Assoc l -> `Assoc (List.map (fun (k, v) -> (T.clean k, scrub v)) l)
  | v -> v

let print json =
  print_string (Yojson.Safe.to_string json);
  print_char '\n'

let bounded json =
  match Wr_fit.fit ~max:max_output_bytes (scrub json) with
  | Some json -> Ok json
  | None -> Error (E.make "output_too_large" "the result is larger than the output bound; narrow the request")

let finish result =
  match Result.bind result bounded with
  | Ok json ->
      print json;
      0
  | Error e ->
      print (error_document e);
      exit_code e
