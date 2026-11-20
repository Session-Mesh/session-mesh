(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

module W = Mesh_worklog

type attempt = {
  id : string;
  task : string;
  n : int;
  outcome : string;
  reason : string option;
  text : string option;
  links : string list;
  started : int option;
  ended : int option;
  ref_ : string option;
  agent : string option;
  session : string option;
  request_id : string option;
  at : int;
}

type summary = { total : int; failures : int; consecutive_failures : int; last : attempt option }

let event_type = "attempt"
let outcomes = [ "success"; "failure"; "abandoned" ]
let reasons = [ "ci_failure"; "review_nogo"; "test_red"; "environment"; "external"; "other" ]
let max_text = 500
let max_links = 5
let max_link = 300
let max_ref = 64
let reframe_threshold = 3
let id_digits = 8
let is_hex c = (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f')

let valid_id id =
  String.length id = 2 + id_digits && String.sub id 0 2 = "A-" && String.for_all is_hex (String.sub id 2 id_digits)

let key_char c =
  (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || String.contains "_.:-" c

let valid_key s = String.length s >= 1 && String.length s <= max_ref && String.for_all key_char s

let string_list = function
  | Some (`List l) -> List.filter_map (function `String s -> Some s | _ -> None) l
  | _ -> []

let time ev key = Option.bind (W.Event.get_string ev key) W.Tstamp.parse

(* A readable event: an [A-] id, a known outcome, and a known reason when it
   is a failure. *)
let of_event (ev : W.Event.t) =
  let reason = W.Event.get_string ev "reason" in
  match (W.Event.get_string ev "id", W.Event.get_string ev "outcome") with
  | Some id, Some outcome
    when valid_id id && List.mem outcome outcomes
         && (outcome <> "failure" || match reason with Some r -> List.mem r reasons | None -> false) ->
      Some
        {
          id;
          task = ev.task;
          n = 0;
          outcome;
          reason = (if outcome = "success" then None else reason);
          text = W.Event.get_string ev "text";
          links = string_list (W.Event.get ev "links");
          started = time ev "started";
          ended = time ev "ended";
          ref_ = W.Event.get_string ev "ref";
          agent = W.Event.get_string ev "agent";
          session = W.Event.get_string ev "session";
          request_id = W.Event.get_string ev "request_id";
          at = ev.ts;
        }
  | _ -> None

let malformed_warning (ev : W.Event.t) =
  Printf.sprintf
    "attempt event ignored at %s: it needs an id of A- and 8 lowercase hex digits, an outcome among %s and, \
     on a failure, a reason among %s"
    (W.Event.where ev) (String.concat ", " outcomes) (String.concat ", " reasons)

let collision_warning id =
  Printf.sprintf "attempt id %s is used by more than one attempt event; only the first is kept" id

let fold events =
  let seen = Hashtbl.create 16 and counts = Hashtbl.create 16 in
  let kept = ref [] and warnings = ref [] in
  let add (ev : W.Event.t) =
    match of_event ev with
    | None -> warnings := malformed_warning ev :: !warnings
    | Some a when Hashtbl.mem seen a.id -> warnings := collision_warning a.id :: !warnings
    | Some a ->
        Hashtbl.add seen a.id ();
        let n = 1 + Option.value ~default:0 (Hashtbl.find_opt counts a.task) in
        Hashtbl.replace counts a.task n;
        kept := { a with n } :: !kept
  in
  List.stable_sort W.Event.compare events
  |> List.filter (fun (ev : W.Event.t) -> ev.typ = event_type)
  |> List.iter add;
  (List.rev !kept, List.rev !warnings)

let of_events events = fst (fold events)
let of_events_report = fold

let load_report ctx =
  Result.map (fun (snap : W.Reader.snapshot) -> fold snap.loaded.events) (Work_err.lift (W.Reader.snapshot ctx))
let of_task task attempts = List.filter (fun a -> a.task = task) attempts

let summary attempts =
  let step (failures, run) a =
    match a.outcome with
    | "failure" -> (failures + 1, run + 1)
    | "success" -> (failures, 0)
    | _ -> (failures, run)
  in
  let failures, run = List.fold_left step (0, 0) attempts in
  let last = match List.rev attempts with a :: _ -> Some a | [] -> None in
  { total = List.length attempts; failures; consecutive_failures = run; last }

let needs_reframe s = s.consecutive_failures >= reframe_threshold

let is_noise warning =
  let sub = "unknown event type \"attempt\"" in
  let n = String.length sub and m = String.length warning in
  let rec at i = i + n <= m && (String.sub warning i n = sub || at (i + 1)) in
  at 0

(* Validation: the library repeats every rule of the tool's schema, since a
   writer may not go through it. *)

let refuse_unsafe what s =
  match Work_text.first_unsafe s with
  | Some Work_text.Control -> W.Err.usage "%s contains a control character" what
  | Some Work_text.Invisible -> W.Err.usage "%s contains an invisible or bidirectional character" what
  | None -> ()

let check_line what limit s =
  (match W.Textcheck.text_error ~field:what ~limit s with Some why -> W.Err.usage "%s" why | None -> ());
  refuse_unsafe what s

let check_outcome outcome reason =
  if not (List.mem outcome outcomes) then
    W.Err.usage "outcome must be one of %s, got %S" (String.concat ", " outcomes) outcome;
  match (outcome, reason) with
  | "failure", None -> W.Err.usage "a failure needs a reason (one of %s)" (String.concat ", " reasons)
  | "success", Some _ -> W.Err.usage "a success takes no reason"
  | _, Some r when not (List.mem r reasons) ->
      W.Err.usage "reason must be one of %s, got %S" (String.concat ", " reasons) r
  | _ -> ()

let check_links links =
  if List.length links > max_links then W.Err.usage "at most %d links" max_links;
  List.iter (check_line "link" max_link) links

let parse_time what = function
  | None -> None
  | Some s -> (
      match W.Tstamp.parse s with
      | Some t -> Some t
      | None -> W.Err.usage "%s must be a UTC timestamp like 2026-11-20T10:00:00Z, got %S" what s)

let check_times ~now started ended =
  let after_now what = function
    | Some t when t > now -> W.Err.usage "%s is later than the time of this write" what
    | _ -> ()
  in
  after_now "started" started;
  after_now "ended" ended;
  match (started, ended) with
  | Some s, Some e when s > e -> W.Err.usage "started is later than ended"
  | _ -> ()

let check_key what = function
  | Some k when not (valid_key k) ->
      W.Err.usage "%s must be 1 to %d characters among A-Z a-z 0-9 _ . : -" what max_ref
  | _ -> ()

type recorded = { attempt_id : string; number : int; duplicate : bool; task_summary : summary }

let fresh_id (tx : W.Txn.t) attempts =
  let rec draw tries =
    let id = Printf.sprintf "A-%08Lx" (Random.State.int64 tx.ctx.rng 0x100000000L) in
    if List.exists (fun a -> a.id = id) attempts && tries > 0 then draw (tries - 1) else id
  in
  draw 50

(* The attempt a retried call already wrote: same session, same request id,
   same task. *)
let earlier_request (tx : W.Txn.t) attempts ~task ~request_id =
  let session = Option.bind tx.session (fun (s : W.Session.t) -> s.session) in
  List.find_opt (fun a -> a.task = task && a.request_id = Some request_id && a.session = session) attempts

let opt_field key f = function Some v -> [ (key, f v) ] | None -> []

let payload ~id ~outcome ~reason ~text ~links ~started ~ended ~ref_ ~request_id =
  [ ("id", `String id); ("outcome", `String outcome) ]
  @ opt_field "reason" (fun r -> `String r) reason
  @ opt_field "text" (fun t -> `String t) text
  @ (if links = [] then [] else [ ("links", `List (List.map (fun l -> `String l) links)) ])
  @ opt_field "started" (fun t -> `String t) started
  @ opt_field "ended" (fun t -> `String t) ended
  @ opt_field "ref" (fun r -> `String r) ref_
  @ opt_field "request_id" (fun r -> `String r) request_id

let validate (tx : W.Txn.t) ~outcome ~reason ~text ~links ~started ~ended ~ref_ ~request_id =
  check_outcome outcome reason;
  Option.iter (check_line "text" max_text) text;
  check_links links;
  check_times ~now:tx.now (parse_time "started" started) (parse_time "ended" ended);
  check_key "ref" ref_;
  check_key "request_id" request_id

let record ctx ?session ~task ~outcome ?reason ?text ?(links = []) ?started ?ended ?ref_ ?request_id () =
  W.Txn.run ctx ?session (fun tx ->
      validate tx ~outcome ~reason ~text ~links ~started ~ended ~ref_ ~request_id;
      let task = (W.Validate.task tx task).W.Model.id in
      let attempts = of_events tx.loaded.events in
      let mine = of_task task attempts in
      match Option.bind request_id (fun request_id -> earlier_request tx attempts ~task ~request_id) with
      | Some a -> { attempt_id = a.id; number = a.n; duplicate = true; task_summary = summary mine }
      | None ->
          let id = fresh_id tx attempts in
          W.Txn.append tx
            [ (task, event_type, payload ~id ~outcome ~reason ~text ~links ~started ~ended ~ref_ ~request_id) ];
          W.Txn.commit tx ~cmd:"attempt" ~subject:(Some id);
          let added =
            {
              id; task; n = List.length mine + 1; outcome; reason; text; links;
              started = parse_time "started" started; ended = parse_time "ended" ended; ref_;
              agent = None; session = None; request_id; at = tx.now;
            }
          in
          { attempt_id = id; number = added.n; duplicate = false; task_summary = summary (mine @ [ added ]) })
