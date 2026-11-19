(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(* Environment that would redirect git to another repository or inject
   configuration; GIT_CONFIG_ also covers _COUNT, _KEY_n, _VALUE_n, _PARAMETERS,
   _GLOBAL, _SYSTEM and _NOSYSTEM. *)
let scrubbed_prefixes =
  [ "GIT_DIR="; "GIT_WORK_TREE="; "GIT_INDEX_FILE="; "GIT_OBJECT_DIRECTORY=";
    "GIT_ALTERNATE_OBJECT_DIRECTORIES="; "GIT_COMMON_DIR="; "GIT_NAMESPACE=";
    "GIT_CEILING_DIRECTORIES="; "GIT_DISCOVERY_ACROSS_FILESYSTEM="; "GIT_PREFIX=";
    "GIT_CONFIG_" ]

let default_timeout = 60.0

let starts_with prefix s =
  String.length s >= String.length prefix && String.sub s 0 (String.length prefix) = prefix

let clean_env () =
  let kept =
    List.filter
      (fun kv -> not (List.exists (fun p -> starts_with p kv) scrubbed_prefixes))
      (Array.to_list (Unix.environment ()))
  in
  Array.of_list (kept @ [ "GIT_TERMINAL_PROMPT=0"; "GIT_LITERAL_PATHSPECS=1" ])

(* Output of one git call is kept in memory; more than this kills the child
   (git here prints a few lines, 16 MiB is far beyond any legitimate output). *)
let max_output_bytes = 16 * 1024 * 1024

(* The descriptor is non-blocking and polled with a short sleep: [Unix.select]
   fails with EINVAL for any descriptor number at or above FD_SETSIZE (1024),
   which a long-running process reaches. The child's exit is polled in the same
   loop, so a grandchild that keeps the pipe open cannot hold a finished git. *)
let poll_interval = 0.005

type outcome = Ended | Child_exited | Timed_out | Too_big

let rec try_wait pid =
  match Unix.waitpid [ Unix.WNOHANG ] pid with
  | 0, _ -> None
  | _, status -> Some status
  | exception Unix.Unix_error (Unix.EINTR, _, _) -> try_wait pid

(* Read until end of file, the child's exit (then one last drain), the monotonic
   [deadline] or the output cap. [status] receives the child's status when it
   is seen here. *)
let read_all fd pid status ~deadline =
  Unix.set_nonblock fd;
  let buf = Buffer.create 256 and chunk = Bytes.create 4096 in
  let rec go ~final =
    if (not final) && deadline -. Lock.monotonic () <= 0.0 then Timed_out
    else
      match Unix.read fd chunk 0 (Bytes.length chunk) with
      | 0 -> Ended
      | n ->
          Buffer.add_subbytes buf chunk 0 n;
          if Buffer.length buf > max_output_bytes then Too_big else go ~final
      | exception Unix.Unix_error ((Unix.EAGAIN | Unix.EWOULDBLOCK | Unix.EINTR), _, _) ->
          if final then Child_exited
          else begin
            status := try_wait pid;
            if !status <> None then go ~final:true
            else begin
              Unix.sleepf poll_interval;
              go ~final
            end
          end
  in
  let outcome = go ~final:false in
  (Buffer.contents buf, outcome)

(* Wait for the child until [deadline]; [None] when it is still running. *)
let wait_until pid status ~deadline =
  let rec go () =
    if !status = None then status := try_wait pid;
    if !status <> None then !status
    else if deadline -. Lock.monotonic () <= 0.0 then None
    else begin
      Unix.sleepf poll_interval;
      go ()
    end
  in
  go ()

(* Kill the direct child and collect it. A signal handler that raises while
   waiting must not leave a zombie: the wait is retried, and only a fatal
   exception (Sys.Break, Out_of_memory) is re-raised, after the reap. Only the
   direct child is killed, not its process group (OCaml's [Unix] cannot start a
   child in its own group), as the reference tool's subprocess timeout. *)
let kill_and_reap pid =
  (try Unix.kill pid Sys.sigkill with Unix.Unix_error _ -> ());
  let fatal = ref None in
  let rec go () =
    match Unix.waitpid [] pid with
    | _ -> ()
    | exception Unix.Unix_error (Unix.ECHILD, _, _) -> ()
    | exception Unix.Unix_error (Unix.EINTR, _, _) -> go ()
    | exception Unix.Unix_error _ -> ()
    | exception ((Sys.Break | Out_of_memory) as e) ->
        fatal := Some e;
        go ()
    | exception _ -> go ()
  in
  go ();
  Option.iter raise !fatal

let spawn argv ~devnull ~out_w =
  match Unix.create_process_env "git" argv (clean_env ()) devnull out_w out_w with
  | pid -> Some pid
  | exception Unix.Unix_error _ -> None

let exit_code_of = function Unix.WEXITED n -> n | _ -> 128

let finish pid out_r status ~timeout ~deadline =
  let output, outcome =
    Fun.protect ~finally:(fun () -> try Unix.close out_r with Unix.Unix_error _ -> ()) (fun () ->
        read_all out_r pid status ~deadline)
  in
  if outcome = Too_big then begin
    kill_and_reap pid;
    (125, Printf.sprintf "git output exceeded %d bytes" max_output_bytes)
  end
  else
    (* The child's exit status decides first: a finished git is a result even
       when a grandchild still holds the pipe. *)
    match wait_until pid status ~deadline with
    | Some st -> (exit_code_of st, output)
    | None ->
        kill_and_reap pid;
        (124, Printf.sprintf "git timed out after %.0f seconds" timeout)

(* Never raises except Sys.Break and Out_of_memory, which propagate after the
   child is killed and reaped; any other exception, a raising signal handler
   included, becomes an exit code, with the child reaped too. *)
let collect pid out_r ~timeout =
  let status = ref None in
  try finish pid out_r status ~timeout ~deadline:(Lock.monotonic () +. timeout)
  with e ->
    if !status = None then kill_and_reap pid;
    Err.reraise_fatal e;
    (125, "git output could not be read: " ^ Printexc.to_string e)

let run_unguarded ?(timeout = default_timeout) ~dir args =
  let argv = Array.of_list ("git" :: "-C" :: dir :: args) in
  let devnull = Unix.openfile "/dev/null" [ Unix.O_RDONLY; Unix.O_CLOEXEC ] 0 in
  match Unix.pipe ~cloexec:true () with
  | exception Unix.Unix_error _ ->
      Unix.close devnull;
      (127, "git could not be started (no pipe)")
  | out_r, out_w -> (
      let started = spawn argv ~devnull ~out_w in
      Unix.close devnull;
      Unix.close out_w;
      match started with
      | None ->
          Unix.close out_r;
          (127, "git could not be started")
      | Some pid -> collect pid out_r ~timeout)

let run ?timeout ~dir args =
  try run_unguarded ?timeout ~dir args
  with e ->
    Err.reraise_fatal e;
    (125, "git could not be run: " ^ Printexc.to_string e)

let first_line s = match String.split_on_char '\n' (String.trim s) with l :: _ -> l | [] -> ""

let context dir =
  try
    match run ~dir [ "rev-parse"; "--show-toplevel" ] with
    | 0, top ->
        let branch =
          match run ~dir [ "branch"; "--show-current" ] with
          | 0, b when first_line b <> "" -> Some (first_line b)
          | _ -> None
        in
        (Some (first_line top), branch)
    | _ -> (None, None)
  with e ->
    Err.reraise_fatal e;
    (None, None)

let in_progress_markers =
  [ ("rebase-merge", "rebase"); ("rebase-apply", "rebase"); ("MERGE_HEAD", "merge");
    ("CHERRY_PICK_HEAD", "cherry-pick"); ("REVERT_HEAD", "revert") ]

(* Exit code 127 is a git that could not be started (not found on PATH); git
   itself exits 128 outside a repository. *)
let own_toplevel root =
  match run ~dir:root [ "rev-parse"; "--show-toplevel" ] with
  | 0, top ->
      if (try Unix.realpath (first_line top) = Unix.realpath root with Unix.Unix_error _ -> false) then Ok ()
      else Error "auto-commit skipped: the data repository is not a git repository"
  | 127, _ -> Error "auto-commit skipped: git was not found"
  | _ -> Error "auto-commit skipped: the data repository is not a git repository"

let operation_in_progress root =
  match run ~dir:root [ "rev-parse"; "--absolute-git-dir" ] with
  | 0, git_dir ->
      let git_dir = first_line git_dir in
      List.find_map
        (fun (marker, label) ->
          if Sys.file_exists (Filename.concat git_dir marker) then Some label else None)
        in_progress_markers
  | _ -> None

let relative root path =
  let root = Unix.realpath root in
  let path = try Unix.realpath path with Unix.Unix_error _ -> path in
  let prefix = if root = "/" then "/" else root ^ "/" in
  if starts_with prefix path then String.sub path (String.length prefix) (String.length path - String.length prefix)
  else path

let identity_args root =
  let missing key = match run ~dir:root [ "config"; key ] with 0, v -> first_line v = "" | _ -> true in
  (if missing "user.name" then [ "-c"; "user.name=wl" ] else [])
  @ if missing "user.email" then [ "-c"; "user.email=wl@localhost" ] else []

let git_error name (code, output) =
  Error (Printf.sprintf "git %s: %s" name (if first_line output = "" then Printf.sprintf "exit %d" code else first_line output))

let stage_and_commit root rel message =
  let ( let* ) = Result.bind in
  let ok name (code, out) = if code = 0 then Ok out else git_error name (code, out) in
  let* _ = ok "add" (run ~dir:root ([ "add"; "-f"; "--" ] @ rel)) in
  let unchanged = fst (run ~dir:root ([ "diff"; "--cached"; "--quiet"; "--" ] @ rel)) = 0 in
  let has_head = fst (run ~dir:root [ "rev-parse"; "-q"; "--verify"; "HEAD" ]) = 0 in
  if unchanged && has_head then Ok false
  else
    let args =
      [ "-c"; "core.hooksPath=/dev/null"; "-c"; "commit.gpgsign=false" ]
      @ identity_args root
      @ [ "commit"; "--only"; "--no-verify"; "--no-gpg-sign"; "-q"; "-m"; message; "--" ]
      @ rel
    in
    let* _ = ok "commit" (run ~dir:root args) in
    Ok true

let commit_paths ~root ~paths ~message =
  if paths = [] then Ok false
  else
    let ( let* ) = Result.bind in
    let* () = own_toplevel root in
    match operation_in_progress root with
    | Some busy -> Error (Printf.sprintf "auto-commit skipped: a %s is in progress" busy)
    | None -> stage_and_commit root (List.map (relative root) paths) message

(* The commit step runs after the write is durable: it reports every failure,
   including an unexpected exception, as an [Error], never by raising. *)
let commit_paths ~root ~paths ~message =
  try commit_paths ~root ~paths ~message
  with e ->
    Err.reraise_fatal e;
    Error ("auto-commit failed: " ^ Printexc.to_string e)
