(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(* mesh-logout-all: sign every browser out of session-mesh at once. See
   Mesh_logout_all. *)

exception Write_failed of string * string

(* A line that cannot be written (a closed or broken pipe, a full disk) stops
   the command at once: exit 1, never an uncaught exception. *)
let line name channel text =
  try
    output_string channel text;
    output_char channel '\n';
    flush channel
  with Sys_error message -> raise (Write_failed (name, message))

(* Said on stderr when it is stdout that failed; stderr may be gone too. *)
let report_failed_write name message =
  if name = "stdout" then
    try
      prerr_endline
        (Printf.sprintf "mesh-logout-all: cannot write on %s (%s)" name message)
    with Sys_error _ -> ()

let () =
  (* A mesh that closes the connection while the request is written is a mesh
     that does not answer (EPIPE), not a reason to die. *)
  Sys.set_signal Sys.sigpipe Sys.Signal_ignore;
  let args = match Array.to_list Sys.argv with [] -> [] | _ :: args -> args in
  let output =
    { Mesh_logout_all.out = line "stdout" stdout; err = line "stderr" stderr }
  in
  match Mesh_logout_all.run ~getenv:Sys.getenv_opt ~args output with
  | code -> exit code
  | exception Write_failed (name, message) ->
      report_failed_write name message;
      (* Not [exit]: its flush of the line left in the channel would fail
         again, uncaught. *)
      Unix._exit 1
