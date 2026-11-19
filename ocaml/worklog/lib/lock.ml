(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

external flock_try : Unix.file_descr -> bool = "mesh_worklog_flock_try"
external monotonic : unit -> float = "mesh_worklog_monotonic"
external raise_nofile_limit : int -> int = "mesh_worklog_raise_nofile"

let poll_interval = 0.005

(* Poll until the lock is held or the deadline passes; the caller closes [fd]. *)
let acquire fd ~path ~deadline =
  let rec go () =
    if flock_try fd then ()
    else if monotonic () >= deadline then
      Err.fail Err.Lock_timeout (Printf.sprintf "timed out waiting for lock %s" path)
    else begin
      Unix.sleepf poll_interval;
      go ()
    end
  in
  go ()

let with_lock ~path ~timeout f =
  let fd = Safefs.open_create path [ Unix.O_RDWR ] in
  (* Closing the descriptor releases the flock, on every exit. *)
  Fun.protect
    ~finally:(fun () -> Unix.close fd)
    (fun () ->
      acquire fd ~path ~deadline:(monotonic () +. timeout);
      f ())
