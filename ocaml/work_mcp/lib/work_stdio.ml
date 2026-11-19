(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

let max_nesting = 32

(* The deepest nesting of brackets and braces outside strings, stopping as
   soon as it exceeds the limit: one pass, constant memory. *)
let too_deep line =
  let n = String.length line in
  let rec go i depth in_string escaped =
    if depth > max_nesting then true
    else if i >= n then false
    else
      let c = line.[i] in
      if in_string then
        if escaped then go (i + 1) depth true false
        else if c = '\\' then go (i + 1) depth true true
        else go (i + 1) depth (c <> '"') false
      else
        match c with
        | '"' -> go (i + 1) depth true false
        | '[' | '{' -> go (i + 1) (depth + 1) false false
        | ']' | '}' -> go (i + 1) (depth - 1) false false
        | _ -> go (i + 1) depth false false
  in
  go 0 0 false false

let refusal =
  {|{"jsonrpc":"2.0","id":null,"error":{"code":-32600,"message":"request refused: JSON nested too deeply"}}|}

let run server input output =
  let session = Mcp_kit.Server.create_session server in
  let rec loop () =
    match input_line input with
    | line ->
        let frames = if too_deep line then [ refusal ] else Mcp_kit_stdio.serve_session_line_frames session line in
        List.iter
          (fun response ->
            output_string output response;
            output_char output '\n')
          frames;
        flush output;
        loop ()
    | exception End_of_file -> ()
  in
  loop ()
