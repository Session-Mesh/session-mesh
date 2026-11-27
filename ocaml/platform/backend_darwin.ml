(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(* macOS backend: libproc and sysctl through the C stubs of darwin_stubs.c.

   Sources: proc_listallpids for the pid list; proc_pidinfo(PROC_PIDTBSDINFO)
   for a process, falling back to sysctl(KERN_PROC_PID) when it is refused
   (another user's process) or misses a zombie; getsid for the session;
   sysctl(KERN_PROCARGS2) for the command line; PROC_PIDVNODEPATHINFO for the
   current directory; PROC_PIDLISTFDS and PROC_PIDFDVNODEPATHINFO for open
   files (vnode descriptors only).

   Zombies are reported with state Z and sid 0: macOS no longer knows their
   session. *)

open Types

let ( let* ) = Result.bind

let error_of_failure what = function
  | Darwin_stubs.Gone -> Not_found
  | Refused -> Denied
  | Short_answer -> Malformed (what ^ ": short kernel answer")
  | Invalid -> Malformed (what ^ ": invalid argument")
  | Failed -> Malformed (what ^ ": system call failed")
  | Unsupported_kind -> Unsupported (what ^ " needs a macOS build")

let lift what result = Result.map_error (error_of_failure what) result

(* pid_t is 32 bits; pid 0 is the kernel, which Linux does not list either. *)
let valid_pid pid = pid > 0 && pid <= 0x7fffffff
let with_pid pid action = if valid_pid pid then action pid else Error Not_found
let zombie_status = 5

let to_process pid (ppid, pgrp, sid, tpgid, comm, status, _uid, incarnation) =
  match Parse.darwin_state status with
  | Some state -> Ok { pid; ppid; pgrp; sid; tpgid; comm; state; incarnation }
  | None ->
      Error
        (Malformed (Printf.sprintf "process %d: unknown status %d" pid status))

let process pid =
  with_pid pid (fun pid ->
      let* raw = lift "process" (Darwin_stubs.process pid) in
      to_process pid raw)

(* KERN_PROCARGS2 answers EINVAL for a missing process, a zombie and another
   user's process alike. A zombie has no arguments left: like an empty Linux
   cmdline, it gives []. *)
let explain_invalid_procargs pid =
  match Darwin_stubs.process pid with
  | Error failure -> Error (error_of_failure "command line" failure)
  | Ok (_, _, _, _, _, status, _, _) when status = zombie_status -> Ok []
  | Ok (_, _, _, _, _, _, uid, _) when uid <> Unix.geteuid () -> Error Denied
  | Ok _ -> Error (Malformed "command line: the kernel refused KERN_PROCARGS2")

let command_line pid =
  with_pid pid (fun pid ->
      match Darwin_stubs.procargs2 pid with
      | Ok buffer -> Parse.darwin_procargs2 buffer
      | Error Darwin_stubs.Invalid -> explain_invalid_procargs pid
      | Error failure -> Error (error_of_failure "command line" failure))

let with_process_environment pid ~incarnation inspect =
  with_pid pid (fun pid ->
      let check_identity () =
        let* _, _, _, _, _, status, uid, observed =
          lift "process" (Darwin_stubs.process pid)
        in
        if uid <> Unix.geteuid () then Error Denied
        else if status = zombie_status || observed <> incarnation then
          Error Not_found
        else Ok ()
      in
      let* () = check_identity () in
      let* buffer = lift "process environment" (Darwin_stubs.procargs2 pid) in
      let* () = check_identity () in
      inspect buffer)

let environment_matches ?unset pid ~incarnation ~key ~expected =
  with_process_environment pid ~incarnation (fun buffer ->
      Parse.darwin_environment_matches ?unset buffer ~key ~expected)

let pi_profile_overlay pid ~incarnation ~history ~overlay_root ~unset =
  let overlay_key = "PI_CODING_AGENT_DIR"
  and history_key = "PI_CODING_AGENT_SESSION_DIR" in
  with_process_environment pid ~incarnation (fun buffer ->
      let* selected =
        Parse.darwin_selected_environment ~title_padding:true buffer
          (overlay_key :: history_key :: unset)
      in
      match List.assoc_opt overlay_key selected with
      | Some overlay
        when List.assoc_opt history_key selected = Some history
             && Filename.dirname overlay = overlay_root
             && String.starts_with ~prefix:"session-" (Filename.basename overlay)
             && List.for_all
                  (fun name -> Option.value ~default:"" (List.assoc_opt name selected) = "")
                  unset ->
          Ok (Some overlay)
      | _ -> Ok None)

let working_directory pid =
  with_pid pid (fun pid ->
      let* path = lift "working directory" (Darwin_stubs.cwd pid) in
      if path = "" then Error (Malformed "working directory: empty path")
      else Ok path)

let open_file_paths pid =
  with_pid pid (fun pid ->
      let* paths = lift "open files" (Darwin_stubs.fd_paths pid) in
      Ok
        (Array.to_list paths
        |> List.filter (fun (_, target) -> target <> "" && target.[0] = '/')
        |> List.sort compare))

let foreground_process_group pid =
  let* found = process pid in
  Parse.foreground_group found.tpgid

(* Not read on macOS yet: callers treat the owner as unknown. *)
let process_owner _pid =
  Error (Unsupported "process owner inspection is not implemented on macOS")

let scan () =
  let* pids = lift "process table" (Darwin_stubs.list_pids ()) in
  Support.collect_scan (Array.to_list pids |> List.map string_of_int) process

(* No reliable equivalent of /proc/net/unix: refused, as the contract allows. *)
let unix_socket_bound _path =
  Error (Unsupported "Unix socket inspection is not implemented on macOS")

let capabilities () =
  {
    process_table = true;
    foreground_agent = true;
    open_file_paths = true;
    isolated_agent = false;
    demo_sandbox = false;
  }
