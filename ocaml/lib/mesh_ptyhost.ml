(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

open Mesh_pty_support
module Observe = Mesh_pty_observe

let observe observer env event =
  Option.iter
    (fun sink ->
      Observe.record sink
        ~now:(Eio.Time.Mono.now (Eio.Stdenv.mono_clock env))
        event)
    observer

(* One line on stderr: the journal, under systemd. *)
let log format =
  Printf.ksprintf
    (fun message ->
      try prerr_endline ("mesh-ptyhost: " ^ message)
      with Sys_error _ | Unix.Unix_error _ -> ())
    format

let valid_utf8 ?(maximum = max_int) ?(nul = true) value =
  let rec count offset total =
    if offset = String.length value then total <= maximum
    else if total = maximum || ((not nul) && value.[offset] = '\000') then false
    else
      let decoded = String.get_utf_8_uchar value offset in
      Uchar.utf_decode_is_valid decoded
      && count (offset + Uchar.utf_decode_length decoded) (total + 1)
  in
  count 0 0

let bounded_depth value =
  let rec visit = function
    | [] -> true
    | (_, depth) :: _ when depth > 128 -> false
    | (`String value, _) :: _ when not (valid_utf8 value) -> false
    | (`List items, depth) :: rest ->
        visit
          (List.fold_left (fun xs item -> (item, depth + 1) :: xs) rest items)
    | (`Assoc items, depth) :: rest ->
        List.for_all (fun (key, _) -> valid_utf8 key) items
        && visit
             (List.fold_left
                (fun xs (_, item) -> (item, depth + 1) :: xs)
                rest items)
    | _ :: rest -> visit rest
  in
  visit [ (value, 0) ]

let parse payload =
  if String.length payload > Mesh_wire.max_small_frame then Error "size"
  else if not (valid_utf8 payload) then Error "utf8"
  else
    try
      let value = Yojson.Basic.from_string payload in
      if bounded_depth value then Ok value else Error "depth"
    with Yojson.Json_error _ -> Error "json"

let error = `Assoc [ ("error", `String "invalid request") ]

let whitelist =
  [
    "HOME";
    "USER";
    "LOGNAME";
    "PATH";
    "SHELL";
    "LANG";
    "LC_ALL";
    "LC_CTYPE";
    "XDG_RUNTIME_DIR";
    "MESH_RUNTIME_DIR";
    "XDG_CONFIG_HOME";
    "XDG_DATA_HOME";
    "DBUS_SESSION_BUS_ADDRESS";
    "DISPLAY";
    "WAYLAND_DISPLAY";
    "SSH_AUTH_SOCK";
    "EDITOR";
    "VISUAL";
  ]

let valid_string ?(maximum = 4096) value = valid_utf8 ~maximum ~nul:false value

let valid_session_name value =
  value <> "" && valid_string ~maximum:max_int value

let valid_key key =
  String.length key > 5
  && String.starts_with ~prefix:"MESH_" key
  &&
  let rec loop i =
    i = String.length key
    || (match key.[i] with 'A' .. 'Z' | '0' .. '9' | '_' -> true | _ -> false)
       && loop (i + 1)
  in
  loop 5

let demo_capability_variable = "MESH_RUNNER_DEMO_CAP"

type isolated_agent = {
  uid : int;
  gid : int;
  home : string;
  name : string;
  shell : string;
}

let isolated_agent_from_environment () =
  match Sys.getenv_opt "MESH_PTY_AGENT_UID" with
  | None -> None
  | Some value ->
      let uid =
        try int_of_string value
        with Failure _ -> invalid_arg "isolated agent uid"
      in
      if
        uid <= 0
        || uid = Unix.geteuid ()
        || Unix.getuid () <> Unix.geteuid ()
        || Unix.getgid () <> Unix.getegid ()
        || Unix.geteuid () = 0
      then invalid_arg "isolated agent identity";
      let account =
        try Unix.getpwuid uid
        with Not_found -> invalid_arg "isolated agent account"
      in
      if
        account.Unix.pw_gid = Unix.getegid ()
        || account.Unix.pw_name = "" || account.Unix.pw_dir = ""
        || Filename.is_relative account.Unix.pw_dir
        || account.Unix.pw_shell = ""
        || Filename.is_relative account.Unix.pw_shell
      then invalid_arg "isolated agent account";
      Some
        {
          uid;
          gid = account.Unix.pw_gid;
          home = account.Unix.pw_dir;
          name = account.Unix.pw_name;
          shell = account.Unix.pw_shell;
        }

let isolated_environment agent child_env =
  (* [setpriv] still starts with the runner's kernel credentials. Never pass a
     request variable that can affect its dynamic loader or runtime before the
     UID transition. The host-built [MESH_*] values are intentionally passed
     to the eventual agent, not copied from the runner's environment. The
     runner's runtime directory is not the agent's: [MESH_RUNTIME_DIR] is
     dropped, as [XDG_RUNTIME_DIR] is. *)
  let safe key =
    List.mem key [ "TERM"; "COLORTERM"; "LANG"; "LC_ALL"; "LC_CTYPE" ]
    || (valid_key key && key <> "MESH_RUNTIME_DIR")
  in
  let base =
    [
      "HOME=" ^ agent.home;
      "USER=" ^ agent.name;
      "LOGNAME=" ^ agent.name;
      "SHELL=" ^ agent.shell;
      "PATH="
      ^ Filename.concat agent.home ".local/bin"
      ^ ":/usr/local/bin:/usr/bin:/bin";
    ]
  in
  Array.of_list
    (base
    @ (Array.to_list child_env
      |> List.filter (fun entry ->
          match String.index_opt entry '=' with
          | None -> false
          | Some index -> safe (String.sub entry 0 index))))

let isolated_arguments ?(exact_cwd = false) agent ~cwd arguments =
  let post_drop_script =
    if exact_cwd then
      "cd -- \"$1\" || exit 126; " ^ "[ \"$(pwd -P)\" = \"$1\" ] || exit 126; "
      ^ "[ \"$(/usr/bin/stat -c %u .)\" = \"$2\" ] || exit 126; "
      ^ "shift 2; exec \"$@\""
    else "cd -- \"$1\" || exit 126; shift; exec \"$@\""
  in
  [
    "/usr/bin/setpriv";
    "--reuid=" ^ string_of_int agent.uid;
    "--regid=" ^ string_of_int agent.gid;
    "--clear-groups";
    "--inh-caps=-all";
    "--ambient-caps=-all";
    "--bounding-set=-all";
    "--no-new-privs";
    "/bin/sh";
    "-c";
    post_drop_script;
    "mesh-agent";
    cwd;
  ]
  @ (if exact_cwd then [ string_of_int agent.uid ] else [])
  @ arguments

let isolated_preset_probe env agent entry =
  let files = Mesh_agent_resume_preset.launcher_files entry in
  let arguments =
    isolated_arguments ~exact_cwd:true agent
      ~cwd:(Mesh_agent_resume_preset.cwd entry)
      ([
         "/bin/sh";
         "-c";
         "[ -x \"$1\" ] || exit 126; shift; "
         ^ "for file do [ -r \"$file\" ] || exit 126; done";
         "mesh-launcher-probe";
       ]
      @ files)
  in
  Eio.Switch.run (fun probe_sw ->
      let process =
        Eio_unix.Process.spawn_unix ~sw:probe_sw
          (Eio.Stdenv.process_mgr env)
          ~cwd:Eio.Path.(Eio.Stdenv.fs env / "/")
          ~env:
            (isolated_environment agent
               (Mesh_agent_resume_preset.environment entry))
          ~fds:[] arguments
      in
      match
        Eio.Time.Timeout.run_exn
          (Eio.Time.Timeout.seconds (Eio.Stdenv.mono_clock env) 3.)
          (fun () -> Eio.Process.await process)
      with
      | `Exited 0 -> ()
      | _ -> invalid_arg "isolated preset inaccessible")

let environment fields =
  let extra =
    match List.assoc_opt "env" fields with
    | None | Some `Null -> []
    | Some (`Assoc entries) when List.length entries <= 32 ->
        List.map
          (function
            | key, `String value
              when valid_key key
                   && key <> demo_capability_variable
                   && valid_string value ->
                (key, value)
            | _ -> invalid_arg "env")
          entries
    | _ -> invalid_arg "env"
  in
  (* A request value replaces an inherited one (only [MESH_RUNTIME_DIR] can
     be both): never two entries for one key. *)
  let base =
    List.filter_map
      (fun key ->
        if List.mem_assoc key extra then None
        else Option.map (fun v -> (key, v)) (Sys.getenv_opt key))
      whitelist
  in
  let path =
    Option.value ~default:"/usr/bin:/bin" (List.assoc_opt "PATH" base)
  in
  let path =
    match List.assoc_opt "HOME" base with
    | None -> path
    | Some home ->
        let local = Filename.concat home ".local/bin" in
        if List.mem local (String.split_on_char ':' path) then path
        else local ^ ":" ^ path
  in
  Array.of_list
    (List.map
       (fun (key, value) -> key ^ "=" ^ value)
       (("TERM", "xterm-256color") :: ("COLORTERM", "truecolor")
        :: ("PATH", path)
        :: List.remove_assoc "PATH" base
       @ extra))

type session = {
  name : string;
  creation_receipt : string;
  legacy_origin : bool;
  demo_capability : string option;
  pid : int;
  cwd : string;
  mutable meta : Yojson.Basic.t;
      (** Replaced only by the [start_if] that follows a [stop_agent_if]. *)
  mutable created : float;
      (** The incarnation. [stop_agent_if] moves it on: the shell and its
          terminal stay, the agent is a new one. *)
  mutable agent_stopping : bool;
  mutable input_signal_epoch : int;
  mutable stop_input_epoch : int;
      (** A [stop_agent_if] is under way: nothing is typed or started. *)
  mutable agent_stopped : bool;
      (** The agent was stopped and none was started since: the next [start_if]
          may replace [meta]. *)
  mutable activity : float;
  mutable alive : bool;
  mutable finishing : bool;
  mutable kill_requested : bool;
  mutable hangup_resending : bool;
  mutable command_started : bool;
  mutable last_input : float;
      (** Wall-clock time of the last bytes queued for the program (keystrokes,
          a typed command, a wake). A wake's idle evidence must postdate it. *)
  human_leases : (float option * string, bool) Hashtbl.t;
  lease_connections : (float option * string, int) Hashtbl.t;
      (** Conditional incarnation (or legacy) and client id -> connections. *)
  lease_expires : (float option * string, Mtime.t) Hashtbl.t;
      (** Incarnation/client id -> end of its lease, while no connection is
          attached. *)
  notified : (string, unit) Hashtbl.t;
  notified_order : string Queue.t;
  input : Mesh_pty_input.t;
  replay : Mesh_pty_replay.t;
  mutable clients : Mesh_pty_output.t list;
  mutable conditional_clients : (Mesh_pty_output.t * (unit -> unit)) list;
  mutable size_owner : Mesh_pty_output.t option;
      (** The attachment that owns the PTY size (Mesh_pty_size). *)
  mutable size_watchers : Mesh_pty_output.t list;
      (** Attachments that claimed at attach: they receive an S frame at each
          size or ownership change. *)
  geometry : unit -> int * int;
  birth_geometry : unit -> (int * int) option;
  birth_clients : Mesh_pty_output.t list ref;
  resize : int -> int -> unit;
  close : unit -> unit;
  done_ : unit Eio.Promise.t;
}

let valid_opaque_id value =
  let length = String.length value in
  length >= 16 && length <= 128
  && String.for_all
       (function
         | 'A' .. 'Z' | 'a' .. 'z' | '0' .. '9' | '_' | '-' -> true | _ -> false)
       value

let is_agent_name name =
  name = "codex" || name = "claude" || name = "opencode" || name = "gemini"
  || name = "agy" || name = "vibe" || name = "copilot"

(* Gemini CLI is a node script: argv[0] is node (or nodejs), and its entry
   point is the first argument that is not a node option (the installed link
   [gemini], or its bundle [gemini.js]). As in discover.py, any other
   executable that merely has such a word is not Gemini. *)
let runs_gemini_script argv0 rest =
  let interpreter = Filename.basename argv0 in
  (interpreter = "node" || interpreter = "nodejs")
  &&
  match
    List.find_opt (fun word -> not (String.starts_with ~prefix:"-" word)) rest
  with
  | Some script ->
      let name = Filename.basename script in
      name = "gemini" || name = "gemini.js"
  | None -> false

(* `vibe` execs its bundled terminal interface, which runs as vibe-rs. *)
let agent_of_name name = if name = "vibe-rs" then "vibe" else name

(* Whether [found] runs the agent [requested]: its kernel name when that is an
   agent name (the kernel truncates it, which none of these names reaches; a
   Copilot's kernel name is MainThread, so it falls to argv), else the basename
   of argv[0], or for gemini the node script it runs. *)
let runs_agent (found : Mesh_platform.process) requested =
  let comm = agent_of_name found.comm in
  if is_agent_name comm then comm = requested
  else
    match Mesh_platform.command_line found.pid with
    | Ok (argv0 :: rest) ->
        agent_of_name (Filename.basename argv0) = requested
        || (requested = "gemini" && runs_gemini_script argv0 rest)
    | Ok [] | Error _ -> false

(* The agent [requested] runs in the foreground group of session [s]. Any
   platform error, [Unsupported] included, means no. *)
let supported_foreground s requested =
  is_agent_name requested
  &&
  match Mesh_platform.process s.pid with
  | Error _ -> false
  | Ok leader when leader.tpgid <= 0 -> false
  | Ok leader -> (
      match Mesh_platform.snapshot () with
      | Error _ -> false
      | Ok processes ->
          List.exists
            (fun (found : Mesh_platform.process) ->
              found.sid = s.pid && found.pgrp = leader.tpgid
              && runs_agent found requested)
            processes)

(* Conditional attach may subscribe to size ownership without resizing. Its
   D/H/R input and queued D writes retire at an incarnation change. In a C ack
   this capability describes this exact, conditional size-watching stream. *)
let conditional_input_capability = `String "conditional_input_v1"

(* [agent_relaunch_v1]: [stop_agent_if] and a [start_if] with [meta] are
   served (not in the Unix identity split, whose sessions are another
   account's processes). *)
let session_json ?(relaunch = true) s =
  `Assoc
    [
      ("name", `String s.name);
      ("pid", `Int s.pid);
      ("cwd", `String s.cwd);
      ("meta", s.meta);
      ("created", `Float s.created);
      ("activity", `Float s.activity);
      ("last_input", `Float s.last_input);
      ("attached", `Int (List.length s.clients));
      ( "pty_capabilities",
        `List
          ([ `String "agent_wake_v1"; `String "human_input_lease_v1";
             conditional_input_capability ]
          @ if relaunch then
              [ `String "agent_relaunch_v1"; `String "agent_relaunch_bound_v1" ]
            else []) );
    ]

(* A dirty human-input lease defers agent wakes. Its client may never come
   back to release it (the tab was closed): once no connection of that client
   is attached, the lease holds for this many more seconds, time for a
   reconnecting page to assert it again. [MESH_PTYHOST_HUMAN_LEASE_GRACE]
   sets it, when it is a finite number >= 0. *)
let human_lease_grace =
  lazy
    (match
       Option.bind (Sys.getenv_opt "MESH_PTYHOST_HUMAN_LEASE_GRACE")
         (fun value -> float_of_string_opt (String.trim value))
     with
    | Some seconds when Float.is_finite seconds && seconds >= 0. -> seconds
    | _ -> 600.)

let lease_connection_opened s client_id =
  let count =
    Option.value ~default:0 (Hashtbl.find_opt s.lease_connections client_id)
  in
  Hashtbl.replace s.lease_connections client_id (count + 1);
  Hashtbl.remove s.lease_expires client_id

let lease_connection_closed s ~now client_id =
  match Hashtbl.find_opt s.lease_connections client_id with
  | Some count when count > 1 ->
      Hashtbl.replace s.lease_connections client_id (count - 1)
  | _ -> (
      Hashtbl.remove s.lease_connections client_id;
      (* A grace too large for the clock never expires. *)
      match
        Option.bind
          (Mtime.Span.of_float_ns (Lazy.force human_lease_grace *. 1e9))
          (Mtime.add_span now)
      with
      | Some deadline -> Hashtbl.replace s.lease_expires client_id deadline
      | None -> ())

(* Whether a human's unsent input defers wakes; leases past their grace are
   dropped first. *)
let human_dirty s ~now =
  Hashtbl.fold
    (fun client_id deadline expired ->
      if Mtime.compare deadline now <= 0 then client_id :: expired else expired)
    s.lease_expires []
  |> List.iter (fun client_id ->
      Hashtbl.remove s.lease_expires client_id;
      Hashtbl.remove s.human_leases client_id);
  Hashtbl.fold (fun _ dirty any -> dirty || any) s.human_leases false

let signal s signum =
  if s.alive then
    try Unix.kill (-s.pid) signum
    with Unix.Unix_error (Unix.ESRCH, _, _) -> ()

(* [kill] is a SIGHUP to the session's process group, and a shell can lose one:
   bash that receives it while starting records it, then waits for input
   without acting on it (measured on Ubuntu 24.04, bash 5.2.21: 26 of 300 kills
   sent 1 ms after [new]). A terminal window that closes also hangs up the
   line, so such a shell ends at its next read; the host keeps the master open,
   so it repeats the signal while the session's program has not exited. *)
let hangup_resend_delays = [ 0.25; 0.5; 1.; 2.; 4. ]

(* A program that ignores SIGHUP altogether would still survive the series:
   [kill_after] seconds after its last signal, the group gets SIGKILL. *)
let kill_after = 4.

(* [signal] only reaches a session whose program the host has not reaped
   ([alive]), so a pid that may since name another process is never
   signalled; a kill of a session already ending starts no series. *)
let hang_up env sw s =
  signal s Sys.sighup;
  (* One series per session, however many kills are requested. A daemon fiber:
     host shutdown does not wait for it. *)
  if s.alive && not s.hangup_resending then (
    s.hangup_resending <- true;
    Eio.Fiber.fork_daemon ~sw (fun () ->
        let clock = Eio.Stdenv.mono_clock env in
        List.iter
          (fun delay ->
            if s.alive then (
              Eio.Time.Mono.sleep clock delay;
              signal s Sys.sighup))
          hangup_resend_delays;
        s.hangup_resending <- false;
        if s.alive then (
          Eio.Time.Mono.sleep clock kill_after;
          if s.alive then (
            log "%s: still running after the SIGHUP series, sending SIGKILL"
              s.name;
            signal s Sys.sigkill));
        `Stop_daemon))

(* Seconds between the reaping of a session's program and the end of a
   session whose terminal a background job still holds open. *)
let orphan_grace = 0.5

(* Type a command once the program has drawn its prompt and gone quiet for
   0.8 s, as a person would, or after ten seconds; for both [new] and
   [start_if]. [clear_line]: first erase what a person may have left on the
   shell's line (after [stop_agent_if], attached clients see the prompt). *)
let type_when_ready ?(clear_line = false) env s command =
  let clock = Eio.Stdenv.clock env in
  let start = Eio.Time.now clock in
  (* A command still waiting when [stop_agent_if] moved the incarnation on
     belongs to the stopped agent: it is dropped, never typed later. *)
  let incarnation = s.created in
  let rec wait () =
    Eio.Time.sleep clock 0.2;
    if s.finishing || s.created <> incarnation then ()
      (* Nothing is typed during a stop: once it succeeds the command is
         dropped above; if it fails, the command is typed as before. *)
    else if s.agent_stopping then wait ()
    else if
      Eio.Time.now clock -. start >= 10.
      || (not (Mesh_pty_replay.is_empty s.replay))
         && Eio.Time.now clock -. s.activity > 0.8
    then (
      s.last_input <- Eio.Time.now clock;
      let line = command ^ "\r" in
      ignore
        (Mesh_pty_input.enqueue s.input
           (if clear_line then Mesh_pty_agent_stop.clear_line ^ line else line)))
    else wait ()
  in
  wait ()

(* A session whose fiber fails ends alone: its programs are killed, it leaves
   the listing and its attachments are closed; the host and the other
   sessions go on. The leader was already killed and reaped when the
   session's switch was cancelled. *)
let end_failed_session sessions owned s finish failure =
  log "session %S ended by an internal error: %s" s.name
    (Printexc.to_string failure);
  s.finishing <- true;
  (* Not once the host itself has reaped the leader: its group may be gone
     and its number reused. *)
  (if s.alive then
     try Unix.kill (-s.pid) Sys.sigkill
     with Unix.Unix_error (Unix.ESRCH, _, _) -> ());
  s.alive <- false;
  Mesh_pty_input.close s.input;
  sessions := List.filter (fun other -> other != s) !sessions;
  owned := List.filter (fun other -> other != s) !owned;
  List.iter Mesh_pty_output.close s.clients;
  ignore (Eio.Promise.try_resolve finish ())

(* Seconds after a line was typed during which an idle shell is not taken
   as running no agent ([stop_agent_if] answers [agent_starting]). *)
let agent_start_window = 2.

let agent_refusal reason =
  `Assoc [ ("ok", `Bool false); ("reason", `String reason) ]

(* One reading of the process table, off the fiber that serves sessions. *)
let read_table check =
  Eio_unix.run_in_systhread ~label:"agent-stop" (fun () ->
      match Mesh_platform.snapshot () with
      | Ok table -> Some (check table)
      | Error _ -> None)

(* [stop_agent_if]: stop the agent that the shell of [s] runs in the
   foreground, and keep the shell, its terminal, its output and its
   attachments (Mesh_pty_agent_stop). On success the session is a new
   incarnation: [created] moves on, and one command may be started again
   ([start_if], which may then replace [meta]). Nothing is started here. *)
let stop_agent env s agent expected =
  let runs_agent found = runs_agent found agent in
  match
    read_table (fun table ->
        let classified =
          Mesh_pty_agent_stop.classify ~runs_agent ~leader:s.pid table
        in
        match (expected, classified) with
        | None, _ -> classified
        | Some (pid, incarnation), Mesh_pty_agent_stop.Running group
          when Mesh_pty_agent_stop.bound_foreground ~runs_agent ~leader:s.pid
                 ~group ~pid ~incarnation table ->
            classified
        | Some _, _ -> Mesh_pty_agent_stop.Refused "agent_changed")
  with
  | None -> agent_refusal "process_scan_failed"
  | Some (Mesh_pty_agent_stop.Refused reason) -> agent_refusal reason
  (* An idle shell that was just sent a line may be about to start the agent:
     the table read now would miss it. *)
  | Some Mesh_pty_agent_stop.Idle
    when Eio.Time.now (Eio.Stdenv.clock env) -. s.last_input
         < agent_start_window ->
      agent_refusal "agent_starting"
  | Some foreground -> (
      let group =
        match foreground with
        | Mesh_pty_agent_stop.Running group -> Some group
        | Idle | Refused _ -> None
      in
      (* Never the shell's own group: [classify] names another one. *)
      let signal signum =
        match group with
        | None -> Option.is_none expected
        | Some group -> (
            let bound =
              match expected with
              | None -> true
              | Some (pid, incarnation) ->
                  read_table
                    (Mesh_pty_agent_stop.bound_foreground ~runs_agent
                       ~leader:s.pid ~group ~pid ~incarnation)
                  = Some true
            in
            if (not s.alive) || not bound then false
            else
              try
                Unix.kill (-group) signum;
                s.input_signal_epoch <- s.input_signal_epoch + 1;
                true
              with Unix.Unix_error _ -> Option.is_none expected)
      in
      let clock = Eio.Stdenv.clock env in
      let stopped () =
        read_table (Mesh_pty_agent_stop.gone ~runs_agent ~leader:s.pid ~group)
        = Some true
      in
      match
        Mesh_pty_agent_stop.stop_guarded Mesh_pty_agent_stop.default_timing
          ~signal ~sleep:(Eio.Time.sleep clock)
          ~now:(fun () -> Eio.Time.now clock)
          ~stopped
      with
      | `Identity_changed -> agent_refusal "agent_changed"
      | `Identity_changed_after_signal -> agent_refusal "agent_stop_uncertain"
      | `Still_running -> agent_refusal "agent_still_running"
      | `Stopped when (not s.alive) || s.finishing || s.kill_requested ->
          agent_refusal "stale_incarnation"
      | `Stopped ->
          (* Join any conditional PTY write before moving the incarnation on.
             No new conditional data is admitted while [agent_stopping]. *)
          Mesh_pty_input.retire_guarded s.input;
          if (not s.alive) || s.finishing || s.kill_requested then
            agent_refusal "stale_incarnation"
          else (
            List.iter (fun (_, retire) -> retire ()) s.conditional_clients;
            let legacy (incarnation, _) value =
              if Option.is_none incarnation then Some value else None
            in
            Hashtbl.filter_map_inplace legacy s.human_leases;
            Hashtbl.filter_map_inplace legacy s.lease_connections;
            Hashtbl.filter_map_inplace legacy s.lease_expires;
            let now = Eio.Time.now clock in
            s.created <- (if now > s.created then now else Float.succ s.created);
            s.command_started <- false;
            s.agent_stopped <- true;
            `Assoc [ ("ok", `Bool true); ("created", `Float s.created) ]))

let nonce_of = function
  | `Assoc fields -> List.assoc_opt "nonce" fields
  | _ -> None

let valid_creation_receipt value =
  let hex = function '0' .. '9' | 'a' .. 'f' -> true | _ -> false in
  String.length value = 81
  && value.[64] = ':'
  && String.for_all hex (String.sub value 0 64)
  && String.for_all hex (String.sub value 65 16)
  && String.sub value 65 16 <> "0000000000000000"
  && value.[65] <= '7'

let valid_demo_capability value =
  String.length value = 64
  && String.for_all
       (function '0' .. '9' | 'a' .. 'f' -> true | _ -> false)
       value

let mint_demo_capability env =
  let random = Cstruct.create 32 in
  Eio.Flow.read_exact (Eio.Stdenv.secure_random env) random;
  String.concat ""
    (List.init 32 (fun i -> Printf.sprintf "%02x" (Cstruct.get_uint8 random i)))

let bound_selection sessions fields ~operation ~geometry =
  let allowed =
    [ "op"; "creation_receipt"; "name" ]
    @ if geometry then [ "rows"; "cols" ] else []
  in
  let rec unique seen = function
    | [] -> ()
    | (key, _) :: rest ->
        if List.mem key seen || not (List.mem key allowed) then
          invalid_arg "keys";
        unique (key :: seen) rest
  in
  unique [] fields;
  if List.assoc_opt "op" fields <> Some (`String operation) then
    invalid_arg "op";
  let receipt =
    match List.assoc_opt "creation_receipt" fields with
    | Some (`String value) when valid_creation_receipt value -> value
    | _ -> invalid_arg "receipt"
  in
  let name =
    match List.assoc_opt "name" fields with
    | None -> None
    | Some (`String value) when valid_session_name value -> Some value
    | _ -> invalid_arg "name"
  in
  let size =
    match (List.assoc_opt "rows" fields, List.assoc_opt "cols" fields) with
    | None, None -> None
    | Some (`Int rows), Some (`Int cols)
      when geometry && rows >= 2 && rows <= 65535 && cols >= 2 && cols <= 65535
      ->
        Some (rows, cols)
    | _ -> invalid_arg "geometry"
  in
  match
    List.find_opt
      (fun s ->
        s.creation_receipt = receipt
        && s.alive && (not s.finishing) && (not s.kill_requested)
        && Option.fold ~none:true ~some:(String.equal s.name) name)
      !sessions
  with
  | None -> invalid_arg "incarnation"
  | Some s -> (s, size)

let dispatch ?project_store_hook ?project_observation_hook ?(preset = None)
    ?(agent_presets = None) ?(isolated_agent = None)
    ?(update = Mesh_update_host.create ()) env sw sessions owned reservations
    pending stopping observer =
  (* One closure per host lifetime, never per client connection. No fallback if
     secure randomness fails; generation allocation is non-yielding and burned. *)
  let random = Cstruct.create 32 in
  Eio.Flow.read_exact (Eio.Stdenv.secure_random env) random;
  let boot =
    String.concat ""
      (List.init 32 (fun i ->
           Printf.sprintf "%02x" (Cstruct.get_uint8 random i)))
  in
  let generation = ref 0L in
  let project_root =
    if Option.is_some isolated_agent then ""
    else Mesh_project_store.startup_root ()
  in
  let project_machine () =
    let fd = Unix.openfile "/dev/urandom" [ Unix.O_RDONLY; Unix.O_CLOEXEC ] 0 in
    Fun.protect
      ~finally:(fun () -> Unix.close fd)
      (fun () ->
        let b = Bytes.create 16 in
        let rec fill i =
          if i < 16 then
            let n = Unix.read fd b i (16 - i) in
            if n = 0 then failwith "randomness unavailable" else fill (i + n)
        in
        fill 0;
        String.concat ""
          (List.init 16 (fun i ->
               Printf.sprintf "%02x" (Char.code (Bytes.get b i)))))
  in
  let project_store =
    Mesh_project_store.make ?hook:project_store_hook ~root:project_root ~boot
      ~machine:project_machine ()
  in
  let project_active = ref 0 in
  let observation =
    Mesh_project_observation.make ?hook:project_observation_hook ~boot
      ~store:project_store ()
  in
  Eio.Fiber.fork_daemon ~sw (fun () ->
      while not !stopping do
        Mesh_project_observation.tick observation ~stopping:false;
        Eio.Time.Mono.sleep (Eio.Stdenv.mono_clock env) 0.05
      done;
      Mesh_project_observation.tick observation ~stopping:true;
      `Stop_daemon);
  fun fields ->
    let get key = List.assoc_opt key fields in
    match get "op" with
    | Some (`String op) when Mesh_project_observation.is_operation op ->
        Eio.Cancel.protect (fun () ->
            Eio_unix.run_in_systhread ~label:"project-observation-control"
              (fun () ->
                Mesh_project_observation.run observation
                  ~isolated:(Option.is_some isolated_agent)
                  ~stopping:!stopping fields))
    | Some (`String op) when Mesh_project_codec.is_operation op ->
        if Option.is_some isolated_agent then
          Mesh_project_store.run project_store ~isolated:true fields
        else if !stopping then
          Mesh_project_store.error ~fields project_store op "unavailable"
            "stopping"
        else if !project_active >= 4 then
          Mesh_project_store.error ~fields project_store op "busy"
            "worker-capacity"
        else (
          incr project_active;
          (* A disconnected/expired caller cannot release a running worker's
             slot or its cooperative writer lock. The fiber waits protected. *)
          Eio.Cancel.protect (fun () ->
              Fun.protect
                ~finally:(fun () -> decr project_active)
                (fun () ->
                  Eio_unix.run_in_systhread ~label:"projects" (fun () ->
                      let reply =
                        Mesh_project_store.run project_store ~isolated:false
                          fields
                      in
                      if op = "project_capabilities" then
                        `Assoc
                          (( "observation",
                             Mesh_project_observation.capability observation )
                          :: Mesh_project_codec.obj reply)
                      else reply))))
    | Some (`String "boot_identity") ->
        if List.map fst fields <> [ "op" ] then invalid_arg "keys";
        if !stopping then invalid_arg "stopping";
        `Assoc [ ("version", `Int 1); ("boot", `String boot) ]
    | Some (`String "preset_info") -> (
        if List.sort String.compare (List.map fst fields) <> [ "op"; "preset" ]
        then invalid_arg "keys";
        if !stopping then invalid_arg "stopping";
        match get "preset" with
        | Some (`String selector)
          when String.starts_with ~prefix:"start-claude-" selector -> (
            match
              Option.bind agent_presets (fun ps ->
                  Mesh_agent_resume_preset.find ps selector)
            with
            | None -> invalid_arg "preset"
            | Some entry ->
                Mesh_agent_resume_preset.revalidate entry;
                `Assoc
                  [
                    ("version", `Int 1);
                    ("cwd", `String (Mesh_agent_resume_preset.cwd entry));
                  ])
        | _ -> invalid_arg "preset")
    | Some (`String "preset_ready") ->
        if List.sort String.compare (List.map fst fields) <> [ "op"; "preset" ]
        then invalid_arg "keys";
        if !stopping then invalid_arg "stopping";
        (match (get "preset", preset, isolated_agent) with
        | Some (`String selector), _, Some agent when selector <> "shell" -> (
            match
              Option.bind agent_presets (fun ps ->
                  Mesh_agent_resume_preset.find ps selector)
            with
            | None -> invalid_arg "preset"
            | Some entry ->
                Mesh_agent_resume_preset.revalidate entry;
                isolated_preset_probe env agent entry)
        | _, _, Some _ -> invalid_arg "preset"
        | _, _, None ->
            let held =
              match (get "preset", preset) with
              | Some (`String "shell"), Some (Some held, _, _, _) -> held
              | Some (`String selector), _ -> (
                  match
                    Option.bind agent_presets (fun ps ->
                        Mesh_agent_resume_preset.find ps selector)
                  with
                  | Some entry -> (
                      Mesh_agent_resume_preset.revalidate entry;
                      match Mesh_agent_resume_preset.directory entry with
                      | Some held -> held
                      | None -> invalid_arg "preset custody")
                  | None -> invalid_arg "preset")
              | _ -> invalid_arg "preset"
            in
            let actual = Eio.Path.stat ~follow:false held in
            if
              actual.Eio.File.Stat.kind <> `Directory
              || actual.uid <> Int64.of_int (Unix.geteuid ())
              || actual.perm land 0o077 <> 0
            then invalid_arg "private preset identity");
        `Assoc [ ("version", `Int 1); ("ready", `Bool true) ]
    | Some (`String "list") ->
        `List
          (List.map
             (session_json ~relaunch:(Option.is_none isolated_agent))
             !sessions)
    | Some (`String "update_notice") ->
        (* The latest answer of the release check, from memory: no request, no
           file. [null] when no newer release is announced. *)
        if List.map fst fields <> [ "op" ] then invalid_arg "keys";
        `Assoc
          [ ("ok", `Bool true); ("update", Mesh_update_host.latest update) ]
    | Some (`String "update_notes") ->
        (* The notes of the release [update_notice] announces, from memory: no
           request, no file. [null] without one. *)
        if List.map fst fields <> [ "op" ] then invalid_arg "keys";
        `Assoc [ ("ok", `Bool true); ("notes", Mesh_update_host.notes update) ]
    | Some (`String "processes") ->
        (* Read-only. Refused in the Unix identity split (Linux only, where
           clients read /proc themselves): there another account's clients
           reach this socket, and the host's view of processes is not theirs.
           The scan blocks, so it runs off the fiber that serves sessions. *)
        if !stopping || Option.is_some isolated_agent then
          invalid_arg "processes";
        let request = Mesh_pty_processes.parse fields in
        Eio_unix.run_in_systhread ~label:"processes" (fun () ->
            Mesh_pty_processes.reply request)
    | Some (`String (("list_bound" | "list_legacy_bound") as operation)) ->
        if List.map fst fields <> [ "op" ] || !stopping then invalid_arg "keys";
        `List
          (List.filter_map
             (fun s ->
               if
                 s.alive && (not s.finishing) && (not s.kill_requested)
                 && (operation = "list_bound" || s.legacy_origin)
               then
                 Some
                   (`Assoc
                      [
                        ("name", `String s.name);
                        ("creation_receipt", `String s.creation_receipt);
                        (* The application's own session identity, read in
                           the same snapshot as the receipt. *)
                        ("created", `Float s.created);
                      ])
               else None)
             !sessions)
    | Some (`String "lookup_demo_self") -> (
        if
          List.sort String.compare (List.map fst fields)
          <> [ "capability"; "op" ]
        then invalid_arg "keys";
        if !stopping then invalid_arg "stopping";
        let capability =
          match get "capability" with
          | Some (`String value) when valid_demo_capability value -> value
          | _ -> invalid_arg "capability"
        in
        let session =
          List.find_opt
            (fun s ->
              s.demo_capability = Some capability
              && s.alive && (not s.finishing) && not s.kill_requested)
            !sessions
        in
        match session with
        | Some s ->
            `Assoc
              [
                ("ok", `Bool true);
                ("creation_receipt", `String s.creation_receipt);
              ]
        | None -> invalid_arg "incarnation")
    | Some (`String (("lookup_bound" | "lookup_legacy_bound") as operation)) ->
        let s, _ = bound_selection sessions fields ~operation ~geometry:false in
        if operation = "lookup_legacy_bound" && not s.legacy_origin then
          invalid_arg "incarnation";
        `Assoc
          [
            ("ok", `Bool true);
            ("name", `String s.name);
            ("creation_receipt", `String s.creation_receipt);
          ]
    | Some (`String "geometry_bound") ->
        let s, _ =
          bound_selection sessions fields ~operation:"geometry_bound"
            ~geometry:false
        in
        let rows, cols = s.geometry () in
        if rows < 1 || rows > 65535 || cols < 1 || cols > 65535 then
          invalid_arg "geometry";
        `Assoc
          [
            ("ok", `Bool true);
            ("name", `String s.name);
            ("creation_receipt", `String s.creation_receipt);
            ("kind", `String "kernel-sample");
            ("rows", `Int rows);
            ("cols", `Int cols);
          ]
    | Some (`String "kill") -> (
        match get "name" with
        | Some (`String name) -> (
            match List.find_opt (fun s -> s.name = name) !sessions with
            | None -> `Assoc [ ("ok", `Bool false) ]
            | Some s ->
                hang_up env sw s;
                observe observer env Observe.Kill;
                `Assoc [ ("ok", `Bool true) ])
        | _ -> `Assoc [ ("ok", `Bool false) ])
    | Some (`String "kill_if") -> (
        let created =
          match get "created" with
          | Some (`Float value) when Float.is_finite value -> value
          | Some (`Int value) -> float_of_int value
          | _ -> invalid_arg "created"
        in
        match get "name" with
        | Some (`String name) when name <> "" -> (
            match List.find_opt (fun s -> s.name = name) !sessions with
            | Some s when s.created = created && not s.kill_requested ->
                hang_up env sw s;
                s.kill_requested <- true;
                observe observer env Observe.Kill;
                `Assoc [ ("ok", `Bool true) ]
            | _ -> `Assoc [ ("ok", `Bool false) ])
        | _ -> invalid_arg "name")
    | Some (`String "stop_agent_if") -> (
        let keys = List.sort String.compare (List.map fst fields) in
        if
          keys <> [ "agent"; "created"; "name"; "op" ]
          && keys
             <> [
                  "agent";
                  "agent_incarnation";
                  "agent_input_at";
                  "agent_pid";
                  "created";
                  "name";
                  "op";
                ]
        then invalid_arg "keys";
        let expected =
          match (get "agent_pid", get "agent_incarnation") with
          | None, None -> None
          | Some (`Int pid), Some (`String incarnation) when pid > 0 -> (
              match Int64.of_string_opt incarnation with
              | Some value when value > 0L -> Some (pid, value)
              | _ -> invalid_arg "agent_incarnation")
          | _ -> invalid_arg "agent_pid"
        in
        let input_at =
          match expected, get "agent_input_at" with
          | None, None -> None
          | Some _, Some (`Float value) when Float.is_finite value -> Some value
          | Some _, Some (`Int value) -> Some (float_of_int value)
          | _ -> invalid_arg "agent_input_at"
        in
        if Option.is_some isolated_agent || !stopping then
          invalid_arg "stop_agent_if";
        let created =
          match get "created" with
          | Some (`Float value) when Float.is_finite value -> value
          | Some (`Int value) -> float_of_int value
          | _ -> invalid_arg "created"
        in
        let agent =
          match get "agent" with
          | Some (`String value) when is_agent_name value -> value
          | _ -> invalid_arg "agent"
        in
        match get "name" with
        | Some (`String name) when name <> "" -> (
            match List.find_opt (fun s -> s.name = name) !sessions with
            | Some s
              when s.created = created && s.alive && (not s.finishing)
                   && (not s.kill_requested) && not s.agent_stopping
                   && (match input_at with None -> true | Some at -> at = s.last_input && not (Mesh_pty_input.pending s.input)) ->
                s.stop_input_epoch <- s.input_signal_epoch;
                s.agent_stopping <- true;
                Fun.protect
                  ~finally:(fun () -> s.agent_stopping <- false)
                  (fun () -> stop_agent env s agent expected)
            | _ -> agent_refusal "stale_incarnation")
        | _ -> invalid_arg "name")
    | Some (`String "start_if") -> (
        (* [meta] replaces the session's, on an incarnation whose agent
           [stop_agent_if] stopped, with the same nonce (the session token
           the shell holds stays valid). *)
        let keys = List.sort String.compare (List.map fst fields) in
        if
          keys <> [ "command"; "created"; "name"; "op" ]
          && keys <> [ "command"; "created"; "meta"; "name"; "op" ]
        then invalid_arg "keys";
        let meta =
          match get "meta" with
          | None -> None
          | Some (`Assoc _ as value) -> Some value
          | Some _ -> invalid_arg "meta"
        in
        let created =
          match get "created" with
          | Some (`Float value) when Float.is_finite value -> value
          | Some (`Int value) -> float_of_int value
          | _ -> invalid_arg "created"
        in
        let command =
          match get "command" with
          | Some (`String value)
            when value <> "" && valid_string ~maximum:max_int value ->
              value
          | _ -> invalid_arg "command"
        in
        match get "name" with
        | Some (`String name) when name <> "" -> (
            match List.find_opt (fun s -> s.name = name) !sessions with
            | Some s
              when s.created = created && s.alive && (not s.finishing)
                   && (not s.kill_requested) && (not s.agent_stopping)
                   && (not s.command_started)
                   && (Option.is_none meta || s.agent_stopped) ->
                Option.iter
                  (fun value ->
                    if nonce_of value <> nonce_of s.meta then invalid_arg "meta";
                    s.meta <- value)
                  meta;
                let clear_line = s.agent_stopped in
                s.agent_stopped <- false;
                s.command_started <- true;
                Eio.Fiber.fork ~sw (fun () ->
                    type_when_ready ~clear_line env s command);
                `Assoc [ ("ok", `Bool true) ]
            | _ -> `Assoc [ ("ok", `Bool false) ])
        | _ -> invalid_arg "name")
    | Some (`String "cancel_submit") -> (
        (* The server saw a new turn begin: withdraw a wake's Enter that is
           still waiting behind its delay. *)
        if
          List.sort String.compare (List.map fst fields)
          <> [ "created"; "name"; "op" ]
        then invalid_arg "keys";
        let created =
          match get "created" with
          | Some (`Float value) when Float.is_finite value -> value
          | Some (`Int value) -> float_of_int value
          | _ -> invalid_arg "created"
        in
        match get "name" with
        | Some (`String name) -> (
            match List.find_opt (fun s -> s.name = name) !sessions with
            | Some s when s.created = created ->
                `Assoc
                  [
                    ("ok", `Bool true);
                    ("cancelled", `Bool (Mesh_pty_input.cancel_submit s.input));
                  ]
            | _ ->
                `Assoc
                  [
                    ("ok", `Bool false); ("reason", `String "stale_incarnation");
                  ])
        | _ -> invalid_arg "name")
    | Some (`String "notify_if") -> (
        if
          List.sort String.compare (List.map fst fields)
          <> [
               "agent";
               "count";
               "created";
               "idle_since";
               "name";
               "notification_id";
               "op";
               "through_seq";
             ]
        then invalid_arg "keys";
        let created =
          match get "created" with
          | Some (`Float value) when Float.is_finite value -> value
          | Some (`Int value) -> float_of_int value
          | _ -> invalid_arg "created"
        in
        let notification_id =
          match get "notification_id" with
          | Some (`String value) when valid_opaque_id value -> value
          | _ -> invalid_arg "notification_id"
        in
        (match get "count" with
        | Some (`Int value) when value >= 1 && value <= 9999 -> ()
        | _ -> invalid_arg "count");
        let idle_since =
          match get "idle_since" with
          | Some (`Float value) when Float.is_finite value -> value
          | Some (`Int value) -> float_of_int value
          | _ -> invalid_arg "idle_since"
        in
        (match get "through_seq" with
        | Some (`Int value) when value >= 1 && value <= 9_007_199_254_740_991 ->
            ()
        | _ -> invalid_arg "through_seq");
        let agent =
          match get "agent" with
          | Some
              (`String
                 (("codex" | "claude" | "opencode" | "gemini" | "vibe") as value))
            ->
              value
          | _ -> invalid_arg "agent"
        in
        match get "name" with
        | Some (`String name) when name <> "" -> (
            match List.find_opt (fun s -> s.name = name) !sessions with
            | None ->
                `Assoc
                  [
                    ("ok", `Bool false); ("reason", `String "stale_incarnation");
                  ]
            | Some s
              when s.created <> created || (not s.alive) || s.finishing
                   || s.kill_requested || s.agent_stopping ->
                `Assoc
                  [
                    ("ok", `Bool false); ("reason", `String "stale_incarnation");
                  ]
            | Some s when Hashtbl.mem s.notified notification_id ->
                `Assoc
                  [
                    ("ok", `Bool true);
                    ("accepted", `Bool false);
                    ("reason", `String "already_notified");
                  ]
            | Some s
              when human_dirty s
                     ~now:(Eio.Time.Mono.now (Eio.Stdenv.mono_clock env)) ->
                `Assoc
                  [ ("ok", `Bool false); ("reason", `String "human_dirty") ]
            (* [idle_since] is when the caller last saw the agent finish a
               turn. Input queued since then may have started a new turn,
               which may show an approval prompt that the notice's Enter
               would answer. *)
            | Some s when s.last_input >= idle_since ->
                `Assoc [ ("ok", `Bool false); ("reason", `String "not_idle") ]
            | Some s when not (supported_foreground s agent) ->
                `Assoc
                  [
                    ("ok", `Bool false);
                    ("reason", `String "unsupported_foreground");
                  ]
            | Some s ->
                (* No digit: a menu that is open after all must not read one
                   as a choice. *)
                let signal =
                  "# Mesh: new message(s) waiting; the user approved reading \
                   mail. Please check mail.inbox and read authorized entries \
                   without asking again."
                in
                s.last_input <- Eio.Time.now (Eio.Stdenv.clock env);
                if not (Mesh_pty_input.enqueue_submit s.input signal) then
                  `Assoc
                    [ ("ok", `Bool false); ("reason", `String "input_refused") ]
                else (
                  if Queue.length s.notified_order >= 256 then
                    Hashtbl.remove s.notified (Queue.pop s.notified_order);
                  Hashtbl.add s.notified notification_id ();
                  Queue.push notification_id s.notified_order;
                  `Assoc [ ("ok", `Bool true); ("accepted", `Bool true) ]))
        | _ -> invalid_arg "name")
    | Some (`String (("new" | "new_bound" | "new_preset_bound") as operation))
      -> (
        let selected_preset = operation = "new_preset_bound" in
        let bound = operation <> "new" in
        (if bound then
           let allowed =
             if selected_preset then [ "op"; "name"; "preset"; "deadline_ns" ]
             else
               [ "op"; "name"; "cwd"; "command"; "meta"; "env"; "deadline_ns" ]
           in
           let rec unique seen = function
             | [] -> ()
             | (key, _) :: rest ->
                 if List.mem key seen || not (List.mem key allowed) then
                   invalid_arg "keys";
                 unique (key :: seen) rest
           in
           unique [] fields);
        let deadline =
          if not bound then None
          else
            match get "deadline_ns" with
            | Some (`String encoded) ->
                let value =
                  try Int64.of_string encoded
                  with Failure _ -> invalid_arg "deadline"
                in
                if value <= 0L || encoded <> Int64.to_string value then
                  invalid_arg "deadline";
                Some (Mtime.of_uint64_ns value)
            | _ -> invalid_arg "deadline"
        in
        let within_deadline () =
          Option.iter
            (fun deadline ->
              if
                Mtime.compare
                  (Eio.Time.Mono.now (Eio.Stdenv.mono_clock env))
                  deadline
                >= 0
              then invalid_arg "deadline")
            deadline
        in
        if !stopping then invalid_arg "stopping";
        let name =
          match get "name" with
          | Some (`String n) when n <> "" && valid_string ~maximum:max_int n ->
              n
          | _ -> invalid_arg "name"
        in
        let selected_resume =
          if not selected_preset then None
          else
            match get "preset" with
            | Some (`String "shell") -> None
            | Some (`String selector) -> (
                match
                  Option.bind agent_presets (fun ps ->
                      Mesh_agent_resume_preset.find ps selector)
                with
                | Some entry ->
                    Mesh_agent_resume_preset.revalidate entry;
                    Some entry
                | None -> invalid_arg "preset")
            | _ -> invalid_arg "preset"
        in
        let preset =
          match selected_resume with
          | None -> preset
          | Some entry ->
              Some
                ( Mesh_agent_resume_preset.directory entry,
                  Mesh_agent_resume_preset.cwd entry,
                  Mesh_agent_resume_preset.arguments entry,
                  Mesh_agent_resume_preset.environment entry )
        in
        let cwd =
          if selected_preset then
            match (get "preset", preset) with
            | Some (`String selector), Some (_, directory, _, _)
              when selector = "shell" || Option.is_some selected_resume ->
                directory
            | _ -> invalid_arg "preset"
          else
            match get "cwd" with
            | Some (`String c) when valid_string ~maximum:max_int c -> c
            | _ -> invalid_arg "cwd"
        in
        let command =
          match get "command" with
          | None | Some `Null | Some (`String "") -> None
          | Some (`String value) when valid_string ~maximum:max_int value ->
              Some value
          | _ -> invalid_arg "command"
        in
        let meta =
          match get "meta" with
          | None | Some `Null -> `Assoc []
          | Some (`Assoc _ as value) -> value
          | _ -> invalid_arg "meta"
        in
        let child_env =
          if selected_preset then
            match preset with
            | Some (_, _, _, environment) -> environment
            | None -> invalid_arg "preset"
          else environment fields
        in
        if Hashtbl.mem reservations name then invalid_arg "duplicate";
        within_deadline ();
        let demo_capability =
          if selected_preset then Some (mint_demo_capability env) else None
        in
        within_deadline ();
        let child_env =
          match demo_capability with
          | None -> child_env
          | Some capability ->
              if
                Array.exists
                  (String.starts_with ~prefix:(demo_capability_variable ^ "="))
                  child_env
              then invalid_arg "env";
              Array.append child_env
                [| demo_capability_variable ^ "=" ^ capability |]
        in
        let child_env =
          match isolated_agent with
          | None -> child_env
          | Some agent -> isolated_environment agent child_env
        in
        if !generation = Int64.max_int then invalid_arg "generation";
        generation := Int64.succ !generation;
        let creation_receipt = Printf.sprintf "%s:%016Lx" boot !generation in
        let reservation = ref () in
        Hashtbl.add reservations name reservation;
        let ready, resolve = Eio.Promise.create () in
        pending := ready :: !pending;
        Eio.Fiber.fork ~sw (fun () ->
            let current = ref None in
            let done_, finish = Eio.Promise.create () in
            Fun.protect
              ~finally:(fun () ->
                (* Compare reservation identity, not equal names across reuse. *)
                (match Hashtbl.find_opt reservations name with
                | Some other when other == reservation ->
                    Hashtbl.remove reservations name
                | _ -> ());
                pending := List.filter (fun other -> other != ready) !pending)
              (fun () ->
                try
                  Eio.Switch.run (fun child_sw ->
                      let terminal = Eio_unix.Pty.open_pty ~sw:child_sw () in
                      Eio_unix.Pty.set_window_size
                        (Eio_unix.Pty.tty terminal)
                        { rows = 50; cols = 200; xpixel = 0; ypixel = 0 };
                      let shell =
                        match isolated_agent with
                        | Some agent -> agent.shell
                        | None ->
                            if selected_preset then "/bin/bash"
                            else
                              Option.value ~default:"/bin/bash"
                                (Sys.getenv_opt "SHELL")
                      in
                      let spawn_cwd, arguments =
                        match isolated_agent with
                        | Some agent ->
                            let arguments, exact_cwd =
                              match selected_resume with
                              | Some entry ->
                                  ( Mesh_agent_resume_preset.arguments entry,
                                    true )
                              | None -> ([ shell; "-l" ], false)
                            in
                            ( Eio.Path.(Eio.Stdenv.fs env / "/"),
                              isolated_arguments ~exact_cwd agent ~cwd arguments
                            )
                        | None ->
                            if selected_preset then
                              match preset with
                              | Some (Some held, _, arguments, _) ->
                                  (held, arguments)
                              | None -> invalid_arg "preset"
                              | Some (None, _, _, _) ->
                                  invalid_arg "preset custody"
                            else
                              ( Eio.Path.(Eio.Stdenv.fs env / cwd),
                                [ shell; "-l" ] )
                      in
                      within_deadline ();
                      Option.iter Mesh_agent_resume_preset.revalidate
                        selected_resume;
                      (match (isolated_agent, selected_resume) with
                      | Some agent, Some entry ->
                          isolated_preset_probe env agent entry;
                          Mesh_agent_resume_preset.revalidate entry
                      | _ -> ());
                      within_deadline ();
                      let process =
                        Eio_unix.Process.spawn_unix ~sw:child_sw
                          (Eio.Stdenv.process_mgr env)
                          ~cwd:spawn_cwd ~env:child_env
                          ~login_tty:(Eio_unix.Pty.tty terminal)
                          ~fds:[] arguments
                      in
                      Eio_unix.Fd.close (Eio_unix.Pty.tty terminal);
                      (* Release hooks run newest first: this one runs before
                         the process's own hook, which kills the child and
                         waits for it without a timeout. On macOS a dying
                         process whose terminal holds unread output stays in
                         exit until the master is read or closed, so a session
                         that fails before its program is reaped would hang
                         the host there. On a normal end the program is
                         already reaped and the master closes here instead of
                         a moment later with the switch. *)
                      Eio.Switch.on_release child_sw (fun () ->
                          Eio_unix.Fd.close (Eio_unix.Pty.pty terminal));
                      let now = Eio.Time.now (Eio.Stdenv.clock env) in
                      let input = Mesh_pty_input.create name in
                      let output_reader = Mesh_pty_output.Reader.create () in
                      (* The host sets 50x200 before spawn. Once a native resize
                         changes that geometry, a raw replay is no longer a
                         complete screen bootstrap, even after resizing back. *)
                      let birth_geometry_valid = ref true in
                      let birth_clients = ref [] in
                      let invalidate_birth () =
                        if !birth_geometry_valid then (
                          birth_geometry_valid := false;
                          let frame =
                            Mesh_wire.encode
                              {
                                kind = 'G';
                                payload =
                                  "{\"status\":\"unavailable\",\"revision\":\"2\"}";
                              }
                          in
                          List.iter
                            (fun client ->
                              if not (Mesh_pty_output.enqueue client frame) then
                                Mesh_pty_output.close client)
                            !birth_clients;
                          birth_clients := [])
                      in
                      let geometry () =
                        let size =
                          Eio_unix.Pty.get_window_size
                            (Eio_unix.Pty.pty terminal)
                        in
                        if size.rows <> 50 || size.cols <> 200 then
                          invalidate_birth ();
                        (size.rows, size.cols)
                      in
                      let birth_geometry () =
                        if not !birth_geometry_valid then None
                        else
                          let rows, cols = geometry () in
                          if !birth_geometry_valid then Some (rows, cols)
                          else None
                      in
                      let s =
                        {
                          name;
                          creation_receipt;
                          legacy_origin = not bound;
                          demo_capability;
                          pid = Eio.Process.pid process;
                          cwd;
                          meta;
                          created = now;
                          activity = now;
                          alive = true;
                          finishing = false;
                          kill_requested = false;
                          hangup_resending = false;
                          command_started = Option.is_some command;
                          agent_stopping = false;
                          input_signal_epoch = 0;
                          stop_input_epoch = 0;
                          agent_stopped = false;
                          last_input = 0.;
                          human_leases = Hashtbl.create 4;
                          lease_connections = Hashtbl.create 4;
                          lease_expires = Hashtbl.create 4;
                          notified = Hashtbl.create 16;
                          notified_order = Queue.create ();
                          input;
                          replay = Mesh_pty_replay.create ();
                          clients = [];
                          conditional_clients = [];
                          size_owner = None;
                          size_watchers = [];
                          geometry;
                          birth_geometry;
                          birth_clients;
                          resize =
                            (fun rows cols ->
                              if rows <> 50 || cols <> 200 then
                                invalidate_birth ();
                              Eio_unix.Pty.set_window_size
                                (Eio_unix.Pty.pty terminal)
                                { rows; cols; xpixel = 0; ypixel = 0 });
                          done_;
                          close =
                            (fun () ->
                              Mesh_pty_input.close input;
                              Mesh_pty_output.Reader.stop output_reader;
                              Eio_unix.Fd.close (Eio_unix.Pty.pty terminal));
                        }
                      in
                      sessions := !sessions @ [ s ];
                      owned := s :: !owned;
                      current := Some s;
                      observe observer env Observe.Create;
                      Eio.Promise.resolve resolve (Ok ());
                      let eof, end_output = Eio.Promise.create () in
                      let status, end_process = Eio.Promise.create () in
                      Eio.Fiber.fork ~sw:child_sw (fun () ->
                          Mesh_pty_input.run input (Eio.Stdenv.clock env)
                            (Eio_unix.Pty.sink terminal));
                      Eio.Fiber.fork ~sw:child_sw (fun () ->
                          let buffer = Cstruct.create 65536 in
                          (try
                             Mesh_pty_output.Reader.run output_reader (fun () ->
                                 while true do
                                   let count =
                                     Eio.Flow.single_read
                                       (Eio_unix.Pty.source terminal)
                                       buffer
                                   in
                                   let data =
                                     Cstruct.to_string
                                       (Cstruct.sub buffer 0 count)
                                   in
                                   Mesh_pty_replay.feed s.replay data;
                                   observe observer env (Observe.Output count);
                                   List.iter
                                     (fun client ->
                                       ignore
                                         (Mesh_pty_output.enqueue_output client
                                            data))
                                     s.clients;
                                   s.activity <-
                                     Eio.Time.now (Eio.Stdenv.clock env);
                                   (* A hot PTY must give healthy writers a turn, without
                                waiting for any slow client's transport. *)
                                   Eio.Fiber.yield ()
                                 done)
                             (* Linux PTY master EOF is reported as EIO by Eio.
                              Input cancellation must not cancel the process reaper. *)
                           with End_of_file | Eio.Io _ -> ());
                          s.finishing <- true;
                          Mesh_pty_input.close input;
                          Eio.Promise.resolve end_output ());
                      Eio.Fiber.fork ~sw:child_sw (fun () ->
                          let code = Eio.Process.await process in
                          s.alive <- false;
                          Eio.Promise.resolve end_process code;
                          (* The program is reaped, EOF or not. A background
                             job it started can keep the terminal open
                             ([sleep 300 & exit]): no EOF comes.
                             [orphan_grace] later the session ends
                             as when a terminal window closes. The reader has
                             relayed the output available meanwhile; stopping
                             it publishes the exit code below and the master
                             closes with the session's switch, which hangs up
                             the job. *)
                          Eio.Fiber.first
                            (fun () -> Eio.Promise.await eof)
                            (fun () ->
                              Eio.Time.Mono.sleep
                                (Eio.Stdenv.mono_clock env)
                                orphan_grace;
                              Mesh_pty_output.Reader.stop output_reader));
                      Option.iter
                        (fun command ->
                          Eio.Fiber.fork ~sw:child_sw (fun () ->
                              type_when_ready env s command))
                        command;
                      Eio.Promise.await eof;
                      let code =
                        try
                          match
                            Eio.Time.Timeout.run_exn
                              (Eio.Time.Timeout.seconds
                                 (Eio.Stdenv.mono_clock env)
                                 2.)
                              (fun () -> Eio.Promise.await status)
                          with
                          | `Exited value -> `Int value
                          | `Signaled value ->
                              `Int (Mesh_pty_protocol.signal_code value)
                        with Eio.Time.Timeout -> `Null
                      in
                      (* X publishes logical completion. Release this incarnation's
                       name before any attachment can observe it, without waiting
                       for a slow writer. Physical process ownership remains below. *)
                      sessions :=
                        List.filter (fun other -> other != s) !sessions;
                      (match Hashtbl.find_opt reservations name with
                      | Some other when other == reservation ->
                          Hashtbl.remove reservations name
                      | _ -> ());
                      observe observer env Observe.Exit;
                      let ending =
                        Mesh_wire.encode
                          {
                            kind = 'X';
                            payload =
                              Yojson.Basic.to_string (`Assoc [ ("code", code) ]);
                          }
                      in
                      let clients = s.clients in
                      List.iter
                        (fun client ->
                          ignore (Mesh_pty_output.enqueue client ending);
                          Mesh_pty_output.finish client)
                        clients;
                      (try
                         Eio.Time.Timeout.run_exn
                           (Eio.Time.Timeout.seconds
                              (Eio.Stdenv.mono_clock env)
                              2.)
                           (fun () ->
                             List.iter
                               (fun client ->
                                 Eio.Promise.await
                                   (Mesh_pty_output.done_ client))
                               clients)
                       with Eio.Time.Timeout ->
                         List.iter Mesh_pty_output.close clients);
                      (* A null exit report does not release process ownership. *)
                      ignore (Eio.Promise.await status);
                      owned := List.filter (fun other -> other != s) !owned;
                      Eio.Promise.resolve finish ())
                with ex -> (
                  match !current with
                  | None -> Eio.Promise.resolve resolve (Error ex)
                  | Some _
                    when match ex with
                         | Eio.Cancel.Cancelled _ -> true
                         | _ -> false ->
                      raise ex
                  | Some s -> end_failed_session sessions owned s finish ex)));
        match Eio.Promise.await ready with
        | Ok () ->
            `Assoc
              ([ ("ok", `Bool true); ("name", `String name) ]
              @
              if bound then [ ("creation_receipt", `String creation_receipt) ]
              else [])
        | Error _ -> error)
    | _ -> error

let read_frame = Mesh_pty_protocol.read_frame
let size = Mesh_pty_protocol.size

(* The attachment that is about to attach, and what the attach decided about
   the PTY size (Mesh_pty_size): [claimed], it applied its geometry and owns
   the size; [watch], it asked for S frames (an attach with "size":"claim"). *)
type size_attach = { client : Mesh_pty_output.t; claimed : bool; watch : bool }

(* Each watching attachment learns the PTY's size and whether it owns it. *)
let announce_size s =
  match s.size_watchers with
  | [] -> ()
  | watchers -> (
      match s.geometry () with
      | exception (Invalid_argument _ | Eio.Io _ | Unix.Unix_error _) -> ()
      | rows, cols ->
          List.iter
            (fun client ->
              let role =
                Mesh_pty_size.role ~same:( == ) ~owner:s.size_owner ~client
              in
              let frame =
                Mesh_wire.encode
                  {
                    kind = 'S';
                    payload = Mesh_pty_size.frame_payload ~rows ~cols role;
                  }
              in
              if not (Mesh_pty_output.enqueue client frame) then
                Mesh_pty_output.close client)
            watchers)

let prepare_attach env observer sessions fields =
  let s =
    match List.assoc_opt "name" fields with
    | Some (`String name) ->
        List.find_opt (fun s -> s.name = name && not s.finishing) !sessions
    | _ -> None
  in
  match s with
  | None -> None
  | Some s -> (
      try
        let geometry =
          match List.assoc_opt "rows" fields with
          | None
          | Some `Null
          | Some (`Bool false)
          | Some (`Int 0)
          | Some (`Float 0.)
          | Some (`String "")
          | Some (`List [])
          | Some (`Assoc []) ->
              None
          | _ -> Some (size fields)
        in
        (* Retained bytes and current geometry, captured before this attach's
           resize. This is not per-byte historical geometry: replay can span
           several resize epochs. *)
        let snapshot = Mesh_pty_replay.replay s.replay in
        let replay_geometry =
          try Some (s.geometry ())
          with Invalid_argument _ | Eio.Io _ | Unix.Unix_error _ -> None
        in
        (* "size":"claim": the geometry applies only while nobody owns the
           size, and the attachment receives S frames. Without it, as before,
           the attach takes the size. *)
        let watch = List.assoc_opt "size" fields = Some (`String "claim") in
        let client = Mesh_pty_output.create () in
        let claimed =
          Option.is_some geometry
          && (Mesh_pty_size.resize ~same:( == ) ~owner:s.size_owner ~client
                (if watch then Mesh_pty_size.Claim else Mesh_pty_size.Take))
               .apply
        in
        Option.iter
          (fun (rows, cols) ->
            if claimed then (
              s.resize rows cols;
              observe observer env Observe.Resize))
          geometry;
        Some (s, snapshot, replay_geometry, { client; claimed; watch })
      with Invalid_argument _ | Eio.Io _ | Unix.Unix_error _ -> None)

let attach ?(origin = false) ?snapshot ?replay_geometry ?size_attach ?incarnation env
    observer s flow =
  let { client; claimed; watch } =
    match size_attach with
    | Some decided -> decided
    | None ->
        { client = Mesh_pty_output.create (); claimed = false; watch = false }
  in
  let input_client_id = ref None in
  let held_input = Queue.create () in
  let held_bytes = ref 0 in
  let holding = ref false in
  let current () =
    Option.fold ~none:true
      ~some:(fun created -> s.created = created && not s.agent_stopping)
      incarnation
  in
  let snapshot, origin_metadata, ready =
    if not origin then
      ( (match snapshot with
        | Some bytes -> bytes
        | None -> Mesh_pty_replay.replay s.replay),
        None,
        false )
    else
      let geometry = s.birth_geometry () in
      match (geometry, Mesh_pty_replay.birth_bytes s.replay) with
      | Some (rows, cols), Some bytes ->
          ( bytes,
            Some
              (`Assoc
                 [
                   ("status", `String "ready");
                   ("revision", `String "1");
                   ("rows", `Int rows);
                   ("cols", `Int cols);
                 ]),
            true )
      | _ ->
          ( Mesh_pty_replay.replay s.replay,
            Some (`Assoc [ ("status", `String "unavailable") ]),
            false )
  in
  let optional key =
    Option.fold ~none:[] ~some:(fun value -> [ (key, value) ])
  in
  let success =
    Yojson.Basic.to_string
      (`Assoc
         ([
            ("ok", `Bool true);
            ( "pty_capabilities",
              `List
                ([ `String "agent_wake_v1"; `String "human_input_lease_v1" ]
                @ if Option.is_some incarnation && watch then
                    [ conditional_input_capability ]
                  else []) );
          ]
         @ optional "replay_geometry"
             (Option.map
                (fun (rows, cols) ->
                  `Assoc [ ("rows", `Int rows); ("cols", `Int cols) ])
                replay_geometry)
         @ optional "terminal_origin" origin_metadata))
  in
  ignore
    (Mesh_pty_output.enqueue client
       (Mesh_wire.encode { kind = 'C'; payload = success }));
  ignore
    (Mesh_pty_output.enqueue client
       (Mesh_wire.encode { kind = 'D'; payload = snapshot }));
  (* No yield between the captured C/D pair and subscriber registration. *)
  if ready then s.birth_clients := client :: !(s.birth_clients);
  s.clients <- client :: s.clients;
  (* Still no yield: a watcher's first S frame follows its replay. *)
  if claimed then s.size_owner <- Some client;
  if watch then s.size_watchers <- client :: s.size_watchers;
  if claimed || watch then announce_size s;
  observe observer env Observe.Attach;
  let released = ref false in
  let release () =
    if not !released then (
      released := true;
      s.conditional_clients <-
        List.filter (fun (other, _) -> other != client) s.conditional_clients;
      s.clients <- List.filter (fun other -> other != client) s.clients;
      s.birth_clients :=
        List.filter (fun other -> other != client) !(s.birth_clients);
      s.size_watchers <-
        List.filter (fun other -> other != client) s.size_watchers;
      (match Mesh_pty_size.detach ~same:( == ) ~owner:s.size_owner ~client with
      | None when Option.is_some s.size_owner ->
          s.size_owner <- None;
          announce_size s
      | _ -> ());
      Option.iter
        (fun client_id ->
          lease_connection_closed s
            ~now:(Eio.Time.Mono.now (Eio.Stdenv.mono_clock env))
            (incarnation, client_id))
        !input_client_id;
      observe observer env Observe.Detach;
      Mesh_pty_output.detached client)
  in
  Option.iter
    (fun _ -> s.conditional_clients <- (client, release) :: s.conditional_clients)
    incarnation;
  Fun.protect ~finally:release
    (fun () ->
      Eio.Switch.run (fun input_switch ->
      let rec output () =
        match Mesh_pty_output.next client with
        | None -> ()
        | Some bytes ->
            Eio.Flow.write flow [ Cstruct.of_string bytes ];
            Mesh_pty_output.sent client bytes;
            output ()
      in
      let rec input () =
        let frame = read_frame flow in
        if not (Option.fold ~none:true ~some:(( = ) s.created) incarnation) then
          Mesh_pty_output.close client
        else if not (current ()) then input ()
        else if frame.kind = 'R' then (
          (match parse frame.payload with
          | Ok (`Assoc fields) -> (
              try
                let rows, cols = size fields in
                match Mesh_pty_size.mode_of_fields fields with
                | None -> ()
                | Some mode ->
                    if not s.finishing then (
                      let decision =
                        Mesh_pty_size.resize ~same:( == ) ~owner:s.size_owner
                          ~client mode
                      in
                      if decision.apply then (
                        s.resize rows cols;
                        observe observer env Observe.Resize);
                      s.size_owner <- decision.owner;
                      announce_size s)
              with Invalid_argument _ | Not_found | Failure _ -> ())
          | _ -> ());
          input ())
        else if frame.kind = 'D' then (
          if s.agent_stopping || !holding then (
            if String.length frame.payload <= (8 * 1024 * 1024) - !held_bytes then (
              let epoch = if s.agent_stopping then s.stop_input_epoch else s.input_signal_epoch in
              Queue.add (s.created, epoch, frame.payload) held_input;
              held_bytes := !held_bytes + String.length frame.payload);
            if not !holding then (
              holding := true;
              Eio.Fiber.fork ~sw:input_switch (fun () ->
                  let rec wait () =
                    if s.agent_stopping && not s.finishing then (
                      Eio.Time.sleep (Eio.Stdenv.clock env) 0.01;
                      wait ())
                  in
                  wait ();
                  while not (Queue.is_empty held_input) do
                    let incarnation, epoch, payload = Queue.take held_input in
                    held_bytes := !held_bytes - String.length payload;
                    if not s.finishing && s.created = incarnation && s.input_signal_epoch = epoch then (
                      s.last_input <- Eio.Time.now (Eio.Stdenv.clock env);
                      if Mesh_pty_input.enqueue s.input payload then
                        observe observer env (Observe.Input (String.length payload)))
                  done;
                  holding := false)))
          else if not s.finishing then (
            s.last_input <- Eio.Time.now (Eio.Stdenv.clock env);
            if
              Mesh_pty_input.enqueue
                ?current:(Option.map (fun _ -> current) incarnation)
                s.input frame.payload
            then
              observe observer env (Observe.Input (String.length frame.payload)));
          input ())
        else if frame.kind = 'H' then (
          (match parse frame.payload with
          | Ok (`Assoc fields)
            when List.sort String.compare (List.map fst fields)
                 = [ "client_id"; "dirty" ] -> (
              match
                ( List.assoc_opt "client_id" fields,
                  List.assoc_opt "dirty" fields )
              with
              | Some (`String client_id), Some (`Bool dirty)
                when valid_opaque_id client_id
                     && Option.fold ~none:true ~some:(String.equal client_id)
                          !input_client_id ->
                  if Option.is_none !input_client_id then
                    lease_connection_opened s (incarnation, client_id);
                  input_client_id := Some client_id;
                  Hashtbl.replace s.human_leases (incarnation, client_id) dirty
              | _ -> ())
          | _ -> ());
          input ())
      in
      Eio.Fiber.first
        (fun () -> Eio.Fiber.first output input)
        (fun () -> Eio.Promise.await (Mesh_pty_output.aborted client))))

let write_reply flow reply =
  let payload = Yojson.Basic.to_string reply in
  let payload =
    if String.length payload > Mesh_wire.max_small_frame then
      Yojson.Basic.to_string error
    else payload
  in
  Eio.Flow.copy_string (Mesh_wire.encode { kind = 'C'; payload }) flow

let conditional_selection sessions fields =
  let allowed = [ "op"; "name"; "created"; "rows"; "cols"; "size" ] in
  let rec keys seen = function
    | [] -> ()
    | (key, _) :: rest ->
        if List.mem key seen || not (List.mem key allowed) then
          invalid_arg "keys";
        keys (key :: seen) rest
  in
  keys [] fields;
  if List.assoc_opt "op" fields <> Some (`String "attach_if") then
    invalid_arg "op";
  (match List.assoc_opt "size" fields with
  | None | Some (`String "claim") -> ()
  | _ -> invalid_arg "size");
  let name =
    match List.assoc_opt "name" fields with
    | Some (`String name) when name <> "" && valid_string ~maximum:max_int name
      ->
        name
    | _ -> invalid_arg "name"
  in
  let created =
    match List.assoc_opt "created" fields with
    | Some (`Float value) when Float.is_finite value && value > 0. -> value
    | Some (`Int value) when value > 0 ->
        let converted = float_of_int value in
        if Int64.of_float converted <> Int64.of_int value then
          invalid_arg "created";
        converted
    | _ -> invalid_arg "created"
  in
  let geometry =
    match (List.assoc_opt "rows" fields, List.assoc_opt "cols" fields) with
    | None, None -> None
    | Some (`Int rows), Some (`Int cols)
      when rows >= 2 && rows <= 65535 && cols >= 2 && cols <= 65535 ->
        Some (rows, cols)
    | _ -> invalid_arg "geometry"
  in
  match
    List.find_opt
      (fun s ->
        s.name = name && s.created = created && (not s.finishing)
        && not s.kill_requested && not s.agent_stopping)
      !sessions
  with
  | None -> invalid_arg "incarnation"
  | Some s -> (s, geometry)

let conditional_attach env observer sessions fields flow =
  let refusal outcome =
    write_reply flow
      (`Assoc [ ("ok", `Bool false); ("outcome", `String outcome) ])
  in
  match
    try
      Some
        (if List.assoc_opt "op" fields = Some (`String "attach_bound") then
           bound_selection sessions fields ~operation:"attach_bound"
             ~geometry:true
         else if
           List.assoc_opt "op" fields = Some (`String "attach_origin_bound")
         then
           bound_selection sessions fields ~operation:"attach_origin_bound"
             ~geometry:false
         else conditional_selection sessions fields)
    with Invalid_argument _ -> None
  with
  | None -> refusal "denied"
  | Some (s, geometry) -> (
      let streaming = ref false in
      try
        let snapshot, replay_geometry =
          if List.assoc_opt "op" fields = Some (`String "attach_if") then
            (* Capture retained bytes and current pre-attach geometry, as for
               ordinary attach, but only after strict incarnation selection. *)
            let snapshot = Mesh_pty_replay.replay s.replay in
            let replay_geometry =
              try Some (s.geometry ())
              with Invalid_argument _ | Eio.Io _ | Unix.Unix_error _ -> None
            in
            (Some snapshot, replay_geometry)
          else (None, None)
        in
        let watch = List.assoc_opt "size" fields = Some (`String "claim") in
        let client = Mesh_pty_output.create () in
        let claimed =
          Option.is_some geometry
          && (Mesh_pty_size.resize ~same:( == ) ~owner:s.size_owner ~client
                (if watch then Mesh_pty_size.Claim else Mesh_pty_size.Take))
               .apply
        in
        let size_attach = { client; claimed; watch } in
        Option.iter
          (fun (rows, cols) ->
            if claimed then (
              s.resize rows cols;
              observe observer env Observe.Resize))
          geometry;
        if (not s.alive) || s.finishing || s.kill_requested then
          refusal "indeterminate"
        else (
          streaming := true;
          attach ?snapshot ?replay_geometry
            ?incarnation:
              (if List.assoc_opt "op" fields = Some (`String "attach_if") then
                 Some s.created
               else None)
            ~origin:
              (List.assoc_opt "op" fields = Some (`String "attach_origin_bound"))
            ~size_attach env observer s flow)
      with Invalid_argument _ | Eio.Io _ | Unix.Unix_error _ ->
        (* Once attach may have emitted its success frame, close the stream;
           never append a contradictory second control outcome. *)
        if not !streaming then refusal "indeterminate")

(* Python's json keeps the last value of a repeated key, at every depth, in
   the position of its first occurrence. *)
let rec last_wins = function
  | `Assoc fields ->
      let latest = Hashtbl.create 8 in
      List.iter (fun (key, value) -> Hashtbl.replace latest key value) fields;
      `Assoc
        (List.filter_map
           (fun (key, _) ->
             Option.map
               (fun value ->
                 Hashtbl.remove latest key;
                 (key, last_wins value))
               (Hashtbl.find_opt latest key))
           fields)
  | `List items -> `List (List.map last_wins items)
  | value -> value

(* The lenient operations read a request with the last occurrence of a
   repeated key winning. The strict operations refuse a repeated key
   instead. *)
let request_fields fields =
  let project_op op = String.starts_with ~prefix:"project_" op in
  let project =
    List.exists
      (function "op", `String op -> project_op op | _ -> false)
      fields
  in
  if project then
    (* Do this before legacy last-wins or attachment dispatch. A mixed repeated
       op must never turn a project request into a legacy mutation. *)
    let op =
      List.find
        (function "op", `String op -> project_op op | _ -> false)
        fields
    in
    (op :: List.filter (fun (key, _) -> key <> "op") fields)
    @
    if List.length (List.filter (fun (key, _) -> key = "op") fields) > 1 then
      [ op ]
    else []
  else
    match last_wins (`Assoc fields) with
    | `Assoc resolved
      when List.mem
             (List.assoc_opt "op" resolved)
             (List.map
                (fun op -> Some (`String op))
                [
                  "list";
                  "new";
                  "kill";
                  "kill_if";
                  "start_if";
                  "notify_if";
                  "cancel_submit";
                  "attach";
                ]) ->
        resolved
    | _ -> fields

let handle env observer dispatch sessions flow =
  try
    let frame = read_frame flow in
    match (frame.kind, parse frame.payload) with
    | 'C', Ok (`Assoc fields) ->
        let fields = request_fields fields in
        let fields =
          if
            String.length frame.payload > Mesh_project_codec.request_bytes
            &&
            match List.assoc_opt "op" fields with
            | Some (`String op) ->
                Mesh_project_codec.is_operation op
                || Mesh_project_observation.is_operation op
            | _ -> false
          then ("__project_request_oversize", `Bool true) :: fields
          else fields
        in
        if
          List.exists
            (fun (key, value) ->
              key = "op"
              && (value = `String "attach_if"
                 || value = `String "attach_bound"
                 || value = `String "attach_origin_bound"))
            fields
        then conditional_attach env observer sessions fields flow
        else if List.assoc_opt "op" fields = Some (`String "attach") then
          match prepare_attach env observer sessions fields with
          | None -> write_reply flow error
          | Some (s, snapshot, replay_geometry, size_attach) ->
              attach ~snapshot ?replay_geometry ~size_attach env observer s flow
        else
          let reply =
            try dispatch fields with
            | Invalid_argument reason when reason = "env" ->
                `Assoc [ ("error", `String "invalid env") ]
            | Invalid_argument reason when reason = "duplicate" ->
                `Assoc [ ("error", `String "Name already taken") ]
            | Invalid_argument _ | Unix.Unix_error _ -> error
          in
          write_reply flow reply
    | _ -> write_reply flow error
  with End_of_file -> ()

let open_private_directory env sw directory =
  if
    Filename.is_relative directory
    || String.length directory > 4096
    || String.contains directory '\000'
  then invalid_arg "private preset directory";
  let rec trusted_ancestors path =
    let ancestor = Unix.lstat path in
    let writable = ancestor.Unix.st_perm land 0o022 <> 0 in
    let root_owner =
      ancestor.st_uid = 0
      || (ancestor.st_uid = 65534 && (Unix.lstat "/").Unix.st_uid = 65534)
    in
    let root_sticky = root_owner && ancestor.st_perm land 0o1000 <> 0 in
    if
      ancestor.st_kind <> Unix.S_DIR
      || ((not root_owner) && ancestor.st_uid <> Unix.geteuid ())
      || (writable && not root_sticky)
    then invalid_arg "private preset ancestor";
    if path <> "/" then (
      let parent = Filename.dirname path in
      if parent = path then invalid_arg "private preset ancestor";
      trusted_ancestors parent)
  in
  trusted_ancestors (Filename.dirname directory);
  let expected = Unix.lstat directory in
  if
    Filename.is_relative directory
    || Unix.realpath directory <> directory
    || expected.Unix.st_kind <> Unix.S_DIR
    || expected.st_uid <> Unix.geteuid ()
    || expected.st_perm land 0o077 <> 0
  then invalid_arg "private preset directory";
  let held =
    Eio.Path.open_subtree ~sw Eio.Path.(Eio.Stdenv.fs env / directory)
  in
  let actual = Eio.Path.stat ~follow:false held in
  if
    actual.Eio.File.Stat.dev <> Int64.of_int expected.st_dev
    || actual.ino <> Int64.of_int expected.st_ino
    || actual.kind <> `Directory
    || actual.uid <> Int64.of_int (Unix.geteuid ())
    || actual.perm land 0o077 <> 0
  then invalid_arg "private preset identity";
  (held :> Eio.Fs.dir_ty Eio.Path.t)

let open_private_preset env sw directory =
  ( Some (open_private_directory env sw directory),
    directory,
    [ "/bin/bash"; "--noprofile"; "--norc"; "-i" ],
    [| "PATH=/usr/bin:/bin"; "TERM=xterm-256color"; "LANG=C.UTF-8" |] )

(* An ignored signal stays ignored across exec, and the spawn has no hook to
   reset it in the child. A caught signal does return to its default there.
   A host started with SIGHUP or SIGQUIT ignored (nohup, a background job of a
   script) therefore keeps surviving them through an empty handler, and its
   sessions start from the default disposition: otherwise a shell that keeps
   an ignored SIGHUP, dash for one, could never be ended by [kill]. *)
let catch_inherited_ignores () =
  List.iter
    (fun signum ->
      match Sys.signal signum Sys.Signal_ignore with
      | Sys.Signal_ignore -> Sys.set_signal signum (Sys.Signal_handle ignore)
      | previous -> Sys.set_signal signum previous)
    [ Sys.sighup; Sys.sigquit ]

(* Eio ignores SIGPIPE so that a write to a closed connection fails with
   EPIPE, and an ignored signal stays ignored across exec: every session
   program would then start with SIGPIPE ignored ([yes | head -1] prints
   "Broken pipe"). A caught signal returns to its default in the child; an
   empty handler keeps EPIPE for the host. Call it once Eio has started. *)
let catch_sigpipe () = Sys.set_signal Sys.sigpipe (Sys.Signal_handle ignore)

(* Whether a live socket of this network namespace is bound to [path]. The
   caller refuses rather than deletes when the answer is yes, so an unreadable
   table (Linux) counts as bound. [Unsupported] (no socket table, macOS today)
   counts as not bound: only a refused connection then marks a socket stale.
   On macOS/BSD a full listen queue, or a socket bound but not yet listening,
   also refuses, so a live owner can look stale. That is safe only because
   [take_host_lock] (same directory as the socket) excludes another native
   host. A host that does not take it (one started by hand, or an older
   Python host) could have its socket removed while its queue is full, so it
   must not run alongside on such a platform. *)
let socket_bound ?(lookup = Mesh_platform.unix_socket_bound) path =
  match lookup path with
  | Ok bound -> bound
  | Error (Mesh_platform.Unsupported _) -> false
  | Error _ -> true

type socket_state = Answering | Bound | Stale

let probe_socket ?lookup path =
  let probe = Unix.socket ~cloexec:true Unix.PF_UNIX Unix.SOCK_STREAM 0 in
  Unix.set_nonblock probe;
  match
    Fun.protect
      ~finally:(fun () -> Unix.close probe)
      (fun () -> Unix.connect probe (Unix.ADDR_UNIX path))
  with
  | () | (exception Unix.Unix_error (Unix.EAGAIN, _, _)) -> Answering
  | exception Unix.Unix_error (Unix.ECONNREFUSED, _, _)
    when socket_bound ?lookup path ->
      Bound
  | exception Unix.Unix_error (Unix.ECONNREFUSED, _, _) -> Stale

(* How long a socket may keep answering, or stay bound, after its host has
   died. The kernel releases the listening socket of a host killed while an
   io_uring operation held it after the process is gone: measured, a host
   restarted right after a SIGKILL found the dead one still answering. *)
let release_wait = 1.

(* A host killed by SIGKILL leaves its socket file behind. Remove it only
   when nothing answers there and no live socket is bound to it; refuse to
   start while another host answers, and leave a socket some process still
   holds untouched. Called with the host lock held, so a host still answering
   is either one that does not take that lock or a dead one being released:
   the probe is repeated for [release_wait] seconds before refusing. *)
let claim_socket_path path =
  match Unix.lstat path with
  | exception Unix.Unix_error (Unix.ENOENT, _, _) -> ()
  | { Unix.st_kind = Unix.S_SOCK; _ } ->
      let deadline = Unix.gettimeofday () +. release_wait in
      let rec claim () =
        match probe_socket path with
        | Stale ->
            log "removing the stale socket %s" path;
            Unix.unlink path
        | (Answering | Bound) when Unix.gettimeofday () < deadline ->
            Unix.sleepf 0.05;
            claim ()
        | Answering -> failwith ("another PTY host is answering on " ^ path)
        | Bound -> failwith ("a live socket is bound to " ^ path)
      in
      claim ()
  | _ -> failwith ("socket target exists and is not a socket: " ^ path)

(* Two hosts started together could both find no live socket, then the later
   one would unlink the socket of the earlier one, leaving its sessions
   unreachable. The host lock next to the socket ([ptyhost.lock]) is taken
   before the socket is examined and held for the host's life: the descriptor
   is never closed, and close-on-exec keeps it out of the sessions. It is a
   POSIX record lock, which needs no C binding. The former Python host took a
   BSD [flock] on the same file: Linux keeps the two kinds apart, so there,
   against such a host, only the connection probe applies; on macOS the two
   kinds conflict (measured) and the hosts exclude each other through this
   lock. *)
let take_host_lock directory =
  let path = Filename.concat directory "ptyhost.lock" in
  let lock =
    Unix.openfile path [ Unix.O_RDWR; Unix.O_CREAT; Unix.O_CLOEXEC ] 0o600
  in
  try Unix.lockf lock Unix.F_TLOCK 0
  with Unix.Unix_error ((Unix.EAGAIN | Unix.EACCES), _, _) ->
    Unix.close lock;
    failwith ("another PTY host holds " ^ path)

(* A host that cannot claim its socket logs why and exits with status 1,
   before serving anything. *)
let claim_or_exit directory path =
  let refuse message =
    log "not starting: %s" message;
    exit 1
  in
  try
    take_host_lock directory;
    claim_socket_path path
  with
  | Failure message -> refuse message
  | Unix.Unix_error _ as failure -> refuse (Printexc.to_string failure)

let accept_retry_delay = 0.5

(* A client that drops its connection is ordinary; anything else is logged.
   Either way only that connection ends. *)
let connection_failed = function
  | Eio.Io (Eio.Net.E (Eio.Net.Connection_reset _), _) -> ()
  | failure ->
      log "connection ended by an error: %s" (Printexc.to_string failure)

let run_impl ?project_store_hook ?project_observation_hook
    ?private_preset_directory ?agent_preset_config () =
  catch_inherited_ignores ();
  let isolated_agent = isolated_agent_from_environment () in
  (match isolated_agent with
  | None -> ()
  | Some agent ->
      if Option.is_some private_preset_directory then
        invalid_arg "isolated shell preset is not supported";
      let executable = Unix.lstat "/usr/bin/setpriv" in
      (* Root-owned files appear as the overflow UID when root is unmapped in
         a subordinate-ID user namespace. All path components must be
         immutable to the agent, even before the runner starts. A mount change
         in the runner's namespace requires CAP_SYS_ADMIN, which the dropped
         agent never receives. *)
      let host_root_is_unmapped () =
        try
          let channel = open_in "/proc/self/uid_map" in
          Fun.protect
            ~finally:(fun () -> close_in channel)
            (fun () ->
              let rec check saw_mapping =
                match input_line channel with
                | line -> (
                    match
                      String.split_on_char ' ' (String.trim line)
                      |> List.filter (( <> ) "")
                    with
                    | [ _inside; outside; count ] ->
                        let outside = Int64.of_string outside in
                        let count = Int64.of_string count in
                        if outside = 0L && count > 0L then false else check true
                    | _ -> false)
                | exception End_of_file -> saw_mapping
              in
              check false)
        with _ -> false
      in
      let trusted_owner uid =
        uid = 0
        || uid = 65534
           && (Unix.lstat "/").Unix.st_uid = 65534
           && host_root_is_unmapped ()
      in
      let trusted_directory path =
        let stat = Unix.lstat path in
        stat.Unix.st_kind = Unix.S_DIR
        && trusted_owner stat.Unix.st_uid
        && stat.Unix.st_perm land 0o022 = 0
      in
      if
        agent.uid = 65534
        || (not (trusted_directory "/"))
        || (not (trusted_directory "/usr"))
        || (not (trusted_directory "/usr/bin"))
        || executable.Unix.st_kind <> Unix.S_REG
        || (not (trusted_owner executable.Unix.st_uid))
        || executable.Unix.st_perm land 0o022 <> 0
        || executable.Unix.st_perm land 0o111 = 0
      then invalid_arg "isolated agent launcher");
  Eio_main.run @@ fun env ->
  Eio.Switch.run @@ fun sw ->
  let preset =
    Option.map (open_private_preset env sw) private_preset_directory
  in
  let agent_presets =
    Option.map
      (fun (path, expected_sha256) ->
        Mesh_agent_resume_preset.load
          ~agent_after_drop:(Option.is_some isolated_agent)
          ~path ~expected_sha256
          ~hold_directory:(open_private_directory env sw)
          ())
      agent_preset_config
  in
  catch_sigpipe ();
  let runtime =
    (* MESH_RUNTIME_DIR, else XDG_RUNTIME_DIR, validated (absolute, canonical,
       owned, not group- or other-writable, short enough for the socket path).
       With both unset: on Linux the guess /run/user/<euid> (mode exactly
       0700); on macOS ~/Library/Application Support/session-mesh/run (passwd
       home), created when missing; on other systems no default, the host
       refuses to start and asks for MESH_RUNTIME_DIR. As [claim_or_exit]: a
       refusal is a clear line and status 1, not an uncaught exception. *)
    match Mesh_platform.runtime_dir () with
    | Ok { Mesh_platform.path; _ } -> path
    | Error message ->
        log "not starting: unusable runtime directory: %s" message;
        exit 1
  in
  (match isolated_agent with
  | None -> ()
  | Some _ ->
      let stat = Unix.lstat runtime in
      if
        Filename.is_relative runtime
        || Unix.realpath runtime <> runtime
        || stat.Unix.st_kind <> Unix.S_DIR
        || stat.Unix.st_uid <> Unix.geteuid ()
        || stat.Unix.st_gid <> Unix.getegid ()
        || stat.Unix.st_perm land 0o027 <> 0
      then invalid_arg "isolated runtime directory");
  let directory = Filename.concat runtime "session-mesh" in
  let directory_mode = if Option.is_some isolated_agent then 0o710 else 0o700 in
  (try Unix.mkdir directory directory_mode
   with Unix.Unix_error (Unix.EEXIST, _, _) ->
     let stat = Unix.lstat directory in
     if
       stat.Unix.st_kind <> Unix.S_DIR
       || Option.is_some isolated_agent
          && (stat.Unix.st_uid <> Unix.geteuid ()
             || stat.Unix.st_gid <> Unix.getegid ())
     then failwith "runtime parent identity");
  Unix.chmod directory directory_mode;
  let path = Filename.concat directory "ptyhost.sock" in
  claim_or_exit directory path;
  let serve observer =
    let socket =
      Eio.Net.listen ~sw ~backlog:16 (Eio.Stdenv.net env) (`Unix path)
    in
    Unix.chmod path (if Option.is_some isolated_agent then 0o660 else 0o600);
    let sessions = ref []
    and owned = ref []
    and reservations = Hashtbl.create 16 in
    let pending = ref [] and stopping = ref false in
    let update = Mesh_update_host.create () in
    let dispatch_owned =
      dispatch ?project_store_hook ?project_observation_hook ~preset
        ~agent_presets ~isolated_agent ~update env sw sessions owned
        reservations pending stopping observer
    in
    let stop, resolve = Eio.Promise.create () in
    let stopped = ref false in
    let handler _ =
      if not !stopped then (
        stopped := true;
        Eio.Promise.resolve resolve ())
    in
    let old_term = Sys.signal Sys.sigterm (Sys.Signal_handle handler) in
    let old_int = Sys.signal Sys.sigint (Sys.Signal_handle handler) in
    Fun.protect
      ~finally:(fun () ->
        Sys.set_signal Sys.sigterm old_term;
        Sys.set_signal Sys.sigint old_int)
      (fun () ->
        Eio.Fiber.first
          (fun () ->
            Eio.Switch.run (fun accept_sw ->
                Option.iter
                  (fun sink ->
                    Eio.Fiber.fork ~sw:accept_sw (fun () ->
                        while Observe.active sink do
                          Observe.tick sink
                            ~now:(Eio.Time.Mono.now (Eio.Stdenv.mono_clock env));
                          Eio.Time.Mono.sleep (Eio.Stdenv.mono_clock env) 0.1
                        done))
                  observer;
                (* Ends with [accept_sw], so a stop does not wait for it. *)
                Mesh_update_host.start update ~sw:accept_sw
                  ~mgr:(Eio.Stdenv.process_mgr env)
                  ~clock:(Eio.Stdenv.mono_clock env) ~log:(fun text ->
                    log "%s" text);
                while true do
                  (* Out of descriptors (EMFILE) or another accept error:
                     the sessions stay; retry once some may be free. *)
                  try
                    Eio.Net.accept_fork ~sw:accept_sw
                      ~on_error:connection_failed socket (fun flow _ ->
                        handle env observer dispatch_owned sessions flow)
                  with (Eio.Io _ | Unix.Unix_error _) as failure ->
                    log "accept failed, retrying in %g s: %s" accept_retry_delay
                      (Printexc.to_string failure);
                    Eio.Time.Mono.sleep
                      (Eio.Stdenv.mono_clock env)
                      accept_retry_delay
                done))
          (fun () -> Eio.Promise.await stop);
        stopping := true;
        Eio.Fiber.first
          (fun () ->
            (* A spawn already accepted before shutdown is still our child. Wait
           for its bounded outcome inside the same global cleanup budget. *)
            List.iter (fun ready -> ignore (Eio.Promise.await ready)) !pending;
            let recorded = !owned in
            List.iter
              (fun s ->
                signal s Sys.sighup;
                s.close ())
              recorded;
            Eio.Time.Mono.sleep (Eio.Stdenv.mono_clock env) 1.;
            List.iter (fun s -> signal s Sys.sigkill) recorded;
            List.iter (fun s -> Eio.Promise.await s.done_) recorded)
          (fun () ->
            Eio.Time.Mono.sleep (Eio.Stdenv.mono_clock env) 5.;
            failwith "child cleanup exceeded five-second budget"))
  in
  match Sys.getenv_opt "MESH_PTY_OBSERVE_BASENAME" with
  | None -> serve None
  | Some basename ->
      Observe.with_sink ~directory ~basename
        ~now:(Eio.Time.Mono.now (Eio.Stdenv.mono_clock env))
        ~lifetime:600. ~max_events:1024
        (fun sink -> serve (Some sink))

let run ?private_preset_directory ?agent_preset_config () =
  run_impl ?private_preset_directory ?agent_preset_config ()
