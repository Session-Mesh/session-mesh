(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

module Py = Mesh_agent_py

type header = { cwd : Yojson.Safe.t; subagent : bool; id : Yojson.Safe.t }
type rollout = { path : string; mtime : float; header : header }

type entry = {
  device : int;
  inode : int;
  size : int;
  mtime : float;
  line_end : int option;
  header : header;
}

type counters = { walks : int; headers_read : int }

type t = {
  lock : Mutex.t;
  table : (string, entry * int) Hashtbl.t;  (* the entry and the last walk that saw it *)
  mutable counters : counters;
}

let unknown = { cwd = `Null; subagent = true; id = `Null }
let days = 30.
let max_header = 8_000_000
let header_limits = { Mesh_jsonl_value.max_bytes = max_header; max_depth = 128; invalid_utf8 = Reject }
let create () = { lock = Mutex.create (); table = Hashtbl.create 1024; counters = { walks = 0; headers_read = 0 } }
let locked cache f = Mutex.protect cache.lock f
let counters cache = locked cache (fun () -> cache.counters)
let entries cache = locked cache (fun () -> Hashtbl.fold (fun path (entry, _) acc -> (path, entry) :: acc) cache.table [])

let restore cache entries =
  locked cache (fun () ->
      List.iter (fun (path, entry) -> Hashtbl.replace cache.table path (entry, cache.counters.walks)) entries)

(* [_rollout_meta]: the payload's cwd, whether its source is an object, its id. *)
let header_of_line line =
  match Mesh_jsonl_value.decode header_limits line with
  | Ok (`Assoc _ as first) ->
      let payload = match Py.get "payload" first with `Assoc _ as payload -> payload | _ -> `Assoc [] in
      { cwd = Py.get "cwd" payload; subagent = Py.is_object (Py.get "source" payload); id = Py.get "id" payload }
  | Ok _ | Error _ -> unknown

(* The first line (without its newline) and where it ends, if it is complete. *)
let first_line descriptor =
  let chunk = Bytes.create 65_536 and buffer = Buffer.create 4096 in
  let rec loop offset =
    let wanted = min (Bytes.length chunk) (max_header - offset) in
    let count = if wanted <= 0 then 0 else Mesh_safe_file.read_at descriptor ~offset chunk ~pos:0 ~len:wanted in
    let text = Bytes.sub_string chunk 0 count in
    match String.index_opt text '\n' with
    | Some index ->
        Buffer.add_string buffer (String.sub text 0 index);
        (Buffer.contents buffer, Some (offset + index + 1))
    | None when count = 0 -> (Buffer.contents buffer, None)
    | None ->
        Buffer.add_string buffer text;
        loop (offset + count)
  in
  loop 0

let read_entry path =
  let read descriptor (stats : Unix.stats) =
    let line, line_end = first_line descriptor in
    let header = if line_end = None && stats.st_size >= max_header then unknown else header_of_line line in
    { device = stats.st_dev; inode = stats.st_ino; size = stats.st_size; mtime = stats.st_mtime; line_end; header }
  in
  match Mesh_safe_file.with_regular path read with Ok entry -> Some entry | Error _ -> None | exception Unix.Unix_error _ -> None

let still_valid entry (stats : Unix.stats) =
  entry.device = stats.st_dev && entry.inode = stats.st_ino
  && ((entry.size = stats.st_size && entry.mtime = stats.st_mtime)
     || match entry.line_end with Some line_end -> stats.st_size >= line_end | None -> false)

(* The header of a regular file whose [lstat] is [stats]: cached, or read now (outside the lock). *)
let header cache path (stats : Unix.stats) =
  let cached =
    locked cache (fun () ->
        match Hashtbl.find_opt cache.table path with
        | Some (entry, _) when still_valid entry stats ->
            Hashtbl.replace cache.table path (entry, cache.counters.walks);
            Some entry.header
        | _ -> None)
  in
  match cached with
  | Some header -> header
  | None -> (
      match read_entry path with
      | None -> unknown
      | Some entry ->
          locked cache (fun () ->
              cache.counters <- { cache.counters with headers_read = cache.counters.headers_read + 1 };
              Hashtbl.replace cache.table path (entry, cache.counters.walks));
          entry.header)

let regular path = match Unix.lstat path with { Unix.st_kind = S_REG; _ } as stats -> Some stats | _ -> None | exception Unix.Unix_error _ -> None

let describe_path cache path =
  Option.map (fun (stats : Unix.stats) -> { path; mtime = stats.st_mtime; header = header cache path stats }) (regular path)

(* Python's glob [*]: the names that do not start with a dot, here sorted. *)
let visible directory =
  match Sys.readdir directory with
  | names -> List.sort String.compare (List.filter (fun name -> not (String.starts_with ~prefix:"." name)) (Array.to_list names))
  | exception Sys_error _ -> []

let below directory = List.map (Filename.concat directory) (visible directory)

let recent ~cutoff directory =
  match Unix.stat directory with stats -> stats.st_mtime >= cutoff | exception Unix.Unix_error _ -> false

let rollout_name name = String.starts_with ~prefix:"rollout-" name && String.ends_with ~suffix:".jsonl" name && String.length name >= 14

let walk cache ~root ~now =
  locked cache (fun () -> cache.counters <- { cache.counters with walks = cache.counters.walks + 1 });
  let cutoff = now -. (days *. 86400.) in
  let days = List.concat_map below (List.concat_map below (below (Filename.concat root "sessions"))) in
  let rollouts =
    List.concat_map
      (fun day ->
        if not (recent ~cutoff day) then []
        else List.filter_map (fun name -> if rollout_name name then describe_path cache (Filename.concat day name) else None) (visible day))
      days
  in
  locked cache (fun () ->
      let walks = cache.counters.walks in
      Hashtbl.filter_map_inplace (fun _ (entry, seen) -> if seen >= walks - 1 then Some (entry, seen) else None) cache.table);
  rollouts
