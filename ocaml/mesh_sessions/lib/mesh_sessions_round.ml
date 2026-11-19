(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

module Request = Mesh_sessions_request
module Describe = Mesh_sessions_describe
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
    rounds = 0;
    avoiding = [];
  }

(* How one session ended. *)
type result = Row of Describe.t | Slow | Error of string

(* A blocking call in a system thread, within the setup deadline. *)
let setup engine f =
  match
    Eio.Time.with_timeout engine.clock engine.config.setup_deadline (fun () ->
        Ok (Blocking.call engine.blocking f))
  with
  | Ok value -> Ok value
  | Error `Timeout -> Error `Failed
  | exception Blocking.Saturated -> Error `Saturated
  | exception (Unix.Unix_error _ | Sys_error _ | Failure _) -> Error `Failed

(* The process table, or the reason every row of the round is an error. *)
let read_table engine =
  match setup engine (fun () -> Mesh_agent_round.read engine.platform) with
  | Ok (Ok round) -> Ok round
  | Error `Saturated -> Error "saturated"
  | Ok (Error _) | Error `Failed -> Error "no_process_table"

let adapters engine = Mesh_agent.Registry.adapters engine.registry

let prepare_adapters engine round =
  List.iter (fun adapter -> ignore (setup engine (fun () -> Mesh_agent.prepare adapter round))) (adapters engine)

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

(* The rows of one adapter's type, with what the adapter described. *)
let rows_of_kind kind ended =
  List.filter_map
    (fun (session, row) ->
      match Describe.agent row with
      | Some (row_kind, described) when row_kind = kind -> Some (session, row, described)
      | _ -> None)
    ended

(* An adapter's cross-session check; a check that fails or overruns corrects nothing. *)
let check_adapter engine round adapter ended =
  match rows_of_kind (Mesh_agent.kind adapter) ended with
  | [] -> []
  | mine ->
      let described = List.map (fun (_, _, described) -> described) mine in
      let check () = match Mesh_agent.check adapter round described with changed -> changed | exception _ -> [] in
      let changed = Result.value ~default:[] (setup engine check) in
      List.filter_map
        (fun ((session : Request.session), row, _) ->
          Option.map (fun fields -> (session, Describe.with_fields row fields)) (List.assoc_opt session.name changed))
        mine

(* The rows the adapters' cross-session checks replace. *)
let corrections engine round ended = List.concat_map (fun adapter -> check_adapter engine round adapter ended) (adapters engine)

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
   Returns the round's table and the corrected rows, [None] without a table. *)
let run engine (request : Request.t) ~backoff ~on_row =
  let order = Mesh_sessions_order.service request in
  match read_table engine with
  | Error reason ->
      List.iter (fun session -> on_row session (Error reason)) order;
      None
  | Ok round ->
      prepare_adapters engine round;
      let ended = ref [] in
      let work (session : Request.session) =
        Blocking.call engine.blocking (fun () -> Describe.row engine.registry round (Request.agent_session session))
      in
      let report session outcome =
        let result = settle engine session ~backoff outcome in
        (match result with Row row -> ended := (session, row) :: !ended | Slow | Error _ -> ());
        on_row session result
      in
      Mesh_deadline_pool.run ~clock:engine.clock ~max_concurrency:engine.config.concurrency
        ~deadline:engine.config.deadline ~next:(admitted engine ~backoff ~on_row order) ~work ~report ();
      Some (round, corrections engine round (List.rev !ended))

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

type counts = { mutable ready : int; mutable unsupported : int; mutable slow : int; mutable error : int }

let count counts = function
  | "ready" -> counts.ready <- counts.ready + 1
  | "unsupported" -> counts.unsupported <- counts.unsupported + 1
  | "slow" -> counts.slow <- counts.slow + 1
  | _ -> counts.error <- counts.error + 1

let counts_json counts ~total =
  `Assoc
    [
      ("total", `Int total);
      ("ready", `Int counts.ready);
      ("unsupported", `Int counts.unsupported);
      ("slow", `Int counts.slow);
      ("error", `Int counts.error);
    ]

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

let final_fields engine ~counts ~total ~table_complete ~saturated =
  [
    ("round", `Int engine.rounds);
    ("complete", `Bool (counts.ready + counts.unsupported = total));
    ("counts", counts_json counts ~total);
    ("table", `Assoc [ ("complete", `Bool table_complete) ]);
  ]
  @ degraded engine ~saturated

let round engine (request : Request.t) ~emit =
  engine.rounds <- engine.rounds + 1;
  (* Only a round, which lists every session, bounds the adapters' caches. *)
  resize_adapters engine request;
  Backoff.avoid engine.backoff request.sessions request.avoid;
  let priorities = priorities request in
  let counts = { ready = 0; unsupported = 0; slow = 0; error = 0 } and slow_names = ref [] and saturated = ref false in
  let on_row (session : Request.session) result =
    (match result with
    | Slow | Error "backoff" -> slow_names := session.name :: !slow_names
    | Error "saturated" -> saturated := true
    | Row _ | Error _ -> ());
    count counts (row_event engine request priorities ~emit session result)
  in
  let ran = run engine request ~backoff:true ~on_row in
  (* A corrected row is sent again; it was counted when first sent. *)
  let corrected = match ran with Some (_, corrected) -> corrected | None -> [] in
  List.iter (fun (session, row) -> ignore (row_event engine request priorities ~emit session (Row row))) corrected;
  Backoff.retain engine.backoff request.sessions;
  Request.retain_listed engine.sent request.sessions;
  let table_complete = match ran with Some (round, _) -> Mesh_agent_round.complete round | None -> false in
  update_avoiding engine request (List.rev !slow_names);
  final_fields engine ~counts ~total:(List.length request.sessions) ~table_complete ~saturated:!saturated

let describe engine (request : Request.t) =
  let results = Hashtbl.create (List.length request.sessions) in
  let on_row (session : Request.session) result = Hashtbl.replace results session.name result in
  (match run engine request ~backoff:false ~on_row with
  | Some (_, corrected) -> List.iter (fun ((session : Request.session), row) -> on_row session (Row row)) corrected
  | None -> ());
  let row (session : Request.session) =
    let result = Option.value ~default:(Error "failed") (Hashtbl.find_opt results session.name) in
    `Assoc
      ([ ("name", `String session.name); ("created", session.created); ("state", `String (state_name result)) ]
      @ outcome_fields result)
  in
  [ ("rows", `List (List.map row request.sessions)) ]
