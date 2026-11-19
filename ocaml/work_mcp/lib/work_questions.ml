(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

module W = Mesh_worklog

type answer = {
  answer_text : string;
  by : string;
  answered_at : int;
  relay_agent : string option;
  relay_session : string option;
}

type question = {
  id : string;
  text : string;
  options : string list;
  assumption : string option;
  about : string option;
  event_task : string;
  agent : string option;
  session : string option;
  request_id : string option;
  asked_at : int;
  answers : answer list;
}

let max_text = 2000
let max_assumption = 1000
let max_options = 8
let max_option = 100
let question_type = "question"
let answer_type = "answer"

let id_digits = 8

(* Eight hex digits are drawn; the six-digit ids of the first version are
   still read. *)
let valid_id id =
  let n = String.length id in
  (n = 8 || n = 2 + id_digits)
  && String.sub id 0 2 = "N-"
  && String.for_all (fun c -> (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f')) (String.sub id 2 (n - 2))

let is_ours typ = typ = question_type || typ = answer_type

let string_list = function
  | Some (`List l) -> List.filter_map (function `String s -> Some s | _ -> None) l
  | _ -> []

let of_question_event (ev : W.Event.t) =
  match (W.Event.get_string ev "id", W.Event.get_string ev "text") with
  | Some id, Some text when valid_id id ->
      Some
        {
          id;
          text;
          options = string_list (W.Event.get ev "options");
          assumption = W.Event.get_string ev "assumption";
          about = (if ev.task = id then None else Some ev.task);
          event_task = ev.task;
          agent = W.Event.get_string ev "agent";
          session = W.Event.get_string ev "session";
          request_id = W.Event.get_string ev "request_id";
          asked_at = ev.ts;
          answers = [];
        }
  | _ -> None

let of_answer_event (ev : W.Event.t) =
  match (W.Event.get_string ev "question", W.Event.get_string ev "text") with
  | Some qid, Some text ->
      let by = Option.value ~default:"unknown" (W.Event.get_string ev "by") in
      Some
        ( qid,
          {
            answer_text = text;
            by;
            answered_at = ev.ts;
            relay_agent = W.Event.get_string ev "agent";
            relay_session = W.Event.get_string ev "session";
          } )
  | _ -> None

let collision_warning id =
  Printf.sprintf
    "question id %s is used by more than one question event (ids drawn on two hosts can collide); only the first is kept, and answers attach to it"
    id

(* A question event that cannot be read (no text, or an id that is not [N-]
   and eight lowercase hex digits) is reported, not dropped silently: the
   library's own warning about its task is filtered as noise. *)
let malformed_warning (ev : W.Event.t) =
  Printf.sprintf
    "question event ignored: it needs a text and an id of N- and 8 lowercase hex digits (id %s)"
    (Option.value ~default:"missing" (W.Event.get_string ev "id"))

(* An answer that attaches to no question is reported, not dropped silently. *)
let orphan_warning qid = Printf.sprintf "answer event ignored: no question has the id %s" qid
let unreadable_answer_warning = "answer event ignored: it needs a question id and a text"

let fold events =
  let questions = Hashtbl.create 16 in
  let order = ref [] in
  let collisions = ref [] in
  let malformed = ref [] in
  let orphans = ref [] in
  let add_question ev =
    match of_question_event ev with
    | Some q when not (Hashtbl.mem questions q.id) ->
        Hashtbl.add questions q.id q;
        order := q.id :: !order
    | Some q -> if not (List.mem q.id !collisions) then collisions := q.id :: !collisions
    | None -> malformed := malformed_warning ev :: !malformed
  in
  let add_answer ev =
    match of_answer_event ev with
    | Some (qid, a) -> (
        match Hashtbl.find_opt questions qid with
        | Some q -> Hashtbl.replace questions qid { q with answers = q.answers @ [ a ] }
        | None -> orphans := orphan_warning qid :: !orphans)
    | None -> orphans := unreadable_answer_warning :: !orphans
  in
  (* Two passes: events order by time then host, so an answer written in the
     same second as its question can sort before it. *)
  let of_type typ = List.filter (fun (ev : W.Event.t) -> ev.typ = typ) events in
  List.iter add_question (of_type question_type);
  List.iter add_answer (of_type answer_type);
  ( List.rev_map (fun id -> Hashtbl.find questions id) !order,
    List.rev_map collision_warning !collisions @ List.rev !malformed @ List.rev !orphans )

let of_events events = fst (fold events)
let of_events_report = fold
let is_open q = q.answers = []

let load_report ctx =
  Result.map
    (fun (snap : W.Reader.snapshot) -> fold snap.loaded.events)
    (Work_err.lift (W.Reader.snapshot ctx))

let load ctx = Result.map fst (load_report ctx)

let is_noise warning =
  let contains sub =
    let n = String.length sub and m = String.length warning in
    let rec at i = i + n <= m && (String.sub warning i n = sub || at (i + 1)) in
    at 0
  in
  contains "unknown event type \"question\""
  || contains "unknown event type \"answer\""
  || contains "unknown event type \"request\""
  || contains "unknown task N-"

let validate_text what limit text =
  let text = W.Validate.text ~what text in
  if W.Textcheck.length text > limit then
    W.Err.usage "%s is longer than %d characters" what limit;
  text

let validate_options options =
  if List.length options > max_options then W.Err.usage "at most %d options" max_options;
  List.iter
    (fun o ->
      match W.Textcheck.text_error ~field:"option" ~limit:max_option o with
      | Some why -> W.Err.usage "%s" why
      | None -> ())
    options

let reference tx about =
  if String.length about >= 2 && (String.sub about 0 2 = "P-" || String.sub about 0 2 = "p-") then
    W.Validate.project_id tx about
  else (W.Validate.task tx about).W.Model.id

let fresh_id (tx : W.Txn.t) =
  let taken = of_events tx.loaded.events |> List.map (fun q -> q.id) in
  let rec draw tries =
    let id = Printf.sprintf "N-%08Lx" (Random.State.int64 tx.ctx.rng 0x100000000L) in
    if List.mem id taken && tries > 0 then draw (tries - 1) else id
  in
  draw 50

(* The question a retried call already wrote: same session, same request id,
   same target. *)
let earlier_request (tx : W.Txn.t) ~request_id ~about =
  let session = Option.bind tx.session (fun (s : W.Session.t) -> s.session) in
  List.find_opt
    (fun q -> q.request_id = Some request_id && q.session = session && q.about = about)
    (of_events tx.loaded.events)

let write_question tx ~text ~options ~assumption ~about ~request_id =
  let id = fresh_id tx in
  let fields =
    [ ("id", `String id); ("text", `String text) ]
    @ (if options = [] then [] else [ ("options", `List (List.map (fun o -> `String o) options)) ])
    @ (match assumption with Some a -> [ ("assumption", `String a) ] | None -> [])
    @ match request_id with Some r -> [ ("request_id", `String r) ] | None -> []
  in
  W.Txn.append tx [ (Option.value ~default:id about, question_type, fields) ];
  W.Txn.commit tx ~cmd:"ask" ~subject:(Some id);
  id

let ask ctx ?session ~text ?(options = []) ?assumption ?about ?request_id () =
  W.Txn.run ctx ?session (fun tx ->
      let text = validate_text "question" max_text text in
      validate_options options;
      let assumption = Option.map (validate_text "assumption" max_assumption) assumption in
      let about = Option.map (reference tx) about in
      match Option.bind request_id (fun request_id -> earlier_request tx ~request_id ~about) with
      | Some q -> (q.id, true)
      | None -> (write_question tx ~text ~options ~assumption ~about ~request_id, false))

let validate_answer ~text ~by =
  let text = validate_text "answer" max_text text in
  (match W.Textcheck.text_error ~field:"by" ~limit:max_option by with
  | Some why -> W.Err.usage "%s" why
  | None -> ());
  text

let find_question (tx : W.Txn.t) question =
  match List.find_opt (fun q -> q.id = question) (of_events tx.loaded.events) with
  | None -> W.Err.not_found "no question %s" question
  | Some q -> q

let write_answer tx q ~text ~by =
  let fields = [ ("question", `String q.id); ("text", `String text); ("by", `String by) ] in
  W.Txn.append tx [ (q.event_task, answer_type, fields) ];
  W.Txn.commit tx ~cmd:"answer" ~subject:(Some q.id)

let answer ctx ~question ~text ~by () =
  W.Txn.run ctx (fun tx ->
      let text = validate_answer ~text ~by in
      let q = find_question tx question in
      write_answer tx q ~text ~by;
      q.id)

type recorded = Recorded of string | Same_answer of string | Already_answered of string

(* The check and the write run under the one repository lock: of two writers
   racing on an open question, the second sees the first answer. *)
let answer_once ctx ?session ~question ~text ~by () =
  W.Txn.run ctx ?session (fun tx ->
      let text = validate_answer ~text ~by in
      let q = find_question tx question in
      if List.exists (fun a -> a.answer_text = text && a.by = by) q.answers then Same_answer q.id
      else if q.answers <> [] then Already_answered q.id
      else begin
        write_answer tx q ~text ~by;
        Recorded q.id
      end)
