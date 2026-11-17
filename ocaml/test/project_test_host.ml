(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(* Only this private executable exposes file-stage barriers. Production main
   still calls the closed public run entry point. *)
let () =
  let root = Sys.getenv "PROJECT_TEST_BARRIER" in
  let path name = Filename.concat root name in
  let hook stage =
    let blocked =
      stage = Mesh_project_store.Temp_synced && not (Sys.file_exists (path "unblocked-writes"))
      || stage = Mesh_project_store.Read
         && Sys.file_exists (path "block-reads")
    in
    if blocked then (
      let marker =
        Unix.openfile (path "blocked")
          [ Unix.O_WRONLY; Unix.O_CREAT; Unix.O_APPEND ]
          0o600
      in
      Fun.protect
        ~finally:(fun () -> Unix.close marker)
        (fun () -> ignore (Unix.write_substring marker "." 0 1));
      let fd = Unix.openfile (path "release") [ Unix.O_RDONLY ] 0 in
      Fun.protect
        ~finally:(fun () -> Unix.close fd)
        (fun () ->
          let b = Bytes.create 1 in
          ignore (Unix.read fd b 0 1)))
  in
  let observation_hook stage =
    let name = match stage with
      | Mesh_project_observation.Capture -> "capture"
      | Mesh_project_observation.Control -> "control"
      | Mesh_project_observation.Borrow -> "borrow"
      | Mesh_project_observation.Settled -> "settled"
      | Mesh_project_observation.Child_started pid -> Printf.sprintf "child-started:%d" pid
      | Mesh_project_observation.Child_exited pid -> Printf.sprintf "child-exited:%d" pid
      | Mesh_project_observation.Pipes_drained -> "pipes-drained"
      | Mesh_project_observation.Charge (label, total) -> Printf.sprintf "charge:%s:%d" label total in
    let blocked = Sys.file_exists (path ("block-" ^ name)) in
    let fd = Unix.openfile (path "observation-events") [Unix.O_WRONLY;Unix.O_CREAT;Unix.O_APPEND] 0o600 in
    Fun.protect ~finally:(fun () -> Unix.close fd) (fun () ->
        let line = name ^ "\n" in ignore (Unix.write_substring fd line 0 (String.length line)));
    if blocked then (
      let fd = Unix.openfile (path "release") [Unix.O_RDONLY] 0 in
      Fun.protect ~finally:(fun () -> Unix.close fd) (fun () -> let b = Bytes.create 1 in ignore (Unix.read fd b 0 1)))
  in
  Project_test_host_impl.run_impl ~project_store_hook:hook ~project_observation_hook:observation_hook ()
