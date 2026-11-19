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
  }

(* How one session ended. *)
type result = Ready of Yojson.Safe.t | Unsupported of Yojson.Safe.t | Slow | Error of string

(* A blocking call in a system thread, within the setup deadline; [None] on failure. *)
let setup engine f =
  match
    Eio.Time.with_timeout engine.clock engine.config.setup_deadline (fun () ->
        Ok (Blocking.call engine.blocking f))
  with
  | Ok value -> Some value
  | Error `Timeout -> None
  | exception (Blocking.Saturated | Unix.Unix_error _ | Sys_error _ | Failure _) -> None

let read_table engine =
  Option.bind (setup engine (fun () -> Mesh_agent_round.read engine.platform)) Result.to_option

let prepare_adapters engine round ~sessions =
  List.iter
    (fun adapter ->
      Mesh_agent.resize adapter ~sessions;
      ignore (setup engine (fun () -> Mesh_agent.prepare adapter round)))
    (Mesh_agent.Registry.adapters engine.registry)

let settle engine (session : Request.session) ~backoff outcome =
  match (outcome : Describe.t Mesh_deadline_pool.outcome) with
  | Ready described ->
      if backoff then Backoff.ready engine.backoff session;
      (match described with Described row -> Ready row | Unsupported row -> Unsupported row)
  | Slow when backoff -> ( match Backoff.slow engine.backoff session with `Slow -> Slow | `Backoff -> Error "backoff")
  | Slow -> Slow
  | Failed Blocking.Saturated -> Error "saturated"
  | Failed _ -> Error "failed"

(* Describe every session of the request; [on_row] receives each as it ends.
   The result says whether the process table was complete. *)
let run engine (request : Request.t) ~backoff ~on_row =
  let order = Mesh_sessions_order.service request in
  match read_table engine with
  | None ->
      List.iter (fun session -> on_row session (Error "no_process_table")) order;
      false
  | Some round ->
      prepare_adapters engine round ~sessions:(List.length request.sessions);
      let pending = ref order in
      let rec next () =
        match !pending with
        | [] -> None
        | session :: rest ->
            pending := rest;
            if (not backoff) || Backoff.admit engine.backoff session then Some session
            else (on_row session (Error "backoff"); next ())
      in
      let work (session : Request.session) =
        Blocking.call engine.blocking (fun () -> Describe.row engine.registry round ~sid:session.pid)
      in
      Mesh_deadline_pool.run ~clock:engine.clock ~max_concurrency:engine.config.concurrency
        ~deadline:engine.config.deadline ~next ~work
        ~report:(fun session outcome -> on_row session (settle engine session ~backoff outcome))
        ();
      Mesh_agent_round.complete round

let state_name = function
  | Ready _ -> "ready"
  | Unsupported _ -> "unsupported"
  | Slow -> "slow"
  | Error _ -> "error"

(* The fields that say how a session ended: [row], [same] or [reason]. *)
let outcome_fields = function
  | Ready row | Unsupported row -> [ ("row", row) ]
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
  | Ready _ -> counts.ready <- counts.ready + 1
  | Unsupported _ -> counts.unsupported <- counts.unsupported + 1
  | Slow -> counts.slow <- counts.slow + 1
  | Error _ -> counts.error <- counts.error + 1

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

let row_event engine request priorities ~emit (session : Request.session) result =
  let head =
    [
      ("name", `String session.name);
      ("created", session.created);
      ("priority", `Int (Hashtbl.find priorities session.name));
      ("state", `String (state_name result));
    ]
  in
  let body = deduplicate engine session ~full:request.Request.full (outcome_fields result) in
  match emit "row" (head @ body) with
  | Ok () -> ()
  | Error _ ->
      Hashtbl.remove engine.sent session.name;
      let head = List.filter (fun (key, _) -> key <> "state") head in
      ignore (emit "row" (head @ [ ("state", `String "error"); ("reason", `String "too_large") ]))

let retain_sent engine (request : Request.t) =
  let listed = Hashtbl.create (List.length request.sessions) in
  List.iter (fun (session : Request.session) -> Hashtbl.replace listed session.name ()) request.sessions;
  Hashtbl.filter_map_inplace (fun name sent -> if Hashtbl.mem listed name then Some sent else None) engine.sent

let degraded engine slow_names =
  let abandoned = Blocking.abandoned engine.blocking in
  if abandoned = 0 then []
  else
    [
      ( "degraded",
        `Assoc
          [ ("abandoned", `Int abandoned); ("avoid", `List (List.map (fun name -> `String name) slow_names)) ] );
    ]

let round engine (request : Request.t) ~emit =
  engine.rounds <- engine.rounds + 1;
  Backoff.avoid engine.backoff request.sessions request.avoid;
  let priorities = priorities request in
  let counts = { ready = 0; unsupported = 0; slow = 0; error = 0 } and slow_names = ref [] in
  let on_row (session : Request.session) result =
    count counts result;
    (match result with Slow | Error "backoff" -> slow_names := session.name :: !slow_names | _ -> ());
    row_event engine request priorities ~emit session result
  in
  let table_complete = run engine request ~backoff:true ~on_row in
  Backoff.retain engine.backoff request.sessions;
  retain_sent engine request;
  let total = List.length request.sessions in
  [
    ("round", `Int engine.rounds);
    ("complete", `Bool (counts.ready + counts.unsupported = total));
    ("counts", counts_json counts ~total);
    ("table", `Assoc [ ("complete", `Bool table_complete) ]);
  ]
  @ degraded engine (List.rev !slow_names)

let describe engine (request : Request.t) =
  let results = Hashtbl.create (List.length request.sessions) in
  ignore (run engine request ~backoff:false ~on_row:(fun session result -> Hashtbl.replace results session.name result));
  let row (session : Request.session) =
    let result = Option.value ~default:(Error "failed") (Hashtbl.find_opt results session.name) in
    `Assoc
      ([ ("name", `String session.name); ("created", session.created); ("state", `String (state_name result)) ]
      @ outcome_fields result)
  in
  [ ("rows", `List (List.map row request.sessions)) ]
