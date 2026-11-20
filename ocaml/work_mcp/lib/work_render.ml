(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

module W = Mesh_worklog

let trunc ?(max = 500) s =
  let s = Work_text.clean s in
  if String.length s <= max then s
  else
    let cut = ref max in
    while !cut > 0 && Char.code s.[!cut] land 0xC0 = 0x80 do
      decr cut
    done;
    String.sub s 0 !cut ^ "..."

(* Cut after [max] characters (not bytes), on a character boundary: the read
   limit of a text that is limited in characters when it is written. *)
let trunc_chars ~max s =
  let s = Work_text.clean s in
  let n = String.length s in
  let rec at i seen =
    if i >= n then None
    else if Char.code s.[i] land 0xC0 = 0x80 then at (i + 1) seen
    else if seen = max then Some i
    else at (i + 1) (seen + 1)
  in
  match at 0 0 with None -> s | Some i -> String.sub s 0 i ^ "..."

let opt key f = function None -> [] | Some v -> [ (key, f v) ]
let str s = `String s
let tstr ?(max = 200) s = `String (trunc ~max s)
let opt_str key v = opt key str v
let opt_tstr ?max key v = opt key (tstr ?max) v
let ts n = `String (W.Tstamp.format n)
let strs l = `List (List.map str l)
let non_empty key = function [] -> [] | l -> [ (key, strs l) ]

let cap n items =
  let rec take k = function
    | x :: rest when k > 0 -> x :: take (k - 1) rest
    | _ -> []
  in
  let kept = take n items in
  (kept, List.length items - List.length kept)

let capped key n items =
  let kept, omitted = cap n items in
  (key, `List kept) :: (if omitted > 0 then [ (key ^ "_omitted", `Int omitted) ] else [])

(* A list of strings inside an object: at most [items] strings of at most
   [len] bytes, [<key>_omitted] counts the rest; nothing for an empty list. *)
let bounded_strings ?(chars = false) key ~items ~len = function
  | [] -> []
  | l ->
      let kept, omitted = cap items l in
      let cut s = if chars then trunc_chars ~max:len s else trunc ~max:len s in
      (key, `List (List.map (fun s -> `String (cut s)) kept))
      :: (if omitted > 0 then [ (key ^ "_omitted", `Int omitted) ] else [])

(* The last component of a folder: the name of a repository, never its
   absolute path. *)
let rec strip_slashes p =
  if String.length p > 1 && p.[String.length p - 1] = '/' then strip_slashes (String.sub p 0 (String.length p - 1))
  else p

(* The home directory (as given, and with symlinks resolved): a repository
   that is the home directory itself would be named after the login. *)
let home_directories () =
  let given =
    List.filter_map Fun.id
      [ Sys.getenv_opt "HOME"; (try Some (Unix.getpwuid (Unix.getuid ())).Unix.pw_dir with Not_found -> None) ]
  in
  List.concat_map
    (fun h -> h :: (try [ Unix.realpath h ] with Unix.Unix_error _ -> []))
    given
  |> List.map strip_slashes

let repo_name path =
  let path = strip_slashes path in
  if List.mem path (home_directories ()) then None
  else match Filename.basename path with "" | "/" | "." | ".." -> None | name -> Some (trunc ~max:100 name)

let opt_repo repo = match Option.bind repo repo_name with Some n -> [ ("repo", str n) ] | None -> []

let blocker_json (b : W.Model.blocker) =
  `Assoc
    ([ ("id", tstr ~max:40 b.blocker_id); ("kind", tstr ~max:40 b.kind); ("text", tstr ~max:300 b.text) ]
    @ opt_tstr ~max:100 "on" b.on
    @ [ ("opened", ts b.opened) ]
    @ opt "resolved" (fun n -> ts n) b.resolved)

(* A session link, without the folder the session worked in: the folder is
   kept in the data repository for [wl] and the interface, never returned.
   [repo] is the repository's name, not its path. *)
let link_json (l : W.Model.session_link) =
  `Assoc
    ([ ("agent", tstr ~max:100 l.agent); ("session", tstr ~max:100 l.session) ]
    @ opt_repo l.repo
    @ opt_tstr ~max:100 "branch" l.branch
    @ [ ("linked_at", ts l.linked_at) ])

let task_row ?project_title (t : W.Model.task) =
  `Assoc
    ([
       ("id", tstr ~max:40 t.id);
       ("title", tstr ~max:200 t.title);
       ("status", tstr ~max:40 t.status);
       ("priority", tstr ~max:40 t.priority);
       ("product", tstr t.product);
     ]
    @ opt_tstr ~max:40 "project" t.project_id
    @ opt_tstr "project_title" project_title
    @ opt_tstr "track" t.track
    @ opt_tstr ~max:40 "due" t.due
    @ (if t.owner <> "me" then [ ("owner", tstr t.owner) ] else [])
    @ opt "last_activity" (fun n -> ts n) t.last_ts
    @ opt "last_note" (fun s -> tstr ~max:160 s) t.last_note)

let shown_keys =
  [ "text"; "field"; "to"; "value"; "date"; "kind"; "on"; "id"; "blocker"; "repo"; "branch";
    "title"; "options"; "assumption"; "question"; "by" ]

let max_event_options = 8

(* One field of an event: scalars are cut, a list keeps its first strings, an
   object is not shown. [repo] is reduced to the repository name. *)
let bounded_value key = function
  | `String s when key = "repo" -> Option.map str (repo_name s)
  | `String s -> Some (`String (trunc s))
  | `List l ->
      let strings = List.filter_map (function `String s -> Some (tstr ~max:100 s) | _ -> None) l in
      Some (`List (fst (cap max_event_options strings)))
  | (`Int _ | `Bool _ | `Float _ | `Null) as v -> Some v
  | _ -> None

(* An event of a timeline: an allow-list of fields, so the folder of a
   [session_linked] event and anything unknown stay out. *)
let event_json (ev : W.Event.t) =
  let shown =
    List.filter_map
      (fun key ->
        Option.bind (W.Event.get ev key) (fun v ->
            Option.map (fun v -> (key, v)) (bounded_value key v)))
      shown_keys
  in
  `Assoc
    ([ ("at", ts ev.ts); ("task", tstr ~max:40 ev.task); ("type", tstr ~max:40 ev.typ) ]
    @ opt_tstr ~max:100 "agent" (W.Event.get_string ev "agent")
    @ opt_tstr ~max:100 "session" (W.Event.get_string ev "session")
    @ shown)

let max_tags = 30
let max_links = 20
let max_related = 20
let max_milestones = 20

let task_full ?project_title (t : W.Model.task) =
  let base = match task_row ?project_title t with `Assoc l -> l | _ -> [] in
  `Assoc
    (base
    @ [ ("category", tstr ~max:100 t.category); ("created", tstr ~max:40 t.created) ]
    @ opt_tstr ~max:40 "eta" t.eta
    @ opt_tstr ~max:40 "size" t.size
    @ opt_tstr ~max:40 "origin" t.origin
    @ bounded_strings "tags" ~items:max_tags ~len:100
        t.tags
    @ bounded_strings "links" ~items:max_links ~len:300 t.links
    @ bounded_strings "blocked_by" ~items:max_related ~len:40 t.blocked_by
    @ bounded_strings "also" ~items:max_related ~len:100 t.also)

let project_json (row : W.Query.project_row) =
  let p = row.project in
  `Assoc
    ([
       ("id", tstr ~max:40 p.pid);
       ("title", tstr ~max:200 p.title_p);
       ("product", tstr p.product_p);
       ("category", tstr ~max:100 p.category_p);
       ("status", tstr ~max:40 p.status_p);
     ]
    @ opt_tstr ~max:40 "quarter" p.quarter
    @ opt_tstr "owner" p.owner_p
    @ opt_tstr ~max:300 "hlp" p.hlp
    @ opt_tstr ~max:500 "goal" p.goal
    @ bounded_strings "milestones" ~items:max_milestones ~len:300 p.milestones
    @ bounded_strings "risks" ~items:max_milestones ~len:300 p.risks
    @ [ ("open_tasks", `Int row.open_tasks); ("done_tasks", `Int row.done_tasks) ]
    @ opt "progress" (fun f -> `Float f) row.progress)

let max_answers = 5

(* [owner_verified]: written through the owner-authenticated writer;
   [superseded]: a relayed answer of a question that has an owner-authenticated
   one. *)
let answer_json ~verified_exists (a : Work_questions.answer) =
  `Assoc
    ([
       ("text", `String (trunc_chars ~max:Work_questions.max_text a.answer_text));
       ("by", tstr ~max:100 a.by);
       ("at", ts a.answered_at);
     ]
    @ opt_tstr ~max:100 "relayed_by_agent" a.relay_agent
    @ opt_tstr ~max:100 "relayed_by_session" a.relay_session
    @ (if a.owner_web then [ ("owner_verified", `Bool true) ] else [])
    @ if verified_exists && not a.owner_web then [ ("superseded", `Bool true) ] else [])

(* The index of the last owner-verified answer, if any. *)
let last_owner_answer answers =
  List.fold_left
    (fun (i, found) (a : Work_questions.answer) -> (i + 1, if a.owner_web then Some i else found))
    (0, None) answers
  |> snd

(* The newest [max_answers] answers in time order, except that the latest
   owner-verified one is always kept (then with the newest others): later
   relayed lines, forged or merged from another host, must not hide that the
   owner answered. [answers_omitted] counts the ones left out;
   [owner_answered] says that the owner answered, even if a size bound later
   cuts the answers. *)
let capped_answers (answers : Work_questions.answer list) =
  let total = List.length answers and owner = last_owner_answer answers in
  let keep =
    match owner with
    | Some o when o < total - max_answers -> fun i -> i = o || i > total - max_answers
    | _ -> fun i -> i >= total - max_answers
  in
  let verified_exists = owner <> None in
  let kept = List.filteri (fun i _ -> keep i) answers in
  let omitted = total - List.length kept in
  (("answers", `List (List.map (answer_json ~verified_exists) kept))
  :: (if omitted > 0 then [ ("answers_omitted", `Int omitted) ] else []))
  @ if verified_exists then [ ("owner_answered", `Bool true) ] else []

(* A question is bounded here as well as when it is written, in the same unit
   (characters): a line written by [wl], by hand or by a later interface is
   not. Of many answers the newest ones are kept, and the owner's. *)
let question_json (q : Work_questions.question) =
  let answers = capped_answers q.answers in
  `Assoc
    ([
       ("id", tstr ~max:40 q.id);
       ("state", str (if Work_questions.is_open q then "open" else "answered"));
       ("text", `String (trunc_chars ~max:Work_questions.max_text q.text));
     ]
    @ bounded_strings ~chars:true "options" ~items:Work_questions.max_options ~len:Work_questions.max_option q.options
    @ opt "assumption" (fun a -> `String (trunc_chars ~max:Work_questions.max_assumption a)) q.assumption
    @ opt_tstr ~max:40 "about" q.about
    @ opt_tstr ~max:100 "asked_by_agent" q.agent
    @ opt_tstr ~max:100 "asked_by_session" q.session
    @ [ ("asked_at", ts q.asked_at) ]
    @ answers)

let attempt_last (a : Work_attempts.attempt) =
  `Assoc
    ([ ("n", `Int a.n); ("id", tstr ~max:40 a.id); ("outcome", tstr ~max:20 a.outcome) ]
    @ opt_tstr ~max:40 "reason" a.reason
    @ opt "text" (fun t -> `String (trunc_chars ~max:Work_attempts.max_text t)) a.text
    @ [ ("at", ts a.at) ])

let attempts_json (s : Work_attempts.summary) =
  `Assoc
    ([
       ("total", `Int s.total);
       ("failures", `Int s.failures);
       ("consecutive_failures", `Int s.consecutive_failures);
       ("consecutive_failures_threshold", `Int Work_attempts.reframe_threshold);
       ("needs_reframe", `Bool (Work_attempts.needs_reframe s));
     ]
    @ opt "last" attempt_last s.last)

let attempts_row (s : Work_attempts.summary) =
  if s.total = 0 then []
  else [ ("attempts", `Int s.total); ("consecutive_failures", `Int s.consecutive_failures) ]

let with_attempts attempts (t : W.Model.task) = function
  | `Assoc l -> `Assoc (l @ attempts_row (Work_attempts.summary (Work_attempts.of_task t.id attempts)))
  | other -> other

let warnings_json warnings =
  let kept = List.filter (fun w -> not (Work_questions.is_noise w || Work_attempts.is_noise w)) warnings in
  let shown, omitted = cap 10 kept in
  match shown with
  | [] -> []
  | _ ->
      [ ("data_warnings", strs (List.map (fun w -> trunc ~max:300 (Work_err.safe_text w)) shown)) ]
      @ if omitted > 0 then [ ("data_warnings_omitted", `Int omitted) ] else []
