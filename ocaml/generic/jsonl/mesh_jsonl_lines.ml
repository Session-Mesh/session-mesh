(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

type line = Line of string | Too_long
type start = At_line_start | Skip_first_line | Inside_long_line

(* [Collecting]: the pending bytes are in [buffer]. [Dropping]: the pending
   bytes belong to an over-long line, counted in [pending] but not kept.
   [Skipping]: the same, for the first line of a window, reported to nobody. *)
type mode = Collecting | Dropping | Skipping

type t = {
  max_line_bytes : int;
  buffer : Buffer.t;
  mutable mode : mode;
  mutable consumed : int;
  mutable pending : int;
}

let create ?(start = At_line_start) ~max_line_bytes () =
  if max_line_bytes < 1 then invalid_arg "Mesh_jsonl_lines.create: max_line_bytes < 1";
  let mode =
    match start with
    | At_line_start -> Collecting
    | Skip_first_line -> Skipping
    | Inside_long_line -> Dropping
  in
  { max_line_bytes; buffer = Buffer.create 256; mode; consumed = 0; pending = 0 }

let end_line t emit =
  t.consumed <- t.consumed + t.pending + 1;
  t.pending <- 0;
  let finished = t.mode in
  t.mode <- Collecting;
  match finished with
  | Collecting ->
      let text = Buffer.contents t.buffer in
      Buffer.clear t.buffer;
      emit (Line text)
  | Dropping -> emit Too_long
  | Skipping -> ()

(* Add [len] bytes that contain no newline to the pending line. *)
let extend t bytes ~pos ~len =
  t.pending <- t.pending + len;
  if t.mode = Collecting then
    if t.pending > t.max_line_bytes then begin
      Buffer.clear t.buffer;
      t.mode <- Dropping
    end
    else Buffer.add_subbytes t.buffer bytes pos len

let feed t bytes ~pos ~len emit =
  if pos < 0 || len < 0 || pos + len > Bytes.length bytes then
    invalid_arg "Mesh_jsonl_lines.feed";
  let stop = pos + len in
  let rec newline_from index =
    if index >= stop then None
    else if Bytes.unsafe_get bytes index = '\n' then Some index
    else newline_from (index + 1)
  in
  let rec scan from =
    if from < stop then
      match newline_from from with
      | Some newline ->
          extend t bytes ~pos:from ~len:(newline - from);
          end_line t emit;
          scan (newline + 1)
      | None -> extend t bytes ~pos:from ~len:(stop - from)
  in
  scan pos

let feed_string t text emit =
  feed t (Bytes.unsafe_of_string text) ~pos:0 ~len:(String.length text) emit

let consumed t = t.consumed
let pending_bytes t = t.pending

let resume t =
  match t.mode with
  | Collecting -> (t.consumed, At_line_start)
  | Dropping -> (t.consumed + t.pending, Inside_long_line)
  | Skipping -> (t.consumed + t.pending, Skip_first_line)
