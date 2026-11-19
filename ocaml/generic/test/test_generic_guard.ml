(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(* Self-tests of the dependency guard: each case copies the dune files of the
   real generic/ directory into a temporary one, injects one violation, and
   expects the guard to refuse it with a message naming the culprit. *)

let source = ref ""
let read path = In_channel.with_open_bin path In_channel.input_all

let copy_generic target =
  List.iter
    (fun directory ->
      let from = Filename.concat !source directory and into = Filename.concat target directory in
      Unix.mkdir into 0o700;
      Support.write_file (Filename.concat into "dune") (read (Filename.concat from "dune")))
    ("test" :: List.map fst Generic_guard.generic)

let contains text fragment =
  let length = String.length fragment in
  let rec from index =
    index + length <= String.length text && (String.sub text index length = fragment || from (index + 1))
  in
  from 0

let test_real_tree () =
  match Generic_guard.check !source with
  | Ok () -> ()
  | Error errors -> Alcotest.fail (String.concat "\n" errors)

let test_copy_passes () =
  Support.with_directory (fun root ->
      copy_generic root;
      Alcotest.(check bool) "a faithful copy passes" true (Generic_guard.check root = Ok ()))

(* [inject root] changes the copy; the guard must fail with [expected] in one
   of its messages. *)
let refused name ~expected inject =
  Alcotest.test_case name `Quick (fun () ->
      Support.with_directory (fun root ->
          copy_generic root;
          inject root;
          match Generic_guard.check root with
          | Ok () -> Alcotest.failf "%s was not refused" name
          | Error errors ->
              if not (List.exists (fun error -> contains error expected) errors) then
                Alcotest.failf "no message names %S in:\n%s" expected (String.concat "\n" errors)))

let library_dune ?(extra = "") fields =
  Printf.sprintf "(library\n (name mesh_lru)\n %s)\n%s" fields extra

let set_lru root text = Support.write_file (Filename.concat (Filename.concat root "lru") "dune") text

let injections =
  [
    refused "a forbidden library" ~expected:"may not depend on mesh_agent_claude" (fun root ->
        set_lru root (library_dune "(libraries unix mesh_agent_claude)"));
    refused "a select alternative" ~expected:"may not depend on mesh_agent_claude" (fun root ->
        set_lru root
          (library_dune "(libraries (select x.ml from (mesh_agent_claude -> x.agent.ml) (-> x.none.ml)))"));
    refused "a re_export" ~expected:"may not depend on mesh_read" (fun root ->
        set_lru root (library_dune "(libraries (re_export mesh_read))"));
    refused "a preprocessor" ~expected:"preprocessor mesh_agent_ppx is not allowed" (fun root ->
        set_lru root (library_dune "(preprocess (pps mesh_agent_ppx --cookie x))"));
    refused "a preprocessing action" ~expected:"(preprocess ...) form is not allowed" (fun root ->
        set_lru root (library_dune "(preprocess (action (run cat %{input-file})))"));
    refused "copy_files# of outside code" ~expected:"found: library, copy_files#" (fun root ->
        set_lru root (library_dune "" ~extra:"(copy_files# ../../lib/mesh_read.ml)\n"));
    refused "include_subdirs" ~expected:"found: library, include_subdirs" (fun root ->
        set_lru root (library_dune "" ~extra:"(include_subdirs unqualified)\n"));
    refused "a rule that copies code" ~expected:"found: library, rule" (fun root ->
        set_lru root
          (library_dune "" ~extra:"(rule (with-stdout-to x.ml (cat ../../lib/mesh_read.ml)))\n"));
    refused "an unknown library field" ~expected:"field (foreign_stubs ...) is not allowed" (fun root ->
        set_lru root (library_dune "(foreign_stubs (language c) (names ../../lib/x))"));
    refused "flags from a file" ~expected:"(:include ...)) is not allowed" (fun root ->
        set_lru root (library_dune "(flags (:include ../../flags.sexp))"));
    refused "a hidden datum comment" ~expected:"#| and #;" (fun root ->
        set_lru root (library_dune "#;(x) (libraries unix)"));
    refused "a nested directory" ~expected:"generic/lru/inner: nested directories" (fun root ->
        let inner = Filename.concat (Filename.concat root "lru") "inner" in
        Unix.mkdir inner 0o700;
        Support.write_file (Filename.concat inner "dune")
          "(library (name inner) (libraries mesh_agent_claude))\n");
    refused "a dune file at the root" ~expected:"generic/dune" (fun root ->
        Support.write_file (Filename.concat root "dune") "(subdir lru (library (name x)))\n");
    refused "an unlisted directory" ~expected:"generic/extra is not listed" (fun root ->
        Unix.mkdir (Filename.concat root "extra") 0o700);
    refused "a renamed library" ~expected:"does not define library mesh_lru" (fun root ->
        set_lru root "(library (name other))\n");
  ]

let () =
  source := Sys.argv.(1);
  Alcotest.run ~argv:[| Sys.argv.(0) |] "generic_guard"
    [
      ( "guard",
        [
          Alcotest.test_case "the real generic/ passes" `Quick test_real_tree;
          Alcotest.test_case "a copy passes" `Quick test_copy_passes;
        ] );
      ("violations", injections);
    ]
