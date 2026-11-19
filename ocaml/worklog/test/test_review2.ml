(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(* Regression tests of the second independent review: the git step after a
   write, Init's taxonomy text, YAML and JSON that the reference tool refuses,
   session cwd validation, bounded and non-blocking reads, and the size of one
   append. Each case failed before its fix. *)

open Mesh_worklog
open Tutil

let is_error = function Ok _ -> false | Error _ -> true

(* Opens [n] descriptors (more than FD_SETSIZE, 1024) around [f]. The soft
   limit is raised first, as far as the hard limit allows; when it still cannot
   hold [n] descriptors plus headroom the case is skipped with a visible message
   naming the limit, instead of failing with EMFILE. *)
let with_descriptors n f =
  let headroom = 200 in
  let limit = Lock.raise_nofile_limit (n + headroom) in
  if limit >= 0 && limit < n + headroom then begin
    Printf.eprintf "SKIPPED: the descriptor limit is %d, %d are needed to cross FD_SETSIZE\n%!" limit (n + headroom);
    Alcotest.skip ()
  end;
  let fds = ref [] in
  Fun.protect
    ~finally:(fun () -> List.iter (fun fd -> try Unix.close fd with Unix.Unix_error _ -> ()) !fds)
    (fun () ->
      for _ = 1 to n do
        fds := Unix.openfile "/dev/null" [ Unix.O_RDONLY ] 0 :: !fds
      done;
      f ())

let no_child_left () =
  match Unix.waitpid [ Unix.WNOHANG ] (-1) with
  | 0, _ -> false
  | _ -> false
  | exception Unix.Unix_error (Unix.ECHILD, _, _) -> true

let timeline_length root id =
  match Reader.get_task (ctx root) id with
  | Ok (v, _) -> List.length v.Query.task.Model.timeline
  | Error e -> Alcotest.failf "get_task: %s" e.Err.message

(* ---- 1: git after the write ----------------------------------------------- *)

let test_write_survives_many_descriptors () =
  let root = Filename.concat (temp_dir "r2fd") "repo" in
  ignore (ok (Init.init ~root ()));
  let c = ctx ~commit:true root in
  let id = ok (Write_task.add c ~title:"probe" ~product:"general" ()) in
  let before = timeline_length root id in
  let warnings = ref [] in
  let c = ctx ~commit:true ~warn:(fun w -> warnings := w :: !warnings) root in
  with_descriptors 1100 (fun () ->
      let r = Write_task.log c ~task:id "written once" in
      Alcotest.(check bool) "the write is Ok" true (not (is_error r)));
  Alcotest.(check int) "one event added, not two" (before + 1) (timeline_length root id);
  Alcotest.(check (list string)) "no warning: git ran" [] !warnings;
  Alcotest.(check bool) "no git child left unreaped" true (no_child_left ());
  Alcotest.(check bool) "and it was committed" true
    (contains ~sub:("wl: log " ^ id) (git root [ "log"; "-1"; "--format=%s" ]))

let test_gitrun_never_raises_with_many_descriptors () =
  let dir = temp_dir "r2run" in
  with_descriptors 1100 (fun () ->
      let code, out = Gitrun.run ~dir [ "--version" ] in
      Alcotest.(check int) "exit code" 0 code;
      Alcotest.(check bool) "output" true (contains ~sub:"git version" out);
      ignore (Gitrun.context dir));
  Alcotest.(check bool) "child reaped" true (no_child_left ())

let test_failing_warn_does_not_fail_the_write () =
  (* the data directory is not a git repository: the commit step reports through
     [warn], which here raises; the write stays Ok *)
  let root = temp_dir "r2warn" in
  write_file (Filename.concat root "taxonomy.yaml")
    "categories:\n  main:\n    name: Main\n    products:\n      - general\n";
  let c = ctx ~commit:true ~warn:(fun _ -> failwith "warn exploded") root in
  let id = ok (Write_task.add c ~title:"survives" ~product:"general" ()) in
  Alcotest.(check bool) "task written" true (timeline_length root id >= 1)

(* ---- 2: Init writes only what it can read back ----------------------------- *)

let names =
  [ "Yes"; "123"; "null"; "~"; "2026-11-19"; "[x"; "'x"; "&a"; "@x"; "- Foo"; "? x"; "x ]";
    "say \"hi\""; "back\\slash"; "caf\xc3\xa9"; "{a}"; "*b"; "!t"; "|"; ">"; "%x"; "`q`" ]

let test_init_roundtrips_every_name () =
  List.iter
    (fun name ->
      let root = Filename.concat (temp_dir "r2init") "repo" in
      let taxonomy = Filename.concat root "taxonomy.yaml" in
      match Init.init ~root ~git:false ~category_name:name () with
      | Ok () ->
          let t = ok (Taxonomy.load taxonomy) in
          let c = List.hd t.Taxonomy.categories in
          Alcotest.(check string) ("name " ^ name) name c.Taxonomy.name;
          let text = read_file taxonomy in
          (* anything typed by YAML or starting with an indicator is quoted *)
          Alcotest.(check bool) ("quoted " ^ name) true (contains ~sub:"name: \"" text)
      | Error _ ->
          Alcotest.(check bool) ("nothing written for " ^ name) false (Sys.file_exists taxonomy))
    names

let test_init_keeps_ordinary_names_plain () =
  let root = Filename.concat (temp_dir "r2init") "repo" in
  ignore (ok (Init.init ~root ~git:false ~category_name:"Platform team" ()));
  Alcotest.(check bool) "plain" true
    (contains ~sub:"name: Platform team\n" (read_file (Filename.concat root "taxonomy.yaml")))

let test_init_refuses_without_writing () =
  List.iter
    (fun name ->
      let root = Filename.concat (temp_dir "r2init") "repo" in
      Alcotest.(check bool) ("refused " ^ String.escaped name) true
        (is_error (Init.init ~root ~git:false ~category_name:name ()));
      Alcotest.(check bool) "nothing written" false (Sys.file_exists (Filename.concat root "taxonomy.yaml")))
    [ "a\nb"; "a\x01b"; String.make 200 'x'; "a: b"; "a # b" ]

(* ---- 3: YAML and JSON that wl refuses ---------------------------------------- *)

let yaml_refused =
  [ "name: - Foo"; "name: ]"; "name: }"; "name: ? x"; "name: , b"; "name: -"; "name: -\tx";
    "name: b\t# c"; "name: b\t"; "name: [a]\t"; "name: [a]\t# c"; "name: \"a\"\t" ]

let yaml_accepted =
  [ "name: -x"; "name: ?x"; "name: :x"; "name: b # c"; "name: [a] # c"; "name: \"a\" # c";
    "name: a\tb" ]

let test_yaml_refuses_what_pyyaml_refuses () =
  List.iter
    (fun doc ->
      Alcotest.(check bool) ("refused " ^ String.escaped doc) true
        (is_error (Result.map_error (fun why -> Err.make Err.Usage why) (Yaml_lite.parse (doc ^ "\n")))))
    yaml_refused;
  List.iter
    (fun doc ->
      Alcotest.(check bool) ("accepted " ^ String.escaped doc) false
        (is_error (Result.map_error (fun why -> Err.make Err.Usage why) (Yaml_lite.parse (doc ^ "\n")))))
    yaml_accepted

let envelope body =
  Printf.sprintf "{\"ts\":\"2026-11-01T10:00:00Z\",\"task\":\"T-aaaa\",\"type\":\"note\",\"text\":\"%s\"%s}" body ""

let test_json_refuses_raw_control_characters () =
  let refused raw = Alcotest.(check bool) (String.escaped raw) true (Result.is_error (Event.classify raw)) in
  refused (envelope "a\tb");
  refused (envelope "a\x01b");
  refused (envelope "a\x1fb");
  Alcotest.(check bool) "escaped tab is valid" true
    (Result.is_ok (Event.classify (envelope "a\\tb\\u0001")));
  Alcotest.(check bool) "tab between tokens is valid" true
    (Result.is_ok (Event.classify ("\t" ^ envelope "x")))

(* ---- 4: cwd is validated before git runs ---------------------------------------- *)

let with_fake_git f =
  let bin = temp_dir "r2bin" and log = Filename.concat (temp_dir "r2log") "calls" in
  write_file log "";
  let script = Filename.concat bin "git" in
  write_file script (Printf.sprintf "#!/bin/sh\necho \"$*\" >> '%s'\nexit 1\n" log);
  Unix.chmod script 0o755;
  let old_path = Sys.getenv "PATH" in
  Unix.putenv "PATH" (bin ^ ":" ^ old_path);
  Fun.protect ~finally:(fun () -> Unix.putenv "PATH" old_path) (fun () -> f (fun () -> read_file log))

let resolve_cwd cwd =
  Session.resolve ~getenv:(fun v -> if v = "WL_AGENT" then Some "claude" else None) ~cwd ()

let test_cwd_validated_before_git () =
  with_fake_git (fun calls ->
      List.iter
        (fun cwd ->
          Alcotest.(check bool) ("refused " ^ String.escaped cwd) true (is_error (resolve_cwd cwd)))
        [ "/tmp/a\nb"; "/tmp/" ^ String.make 5000 'x'; "relative/dir"; "/tmp/a\x1b[31m" ];
      Alcotest.(check string) "git never called for a refused cwd" "" (calls ());
      ignore (resolve_cwd "/tmp");
      Alcotest.(check bool) "git is called for a valid cwd" true (calls () <> ""))

let test_resolve_never_raises_with_many_descriptors () =
  with_descriptors 1100 (fun () ->
      match resolve_cwd (temp_dir "r2cwd") with
      | Ok (Some s) -> Alcotest.(check (option string)) "no repo" None s.Session.repo
      | _ -> Alcotest.fail "resolve failed");
  Alcotest.(check bool) "child reaped" true (no_child_left ())

(* ---- 5: bounded, non-blocking reads ------------------------------------------------ *)

let with_alarm seconds f =
  let previous = Sys.signal Sys.sigalrm (Sys.Signal_handle (fun _ -> failwith "blocked: alarm")) in
  ignore (Unix.alarm seconds);
  Fun.protect ~finally:(fun () -> ignore (Unix.alarm 0); Sys.set_signal Sys.sigalrm previous) f

let test_fifo_taxonomy_does_not_block () =
  let root = temp_dir "r2fifo" in
  let path = Filename.concat root "taxonomy.yaml" in
  Unix.mkfifo path 0o644;
  with_alarm 10 (fun () ->
      Alcotest.(check bool) "load refuses" true (is_error (Taxonomy.load path));
      Alcotest.(check bool) "edit refuses" true
        (is_error (Taxonomy_edit.add_product (ctx root) ~id:"newprod" ~category:"main" ())))

let test_oversized_taxonomy_is_refused () =
  let root = temp_dir "r2big" in
  let path = Filename.concat root "taxonomy.yaml" in
  write_file path ("# " ^ String.make (Safefs.max_taxonomy_bytes + 1) 'x' ^ "\ncategories: {}\n");
  match Taxonomy.load path with
  | Error e -> Alcotest.(check bool) "says why" true (contains ~sub:"larger than" e.Err.message)
  | Ok _ -> Alcotest.fail "an oversized taxonomy was read"

let test_read_limit () =
  let path = Filename.concat (temp_dir "r2lim") "f.jsonl" in
  write_file path (String.make 200 'a');
  Alcotest.(check int) "within the limit" 200 (String.length (Safefs.read_file ~limit:200 path));
  (match Safefs.read_file ~limit:199 path with
  | exception Err.E _ -> ()
  | _ -> Alcotest.fail "a file over the limit was read");
  Alcotest.(check bool) "reader skips it with a reason" true
    (is_error (Safefs.read_file_result ~limit:10 path |> Result.map_error (fun m -> Err.make Err.Other m)))

let test_open_regular_refuses_special_files_unopened () =
  let dir = temp_dir "r2spec" in
  let fifo = Filename.concat dir "f" in
  Unix.mkfifo fifo 0o644;
  with_alarm 10 (fun () ->
      match Safefs.open_regular fifo [ Unix.O_RDONLY ] with
      | exception Err.E _ -> ()
      | fd -> Unix.close fd; Alcotest.fail "a fifo was opened");
  let link = Filename.concat dir "dev" in
  Unix.symlink "/dev/null" link;
  match Safefs.open_regular link [ Unix.O_RDONLY ] with
  | exception Err.E _ -> ()
  | fd -> Unix.close fd; Alcotest.fail "a link to a device was opened"

(* ---- 6: one append is one write ---------------------------------------------------------- *)

let test_oversized_change_is_refused_before_any_write () =
  let root = Filename.concat (temp_dir "r2cap") "repo" in
  ignore (ok (Init.init ~root ~git:false ()));
  let c = ctx root in
  let tags = List.init 4000 (fun i -> Printf.sprintf "tag-%04d-padding" i) in
  let r = Write_task.add c ~title:"too many tags" ~product:"general" ~tags () in
  Alcotest.(check bool) "refused" true (error_kind r = Some Err.Usage);
  Alcotest.(check int) "no task file" 0 (List.length (Safefs.list_dir (Filename.concat root "tasks/general") |> List.filter (fun f -> f <> ".gitkeep")));
  Alcotest.(check int) "no event" 0 (List.length (List.filter (fun f -> f <> ".gitkeep") (Safefs.list_dir (Filename.concat root "events"))))

let test_change_under_the_cap_is_one_write () =
  let root = Filename.concat (temp_dir "r2cap") "repo" in
  ignore (ok (Init.init ~root ~git:false ()));
  let tags = List.init 100 (fun i -> Printf.sprintf "tag-%04d" i) in
  let id = ok (Write_task.add (ctx root) ~title:"many tags" ~product:"general" ~tags ()) in
  Alcotest.(check bool) "written" true (timeline_length root id >= 1);
  Alcotest.(check bool) "cap is under 64 KiB" true (Txn.max_blob_bytes < 65536)

let () =
  Alcotest.run "worklog review 2"
    [ ( "git after the write",
        [ Alcotest.test_case "1100 descriptors" `Quick test_write_survives_many_descriptors;
          Alcotest.test_case "Gitrun total" `Quick test_gitrun_never_raises_with_many_descriptors;
          Alcotest.test_case "warn raising" `Quick test_failing_warn_does_not_fail_the_write ] );
      ( "init",
        [ Alcotest.test_case "names round-trip" `Quick test_init_roundtrips_every_name;
          Alcotest.test_case "ordinary names stay plain" `Quick test_init_keeps_ordinary_names_plain;
          Alcotest.test_case "refusals write nothing" `Quick test_init_refuses_without_writing ] );
      ( "strictness",
        [ Alcotest.test_case "yaml" `Quick test_yaml_refuses_what_pyyaml_refuses;
          Alcotest.test_case "json control characters" `Quick test_json_refuses_raw_control_characters ] );
      ( "session",
        [ Alcotest.test_case "cwd before git" `Quick test_cwd_validated_before_git;
          Alcotest.test_case "resolve total" `Quick test_resolve_never_raises_with_many_descriptors ] );
      ( "reads",
        [ Alcotest.test_case "fifo taxonomy" `Quick test_fifo_taxonomy_does_not_block;
          Alcotest.test_case "oversized taxonomy" `Quick test_oversized_taxonomy_is_refused;
          Alcotest.test_case "read limit" `Quick test_read_limit;
          Alcotest.test_case "special files" `Quick test_open_regular_refuses_special_files_unopened ] );
      ( "append",
        [ Alcotest.test_case "cap" `Quick test_oversized_change_is_refused_before_any_write;
          Alcotest.test_case "under the cap" `Quick test_change_under_the_cap_is_one_write ] ) ]
