(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(* Declarations of the C stubs in darwin_stubs.c. Compiled and linked on every
   system; without macOS every call answers [Error Unsupported_kind]. *)

(* The failure classes the stubs report, in the order of the C KIND_* codes. *)
type failure =
  | Gone  (** ESRCH, or an empty kernel answer: no such process. *)
  | Refused  (** EPERM or EACCES. *)
  | Short_answer  (** The kernel answered fewer bytes than its structure. *)
  | Invalid  (** EINVAL: ambiguous, the caller decides. *)
  | Failed  (** Any other errno. *)
  | Unsupported_kind  (** Not a macOS build. *)

(* ppid, pgid, sid, tpgid, comm, status (SIDL..SZOMB), effective uid, start time
   in microseconds since the epoch. *)
type raw_process = int * int * int * int * string * int * int * int64

external process : int -> (raw_process, failure) result = "mesh_darwin_process"

external list_pids : unit -> (int array, failure) result
  = "mesh_darwin_list_pids"

external procargs2 : int -> (string, failure) result = "mesh_darwin_procargs2"
external cwd : int -> (string, failure) result = "mesh_darwin_cwd"

external fd_paths : int -> ((int * string) array, failure) result
  = "mesh_darwin_fd_paths"
