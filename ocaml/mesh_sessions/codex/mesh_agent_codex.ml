(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

module Round = Mesh_agent_round
module Checks = Mesh_session_checks
module Identity = Mesh_agent_codex_identity
module Rollouts = Mesh_agent_codex_rollouts
module Fold = Mesh_agent_codex_fold
module Transcripts = Mesh_agent_transcripts

let kind = "codex"
let window = 8_000_000
let busy_seconds = 20.
let clock_ticks = 100. (* USER_HZ: the unit of a Linux process's start time *)

let limits =
  Mesh_jsonl_tail.limits ~max_line_bytes:window ~window ~max_read:(16 * 1024 * 1024)
    ~invalid_utf8:Mesh_jsonl_value.Drop ()

type config = {
  now : unit -> float;
  boot_time : unit -> float option;
  registry_lookup : Checks.session -> (string * Checks.registry_source) option;
}

let read_boot_time () =
  let btime line = Scanf.sscanf_opt line "btime %f" Fun.id in
  match In_channel.with_open_bin "/proc/stat" In_channel.input_lines with
  | lines -> List.find_map btime lines
  | exception Sys_error _ -> None

let default_config =
  let boot = lazy (read_boot_time ()) in
  { now = Unix.gettimeofday; boot_time = (fun () -> Lazy.force boot); registry_lookup = (fun _ -> None) }

type outcome = { identity : Identity.t; verdict : Checks.verdict }
type prepared = { round : Round.t; context : Identity.context; outcomes : (int, outcome option) Hashtbl.t }

type t = {
  config : config;
  roots : Mesh_agent_roots.t;
  rollouts : Rollouts.t;
  transcripts : Fold.t Transcripts.t;
  lock : Mutex.t;
  mutable prepared : prepared list;  (* the latest rounds first *)
}

type counters = { walks : int; headers_read : int; restarted : int; appended : int; unchanged : int }

let create_with config roots =
  {
    config;
    roots;
    rollouts = Rollouts.create ();
    transcripts = Transcripts.create limits Fold.fold;
    lock = Mutex.create ();
    prepared = [];
  }

let create = create_with default_config
let resize adapter ~sessions = Transcripts.resize adapter.transcripts (2 * sessions)

let counters adapter =
  let walked = Rollouts.counters adapter.rollouts and folded = Transcripts.counters adapter.transcripts in
  {
    walks = walked.walks;
    headers_read = walked.headers_read;
    restarted = folded.restarted;
    appended = folded.appended;
    unchanged = folded.unchanged;
  }

(* [discover.proc_start]: 0 when unknown, as Python. *)
let start_time config (process : Round.process) =
  match Mesh_platform.platform with
  | Linux -> ( match config.boot_time () with Some boot -> boot +. (Int64.to_float process.incarnation /. clock_ticks) | None -> 0.)
  | Macos -> Int64.to_float process.incarnation /. 1e6
  | Other _ -> 0.

let session (process : Round.process) = { Checks.sid = process.sid; agent_pid = process.pid }

(* The agent of each terminal session that runs a Codex process, when it is Codex. *)
let participants round codex_pids =
  let sids = List.sort_uniq compare (List.filter_map (fun pid -> Option.map (fun (p : Round.process) -> p.sid) (Round.find round pid)) codex_pids) in
  List.filter_map
    (fun sid ->
      match (Mesh_agent_session.frame round ~sid).agent with Some (process, "codex") -> Some process | _ -> None)
    sids

let claims identities =
  List.filter_map
    (fun (pid, identity) ->
      match identity with
      | Some { Identity.id = `String id; source; holds_open; _ } when id <> "" ->
          Some { Checks.key = pid; id; source = Identity.check_source source; holds_open }
      | _ -> None)
    identities

let resolve adapter context round =
  let identities =
    List.map
      (fun (process : Round.process) ->
        (process.pid, Identity.conversation context ~registered:(adapter.config.registry_lookup (session process)) process))
      (participants round (Mesh_agent_codex_view.codex_pids context.view))
  in
  let verdicts = Checks.check (claims identities) in
  let outcomes = Hashtbl.create 16 in
  List.iter
    (fun (pid, identity) ->
      let verdict = Option.value ~default:Checks.Keep (List.assoc_opt pid verdicts) in
      Hashtbl.replace outcomes pid (Option.map (fun identity -> { identity; verdict }) identity))
    identities;
  outcomes

let prepare adapter round =
  let rollouts = Rollouts.walk adapter.rollouts ~root:(Mesh_agent_roots.codex adapter.roots) ~now:(adapter.config.now ()) in
  let context =
    {
      Identity.view = Mesh_agent_codex_view.read round;
      rollouts;
      describe_path = Rollouts.describe_path adapter.rollouts;
      start_time = start_time adapter.config;
    }
  in
  let prepared = { round; context; outcomes = resolve adapter context round } in
  Mutex.protect adapter.lock (fun () ->
      adapter.prepared <- List.filteri (fun index _ -> index < 4) (prepared :: adapter.prepared))

let identity_fields { identity; verdict } =
  match verdict with
  | Checks.Keep -> [ ("session_id", identity.id); ("identity_source", `String (Identity.source_name identity.source)) ]
  | Drop -> [ ("session_id", `Null); ("identity_source", `Null) ]
  | Contested -> [ ("session_id", `Null); ("identity_source", `String "contested") ]

(* [_codex_transcript]; an unreadable rollout gives Python's empty answer. *)
let transcript_fields adapter path =
  match Transcripts.read adapter.transcripts ~key:path path with
  | Some tail ->
      let state = Mesh_jsonl_tail.state tail and mtime = (Mesh_jsonl_tail.signature tail).mtime in
      let status = if adapter.config.now () -. mtime < busy_seconds then "busy" else "idle" in
      [ ("last", Fold.last state); ("updated", `Float mtime); ("cwd", Fold.cwd state); ("status", `String status);
        ("said", Fold.said state) ]
  | None -> [ ("last", `Null); ("updated", `Int 0); ("cwd", `Null); ("status", `String "idle"); ("said", `Null) ]

let outcome adapter prepared (process : Round.process) =
  match Hashtbl.find_opt prepared.outcomes process.pid with
  | Some outcome -> outcome
  | None ->
      (* A Codex the kernel does not name [codex]: described alone, without the checks. *)
      Identity.conversation prepared.context ~registered:(adapter.config.registry_lookup (session process)) process
      |> Option.map (fun identity -> { identity; verdict = Checks.Keep })

let describe adapter round process =
  let prepared = Mutex.protect adapter.lock (fun () -> List.find_opt (fun p -> p.round == round) adapter.prepared) in
  match Option.bind prepared (fun prepared -> outcome adapter prepared process) with
  | None -> []
  | Some outcome ->
      identity_fields outcome
      @ (match outcome.identity.path with Some path -> transcript_fields adapter path | None -> [])

let with_config config : (module Mesh_agent.ADAPTER with type t = t) =
  (module struct
    type nonrec t = t

    let kind = kind
    let create = create_with config
    let prepare = prepare
    let resize = resize
    let describe = describe
  end)
