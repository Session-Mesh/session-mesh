(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

let rec remove_tree path =
  match Unix.lstat path with
  | exception Unix.Unix_error (Unix.ENOENT, _, _) -> ()
  | { Unix.st_kind = Unix.S_DIR; _ } ->
      Array.iter (fun name -> remove_tree (Filename.concat path name)) (Sys.readdir path);
      Unix.rmdir path
  | _ -> Unix.unlink path

let with_directory f =
  let directory = Filename.temp_dir ~perms:0o700 "mesh-generic-" "" in
  Fun.protect ~finally:(fun () -> remove_tree directory) (fun () -> f directory)

let write_with flags path text =
  let channel = open_out_gen (Open_wronly :: Open_creat :: Open_binary :: flags) 0o600 path in
  Fun.protect ~finally:(fun () -> close_out channel) (fun () -> output_string channel text)

let write_file = write_with [ Open_trunc ]
let append_file = write_with [ Open_append ]

let qcheck ?(count = 200) ~name arbitrary property =
  QCheck.Test.check_exn
    ~rand:(Random.State.make [| 0x6d65; 0x7368 |])
    (QCheck.Test.make ~count ~name arbitrary property)
