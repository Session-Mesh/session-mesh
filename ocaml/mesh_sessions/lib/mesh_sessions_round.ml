(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

module Request = Mesh_sessions_request
module Describe = Mesh_sessions_describe
module Corrections = Mesh_sessions_corrections
module Backoff = Mesh_sessions_order.Backoff
module Blocking = Mesh_deadline_pool.Blocking

type config = { deadline : float; concurrency : int; max_threads : int; setup_deadline : float }

let config ?(deadline = 2.) ?(concurrency = 8) ?(max_threads = 16) ?(setup_deadline = 5.) () =
  { deadline; concurrency; max_threads; setup_deadline }

type t = {
  clock : float Eio.Time.clock_ty Eio.Std.r;
  config : config;
  platform : Mesh_pty_processes.platform;
  registry : Mesh_agent.Registry.t;
  blocking : Blocking.t;
  backoff : Backoff.t;
  sent : (string, Yojson.Safe.t * Digest.t) Hashtbl.t;  (* last row sent, by name *)
  corrections : Corrections.t;
  mutable described : (Request.session * Describe.t) list;  (* the last round's rows, before its checks *)
  mutable rounds : int;
  mutable avoiding : string list;  (* [degraded.avoid] of the last round *)
}

let create ~clock config platform registry =
  {
    clock = (clock :> float Eio.Time.clock_ty Eio.Std.r);
    config;
    platform;
    registry;
    blocking = Blocking.create ~max_threads:config.max_threads;
    backoff = Backoff.create ();
    sent = Hashtbl.create 64;
    corrections = Corrections.create ();
    described = [];
    rounds = 0;
    avoiding = [];
  }

(* How one session ended. *)
type result = Row of Describe.t | Slow | Error of string

exception Adapter_not_prepared

(* A blocking call in a system thread, within the setup deadline. Any
   exception of [f] is [`Failed]; a cancellation of the round propagates. *)
let setup engine f =
  match
    Eio.Time.with_timeout engine.clock engine.config.setup_deadline (fun () ->
        Ok (Blocking.call engine.blocking f))
  with
  | Ok value -> Ok value
  | Error `Timeout -> Error `Timeout
  | exception Blocking.Saturated -> Error `Saturated
  | exception (Eio.Cancel.Cancelled _ as cancelled) -> raise cancelled
  | exception _ -> Error `Failed

(* The process table, or the reason every row of the round is an error. *)
let read_table engine =
  match setup engine (fun () -> Mesh_agent_round.read engine.platform) with
  | Ok (Ok round) -> Ok round
  | Error `Saturated -> Error "saturated"
  | Ok (Error _) | Error (`Failed | `Timeout) -> Error "no_process_table"

let adapters engine = Mesh_agent.Registry.adapters engine.registry

(* Prepare each adapter for the round; returns the registry of the adapters
   whose preparation did not raise, and the types of those whose did. One
   that overran or found no thread is kept: its rows are still described. *)
let prepare_adapters engine round =
  let raised adapter = setup engine (fun () -> Mesh_agent.prepare adapter round) = Error `Failed in
  let failed, prepared = List.partition raised (adapters engine) in
  (Mesh_agent.Registry.create prepared, List.map Mesh_agent.kind failed)

let settle engine (session : Request.session) ~backoff outcome =
  match (outcome : Describe.t Mesh_deadline_pool.outcome) with
  | Ready row ->
      if backoff then Backoff.ready engine.backoff session;
      Row row
  | Slow when backoff -> ( match Backoff.slow engine.backoff session with `Slow -> Slow | `Backoff -> Error "backoff")
  | Slow -> Slow
  | Failed Blocking.Saturated -> Error "saturated"
  | Failed _ ->
      (* Described, though it failed: the slow rounds are no longer consecutive. *)
      if backoff then Backoff.ready engine.backoff session;
      Error "failed"

(* An adapter's check, in a system thread with the setup deadline; [None]
   when it raised, overran or found no thread. *)
let run_check engine check =
  match setup engine (fun () -> match check () with changed -> Some changed | exception _ -> None) with
  | Ok result -> result
  | Error _ -> None

let check engine round ?context ended = Corrections.check ~run:(run_check engine) (adapters engine) round ?context ended

let admitted engine ~backoff ~on_row order =
  let pending = ref order in
  let rec next () =
    match !pending with
    | [] -> None
    | session :: rest ->
        pending := rest;
        if (not backoff) || Backoff.admit engine.backoff session then Some session
        else (on_row session (Error "backoff"); next ())
  in
  next

(* Describe every session of the request; [on_row] receives each as it ends.
   Returns the round's table and the rows described, in the order they
   ended, before any check; [None] without a table. *)
let run engine (request : Request.t) ~backoff ~on_row =
  let order = Mesh_sessions_order.service request in
  match read_table engine with
  | Error reason ->
      List.iter (fun session -> on_row session (Error reason)) order;
      None
  | Ok round ->
      let registry, failed = prepare_adapters engine round in
      let ended = ref [] in
      (* A row of an adapter whose preparation raised fails: that adapter is
         not in [registry], so it is not asked to describe. *)
      let describe session =
        let row = Describe.row registry round (Request.agent_session session) in
        match Describe.kind row with Some kind when List.mem kind failed -> raise Adapter_not_prepared | _ -> row
      in
      let work (session : Request.session) = Blocking.call engine.blocking (fun () -> describe session) in
      let report session outcome =
        let result = settle engine session ~backoff outcome in
        (match result with Row row -> ended := (session, row) :: !ended | Slow | Error _ -> ());
        on_row session result
      in
      Mesh_deadline_pool.run ~clock:engine.clock ~max_concurrency:engine.config.concurrency
        ~deadline:engine.config.deadline ~next:(admitted engine ~backoff ~on_row order) ~work ~report ();
      Some (round, List.rev !ended)

let state_name = function
  | Row row -> if Describe.supported row then "ready" else "unsupported"
  | Slow -> "slow"
  | Error _ -> "error"

(* The fields that say how a session ended: [row], [same] or [reason]. *)
let outcome_fields = function
  | Row row -> [ ("row", Describe.json row) ]
  | Slow -> []
  | Error reason -> [ ("reason", `String reason) ]

(* Replace [row] by [same] when it is the row last sent for this session. *)
let deduplicate engine (session : Request.session) ~full fields =
  match List.assoc_opt "row" fields with
  | None ->
      Hashtbl.remove engine.sent session.name;
      fields
  | Some row ->
      let digest = Digest.string (Yojson.Safe.to_string row) in
      let same = Hashtbl.find_opt engine.sent session.name = Some (session.created, digest) in
      Hashtbl.replace engine.sent session.name (session.created, digest);
      if same && not full then [ ("same", `Bool true) ] else fields

(* The sessions last sent with one of these states. *)
let count states names = Hashtbl.fold (fun _ state total -> if List.mem state names then total + 1 else total) states 0

let counts_json states ~total =
  let field state = (state, `Int (count states [ state ])) in
  `Assoc (("total", `Int total) :: List.map field [ "ready"; "unsupported"; "slow"; "error" ])

let priorities (request : Request.t) =
  let table = Hashtbl.create (List.length request.sessions) in
  List.iteri (fun index (session : Request.session) -> Hashtbl.replace table session.name index)
    (Mesh_sessions_order.service request);
  table

(* Emit the row event of a session; returns the state it was sent with. *)
let row_event engine request priorities ~emit (session : Request.session) result =
  let head =
    [
      ("name", `String session.name);
      ("created", session.created);
      ("priority", `Int (Hashtbl.find priorities session.name));
    ]
  in
  let state = state_name result in
  let body = deduplicate engine session ~full:request.Request.full (outcome_fields result) in
  match emit "row" (head @ (("state", `String state) :: body)) with
  | Ok () -> state
  | Error _ ->
      Hashtbl.remove engine.sent session.name;
      ignore (emit "row" (head @ [ ("state", `String "error"); ("reason", `String "too_large") ]));
      "error"

(* While threads stay blocked, the names to avoid accumulate: this round's
   slow names, after the earlier ones still listed. *)
let update_avoiding engine (request : Request.t) slow_names =
  if Blocking.abandoned engine.blocking = 0 then engine.avoiding <- []
  else
    let listed name = List.exists (fun (session : Request.session) -> session.name = name) request.sessions in
    let earlier = List.filter (fun name -> listed name && not (List.mem name slow_names)) engine.avoiding in
    engine.avoiding <- earlier @ slow_names

(* [restart]: no thread is left for the next round, or this round lacked one. *)
let degraded engine ~saturated =
  let abandoned = Blocking.abandoned engine.blocking in
  if abandoned = 0 then []
  else
    let restart = saturated || Blocking.saturated engine.blocking in
    let avoid = `List (List.map (fun name -> `String name) engine.avoiding) in
    [ ("degraded", `Assoc [ ("abandoned", `Int abandoned); ("avoid", avoid); ("restart", `Bool restart) ]) ]

let resize_adapters engine (request : Request.t) =
  List.iter (fun adapter -> Mesh_agent.resize adapter ~sessions:(List.length request.sessions)) (adapters engine)

let final_fields engine ~number ~states ~total ~table_complete ~saturated =
  [
    ("round", `Int number);
    ("complete", `Bool (count states [ "ready"; "unsupported" ] = total));
    ("counts", counts_json states ~total);
    ("table", `Assoc [ ("complete", `Bool table_complete) ]);
  ]
  @ degraded engine ~saturated

(* After the checks, a row whose final form is not the one sent is sent
   again; the corrections are kept for the next round. *)
let send_corrections engine round ended ~sent_rows ~send =
  let outcomes = check engine round ended in
  Corrections.remember engine.corrections outcomes;
  engine.described <- ended;
  List.iter
    (fun (outcome : Corrections.outcome) ->
      let row = Corrections.final outcome in
      if Hashtbl.find_opt sent_rows outcome.session.name <> Some (Corrections.digest row) then
        send outcome.session (Row row))
    outcomes

let forget_unlisted engine (request : Request.t) =
  Backoff.retain engine.backoff request.sessions;
  Request.retain_listed engine.sent request.sessions;
  Corrections.retain engine.corrections request.sessions

let round engine (request : Request.t) ~emit =
  (* The number is taken before the round runs: a round that starts while
     this one sends its rows has the next one. *)
  let number = engine.rounds + 1 in
  engine.rounds <- number;
  (* Only a round, which lists every session, bounds the adapters' caches. *)
  resize_adapters engine request;
  Backoff.avoid engine.backoff request.sessions request.avoid;
  let priorities = priorities request and total = List.length request.sessions in
  let states = Hashtbl.create total and sent_rows = Hashtbl.create total in
  let slow_names = ref [] and saturated = ref false in
  (* Each session counts with the state it was last sent with. *)
  let send (session : Request.session) result =
    (match result with Row row -> Hashtbl.replace sent_rows session.name (Corrections.digest row) | Slow | Error _ -> ());
    Hashtbl.replace states session.name (row_event engine request priorities ~emit session result)
  in
  let on_row (session : Request.session) result =
    (match result with
    | Slow | Error "backoff" -> slow_names := session.name :: !slow_names
    | Error "saturated" -> saturated := true
    | Row _ | Error _ -> ());
    match result with
    | Row row -> send session (Row (Corrections.remembered engine.corrections session row))
    | Slow | Error _ -> send session result
  in
  let ran = run engine request ~backoff:true ~on_row in
  Option.iter (fun (round, ended) -> send_corrections engine round ended ~sent_rows ~send) ran;
  forget_unlisted engine request;
  let table_complete = match ran with Some (round, _) -> Mesh_agent_round.complete round | None -> false in
  update_avoiding engine request (List.rev !slow_names);
  final_fields engine ~number ~states ~total ~table_complete ~saturated:!saturated

(* The last round's rows whose agent process is still in [round]'s table:
   the context of a [describe]'s checks. *)
let context engine round =
  List.filter
    (fun (_, row) ->
      match Describe.agent row with
      | Some (_, (described : Mesh_agent.described)) -> Mesh_agent_round.find round described.process.pid <> None
      | None -> false)
    engine.described

let describe engine (request : Request.t) =
  let results = Hashtbl.create (List.length request.sessions) in
  let on_row (session : Request.session) result = Hashtbl.replace results session.name result in
  (match run engine request ~backoff:false ~on_row with
  | Some (round, ended) ->
      List.iter
        (fun (outcome : Corrections.outcome) -> on_row outcome.session (Row (Corrections.final outcome)))
        (check engine round ~context:(context engine round) ended)
  | None -> ());
  let row (session : Request.session) =
    let result = Option.value ~default:(Error "failed") (Hashtbl.find_opt results session.name) in
    `Assoc
      ([ ("name", `String session.name); ("created", session.created); ("state", `String (state_name result)) ]
      @ outcome_fields result)
  in
  [ ("rows", `List (List.map row request.sessions)) ]
