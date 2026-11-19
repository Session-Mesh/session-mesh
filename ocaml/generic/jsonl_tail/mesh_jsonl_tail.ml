(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

type 's fold = { init : unit -> 's; step : 's -> Yojson.Safe.t -> 's }

type limits = { max_line_bytes : int; max_depth : int; window : int; max_read : int }

let limits ?(max_line_bytes = 1024 * 1024) ?(max_depth = 128) ?(window = 8 * 1024 * 1024)
    ?(max_read = 64 * 1024 * 1024) () =
  if max_line_bytes < 1 || max_depth < 1 || window < 1 || max_read < 1 then
    invalid_arg "Mesh_jsonl_tail.limits";
  { max_line_bytes; max_depth; window; max_read }

module Signature = struct
  type t = { path : string; device : int; inode : int; size : int; mtime : float }

  let equal a b =
    String.equal a.path b.path && a.device = b.device && a.inode = b.inode && a.size = b.size
    && Float.equal a.mtime b.mtime

  let hash t = Hashtbl.hash (t.path, t.device, t.inode, t.size, t.mtime)
end

type stats = { lines : int; dropped : int; resets : int }
type outcome = Unchanged | Appended | Restarted

(* The cursor: reading resumes at [offset] in mode [start]; [tail] holds the
   (at most [fingerprint_bytes]) bytes of the file that end at [offset], to
   recognise a rewrite that kept or grew the size. *)
type 's t = {
  state : 's;
  offset : int;
  start : Mesh_jsonl_lines.start;
  tail : string;
  signature : Signature.t;
  complete : bool;
  stats : stats;
}

let fingerprint_bytes = 256
let chunk_bytes = 64 * 1024

let signature_of path (stats : Unix.stats) =
  {
    Signature.path;
    device = stats.st_dev;
    inode = stats.st_ino;
    size = stats.st_size;
    mtime = stats.st_mtime;
  }

let tail_at fd offset =
  let length = min offset fingerprint_bytes in
  Mesh_safe_file.read_range fd ~offset:(offset - length) ~length

let unchanged previous (current : Signature.t) =
  previous.complete && Signature.equal previous.signature current

let rewritten fd previous (current : Signature.t) =
  let before = previous.signature in
  (not (String.equal before.path current.path))
  || before.device <> current.device
  || before.inode <> current.inode
  || current.size < previous.offset
  || not (String.equal (tail_at fd previous.offset) previous.tail)

(* Where a fold from an empty state starts: the whole file, or the window at
   its end without the partial line it begins with. *)
let fresh_cursor limits fold signature resets =
  let size = signature.Signature.size in
  let offset, start =
    if size > limits.window then (size - limits.window, Mesh_jsonl_lines.Skip_first_line)
    else (0, Mesh_jsonl_lines.At_line_start)
  in
  {
    state = fold.init ();
    offset;
    start;
    tail = "";
    signature;
    complete = false;
    stats = { lines = 0; dropped = 0; resets };
  }

(* One line: folded, or counted as dropped. *)
let apply_line value_limits fold (state, lines, dropped) line =
  match line with
  | Mesh_jsonl_lines.Too_long -> (state, lines, dropped + 1)
  | Mesh_jsonl_lines.Line text -> (
      match Mesh_jsonl_value.decode value_limits text with
      | Error _ -> (state, lines, dropped + 1)
      | Ok json -> (
          match fold.step state json with
          | next -> (next, lines + 1, dropped)
          | exception (Yojson.Safe.Util.Type_error _ | Not_found | Failure _ | Invalid_argument _) ->
              (state, lines, dropped + 1)))

(* Read [offset, stop) through the splitter; returns the folded counters, the
   splitter, and whether the end of file came before [stop]. *)
let read_span limits fold fd cursor ~stop =
  let splitter =
    Mesh_jsonl_lines.create ~start:cursor.start ~max_line_bytes:limits.max_line_bytes ()
  in
  let value_limits =
    { Mesh_jsonl_value.max_bytes = limits.max_line_bytes; max_depth = limits.max_depth }
  in
  let acc = ref (cursor.state, cursor.stats.lines, cursor.stats.dropped) in
  let buffer = Bytes.create chunk_bytes in
  let rec loop position =
    if position >= stop then false
    else
      let wanted = min chunk_bytes (stop - position) in
      match Mesh_safe_file.read_at fd ~offset:position buffer ~pos:0 ~len:wanted with
      | 0 -> true
      | count ->
          Mesh_jsonl_lines.feed splitter buffer ~pos:0 ~len:count (fun line ->
              acc := apply_line value_limits fold !acc line);
          loop (position + count)
  in
  let hit_end = loop cursor.offset in
  (!acc, splitter, hit_end)

let advance limits fold fd cursor =
  let size = cursor.signature.Signature.size in
  (* Reading at least one byte more than a line may hold guarantees progress:
     the pending line either ends or becomes too long. *)
  let span = max limits.max_read (limits.max_line_bytes + 1) in
  let stop = min size (cursor.offset + span) in
  let (state, lines, dropped), splitter, hit_end = read_span limits fold fd cursor ~stop in
  let read, start = Mesh_jsonl_lines.resume splitter in
  let offset = cursor.offset + read in
  {
    cursor with
    state;
    offset;
    start;
    tail = tail_at fd offset;
    complete = hit_end || stop >= size;
    stats = { cursor.stats with lines; dropped };
  }

let update_open limits fold path previous fd stats =
  let current = signature_of path stats in
  match previous with
  | Some previous when unchanged previous current -> (previous, Unchanged)
  | Some previous when not (rewritten fd previous current) ->
      (advance limits fold fd { previous with signature = current }, Appended)
  | Some previous ->
      (advance limits fold fd (fresh_cursor limits fold current (previous.stats.resets + 1)), Restarted)
  | None -> (advance limits fold fd (fresh_cursor limits fold current 0), Restarted)

let update limits fold path previous =
  match Mesh_safe_file.with_regular path (update_open limits fold path previous) with
  | result -> result
  | exception Unix.Unix_error (error, _, _) ->
      Error (Mesh_safe_file.Unreadable (Unix.error_message error))

let state t = t.state
let signature t = t.signature
let offset t = t.offset
let complete t = t.complete
let stats t = t.stats
