(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

module W = Mesh_worklog
module Q = Work_mcp.Work_questions

type format = Claude | Vibe | Text | Json

let formats =
  [ ("claude", Claude); ("vibe", Vibe); ("text", Text); ("json", Json) ]

let cap_seconds = 1.5
let max_ids = 5
let answered_days = 14

type summary = {
  session_tasks : string list;
  session_tasks_total : int;
  folder_tasks : string list;
  folder_tasks_total : int;
  folder_tasks_capped : bool;
  open_questions : int;
  answered_questions : int;
}

(* An identifier the library generated: T- and hexadecimal digits. Anything
   else (a hand-edited file) is not printed. *)
let is_task_id s =
  let n = String.length s in
  n >= 4 && n <= 34
  && String.sub s 0 2 = "T-"
  && String.for_all
       (fun c -> (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))
       (String.sub s 2 (n - 2))

let take n l = List.filteri (fun i _ -> i < n) l

let ids rows =
  let all =
    List.filter is_task_id (List.map (fun (r : W.Resume.row) -> r.task.id) rows)
  in
  (take max_ids all, List.length all)

let plural n one many = Printf.sprintf "%d %s" n (if n = 1 then one else many)

let with_ids shown total =
  if shown = [] then ""
  else
    let more = if total > List.length shown then ", ..." else "" in
    " (" ^ String.concat ", " shown ^ more ^ ")"

let sentence s =
  let parts =
    (if s.session_tasks_total > 0 then
       [
         plural s.session_tasks_total "task" "tasks"
         ^ " linked to this session"
         ^ with_ids s.session_tasks s.session_tasks_total;
       ]
     else [])
    @ (if s.folder_tasks_total > 0 then
         [
           (if s.folder_tasks_capped then "at least " else "")
           ^ plural s.folder_tasks_total "task" "tasks"
           ^ " linked to this folder"
           ^ with_ids s.folder_tasks s.folder_tasks_total;
         ]
       else [])
    @ (if s.open_questions > 0 then
         [ plural s.open_questions "open question" "open questions" ]
       else [])
    @
    if s.answered_questions > 0 then
      [ plural s.answered_questions "answered question" "answered questions" ]
    else []
  in
  if parts = [] then None
  else
    Some
      ("Project tracker: " ^ String.concat ", " parts
     ^ ". Call work_resume for the details.")

let summary_json s line =
  `Assoc
    [
      ("schema", `Int 1);
      ("session_tasks", `List (List.map (fun id -> `String id) s.session_tasks));
      ("session_tasks_total", `Int s.session_tasks_total);
      ("folder_tasks", `List (List.map (fun id -> `String id) s.folder_tasks));
      ("folder_tasks_total", `Int s.folder_tasks_total);
      ("folder_tasks_capped", `Bool s.folder_tasks_capped);
      ("open_questions", `Int s.open_questions);
      ("answered_questions", `Int s.answered_questions);
      ("line", `String line);
    ]

let additional_context event line =
  `Assoc
    [
      ( "hookSpecificOutput",
        `Assoc
          [
            ("hookEventName", `String event); ("additionalContext", `String line);
          ] );
    ]

let render format s =
  Option.map
    (fun line ->
      match format with
      | Vibe ->
          Yojson.Safe.to_string
            (`Assoc
              [ ("hook_specific_output", `Assoc [ ("additional_context", `String line) ]) ])
      | Claude ->
          Yojson.Safe.to_string (additional_context "SessionStart" line)
      | Text -> line
      | Json -> Yojson.Safe.to_string (summary_json s line))
    (sentence s)

let where_of (ctx : W.Ctx.t) getenv (id : Work_mcp.Work_identity.t) :
    W.Resume.where =
  let s = id.session in
  {
    host = ctx.host;
    cwd = id.cwd;
    home = getenv "HOME";
    session = Work_mcp.Work_identity.session_id id;
    repo = Option.bind s (fun (s : W.Session.t) -> s.repo);
    branch = Option.bind s (fun (s : W.Session.t) -> s.branch);
  }

let questions_of ~now name questions =
  let mine =
    List.filter (fun (q : Q.question) -> q.session = Some name) questions
  in
  let recent (q : Q.question) =
    match List.rev q.answers with
    | a :: _ -> now - a.Q.answered_at <= answered_days * 86_400
    | [] -> false
  in
  ( List.length (List.filter Q.is_open mine),
    List.length (List.filter recent mine) )

let summarise ~getenv () =
  match getenv "MESH_SESSION" with
  | None | Some "" -> None
  | Some _ -> (
      let id = Work_mcp.Work_identity.of_env ~getenv () in
      match
        ( Work_mcp.Work_identity.session_id id,
          W.Ctx.of_env ~getenv ~commit:false ~warn:ignore () )
      with
      | None, _ | _, Error _ -> None
      | Some name, Ok ctx -> (
          match W.Reader.snapshot ctx with
          | Error _ -> None
          | Ok snapshot ->
              let world = snapshot.loaded.world and now = ctx.now () in
              let where = where_of ctx getenv id in
              (* The briefing's HERE section holds at most [W.Resume.here_cap]
                 rows, session links first: the session's own tasks are
                 counted from the whole tracker, and the folder's are read
                 from a briefing without them. *)
              let filter = { W.Query.no_filter with session = Some name } in
              let mine t = W.Query.matches ~world ~project:None filter t in
              let here keep = (W.Resume.build world ~now ~where ~keep ()).here in
              let linked =
                W.Model.Smap.fold
                  (fun id (t : W.Model.task) n ->
                    if mine t && is_task_id id && t.status <> "done" && t.status <> "dropped" then n + 1 else n)
                  world.tasks 0
              in
              let session_tasks, _ = ids (here mine) in
              let folder_rows = here (fun t -> not (mine t)) in
              let folder_tasks, folder_tasks_total = ids folder_rows in
              let questions, _ = Q.of_events_report snapshot.loaded.events in
              let open_questions, answered_questions = questions_of ~now name questions in
              Some
                {
                  session_tasks;
                  session_tasks_total = linked;
                  folder_tasks;
                  folder_tasks_total;
                  folder_tasks_capped = List.length folder_rows >= W.Resume.here_cap;
                  open_questions;
                  answered_questions;
                }))

(* The cap. The read runs in a worker, a child process in a session (so a
   process group) of its own: every process it starts, the git the library
   runs included, is in that group. After [cap_seconds] of real time, SIGALRM
   kills the whole group and ends work-read at once, with exit 0 and nothing
   printed (the worker hands its line over only when the read has finished).
   SIGALRM is unblocked first: the signal mask is inherited across exec, and a
   launcher that blocks it would otherwise disable the cap. *)
let arm_alarm seconds handler =
  ignore (Unix.sigprocmask Unix.SIG_UNBLOCK [ Sys.sigalrm ]);
  Sys.set_signal Sys.sigalrm (Sys.Signal_handle handler);
  ignore
    (Unix.setitimer Unix.ITIMER_REAL
       { Unix.it_interval = 0.; it_value = seconds })

let disarm_cap () =
  ignore
    (Unix.setitimer Unix.ITIMER_REAL { Unix.it_interval = 0.; it_value = 0. })

let kill_quietly target =
  try Unix.kill target Sys.sigkill with Unix.Unix_error _ -> ()

(* The worker never writes to the agent: its standard output and error go to
   /dev/null, and its line goes to [out] once complete. Should work-read be
   killed before its cap, the worker's own alarm, a little later, kills the
   group. Without a session of its own, the worker does nothing (a [kill 0]
   would reach work-read's group). *)
let worker out compute =
  (try
     ignore (Unix.setsid ());
     arm_alarm (cap_seconds +. 0.5) (fun _ -> kill_quietly 0);
     let null = Unix.openfile "/dev/null" [ Unix.O_RDWR; Unix.O_CLOEXEC ] 0 in
     Unix.dup2 ~cloexec:false null Unix.stdout;
     Unix.dup2 ~cloexec:false null Unix.stderr;
     match compute () with
     | Some line -> ignore (Unix.write_substring out line 0 (String.length line))
     | None -> ()
   with _ -> ());
  Unix._exit 0

let read_all fd =
  let buf = Buffer.create 256 and chunk = Bytes.create 4096 in
  let rec go () =
    match Unix.read fd chunk 0 (Bytes.length chunk) with
    | 0 -> Buffer.contents buf
    | n ->
        Buffer.add_subbytes buf chunk 0 n;
        go ()
    | exception Unix.Unix_error (Unix.EINTR, _, _) -> go ()
  in
  go ()

let rec reap pid =
  match Unix.waitpid [] pid with
  | _ -> ()
  | exception Unix.Unix_error (Unix.EINTR, _, _) -> reap pid

(* [compute ()] in the worker, under the cap. The group is killed through
   [-pid], and the worker through [pid] in case the alarm comes before its
   [setsid] (it has started nothing then). *)
let bounded compute =
  flush_all ();
  let out_r, out_w = Unix.pipe ~cloexec:true () in
  match Unix.fork () with
  | 0 ->
      (try Unix.close out_r with Unix.Unix_error _ -> ());
      worker out_w compute
  | pid ->
      Unix.close out_w;
      arm_alarm cap_seconds (fun _ ->
          kill_quietly (-pid);
          kill_quietly pid;
          Unix._exit 0);
      let line =
        Fun.protect
          ~finally:(fun () -> Unix.close out_r)
          (fun () -> read_all out_r)
      in
      reap pid;
      disarm_cap ();
      if line = "" then None else Some line

let parse = function
  | [ "--format"; name ] -> List.assoc_opt name formats
  | _ -> None

let main args =
  (try
     Work_mcp.Work_identity.scrub_environment ();
     match parse args with
     | None -> ()
     | Some format -> (
         match
           bounded (fun () ->
               Option.bind (summarise ~getenv:Sys.getenv_opt ()) (render format))
         with
         | Some line ->
             print_string (line ^ "\n");
             flush stdout
         | None -> ())
   with _ -> ());
  0
