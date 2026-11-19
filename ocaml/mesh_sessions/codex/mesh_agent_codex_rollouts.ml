(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

module Py = Mesh_agent_py
module File = Mesh_safe_file
module Stat = Mesh_agent_codex_stat

type header = { cwd : Yojson.Safe.t; subagent : bool; id : Yojson.Safe.t }
type rollout = { path : string; mtime : float; header : header }

type entry = {
  device : int;
  inode : int;
  size : int;
  mtime_ns : int;
  line_end : int option;
  header : header;
}

type counters = { walks : int; headers_read : int }

(* An entry, the last walk that saw it, and whether it was read or matched
   exactly in this process (a restored entry is not, until then). *)
type slot = { entry : entry; seen : int; verified : bool }

type t = {
  lock : Mutex.t;
  table : (string, slot) Hashtbl.t;
  mutable counters : counters;
}

let unknown = { cwd = `Null; subagent = true; id = `Null }
let days = 30.
let max_header = 8_000_000
let header_limits = { Mesh_jsonl_value.max_bytes = max_header; max_depth = 128; invalid_utf8 = Reject }
let create () = { lock = Mutex.create (); table = Hashtbl.create 1024; counters = { walks = 0; headers_read = 0 } }
let locked cache f = Mutex.protect cache.lock f
let counters cache = locked cache (fun () -> cache.counters)

let text_or_null = function `Null | `String _ -> true | _ -> false

let valid_line_end entry =
  match entry.line_end with None -> true | Some line_end -> line_end >= 1 && line_end <= min entry.size (max_header + 1)

let valid_id = function `Null -> true | `String id -> Mesh_agent_codex_argv.thread_id id | _ -> false

let valid (path, entry) =
  (not (Filename.is_relative path))
  && (not (String.contains path '\000'))
  && entry.device >= 0 && entry.inode >= 0 && entry.size >= 0 && entry.mtime_ns >= 0
  && valid_line_end entry && valid_id entry.header.id && text_or_null entry.header.cwd

let entries cache =
  locked cache (fun () -> Hashtbl.fold (fun path slot acc -> (path, slot.entry) :: acc) cache.table [])
  |> List.filter valid

let restore cache entries =
  locked cache (fun () ->
      List.iter
        (fun ((path, entry) as restored) ->
          if valid restored then Hashtbl.replace cache.table path { entry; seen = cache.counters.walks; verified = false })
        entries)

(* [_rollout_meta]: the payload's cwd, whether its source is an object, its
   id (a string, else none). *)
let header_of_line line =
  match Mesh_jsonl_value.decode header_limits line with
  | Ok (`Assoc _ as first) ->
      let payload = match Py.get "payload" first with `Assoc _ as payload -> payload | _ -> `Assoc [] in
      let id = match Py.get "id" payload with `String _ as id -> id | _ -> `Null in
      { cwd = Py.get "cwd" payload; subagent = Py.is_object (Py.get "source" payload); id }
  | Ok _ | Error _ -> unknown

(* The first line (without its newline) and where it ends, if it is complete. *)
let first_line descriptor =
  let chunk = Bytes.create 65_536 and buffer = Buffer.create 4096 in
  let rec loop offset =
    let wanted = min (Bytes.length chunk) (max_header - offset) in
    let count = if wanted <= 0 then 0 else File.read_at descriptor ~offset chunk ~pos:0 ~len:wanted in
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

(* The entry of the file [key] describes; [None] when another file is there now. *)
let read_entry path (key : Stat.t) =
  let read descriptor (stats : Unix.stats) =
    if stats.st_dev <> key.device || stats.st_ino <> key.inode then None
    else
      let line, line_end = first_line descriptor in
      let header = if line_end = None && stats.st_size >= max_header then unknown else header_of_line line in
      Some { device = key.device; inode = key.inode; size = key.size; mtime_ns = key.mtime_ns; line_end; header }
  in
  match File.with_regular path read with Ok entry -> entry | Error _ -> None | exception Unix.Unix_error _ -> None

(* The same file, and either unchanged (the exact key) or, once verified,
   still holding the complete first line it was read from. *)
let still_valid slot (key : Stat.t) =
  let entry = slot.entry in
  entry.device = key.device && entry.inode = key.inode
  && ((entry.size = key.size && entry.mtime_ns = key.mtime_ns)
     || (slot.verified && match entry.line_end with Some line_end -> key.size >= line_end | None -> false))

(* The header of a regular file whose [lstat] is [key]: cached, or read now (outside the lock). *)
let header cache path (key : Stat.t) =
  let cached =
    locked cache (fun () ->
        match Hashtbl.find_opt cache.table path with
        | Some slot when still_valid slot key ->
            let entry = { slot.entry with size = key.size; mtime_ns = key.mtime_ns } in
            Hashtbl.replace cache.table path { entry; seen = cache.counters.walks; verified = true };
            Some entry.header
        | _ -> None)
  in
  match cached with
  | Some header -> header
  | None -> (
      match read_entry path key with
      | None -> unknown
      | Some entry ->
          locked cache (fun () ->
              cache.counters <- { cache.counters with headers_read = cache.counters.headers_read + 1 };
              Hashtbl.replace cache.table path { entry; seen = cache.counters.walks; verified = true });
          entry.header)

let describe_path cache path =
  Option.map (fun (key : Stat.t) -> { path; mtime = key.mtime; header = header cache path key }) (Stat.lstat_regular path)

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
      Hashtbl.filter_map_inplace (fun _ slot -> if slot.seen >= walks - 1 then Some slot else None) cache.table);
  rollouts
