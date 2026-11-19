(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

let draws_per_length = 20

let hex rng digits =
  String.init digits (fun _ -> "0123456789abcdef".[Random.State.int rng 16])

let draw_in rng ~taken ~prefix ~noun ~min_digits ~max_digits =
  let tbl = Hashtbl.create 64 in
  List.iter (fun h -> Hashtbl.replace tbl (String.lowercase_ascii h) ()) taken;
  let rec at_length digits tries =
    if tries = 0 then None
    else
      let candidate = hex rng digits in
      if Hashtbl.mem tbl candidate then at_length digits (tries - 1) else Some candidate
  in
  let rec go digits =
    if digits > max_digits then Err.fail Err.Other ("could not draw a free " ^ noun ^ " id")
    else
      match at_length digits draws_per_length with
      | Some c -> prefix ^ "-" ^ c
      | None -> go (digits + 1)
  in
  go min_digits

let task rng ~taken = draw_in rng ~taken ~prefix:"T" ~noun:"task" ~min_digits:4 ~max_digits:8
let project rng ~taken = draw_in rng ~taken ~prefix:"P" ~noun:"project" ~min_digits:4 ~max_digits:8

let blocker rng ~taken =
  draw_in rng ~taken ~prefix:"B" ~noun:"blocker" ~min_digits:6 ~max_digits:6
