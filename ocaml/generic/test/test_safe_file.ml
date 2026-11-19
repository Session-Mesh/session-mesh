(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

let refused expected path =
  match Mesh_safe_file.open_regular path with
  | Ok (fd, _) ->
      Unix.close fd;
      false
  | Error error -> error = expected

let test_regular_file () =
  Support.with_directory (fun directory ->
      let path = Filename.concat directory "file" in
      Support.write_file path "0123456789";
      let read =
        Mesh_safe_file.with_regular path (fun fd stats ->
            (stats.Unix.st_size, Mesh_safe_file.read_range fd ~offset:3 ~length:4,
             Mesh_safe_file.read_range fd ~offset:8 ~length:10))
      in
      Alcotest.(check (result (triple int string string) reject)) "read" (Ok (10, "3456", "89"))
        (Result.map_error ignore read))

let test_refusals () =
  Support.with_directory (fun directory ->
      let target = Filename.concat directory "target" in
      Support.write_file target "x";
      let link = Filename.concat directory "link" in
      Unix.symlink target link;
      let fifo = Filename.concat directory "fifo" in
      Unix.mkfifo fifo 0o600;
      Alcotest.(check bool) "symbolic link" true (refused Mesh_safe_file.Not_regular link);
      (* No writer holds the FIFO open: a blocking open would never return. *)
      Alcotest.(check bool) "fifo, without blocking" true (refused Mesh_safe_file.Not_regular fifo);
      Alcotest.(check bool) "directory" true (refused Mesh_safe_file.Not_regular directory);
      Alcotest.(check bool) "missing" true
        (refused Mesh_safe_file.Missing (Filename.concat directory "absent"));
      Alcotest.(check bool) "missing parent" true
        (refused Mesh_safe_file.Missing (Filename.concat target "child")))

let test_closes_on_exception () =
  Support.with_directory (fun directory ->
      let path = Filename.concat directory "file" in
      Support.write_file path "x";
      let seen = ref None in
      (try
         ignore
           (Mesh_safe_file.with_regular path (fun fd _ ->
                seen := Some fd;
                failwith "boom"))
       with Failure _ -> ());
      match !seen with
      | None -> Alcotest.fail "the function did not run"
      | Some fd ->
          Alcotest.(check bool) "descriptor closed" true
            (match Unix.fstat fd with _ -> false | exception Unix.Unix_error (Unix.EBADF, _, _) -> true))

let () =
  Alcotest.run "mesh_safe_file"
    [
      ( "safe_file",
        [
          Alcotest.test_case "regular file and ranges" `Quick test_regular_file;
          Alcotest.test_case "links, FIFOs, directories, missing" `Quick test_refusals;
          Alcotest.test_case "closed when the function raises" `Quick test_closes_on_exception;
        ] );
    ]
