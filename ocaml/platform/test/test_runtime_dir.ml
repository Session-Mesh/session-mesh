(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

open Mesh_platform

(* Unless a test passes its own, the /run/user guess points at a directory that
   cannot exist and no home directory is known (the macOS default is never
   created in the real home), so the host machine never decides a test
   outcome. *)
let runtime_dir ?(run_user_root = "/nonexistent/mesh-platform-test") ?getenv ()
    =
  Mesh_platform.runtime_dir ?getenv ~home:(fun () -> None) ~run_user_root ()

(* Directories are created under a fresh private temp directory and removed
   afterwards. *)
let rec remove_tree path =
  match Unix.lstat path with
  | exception Unix.Unix_error _ -> ()
  | { Unix.st_kind = Unix.S_DIR; _ } ->
      Array.iter
        (fun name -> remove_tree (Filename.concat path name))
        (Sys.readdir path);
      Unix.rmdir path
  | _ -> Unix.unlink path

(* The root is canonical (realpath) so that directories below it pass the
   canonical-path check even when the temp directory is itself a symlink. It is
   made under /tmp, not $TMPDIR: on macOS $TMPDIR (a /var/folders path, longer
   still under dune) leaves no room for the socket path within 103 bytes. *)
let with_scratch run =
  let root =
    Unix.realpath (Filename.temp_dir ~temp_dir:"/tmp" "mesh-platform-test" "")
  in
  Fun.protect ~finally:(fun () -> remove_tree root) (fun () -> run root)

let make_dir root name mode =
  let path = Filename.concat root name in
  Unix.mkdir path 0o700;
  Unix.chmod path mode;
  path

let env bindings name = List.assoc_opt name bindings

let check_error name result =
  match result with
  | Ok _ -> Alcotest.failf "%s: expected an error" name
  | Error _ -> ()

let error_mentions name needle result =
  match result with
  | Ok _ -> Alcotest.failf "%s: expected an error" name
  | Error message ->
      let found =
        let n = String.length needle in
        let rec scan i =
          i + n <= String.length message
          && (String.sub message i n = needle || scan (i + 1))
        in
        scan 0
      in
      if not found then Alcotest.failf "%s: %S lacks %S" name message needle

let test_unset () =
  let result = runtime_dir ~getenv:(env []) () in
  error_mentions "mesh" "MESH_RUNTIME_DIR" result;
  error_mentions "xdg" "XDG_RUNTIME_DIR" result

let test_empty_is_unset () =
  with_scratch (fun root ->
      let good = make_dir root "good" 0o700 in
      let only_xdg =
        runtime_dir
          ~getenv:(env [ ("MESH_RUNTIME_DIR", ""); ("XDG_RUNTIME_DIR", good) ])
          ()
      in
      (match only_xdg with
      | Ok dir ->
          Alcotest.(check bool) "xdg source" true (dir.source = Xdg_runtime_dir)
      | Error message -> Alcotest.fail message);
      check_error "both empty"
        (runtime_dir
           ~getenv:(env [ ("MESH_RUNTIME_DIR", ""); ("XDG_RUNTIME_DIR", "") ])
           ()))

let test_relative () =
  error_mentions "relative" "MESH_RUNTIME_DIR"
    (runtime_dir ~getenv:(env [ ("MESH_RUNTIME_DIR", "relative/dir") ]) ())

let test_group_writable () =
  with_scratch (fun root ->
      let loose = make_dir root "loose" 0o770 in
      error_mentions "group-writable" "XDG_RUNTIME_DIR"
        (runtime_dir ~getenv:(env [ ("XDG_RUNTIME_DIR", loose) ]) ());
      let other_writable = make_dir root "other" 0o702 in
      check_error "other-writable"
        (runtime_dir ~getenv:(env [ ("XDG_RUNTIME_DIR", other_writable) ]) ()))

let test_symlink () =
  with_scratch (fun root ->
      let real = make_dir root "real" 0o700 in
      let link = Filename.concat root "link" in
      Unix.symlink real link;
      error_mentions "symlink" "symbolic link"
        (runtime_dir ~getenv:(env [ ("MESH_RUNTIME_DIR", link) ]) ()))

let resolve_mesh value =
  runtime_dir ~getenv:(env [ ("MESH_RUNTIME_DIR", value) ]) ()

let test_symlink_with_trailing_slash () =
  with_scratch (fun root ->
      let real = make_dir root "real" 0o700 in
      let link = Filename.concat root "link" in
      Unix.symlink real link;
      error_mentions "link/" "normalised" (resolve_mesh (link ^ "/"));
      error_mentions "link/." "normalised" (resolve_mesh (link ^ "/.")))

let test_dot_dot_segment () =
  with_scratch (fun root ->
      let real = make_dir root "real" 0o700 in
      let sneaky = Filename.concat (Filename.concat real "..") "real" in
      error_mentions "dot-dot" "normalised" (resolve_mesh sneaky))

let test_empty_segment () =
  with_scratch (fun root ->
      let real = make_dir root "real" 0o700 in
      error_mentions "double slash" "normalised"
        (resolve_mesh (root ^ "//real"));
      error_mentions "trailing slash" "normalised" (resolve_mesh (real ^ "/")))

let test_symlinked_ancestor_not_canonical () =
  with_scratch (fun root ->
      let real_parent = make_dir root "parent" 0o700 in
      let child = make_dir real_parent "child" 0o700 in
      let linked_parent = Filename.concat root "linked" in
      Unix.symlink real_parent linked_parent;
      error_mentions "ancestor link" "not canonical"
        (resolve_mesh (Filename.concat linked_parent "child"));
      match resolve_mesh child with
      | Ok _ -> ()
      | Error message -> Alcotest.fail message)

(* The socket path is the directory plus this suffix. *)
let socket_suffix_length = String.length "/session-mesh/ptyhost.sock"

(* A directory whose absolute path has exactly [length] bytes. *)
let make_dir_of_path_length root length =
  let name_length = length - String.length root - 1 in
  make_dir root (String.make name_length 'a') 0o700

let test_max_socket_path_boundary () =
  with_scratch (fun root ->
      let exact =
        make_dir_of_path_length root (max_socket_path - socket_suffix_length)
      in
      (match resolve_mesh exact with
      | Ok dir ->
          Alcotest.(check int)
            "socket path length" max_socket_path
            (String.length (socket_path dir))
      | Error message -> Alcotest.fail message);
      let over =
        make_dir_of_path_length root (max_socket_path - socket_suffix_length + 1)
      in
      error_mentions "one byte over" "byte limit" (resolve_mesh over))

let test_not_a_directory () =
  with_scratch (fun root ->
      let file = Filename.concat root "file" in
      close_out (open_out file);
      check_error "regular file"
        (runtime_dir ~getenv:(env [ ("MESH_RUNTIME_DIR", file) ]) ());
      check_error "missing"
        (runtime_dir
           ~getenv:(env [ ("MESH_RUNTIME_DIR", Filename.concat root "nope") ])
           ()))

let test_mesh_wins () =
  with_scratch (fun root ->
      let mesh = make_dir root "mesh" 0o700 in
      let xdg = make_dir root "xdg" 0o700 in
      match
        runtime_dir
          ~getenv:(env [ ("MESH_RUNTIME_DIR", mesh); ("XDG_RUNTIME_DIR", xdg) ])
          ()
      with
      | Ok dir ->
          Alcotest.(check string) "path" mesh dir.path;
          Alcotest.(check bool) "source" true (dir.source = Mesh_runtime_dir)
      | Error message -> Alcotest.fail message)

let test_invalid_mesh_does_not_fall_back () =
  with_scratch (fun root ->
      let xdg = make_dir root "xdg" 0o700 in
      error_mentions "no fallback" "MESH_RUNTIME_DIR"
        (runtime_dir
           ~getenv:
             (env
                [ ("MESH_RUNTIME_DIR", "relative"); ("XDG_RUNTIME_DIR", xdg) ])
           ()))

let test_path_too_long () =
  with_scratch (fun root ->
      let long = make_dir root (String.make max_socket_path 'a') 0o700 in
      error_mentions "too long" "byte limit"
        (runtime_dir ~getenv:(env [ ("MESH_RUNTIME_DIR", long) ]) ()))

let test_good () =
  with_scratch (fun root ->
      let good = make_dir root "good" 0o700 in
      match runtime_dir ~getenv:(env [ ("MESH_RUNTIME_DIR", good) ]) () with
      | Ok dir ->
          Alcotest.(check string)
            "socket path"
            (good ^ "/session-mesh/ptyhost.sock")
            (socket_path dir)
      | Error message -> Alcotest.fail message)

let euid_name = string_of_int (Unix.geteuid ())

let test_guess_accepted () =
  with_scratch (fun root ->
      let guessed = make_dir root euid_name 0o700 in
      match runtime_dir ~run_user_root:root ~getenv:(env []) () with
      | Ok dir when platform = Linux ->
          Alcotest.(check string) "path" guessed dir.path;
          Alcotest.(check bool) "source" true (dir.source = Run_user_guess)
      | Ok _ -> Alcotest.fail "the guess is Linux only"
      | Error message when platform = Linux -> Alcotest.fail message
      | Error _ -> ())

let test_guess_needs_mode_0700 () =
  with_scratch (fun root ->
      ignore (make_dir root euid_name 0o750);
      let result = runtime_dir ~run_user_root:root ~getenv:(env []) () in
      error_mentions "mode" "MESH_RUNTIME_DIR" result;
      if platform = Linux then error_mentions "mode" "not 0700" result)

let test_guess_missing () =
  with_scratch (fun root ->
      error_mentions "missing" "MESH_RUNTIME_DIR"
        (runtime_dir ~run_user_root:root ~getenv:(env []) ()))

let test_guess_symlink () =
  with_scratch (fun root ->
      let real = make_dir root "real" 0o700 in
      Unix.symlink real (Filename.concat root euid_name);
      let result = runtime_dir ~run_user_root:root ~getenv:(env []) () in
      check_error "symlinked guess" result;
      if platform = Linux then
        error_mentions "symlinked guess" "symbolic link" result)

let test_guess_sticky_bit () =
  with_scratch (fun root ->
      ignore (make_dir root euid_name 0o1700);
      let result = runtime_dir ~run_user_root:root ~getenv:(env []) () in
      check_error "sticky guess" result;
      if platform = Linux then error_mentions "sticky guess" "not 0700" result)

(* A valid guess exists; an invalid variable must still be reported, never
   replaced by the guess. *)
let test_invalid_variable_never_reaches_guess () =
  with_scratch (fun root ->
      ignore (make_dir root euid_name 0o700);
      error_mentions "invalid MESH" "MESH_RUNTIME_DIR"
        (runtime_dir ~run_user_root:root
           ~getenv:(env [ ("MESH_RUNTIME_DIR", "relative") ])
           ());
      error_mentions "invalid XDG" "XDG_RUNTIME_DIR"
        (runtime_dir ~run_user_root:root
           ~getenv:(env [ ("XDG_RUNTIME_DIR", "relative") ])
           ()))

let test_xdg_wins_over_guess () =
  with_scratch (fun root ->
      ignore (make_dir root euid_name 0o700);
      let xdg = make_dir root "xdg" 0o700 in
      match
        runtime_dir ~run_user_root:root
          ~getenv:(env [ ("XDG_RUNTIME_DIR", xdg) ])
          ()
      with
      | Ok dir -> Alcotest.(check string) "xdg path" xdg dir.path
      | Error message -> Alcotest.fail message)

(* The macOS rules, resolved as a macOS build would on any machine. *)
let resolve_on ?home ?(getenv = env []) platform =
  For_testing.runtime_dir_on ?home ~platform ~getenv ()

(* A short root: on macOS /tmp is /private/tmp, and the default path below a
   fake home must still leave room for the socket within 103 bytes. *)
let with_short_scratch run =
  let root = Unix.realpath (Filename.temp_dir ~temp_dir:"/tmp" "m" "") in
  Fun.protect ~finally:(fun () -> remove_tree root) (fun () -> run root)

(* A fake home holding Library/Application Support, as every macOS account. *)
let fake_home root =
  let home = make_dir root "h" 0o700 in
  let library = make_dir home "Library" 0o700 in
  ignore (make_dir library "Application Support" 0o700);
  home

let macos_default home =
  String.concat "/" [ home; "Library/Application Support/session-mesh/run" ]

let test_macos_default_created () =
  with_short_scratch (fun root ->
      let home = fake_home root in
      match resolve_on ~home Macos with
      | Ok dir ->
          Alcotest.(check string) "path" (macos_default home) dir.path;
          Alcotest.(check bool) "source" true (dir.source = Macos_default);
          List.iter
            (fun path ->
              Alcotest.(check int)
                (path ^ " mode") 0o700 (Unix.lstat path).Unix.st_perm)
            [ Filename.dirname dir.path; dir.path ];
          (* A second resolution accepts the existing directory. *)
          Alcotest.(check bool)
            "again" true
            (Result.is_ok (resolve_on ~home Macos))
      | Error message -> Alcotest.fail message)

let test_macos_default_symlink_refused () =
  with_short_scratch (fun root ->
      let home = fake_home root in
      let elsewhere = make_dir root "elsewhere" 0o700 in
      Unix.symlink elsewhere
        (Filename.concat home "Library/Application Support/session-mesh");
      let result = resolve_on ~home Macos in
      error_mentions "symlink" "symbolic link" result;
      error_mentions "hint" "set MESH_RUNTIME_DIR" result;
      Alcotest.(check bool)
        "nothing created through the link" false
        (Sys.file_exists (Filename.concat elsewhere "run")))

let test_macos_default_needs_application_support () =
  with_short_scratch (fun root ->
      let home = make_dir root "h" 0o700 in
      let result = resolve_on ~home Macos in
      error_mentions "missing" "Application Support" result;
      error_mentions "hint" "set MESH_RUNTIME_DIR" result;
      Alcotest.(check bool)
        "Library not created" false
        (Sys.file_exists (Filename.concat home "Library")))

let test_macos_default_too_long () =
  with_short_scratch (fun root ->
      let home = make_dir root (String.make 60 'h') 0o700 in
      let library = make_dir home "Library" 0o700 in
      let support = make_dir library "Application Support" 0o700 in
      let result = resolve_on ~home Macos in
      error_mentions "too long" "byte limit" result;
      error_mentions "hint" "set MESH_RUNTIME_DIR to a shorter directory" result;
      Alcotest.(check bool)
        "nothing created" false
        (Sys.file_exists (Filename.concat support "session-mesh")))

let test_macos_without_home () =
  error_mentions "no home" "MESH_RUNTIME_DIR" (resolve_on Macos)

let test_macos_variables_accepted () =
  with_scratch (fun root ->
      let mesh = make_dir root "mesh" 0o700 in
      let xdg = make_dir root "xdg" 0o700 in
      (match resolve_on ~getenv:(env [ ("MESH_RUNTIME_DIR", mesh) ]) Macos with
      | Ok dir -> Alcotest.(check string) "mesh path" mesh dir.path
      | Error message -> Alcotest.fail message);
      (match resolve_on ~getenv:(env [ ("XDG_RUNTIME_DIR", xdg) ]) Macos with
      | Ok dir -> Alcotest.(check string) "xdg path" xdg dir.path
      | Error message -> Alcotest.fail message);
      error_mentions "invalid variable" "XDG_RUNTIME_DIR"
        (resolve_on ~getenv:(env [ ("XDG_RUNTIME_DIR", "relative") ]) Macos))

let test_other_system_needs_a_variable () =
  error_mentions "other" "MESH_RUNTIME_DIR" (resolve_on (Other "freebsd"))

let tests =
  [
    Alcotest.test_case "macOS default created 0700" `Quick
      test_macos_default_created;
    Alcotest.test_case "macOS default refuses a symlink" `Quick
      test_macos_default_symlink_refused;
    Alcotest.test_case "macOS default needs Application Support" `Quick
      test_macos_default_needs_application_support;
    Alcotest.test_case "macOS default too long" `Quick
      test_macos_default_too_long;
    Alcotest.test_case "macOS default without a home" `Quick
      test_macos_without_home;
    Alcotest.test_case "macOS accepts the variables" `Quick
      test_macos_variables_accepted;
    Alcotest.test_case "other systems need a variable" `Quick
      test_other_system_needs_a_variable;
    Alcotest.test_case "run/user guess accepted" `Quick test_guess_accepted;
    Alcotest.test_case "run/user guess needs 0700" `Quick
      test_guess_needs_mode_0700;
    Alcotest.test_case "run/user guess missing" `Quick test_guess_missing;
    Alcotest.test_case "run/user guess symlink" `Quick test_guess_symlink;
    Alcotest.test_case "run/user guess rejects sticky bit" `Quick
      test_guess_sticky_bit;
    Alcotest.test_case "invalid variable never reaches the guess" `Quick
      test_invalid_variable_never_reaches_guess;
    Alcotest.test_case "XDG wins over the guess" `Quick test_xdg_wins_over_guess;
    Alcotest.test_case "unset everywhere" `Quick test_unset;
    Alcotest.test_case "empty counts as unset" `Quick test_empty_is_unset;
    Alcotest.test_case "relative path" `Quick test_relative;
    Alcotest.test_case "group or other writable" `Quick test_group_writable;
    Alcotest.test_case "symlink" `Quick test_symlink;
    Alcotest.test_case "symlink with trailing slash or dot" `Quick
      test_symlink_with_trailing_slash;
    Alcotest.test_case "dot-dot segment" `Quick test_dot_dot_segment;
    Alcotest.test_case "empty segment" `Quick test_empty_segment;
    Alcotest.test_case "symlinked ancestor" `Quick
      test_symlinked_ancestor_not_canonical;
    Alcotest.test_case "socket path length boundary" `Quick
      test_max_socket_path_boundary;
    Alcotest.test_case "not a directory" `Quick test_not_a_directory;
    Alcotest.test_case "MESH wins over XDG" `Quick test_mesh_wins;
    Alcotest.test_case "invalid MESH does not fall back" `Quick
      test_invalid_mesh_does_not_fall_back;
    Alcotest.test_case "socket path too long" `Quick test_path_too_long;
    Alcotest.test_case "good directory" `Quick test_good;
  ]
