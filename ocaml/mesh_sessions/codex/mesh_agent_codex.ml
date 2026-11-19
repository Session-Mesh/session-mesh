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
  registry_lookup : Mesh_agent.session -> (string * Checks.registry_source) option;
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

(* The heuristic identities of the round, with Python's duplicate-id rules. *)
let resolve context round =
  let identities =
    List.map
      (fun (process : Round.process) -> (process.pid, Identity.conversation context ~registered:None process))
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
  let prepared = { round; context; outcomes = resolve context round } in
  Mutex.protect adapter.lock (fun () ->
      adapter.prepared <- List.filteri (fun index _ -> index < 4) (prepared :: adapter.prepared))

let verdict_fields verdict (id, source) =
  match verdict with
  | Checks.Keep -> [ ("session_id", id); ("identity_source", source) ]
  | Drop -> [ ("session_id", `Null); ("identity_source", `Null) ]
  | Contested -> [ ("session_id", `Null); ("identity_source", `String "contested") ]

let identity_fields { identity; verdict } =
  verdict_fields verdict (identity.id, `String (Identity.source_name identity.source))

(* [_codex_transcript]; an unreadable rollout gives Python's empty answer. *)
let transcript_fields adapter path =
  match Transcripts.read adapter.transcripts ~key:path path with
  | Some tail ->
      let state = Mesh_jsonl_tail.state tail and mtime = (Mesh_jsonl_tail.signature tail).mtime in
      let status = if adapter.config.now () -. mtime < busy_seconds then "busy" else "idle" in
      [ ("last", Fold.last state); ("updated", `Float mtime); ("cwd", Fold.cwd state); ("status", `String status);
        ("said", Fold.said state) ]
  | None -> [ ("last", `Null); ("updated", `Int 0); ("cwd", `Null); ("status", `String "idle"); ("said", `Null) ]

(* A registered identity first; else the round's; else (a Codex the kernel does
   not name [codex]) the heuristic alone, without the checks. *)
let outcome adapter prepared session (process : Round.process) =
  let alone registered =
    Identity.conversation prepared.context ~registered process |> Option.map (fun identity -> { identity; verdict = Checks.Keep })
  in
  match (adapter.config.registry_lookup session, Hashtbl.find_opt prepared.outcomes process.pid) with
  | (Some _ as registered), _ -> alone registered
  | None, Some outcome -> outcome
  | None, None -> alone None

let prepared_for adapter round =
  Mutex.protect adapter.lock (fun () -> List.find_opt (fun p -> p.round == round) adapter.prepared)

let describe adapter round session process =
  match Option.bind (prepared_for adapter round) (fun prepared -> outcome adapter prepared session process) with
  | None -> []
  | Some outcome ->
      identity_fields outcome
      @ (match outcome.identity.path with Some path -> transcript_fields adapter path | None -> [])

let claim_source = function
  | `String "open_rollout" -> Some Checks.Open
  | `String "argv_resume" -> Some Checks.Launch
  | `String "cwd_unique" -> Some Checks.Guessed
  | `String "chosen" -> Some (Checks.Registry Chosen)
  | `String "hook" -> Some (Checks.Registry Hook)
  | `String "observed" -> Some (Checks.Registry Observed)
  | _ -> None

let holds prepared pid id =
  List.exists
    (fun path ->
      match prepared.context.describe_path path with Some r -> r.header.id = `String id | None -> false)
    (Option.value ~default:[] (Mesh_agent_codex_view.open_rollouts prepared.context.view pid))

(* Decision I4 on the ids a registered identity shares; the other duplicates
   were settled in [prepare], before any row was described. *)
let check adapter round (described : Mesh_agent.described list) =
  match prepared_for adapter round with
  | None -> []
  | Some prepared ->
      let field key (row : Mesh_agent.described) = Option.value ~default:`Null (List.assoc_opt key row.fields) in
      let claims =
        List.filter_map
          (fun (row : Mesh_agent.described) ->
            match (field "session_id" row, claim_source (field "identity_source" row)) with
            | `String id, Some source when id <> "" ->
                Some { Checks.key = row; id; source; holds_open = holds prepared row.process.pid id }
            | _ -> None)
          described
      in
      let registered = List.filter_map (fun (c : _ Checks.claim) -> match c.source with Registry _ -> Some c.id | _ -> None) claims in
      Checks.check (List.filter (fun (c : _ Checks.claim) -> List.mem c.id registered) claims)
      |> List.filter_map (fun ((row : Mesh_agent.described), verdict) ->
             if verdict = Checks.Keep then None
             else
               let replaced = verdict_fields verdict (`Null, `Null) in
               Some (row.session.name, List.map (fun (key, value) -> (key, Option.value ~default:value (List.assoc_opt key replaced))) row.fields))

let with_config config : (module Mesh_agent.ADAPTER with type t = t) =
  (module struct
    type nonrec t = t

    let kind = kind
    let create = create_with config
    let prepare = prepare
    let resize = resize
    let describe = describe
    let check = check
  end)
