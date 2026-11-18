(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(* The cookie generation file, as cookiegen.py reads and writes it: created at
   0, a damaged file never read as 0, an unreadable one never written. *)

let rec remove path =
  match Unix.lstat path with
  | { Unix.st_kind = Unix.S_DIR; _ } ->
      Unix.chmod path 0o700;
      Array.iter
        (fun name -> remove (Filename.concat path name))
        (Sys.readdir path);
      Unix.rmdir path
  | _ -> Unix.unlink path
  | exception Unix.Unix_error (Unix.ENOENT, _, _) -> ()

let with_directory f =
  let directory = Test_scratch.private_directory "mesh-generation-" in
  Fun.protect ~finally:(fun () -> remove directory) (fun () -> f directory)

let file_in directory = Filename.concat directory Mesh_generation.file_name
let contents path = In_channel.with_open_bin path In_channel.input_all
let mode path = (Unix.stat path).Unix.st_perm
let generation = Alcotest.testable Fmt.int ( = )

let value = function
  | Ok (generation : Mesh_generation.t) -> (generation :> int)
  | Error message -> Alcotest.failf "unexpected error: %s" message

let silent _ = Alcotest.fail "unexpected warning"

let write_file path text =
  Out_channel.with_open_gen [ Open_wronly; Open_creat; Open_trunc ] 0o600 path
    (fun channel -> output_string channel text)

let test_parse () =
  let check text expected =
    Alcotest.(check (option int))
      (String.escaped text) expected
      (Option.map
         (fun (g : Mesh_generation.t) -> (g :> int))
         (Mesh_generation.parse text))
  in
  check "0\n" (Some 0);
  check "42\n" (Some 42);
  check "  7 \t\n" (Some 7);
  check "+5" (Some 5);
  check "-0" (Some 0);
  check "1_000" (Some 1000);
  check "0005" (Some 5);
  check "" None;
  check "abc\n" None;
  check "-3\n" None;
  check "1.5\n" None;
  check "_1" None;
  check "1_" None;
  check "1__0" None;
  check "0x10" None;
  check "1 2" None;
  check "\xd9\xa3" None;
  check "99999999999999999999999" None

let test_missing_file_created_at_zero () =
  with_directory (fun directory ->
      let conf = Filename.concat directory "new/conf" in
      let path = file_in conf in
      Alcotest.check generation "generation" 0
        (value (Mesh_generation.read ~warn:silent path));
      Alcotest.(check string) "content" "0\n" (contents path);
      Alcotest.(check int) "file mode" 0o600 (mode path);
      Alcotest.(check int) "directory mode" 0o700 (mode conf))

let test_bump_of_a_missing_file () =
  with_directory (fun directory ->
      let path = file_in directory in
      Alcotest.check generation "bumped" 1
        (value (Mesh_generation.bump ~warn:silent path));
      Alcotest.(check string) "content" "1\n" (contents path);
      Alcotest.(check int) "mode" 0o600 (mode path))

let test_bump_replaces_the_inode () =
  with_directory (fun directory ->
      let path = file_in directory in
      write_file path "41\n";
      let before = (Unix.stat path).Unix.st_ino in
      Alcotest.check generation "bumped" 42
        (value (Mesh_generation.bump ~warn:silent path));
      Alcotest.(check string) "content" "42\n" (contents path);
      Alcotest.(check bool)
        "a new inode, which the server notices" true
        ((Unix.stat path).Unix.st_ino <> before);
      Alcotest.(check (list string))
        "no temporary file left"
        [ Mesh_generation.file_name ]
        (Array.to_list (Sys.readdir directory)))

(* INV-5's race: another process creates the file between our failed read and
   our create. Its value must survive; truncating it would revive old cookies. *)
let test_create_never_overwrites () =
  with_directory (fun directory ->
      let path = file_in directory in
      write_file path "42\n";
      let before = (Unix.stat path).Unix.st_ino in
      Alcotest.(check bool) "Exists" true (Mesh_generation.create path = `Exists);
      Alcotest.(check string) "content intact" "42\n" (contents path);
      Alcotest.(check bool)
        "same inode" true
        ((Unix.stat path).Unix.st_ino = before))

let test_write_mode_despite_umask () =
  with_directory (fun directory ->
      let path = file_in directory in
      let previous = Unix.umask 0o277 in
      Fun.protect
        ~finally:(fun () -> ignore (Unix.umask previous))
        (fun () ->
          ignore (value (Mesh_generation.bump ~warn:silent path));
          ignore (value (Mesh_generation.bump ~warn:silent path)));
      Alcotest.(check int) "mode" 0o600 (mode path);
      Alcotest.(check string) "content" "2\n" (contents path))

let test_damaged junk () =
  with_directory (fun directory ->
      let path = file_in directory in
      write_file path junk;
      let warnings = ref [] in
      let warn line = warnings := line :: !warnings in
      let repaired = value (Mesh_generation.read ~warn path) in
      Alcotest.(check bool) "far above any counter" true (repaired > 1_000_000);
      Alcotest.(check (list string))
        "warning"
        [
          Printf.sprintf
            "session-mesh: %s is not a generation number; every login is \
             revoked"
            path;
        ]
        !warnings;
      Alcotest.(check string)
        "rewritten"
        (Printf.sprintf "%d\n" repaired)
        (contents path);
      Alcotest.(check int) "mode" 0o600 (mode path);
      let bumped = value (Mesh_generation.bump ~warn path) in
      Alcotest.check generation "bump of the repaired value" (repaired + 1)
        bumped;
      Alcotest.(check bool) "0 never written" true (contents path <> "0\n"))

let test_damaged_bump () =
  with_directory (fun directory ->
      let path = file_in directory in
      write_file path "abc\n";
      let bumped = value (Mesh_generation.bump ~warn:ignore path) in
      Alcotest.(check bool) "far above any counter" true (bumped > 1_000_000))

let test_unreadable_file () =
  if Unix.geteuid () = 0 then Alcotest.skip ()
    (* root reads a mode-000 file: the case cannot be built *)
  else
    with_directory (fun directory ->
        let path = file_in directory in
        write_file path "5\n";
        Unix.chmod path 0o000;
        (match Mesh_generation.bump ~warn:silent path with
        | Ok g -> Alcotest.failf "bumped to %d" (g :> int)
        | Error message ->
            Alcotest.(check bool)
              ("one line naming the file: " ^ message)
              true
              (String.starts_with ~prefix:path message
              && not (String.contains message '\n')));
        Unix.chmod path 0o600;
        Alcotest.(check string) "unchanged" "5\n" (contents path);
        Alcotest.(check (list string))
          "nothing beside it"
          [ Mesh_generation.file_name ]
          (Array.to_list (Sys.readdir directory)))

(* The rename is flushed through the directory: a directory that cannot be
   opened for reading (mode 0300) makes [bump] fail after the rename, with a
   one-line message naming the directory. *)
let test_directory_sync_failure () =
  if Unix.geteuid () = 0 then Alcotest.skip ()
    (* root opens a mode-0300 directory: the case cannot be built *)
  else
    with_directory (fun directory ->
        let path = file_in directory in
        write_file path "6\n";
        Unix.chmod directory 0o300;
        let result =
          Fun.protect
            ~finally:(fun () -> Unix.chmod directory 0o700)
            (fun () -> Mesh_generation.bump ~warn:silent path)
        in
        (match result with
        | Ok g ->
            Alcotest.failf "bumped to %d despite the failed sync" (g :> int)
        | Error message ->
            Alcotest.(check bool)
              ("one line naming the directory: " ^ message)
              true
              (String.starts_with ~prefix:(directory ^ ": ") message
              && not (String.contains message '\n')));
        Alcotest.(check string) "renamed before the sync" "7\n" (contents path))

let test_directory_in_the_way () =
  with_directory (fun directory ->
      let path = file_in directory in
      Unix.mkdir path 0o700;
      match Mesh_generation.bump ~warn:silent path with
      | Ok g -> Alcotest.failf "bumped to %d" (g :> int)
      | Error _ ->
          Alcotest.(check (array string)) "untouched" [||] (Sys.readdir path))

let () =
  if Unix.geteuid () = 0 then
    prerr_endline
      "mesh_generation_test: running as root, the mode-000 case is skipped";
  Alcotest.run "mesh_generation"
    [
      ("parse", [ Alcotest.test_case "python int" `Quick test_parse ]);
      ( "file",
        [
          Alcotest.test_case "missing: created at 0" `Quick
            test_missing_file_created_at_zero;
          Alcotest.test_case "missing: bump gives 1" `Quick
            test_bump_of_a_missing_file;
          Alcotest.test_case "bump: new inode" `Quick
            test_bump_replaces_the_inode;
          Alcotest.test_case "mode 0600 whatever the umask" `Quick
            test_write_mode_despite_umask;
          Alcotest.test_case "create: a file made meanwhile is kept" `Quick
            test_create_never_overwrites;
        ] );
      ( "damaged",
        List.map
          (fun junk ->
            Alcotest.test_case (String.escaped junk) `Quick (test_damaged junk))
          [ ""; "abc\n"; "-3\n"; "1.5\n" ]
        @ [ Alcotest.test_case "bump" `Quick test_damaged_bump ] );
      ( "unreadable",
        [
          Alcotest.test_case "mode 000" `Quick test_unreadable_file;
          Alcotest.test_case "a directory" `Quick test_directory_in_the_way;
          Alcotest.test_case "directory sync fails" `Quick
            test_directory_sync_failure;
        ] );
    ]
