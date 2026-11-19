(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

module Fold = Mesh_agent_claude_fold
module Py = Mesh_agent_py
module Tail = Mesh_jsonl_tail
module Lru = Mesh_lru.Make (String)

let kind = "claude"
let window = 1_500_000

let limits =
  Tail.limits ~max_line_bytes:window ~window ~max_read:(16 * 1024 * 1024)
    ~invalid_utf8:Mesh_jsonl_value.Drop ()

let metadata_limits =
  { Mesh_jsonl_value.max_bytes = 1 lsl 20; max_depth = 128; invalid_utf8 = Reject }

type entry = { path : string; tail : Fold.t Tail.t }
type counters = { restarted : int; appended : int; unchanged : int }

(* What the project directories looked like: each name with its modification
   time, which changes when a transcript is created, removed or renamed in it. *)
type layout = (string * float) list

type t = {
  roots : Mesh_agent_roots.t;
  lock : Mutex.t;
  transcripts : entry Lru.t;  (* by conversation id *)
  locations : (int * string option) Lru.t;  (* by conversation id: the generation searched, the path found *)
  mutable projects : string list;  (* the project directories, read once per round *)
  mutable layout : layout;
  mutable generation : int;  (* incremented when the layout changes *)
  mutable counters : counters;
}

let create roots =
  {
    roots;
    lock = Mutex.create ();
    transcripts = Lru.create ~max_entries:64 ();
    locations = Lru.create ~max_entries:64 ();
    projects = [];
    layout = [];
    generation = 0;
    counters = { restarted = 0; appended = 0; unchanged = 0 };
  }

let locked adapter f = Mutex.protect adapter.lock f
let counters adapter = locked adapter (fun () -> adapter.counters)
let projects_dir adapter = Filename.concat (Mesh_agent_roots.claude adapter.roots) "projects"

let resize adapter ~sessions =
  locked adapter (fun () ->
      Lru.set_max_entries adapter.transcripts (max 1 (2 * sessions));
      Lru.set_max_entries adapter.locations (max 1 (2 * sessions)))

(* Python's glob [*] skips names that start with a dot. *)
let list_projects directory =
  match Sys.readdir directory with
  | names ->
      Array.to_list names
      |> List.filter (fun name -> not (String.starts_with ~prefix:"." name))
      |> List.sort String.compare
  | exception Sys_error _ -> []

let modified path = match Unix.lstat path with stats -> Some stats.st_mtime | exception Unix.Unix_error _ -> None

let layout_of adapter projects =
  List.map
    (fun project ->
      (project, Option.value ~default:Float.nan (modified (Filename.concat (projects_dir adapter) project))))
    projects

(* One listing and one [lstat] per project directory per round; the
   transcripts are searched again only after the layout changed. *)
let prepare adapter _round =
  let projects = list_projects (projects_dir adapter) in
  let layout = layout_of adapter projects in
  locked adapter (fun () ->
      adapter.projects <- projects;
      if not (List.equal (fun (a, x) (b, y) -> String.equal a b && Float.equal x y) layout adapter.layout) then begin
        adapter.layout <- layout;
        adapter.generation <- adapter.generation + 1
      end)

(* A conversation id usable as a file name component. *)
let valid_id text =
  let ok = function 'A' .. 'Z' | 'a' .. 'z' | '0' .. '9' | '_' | '-' | '.' -> true | _ -> false in
  let length = String.length text in
  length > 0 && length <= 128 && text.[0] <> '.' && String.for_all ok text

let read_metadata adapter pid =
  let path =
    Filename.concat (Filename.concat (Mesh_agent_roots.claude adapter.roots) "sessions")
      (string_of_int pid ^ ".json")
  in
  let read descriptor (stats : Unix.stats) =
    if stats.st_size > metadata_limits.max_bytes then None
    else Some (Mesh_safe_file.read_range descriptor ~offset:0 ~length:stats.st_size)
  in
  match Mesh_safe_file.with_regular path read with
  | Ok (Some text) -> (
      match Mesh_jsonl_value.decode metadata_limits text with
      | Ok (`Assoc _ as metadata) -> Some metadata
      | Ok _ | Error _ -> None)
  | Ok None | Error _ -> None
  | exception Unix.Unix_error _ -> None

(* The newest [<project>/<id>.jsonl]; equal times go to the first project by name. *)
let search adapter id =
  let projects = locked adapter (fun () -> adapter.projects) in
  List.filter_map
    (fun project ->
      let path = Filename.concat (Filename.concat (projects_dir adapter) project) (id ^ ".jsonl") in
      Option.map (fun time -> (time, path)) (modified path))
    projects
  |> List.fold_left
       (fun best (time, path) ->
         match best with Some (best_time, _) when best_time >= time -> best | _ -> Some (time, path))
       None
  |> Option.map snd

(* Where the transcript is, searched again when the layout changed since the
   last search or the file found then is gone; absent ones are cached too. *)
let transcript_path adapter id =
  let generation, cached = locked adapter (fun () -> (adapter.generation, Lru.find adapter.locations id)) in
  match cached with
  | Some (searched, None) when searched = generation -> None
  | Some (searched, Some path) when searched = generation && modified path <> None -> Some path
  | _ ->
      let found = search adapter id in
      locked adapter (fun () -> Lru.add adapter.locations id (generation, found));
      found

let count adapter outcome =
  locked adapter (fun () ->
      let counted = adapter.counters in
      adapter.counters <-
        (match (outcome : Tail.outcome) with
        | Restarted -> { counted with restarted = counted.restarted + 1 }
        | Appended -> { counted with appended = counted.appended + 1 }
        | Unchanged -> { counted with unchanged = counted.unchanged + 1 }))

(* The transcript's fold, brought up to date; [None] when it cannot be read. *)
let fold_transcript adapter id path =
  let previous =
    locked adapter (fun () ->
        match Lru.find adapter.transcripts id with
        | Some entry when entry.path = path -> Some entry.tail
        | _ -> None)
  in
  match Tail.update limits Fold.fold path previous with
  | Ok (tail, outcome) ->
      count adapter outcome;
      locked adapter (fun () -> Lru.add adapter.transcripts id { path; tail });
      Some tail
  | Error _ ->
      locked adapter (fun () -> Lru.remove adapter.transcripts id);
      None
  | exception Unix.Unix_error _ -> None

let transcript_fields adapter = function
  | `String id when valid_id id -> (
      match Option.bind (transcript_path adapter id) (fold_transcript adapter id) with
      | Some tail ->
          Fold.fields (Tail.state tail) @ [ ("updated", `Float (Tail.signature tail).mtime) ]
      | None -> [])
  | _ -> []

let seconds = function
  | `Int milliseconds -> `Float (float_of_int milliseconds /. 1000.)
  | `Intlit text -> `Float (float_of_string text /. 1000.)
  | `Float milliseconds -> `Float (milliseconds /. 1000.)
  | `Bool flag -> `Float (if flag then 0.001 else 0.)
  | _ -> `Null

let metadata_fields metadata =
  let status = Py.get "status" metadata in
  [
    ("session_id", Py.get "sessionId" metadata);
    ("identity_source", `String "pid_metadata");
    ("name", Py.get "name" metadata);
    ("status", status);
    ("since", seconds (Py.get "statusUpdatedAt" metadata));
    ("waiting_for", if status = `String "waiting" then Py.get "waitingFor" metadata else `Null);
  ]

let check = Mesh_agent.no_check

let describe adapter _round (_ : Mesh_agent.session) (process : Mesh_agent_round.process) =
  match read_metadata adapter process.pid with
  | None -> []
  | Some metadata ->
      metadata_fields metadata @ transcript_fields adapter (Py.get "sessionId" metadata)
