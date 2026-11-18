(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(* The PTY host's update check: its schedule with a fake clock and a fake
   request, and its bounded child with a fake curl. No request leaves the
   machine. *)

module C = Mesh_update_check
module R = Mesh_update_report
module H = Mesh_update_host

let with_root f =
  let root = Filename.temp_file "mesh-update-host" "" in
  Sys.remove root;
  Unix.mkdir root 0o700;
  let rec remove path =
    match (Unix.lstat path).Unix.st_kind with
    | Unix.S_DIR ->
        Sys.readdir path
        |> Array.iter (fun name -> remove (Filename.concat path name));
        Unix.rmdir path
    | _ -> Unix.unlink path
  in
  Fun.protect
    ~finally:(fun () -> remove root)
    (fun () -> f (Unix.realpath root))

let installation = R.installation_of_release_dir "/s/releases/v0.1.0"

let list_body =
  {|[{"tag_name":"v0.2.0","draft":false,"prerelease":false,"body":"Security: yes"}]|}

let env pairs name = List.assoc_opt name pairs

exception Stop

(* The fake clock: [sleep] moves the wall clock, and ends the loop after
   [ticks] sleeps (the loop itself never returns while the feature is on). *)
let run_loop ?(installation = fun () -> installation) ?(extra = [])
    ?(between = ignore) ~root ~ticks ~fetch () =
  let host = H.create () in
  let clock = ref 1_000_000. and slept = ref [] and logs = ref [] in
  let sleep seconds =
    slept := seconds :: !slept;
    if List.length !slept >= ticks then raise Stop;
    clock := !clock +. seconds;
    between ()
  in
  let getenv = env (("MESH_CACHE_DIR", root) :: extra) in
  (try
     H.loop host ~getenv ~installation ~now:(fun () -> !clock) ~sleep ~fetch
       ~log:(fun text -> logs := text :: !logs)
   with Stop -> ());
  (host, List.rev !slept, List.rev !logs)

let counting answer =
  let calls = ref 0 in
  ( calls,
    fun ~etag:_ ->
      incr calls;
      answer )

let test_first_check_then_cache () =
  with_root (fun root ->
      let calls, fetch = counting (C.Body { etag = None; body = list_body }) in
      let host, slept, logs = run_loop ~root ~ticks:5 ~fetch () in
      Alcotest.(check int) "one request at startup, none within the interval" 1
        !calls;
      Alcotest.(check (list (float 0.)))
        "looks again every ten minutes"
        (List.init 5 (fun _ -> H.tick))
        slept;
      Alcotest.(check int) "the line is logged once" 1 (List.length logs);
      Alcotest.(check bool) "with the release" true
        (String.starts_with ~prefix:"Session Mesh v0.2.0 is available, with a security fix"
           (List.hd logs));
      match H.latest host with
      | `Assoc fields ->
          Alcotest.(check (option string)) "status" (Some "available")
            (match List.assoc_opt "status" fields with
            | Some (`String text) -> Some text
            | _ -> None);
          Alcotest.(check bool) "latest" true
            (List.assoc_opt "latest" fields = Some (`String "v0.2.0"))
      | _ -> Alcotest.fail "an available answer is an object")

(* The memory of the attempt, not the cache, spaces the requests: with the
   cache file removed after every tick, a request still waits for the period. *)
let test_memory_spaces_requests () =
  with_root (fun root ->
      let cache = Filename.concat root "update-check.json" in
      let calls, fetch = counting (C.Failed "offline") in
      let ticks = int_of_float (C.period /. H.tick) in
      let _ =
        run_loop ~root ~ticks:(ticks - 1) ~fetch
          ~between:(fun () -> try Sys.remove cache with Sys_error _ -> ())
          ()
      in
      Alcotest.(check int) "one request in the first period" 1 !calls;
      calls := 0;
      let _ =
        run_loop ~root ~ticks:(ticks + 2) ~fetch
          ~between:(fun () -> try Sys.remove cache with Sys_error _ -> ())
          ()
      in
      Alcotest.(check int) "a second one after it" 2 !calls)

let test_failure_shows_nothing () =
  let _, fetch = counting (C.Failed "curl exited with 6") in
  with_root (fun root ->
      let host, _, logs = run_loop ~root ~ticks:2 ~fetch () in
      Alcotest.(check bool) "nothing to show" true (H.latest host = `Null);
      Alcotest.(check (list string)) "and nothing logged" [] logs);
  with_root (fun root ->
      let _, _, logs =
        run_loop ~root ~ticks:1 ~fetch ~extra:[ ("MESH_UPDATE_DEBUG", "1") ] ()
      in
      Alcotest.(check bool) "the reason under MESH_UPDATE_DEBUG=1" true
        (List.exists
           (fun text -> String.starts_with ~prefix:"update check: " text)
           logs));
  with_root (fun root ->
      let raising ~etag:_ = failwith "boom" in
      let host, slept, _ = run_loop ~root ~ticks:3 ~fetch:raising () in
      Alcotest.(check bool) "an exception is swallowed" true
        (H.latest host = `Null);
      Alcotest.(check int) "the loop goes on" 3 (List.length slept))

let test_off_and_source_install () =
  with_root (fun root ->
      let calls, fetch = counting (C.Body { etag = None; body = list_body }) in
      List.iter
        (fun (label, extra, installation, looks) ->
          let host, slept, logs =
            run_loop
              ?installation:(Option.map (fun value () -> value) installation)
              ~root ~ticks:3 ~fetch ~extra ()
          in
          Alcotest.(check int) (label ^ ": no request") 0 !calls;
          (* a source install ends the loop; a feature that is off keeps
             looking, since the settings file may turn it on *)
          Alcotest.(check int) (label ^ ": looks") looks (List.length slept);
          Alcotest.(check (list string)) (label ^ ": no log") [] logs;
          Alcotest.(check bool) (label ^ ": nothing") true (H.latest host = `Null))
        [
          ("MESH_UPDATE_CHECK=0", [ ("MESH_UPDATE_CHECK", "0") ], None, 3);
          ( "MESH_UPDATE_NOTICE=none",
            [ ("MESH_UPDATE_NOTICE", "none") ],
            None,
            3 );
          ("source install", [], Some None, 0);
        ])

(* ---- the settings file, read at every look *)

let settings_file conf text =
  (try Unix.mkdir conf 0o700 with Unix.Unix_error (Unix.EEXIST, _, _) -> ());
  let path = Filename.concat conf R.settings_name in
  (try Unix.unlink path with Unix.Unix_error _ -> ());
  Out_channel.with_open_bin path (fun channel -> output_string channel text);
  Unix.chmod path 0o600

(* Drives the loop for [looks] looks; [script] runs before the look [n]
   (counted from 2) and may change the file. Returns, per look, whether an
   announcement was held and how many requests had been made. *)
let observed ?(extra = []) ~root ~looks ~script ~fetch calls () =
  let host = H.create () in
  let clock = ref 1_000_000. and slept = ref 0 and seen = ref [] in
  let record () = seen := (H.latest host <> `Null, !calls) :: !seen in
  let sleep seconds =
    record ();
    incr slept;
    if !slept >= looks then raise Stop;
    clock := !clock +. seconds;
    script (!slept + 1)
  in
  let logs = ref [] in
  let getenv = env (("MESH_CACHE_DIR", root) :: extra) in
  (try
     H.loop host ~getenv ~installation:(fun () -> installation)
       ~now:(fun () -> !clock) ~sleep ~fetch
       ~log:(fun text -> logs := text :: !logs)
   with Stop -> ());
  (List.rev !seen, List.rev !logs)

let state = Alcotest.(list (pair bool int))

(* The owner's way to switch the notice off without restarting the host: the
   next look makes no request and the announcement is gone; switching it on
   again brings it back from the cache. *)
let test_file_disables_then_enables () =
  List.iter
    (fun (label, off, on) ->
      with_root (fun root ->
          let conf = Filename.concat root "conf" in
          let calls, fetch =
            counting (C.Body { etag = None; body = list_body })
          in
          let script look =
            match look with
            | 2 -> settings_file conf off
            | 4 -> settings_file conf on
            | _ -> ()
          in
          let seen, logs =
            observed ~root ~extra:[ ("MESH_CONF_DIR", conf) ] ~looks:5 ~script
              ~fetch calls ()
          in
          Alcotest.check state label
            [ (true, 1); (false, 1); (false, 1); (true, 1); (true, 1) ]
            seen;
          Alcotest.(check int) (label ^ ": the line is logged once") 1
            (List.length logs)))
    [
      ("check=0", "check=0\n", "check=1\n");
      ("notice=none", "# off\nnotice=none\n", "notice=all\n");
    ]

(* The file is read at the first look too, and overrides the environment. *)
let test_file_overrides_environment_in_the_host () =
  with_root (fun root ->
      let conf = Filename.concat root "conf" in
      settings_file conf "check=1\n";
      let calls, fetch = counting (C.Body { etag = None; body = list_body }) in
      let seen, _ =
        observed ~root
          ~extra:[ ("MESH_CONF_DIR", conf); ("MESH_UPDATE_CHECK", "0") ]
          ~looks:2 ~script:ignore ~fetch calls ()
      in
      Alcotest.check state "check=1 beats MESH_UPDATE_CHECK=0"
        [ (true, 1); (true, 1) ]
        seen;
      let conf = Filename.concat root "conf2" in
      settings_file conf "check=0\n";
      calls := 0;
      Sys.remove (Filename.concat root "update-check.json");
      let seen, _ =
        observed ~root ~extra:[ ("MESH_CONF_DIR", conf) ] ~looks:2
          ~script:ignore ~fetch calls ()
      in
      Alcotest.check state "check=0 beats the default"
        [ (false, 0); (false, 0) ]
        seen)

(* A file that cannot be used changes nothing: the environment values apply,
   and the reason is logged under MESH_UPDATE_DEBUG=1. *)
let test_invalid_file_falls_back () =
  with_root (fun root ->
      let conf = Filename.concat root "conf" in
      let calls, fetch = counting (C.Body { etag = None; body = list_body }) in
      settings_file conf "check=0\nnotice=sometimes\n";
      let seen, logs =
        observed ~root
          ~extra:
            [ ("MESH_CONF_DIR", conf); ("MESH_UPDATE_DEBUG", "1") ]
          ~looks:2 ~script:ignore ~fetch calls ()
      in
      Alcotest.check state "defaults: on" [ (true, 1); (true, 1) ] seen;
      Alcotest.(check bool) "the reason is logged" true
        (List.exists
           (fun text ->
             String.starts_with
               ~prefix:"update check: update-notice notice: unknown value" text)
           logs);
      (* the same file, with the environment off: stays off *)
      calls := 0;
      Sys.remove (Filename.concat root "update-check.json");
      let seen, _ =
        observed ~root
          ~extra:[ ("MESH_CONF_DIR", conf); ("MESH_UPDATE_CHECK", "0") ]
          ~looks:2 ~script:ignore ~fetch calls ()
      in
      Alcotest.check state "environment off, invalid file: off"
        [ (false, 0); (false, 0) ]
        seen;
      (* a valid file turned invalid later: back to the environment *)
      settings_file conf "check=1\n";
      let seen, _ =
        observed ~root
          ~extra:[ ("MESH_CONF_DIR", conf); ("MESH_UPDATE_CHECK", "0") ]
          ~looks:3
          ~script:(fun look ->
            if look = 3 then settings_file conf "check=banana\n")
          ~fetch calls ()
      in
      Alcotest.check state "valid then invalid"
        [ (true, 1); (true, 1); (false, 1) ]
        seen)

(* The host is not restarted by an upgrade: once [current] points at the
   release that was announced, the notice goes away without a restart. *)
let test_follows_the_installed_release () =
  with_root (fun root ->
      let releases = Filename.concat root "share/releases" in
      List.iter
        (fun path ->
          try Unix.mkdir path 0o700
          with Unix.Unix_error (Unix.EEXIST, _, _) -> ())
        [
          Filename.concat root "share";
          releases;
          Filename.concat releases "v0.1.0";
          Filename.concat releases "v0.2.0";
        ];
      let current = Filename.concat root "share/current" in
      Unix.symlink "releases/v0.1.0" current;
      let own =
        Option.get
          (R.installation_of_release_dir (Filename.concat releases "v0.1.0"))
      in
      let _, fetch = counting (C.Body { etag = None; body = list_body }) in
      let seen = ref [] in
      let host = H.create () in
      let clock = ref 1_000_000. and ticks = ref 0 in
      let sleep seconds =
        seen := H.latest host :: !seen;
        incr ticks;
        if !ticks = 1 then (
          Unix.unlink current;
          Unix.symlink "releases/v0.2.0" current);
        if !ticks = 3 then raise Stop;
        clock := !clock +. seconds
      in
      (try
         H.loop host
           ~getenv:(env [ ("MESH_CACHE_DIR", Filename.concat root "cache") ])
           ~installation:(fun () -> Some (R.following_current own))
           ~now:(fun () -> !clock) ~sleep ~fetch ~log:ignore
       with Stop -> ());
      Alcotest.(check bool) "announced while v0.1.0 is installed" true
        (List.nth (List.rev !seen) 0 <> `Null);
      Alcotest.(check bool) "gone once current is v0.2.0" true
        (List.nth (List.rev !seen) 2 = `Null);
      (* current rolled back below the running release: not followed *)
      Unix.unlink current;
      Unix.symlink "releases/v0.1.0" current;
      let newer =
        Option.get
          (R.installation_of_release_dir (Filename.concat releases "v0.2.0"))
      in
      Alcotest.(check string) "a rollback is not followed" "v0.2.0"
        (R.following_current newer).tag)

(* ---- the bounded child, with a fake curl *)

let fake_curl root script =
  let bin = Filename.concat root "bin" in
  (try Unix.mkdir bin 0o700 with Unix.Unix_error (Unix.EEXIST, _, _) -> ());
  let path = Filename.concat bin "curl" in
  Out_channel.with_open_bin path (fun channel -> output_string channel script);
  Unix.chmod path 0o700;
  Unix.putenv "PATH" (bin ^ ":" ^ Sys.getenv "PATH")

let pid_alive pid =
  match Unix.kill pid 0 with
  | () -> true
  | exception Unix.Unix_error (Unix.ESRCH, _, _) -> false

(* kill 0 succeeds on a zombie: after the reap the pid is gone. *)
let read_pid root =
  int_of_string (String.trim (In_channel.with_open_bin (Filename.concat root "pid") In_channel.input_all))

let hang root =
  "#!/bin/sh\necho $$ > '" ^ Filename.concat root "pid" ^ "'\nexec sleep 60\n"

let answering_curl =
  "#!/bin/sh\n\
   while [ $# -gt 0 ]; do\n\
   case \"$1\" in -D) h=$2; shift;; -o) o=$2; shift;; esac\n\
   shift\n\
   done\n\
   printf 'HTTP/2 200\\r\\netag: \"w1\"\\r\\n\\r\\n' > \"$h\"\n\
   printf '%s' '" ^ list_body ^ "' > \"$o\"\n\
   printf 200\n"

let test_child_answers () =
  with_root (fun root ->
      fake_curl root answering_curl;
      Eio_main.run @@ fun env ->
      let directory = Filename.concat root "cache" in
      let run =
        H.run_curl ~mgr:(Eio.Stdenv.process_mgr env)
          ~clock:(Eio.Stdenv.mono_clock env) ~seconds:10.
      in
      (match R.fetch_with ~run ~directory ~etag:None with
      | C.Body { etag; body } ->
          Alcotest.(check (option string)) "etag" (Some "\"w1\"") etag;
          Alcotest.(check string) "body" list_body body
      | C.Failed reason -> Alcotest.fail reason
      | C.Not_modified -> Alcotest.fail "unexpected 304");
      Alcotest.(check (list string)) "no file left" [] (Array.to_list (Sys.readdir directory));
      (* through the whole loop, the cache is written there too *)
      let fetch = R.fetch_with ~run ~directory in
      let host, _, _ = run_loop ~root ~ticks:1 ~fetch () in
      Alcotest.(check bool) "available" true (H.latest host <> `Null);
      Alcotest.(check bool) "cache written" true
        (Sys.file_exists (Filename.concat root "update-check.json")))

let test_child_timeout_is_killed_and_reaped () =
  with_root (fun root ->
      fake_curl root (hang root);
      Eio_main.run @@ fun env ->
      let started = Unix.gettimeofday () in
      let status, text =
        H.run_curl ~mgr:(Eio.Stdenv.process_mgr env)
          ~clock:(Eio.Stdenv.mono_clock env) ~seconds:0.5
          [ "curl"; "-q" ]
      in
      Alcotest.(check bool) "returned at the limit" true
        (Unix.gettimeofday () -. started < 5.);
      Alcotest.(check bool) "reported as killed" true
        (match status with Unix.WSIGNALED _ -> true | _ -> false);
      Alcotest.(check string) "no output" "" text;
      Alcotest.(check bool) "gone and reaped, not a zombie" false
        (pid_alive (read_pid root));
      let failed =
        R.fetch_with
          ~run:(H.run_curl ~mgr:(Eio.Stdenv.process_mgr env)
                  ~clock:(Eio.Stdenv.mono_clock env) ~seconds:0.3)
          ~directory:(Filename.concat root "cache") ~etag:None
      in
      Alcotest.(check bool) "a failure for the check" true
        (match failed with C.Failed _ -> true | _ -> false);
      Alcotest.(check (list string)) "no file left" []
        (Array.to_list (Sys.readdir (Filename.concat root "cache"))))

(* A stop of the host cancels the fiber: the child dies at once and the
   cancellation does not wait for the request. *)
let test_cancellation_kills_the_child () =
  with_root (fun root ->
      fake_curl root (hang root);
      Eio_main.run @@ fun env ->
      let mono = Eio.Stdenv.mono_clock env in
      let started = Unix.gettimeofday () in
      Eio.Fiber.first
        (fun () ->
          ignore
            (H.run_curl ~mgr:(Eio.Stdenv.process_mgr env) ~clock:mono
               ~seconds:60. [ "curl"; "-q" ]))
        (fun () -> Eio.Time.Mono.sleep mono 0.5);
      Alcotest.(check bool) "cancelled promptly" true
        (Unix.gettimeofday () -. started < 5.);
      Alcotest.(check bool) "child gone and reaped" false (pid_alive (read_pid root)))

(* The child's standard error goes to /dev/null: a curl that writes 200 MB on it
   neither grows the host's heap nor slows the request. *)
let test_child_stderr_is_not_buffered () =
  with_root (fun root ->
      fake_curl root "#!/bin/sh\nhead -c 200000000 /dev/zero >&2\nprintf 200\n";
      Eio_main.run @@ fun env ->
      Gc.compact ();
      let before = (Gc.quick_stat ()).Gc.top_heap_words in
      let started = Unix.gettimeofday () in
      let status, text =
        H.run_curl ~mgr:(Eio.Stdenv.process_mgr env)
          ~clock:(Eio.Stdenv.mono_clock env) ~seconds:20.
          [ "curl"; "-q" ]
      in
      Alcotest.(check bool) "answered" true
        (status = Unix.WEXITED 0 && text = "200");
      Alcotest.(check bool) "promptly" true (Unix.gettimeofday () -. started < 10.);
      let grown = (Gc.quick_stat ()).Gc.top_heap_words - before in
      Alcotest.(check bool) "the heap did not take the output" true
        (grown * 8 < 32_000_000))

(* A killed wrapper leaves a descendant that holds the output pipe: the limit is
   still strict, and the descendant is not waited for. *)
let test_child_limit_with_a_descendant () =
  with_root (fun root ->
      let descendant = Filename.concat root "descendant" in
      fake_curl root
        ("#!/bin/sh\necho $$ > '" ^ Filename.concat root "pid"
       ^ "'\nsleep 60 &\necho $! > '" ^ descendant ^ "'\nwait\n");
      Fun.protect
        ~finally:(fun () ->
          match
            int_of_string_opt
              (String.trim
                 (In_channel.with_open_bin descendant In_channel.input_all))
          with
          | Some pid -> ( try Unix.kill pid Sys.sigkill with Unix.Unix_error _ -> ())
          | None -> ()
          | exception Sys_error _ -> ())
        (fun () ->
          Eio_main.run @@ fun env ->
          let started = Unix.gettimeofday () in
          let status, text =
            H.run_curl ~mgr:(Eio.Stdenv.process_mgr env)
              ~clock:(Eio.Stdenv.mono_clock env) ~seconds:1.
              [ "curl"; "-q" ]
          in
          let elapsed = Unix.gettimeofday () -. started in
          Alcotest.(check bool)
            (Printf.sprintf "returned at the limit (%.1f s)" elapsed)
            true (elapsed < 3.);
          Alcotest.(check bool) "reported as killed" true
            (match status with Unix.WSIGNALED _ -> true | _ -> false);
          Alcotest.(check string) "no output" "" text;
          Alcotest.(check bool) "the wrapper is gone and reaped" false
            (pid_alive (read_pid root))))

let test_missing_curl_is_a_failure () =
  with_root (fun root ->
      Unix.putenv "PATH" (Filename.concat root "nothing");
      Eio_main.run @@ fun env ->
      let result =
        R.fetch_with
          ~run:
            (H.run_curl ~mgr:(Eio.Stdenv.process_mgr env)
               ~clock:(Eio.Stdenv.mono_clock env) ~seconds:2.)
          ~directory:(Filename.concat root "cache") ~etag:None
      in
      Alcotest.(check bool) "a failure, not an exception" true
        (result = C.Failed "curl exited with 127"))

let () =
  let saved_path = Sys.getenv "PATH" in
  Fun.protect
    ~finally:(fun () -> Unix.putenv "PATH" saved_path)
    (fun () ->
      Alcotest.run "mesh_update_host"
        [
          ( "schedule",
            [
              Alcotest.test_case "first check, then the cache" `Quick
                test_first_check_then_cache;
              Alcotest.test_case "memory spaces the requests" `Quick
                test_memory_spaces_requests;
              Alcotest.test_case "failure shows nothing" `Quick
                test_failure_shows_nothing;
              Alcotest.test_case "off and source install" `Quick
                test_off_and_source_install;
              Alcotest.test_case "follows the installed release" `Quick
                test_follows_the_installed_release;
              Alcotest.test_case "settings file: off, then on again" `Quick
                test_file_disables_then_enables;
              Alcotest.test_case "settings file overrides the environment"
                `Quick test_file_overrides_environment_in_the_host;
              Alcotest.test_case "invalid settings file: fallback" `Quick
                test_invalid_file_falls_back;
            ] );
          ( "child",
            [
              Alcotest.test_case "answers" `Quick test_child_answers;
              Alcotest.test_case "timeout: killed and reaped" `Quick
                test_child_timeout_is_killed_and_reaped;
              Alcotest.test_case "cancellation kills it" `Quick
                test_cancellation_kills_the_child;
              Alcotest.test_case "stderr is not buffered" `Quick
                test_child_stderr_is_not_buffered;
              Alcotest.test_case "limit with a descendant holding the pipe"
                `Quick test_child_limit_with_a_descendant;
              Alcotest.test_case "missing curl" `Quick
                test_missing_curl_is_a_failure;
            ] );
        ])
