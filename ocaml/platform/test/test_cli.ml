(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(* Runs the mesh-platform executable: usage errors, error kinds, [require], and
   the exit code under every kind of failing stdout. *)

let exe = "../cli/mesh_platform_main.exe"

let read_all descriptor =
  let channel = Unix.in_channel_of_descr descriptor in
  In_channel.input_all channel

let variable_name binding =
  match String.index_opt binding '=' with
  | Some index -> String.sub binding 0 index
  | None -> binding

(* The inherited environment without the variables that [overrides] sets:
   getenv returns the first binding of a name, so an inherited value placed
   before an override would win. *)
let environment_with overrides =
  let overridden = List.map variable_name overrides in
  let inherited =
    Array.to_list (Unix.environment ())
    |> List.filter (fun binding ->
           not (List.mem (variable_name binding) overridden))
  in
  Array.of_list (inherited @ overrides)

(* Run with [argv] (argv.(0) included), [env] overrides, stdout to a pipe;
   return (exit status, stdout, stderr). *)
let run ?(env = []) argv =
  let out_read, out_write = Unix.pipe ~cloexec:true () in
  let err_read, err_write = Unix.pipe ~cloexec:true () in
  let environment = environment_with env in
  let child =
    Unix.create_process_env exe argv environment Unix.stdin out_write err_write
  in
  Unix.close out_write;
  Unix.close err_write;
  let stdout_text = read_all out_read in
  let stderr_text = read_all err_read in
  let _, status = Unix.waitpid [] child in
  (status, stdout_text, stderr_text)

let test_empty_argv_is_usage_error () =
  let status, _, stderr_text = run [||] in
  Alcotest.(check bool) "exit 2" true (status = Unix.WEXITED 2);
  Alcotest.(check bool) "usage" true (String.length stderr_text > 0)

let kind_of stdout_text =
  match Yojson.Safe.from_string stdout_text with
  | `Assoc fields -> (
      match List.assoc_opt "kind" fields with
      | Some (`String kind) -> kind
      | _ -> Alcotest.fail "no kind field")
  | _ -> Alcotest.fail "not an object"

let test_runtime_dir_kind () =
  let status, stdout_text, _ =
    run
      ~env:[ "MESH_RUNTIME_DIR=relative/dir" ]
      [| "mesh-platform"; "runtime-dir" |]
  in
  Alcotest.(check bool) "exit 1" true (status = Unix.WEXITED 1);
  Alcotest.(check string) "kind" "runtime_dir" (kind_of stdout_text)

let test_not_found_kind () =
  let status, stdout_text, _ =
    run [| "mesh-platform"; "process"; "2147483646" |]
  in
  Alcotest.(check bool) "exit 1" true (status = Unix.WEXITED 1);
  Alcotest.(check string) "kind" "not_found" (kind_of stdout_text)

let test_pid_is_decimal () =
  List.iter
    (fun pid ->
      let status, stdout_text, _ = run [| "mesh-platform"; "process"; pid |] in
      Alcotest.(check bool) (pid ^ ": exit 2") true (status = Unix.WEXITED 2);
      Alcotest.(check string) (pid ^ ": no stdout") "" stdout_text)
    [ "0x1"; "+1"; "1_"; "0o1"; " 1"; "-1"; "0"; ""; "99999999999" ]

let contains text fragment =
  let length = String.length fragment in
  let rec scan index =
    index + length <= String.length text
    && (String.sub text index length = fragment || scan (index + 1))
  in
  scan 0

(* Until the child has executed /bin/sh, its command line is still ours. *)
let rec command_line_after_exec pid tries =
  let status, stdout_text, _ =
    run [| "mesh-platform"; "command-line"; string_of_int pid |]
  in
  if (status = Unix.WEXITED 0 && contains stdout_text "read line") || tries = 0
  then (status, stdout_text)
  else (
    Unix.sleepf 0.05;
    command_line_after_exec pid (tries - 1))

(* A child whose argument is not UTF-8: the CLI prints U+FFFD in its place, so
   that the output stays valid JSON for strict decoders. *)
let test_invalid_utf_8_is_replaced () =
  let input, holder = Unix.pipe ~cloexec:true () in
  let child =
    Unix.create_process "/bin/sh"
      [| "/bin/sh"; "-c"; "read line"; "\xff\xfe" |]
      input Unix.stdout Unix.stderr
  in
  Unix.close input;
  Fun.protect
    ~finally:(fun () ->
      Unix.close holder;
      ignore (Unix.waitpid [] child))
    (fun () ->
      let status, stdout_text = command_line_after_exec child 40 in
      Alcotest.(check bool) "exit 0" true (status = Unix.WEXITED 0);
      Alcotest.(check bool)
        "valid UTF-8" true
        (String.is_valid_utf_8 stdout_text);
      Alcotest.(check bool)
        "replacement characters" true
        (Yojson.Safe.from_string stdout_text
        = `List
            [
              `String "/bin/sh";
              `String "-c";
              `String "read line";
              `String "\u{FFFD}\u{FFFD}";
            ]))

let string_field name stdout_text =
  match Yojson.Safe.from_string stdout_text with
  | `Assoc fields -> (
      match List.assoc_opt name fields with
      | Some (`String text) -> text
      | _ -> Alcotest.fail ("no string field " ^ name))
  | _ -> Alcotest.fail "not an object"

(* The machine decides: the exit code and JSON must match what the library
   says for the same feature here (0 and available, or 78 and unavailable). *)
let check_require feature () =
  let name = Mesh_platform.feature_name feature in
  let status, stdout_text, stderr_text =
    run [| "mesh-platform"; "require"; name |]
  in
  Alcotest.(check string) "feature" name (string_field "feature" stdout_text);
  match Mesh_platform.require feature with
  | Ok () ->
      Alcotest.(check bool) "exit 0" true (status = Unix.WEXITED 0);
      Alcotest.(check bool)
        "available" true
        (Yojson.Safe.from_string stdout_text
        = `Assoc [ ("feature", `String name); ("available", `Bool true) ]);
      Alcotest.(check string) "silent" "" stderr_text
  | Error message ->
      Alcotest.(check bool) "exit 78" true (status = Unix.WEXITED 78);
      Alcotest.(check string) "kind" "unavailable" (kind_of stdout_text);
      Alcotest.(check string) "error" message (string_field "error" stdout_text);
      Alcotest.(check string) "stderr" (message ^ "\n") stderr_text

let test_require_unknown_feature () =
  let status, stdout_text, stderr_text =
    run [| "mesh-platform"; "require"; "no-such-feature" |]
  in
  Alcotest.(check bool) "exit 2" true (status = Unix.WEXITED 2);
  Alcotest.(check string) "no stdout" "" stdout_text;
  Alcotest.(check bool) "usage" true (String.length stderr_text > 0)

let test_require_without_feature () =
  let status, _, _ = run [| "mesh-platform"; "require" |] in
  Alcotest.(check bool) "exit 2" true (status = Unix.WEXITED 2)

(* Where the child's stdout goes. Every sink but [Piped] makes writing fail. *)
type sink =
  | Piped  (** a pipe that is read: writing succeeds *)
  | Closed  (** no descriptor 1: EBADF *)
  | Full  (** /dev/full: ENOSPC *)
  | Nonblocking_full  (** a full pipe in non-blocking mode: EAGAIN *)
  | Broken_pipe  (** a pipe without reader, SIGPIPE ignored: EPIPE *)

let sink_name = function
  | Piped -> "piped"
  | Closed -> "closed"
  | Full -> "/dev/full"
  | Nonblocking_full -> "full non-blocking pipe"
  | Broken_pipe -> "pipe without reader"

(* /dev/full is a Linux device; elsewhere (macOS) the Full cases are not built. *)
let dev_full_exists =
  match Unix.stat "/dev/full" with
  | { Unix.st_kind = Unix.S_CHR; _ } -> true
  | _ -> false
  | exception Unix.Unix_error _ -> false

let failing_sinks =
  List.filter
    (fun sink -> sink <> Full || dev_full_exists)
    [ Closed; Full; Nonblocking_full; Broken_pipe ]

let redirection = function
  | Closed -> " >&-"
  | Full -> " >/dev/full"
  | Piped | Nonblocking_full | Broken_pipe -> ""

let rec fill descriptor chunk =
  match Unix.single_write descriptor chunk 0 (Bytes.length chunk) with
  | _ -> fill descriptor chunk
  | exception Unix.Unix_error ((Unix.EAGAIN | Unix.EWOULDBLOCK), _, _) -> ()

(* A pipe whose non-blocking write end accepts no more byte: filled by pages,
   then byte by byte. O_NONBLOCK belongs to the open file description, so the
   child inherits it with the descriptor. *)
let full_nonblocking_pipe () =
  let read_end, write_end = Unix.pipe ~cloexec:true () in
  Unix.set_nonblock write_end;
  fill write_end (Bytes.make 4096 'x');
  fill write_end (Bytes.make 1 'x');
  (read_end, write_end)

(* The child's stdout for [sink], the descriptor to read its output from (if
   it can be read) and the descriptors to keep open until the child exits. *)
let open_sink sink =
  match sink with
  | Piped | Closed | Full ->
      let read_end, write_end = Unix.pipe ~cloexec:true () in
      (write_end, Some read_end, [])
  | Nonblocking_full ->
      let read_end, write_end = full_nonblocking_pipe () in
      (write_end, None, [ read_end ])
  | Broken_pipe ->
      let read_end, write_end = Unix.pipe ~cloexec:true () in
      Unix.close read_end;
      (write_end, None, [])

(* The child inherits the ignored SIGPIPE, also through [unshare] and [sh]:
   writing to a pipe without reader then fails with EPIPE instead of killing
   it. *)
let ignoring_sigpipe spawn =
  let previous = Sys.signal Sys.sigpipe Sys.Signal_ignore in
  Fun.protect ~finally:(fun () -> Sys.set_signal Sys.sigpipe previous) spawn

(* Run [argv] through [sh -c script exe args...] ([unshare -rm] first when
   [namespace]) with stdout on [sink]; [script] must end with the command that
   writes to stdout. Return (exit status, stdout, stderr); stdout is "" for a
   sink that cannot be read. *)
let run_shell ?(sink = Piped) ~namespace ~script argv =
  let child_stdout, readable, held = open_sink sink in
  let err_read, err_write = Unix.pipe ~cloexec:true () in
  let script = script ^ redirection sink in
  let words = [ "sh"; "-c"; script; exe ] @ List.tl (Array.to_list argv) in
  let words = if namespace then "unshare" :: "-rm" :: words else words in
  let spawn () =
    Unix.create_process (List.hd words) (Array.of_list words) Unix.stdin
      child_stdout err_write
  in
  let child =
    Fun.protect
      ~finally:(fun () ->
        Unix.close child_stdout;
        Unix.close err_write)
      (if sink = Broken_pipe then fun () -> ignoring_sigpipe spawn else spawn)
  in
  let stdout_text = Option.fold ~none:"" ~some:read_all readable in
  let stderr_text = read_all err_read in
  let _, status = Unix.waitpid [] child in
  List.iter Unix.close held;
  (status, stdout_text, stderr_text)

let exec_cli = "exec \"$0\" \"$@\""

(* Bind /dev/null over [path] (when it exists) so that the executable there
   looks present but is not a regular file. *)
let shadow path =
  Printf.sprintf "if [ -e %s ]; then mount --bind /dev/null %s || exit 125; fi"
    path path

let probe_marker = "mesh-shadow-ok"

let status_text = function
  | Unix.WEXITED code -> Printf.sprintf "exit %d" code
  | Unix.WSIGNALED signal -> Printf.sprintf "signal %d" signal
  | Unix.WSTOPPED signal -> Printf.sprintf "stopped by signal %d" signal

(* The shadowed tests need a user and mount namespace, which a machine may
   refuse in several ways ([unshare] absent, or exit 1 where user namespaces
   are restricted). So the probe is positive: [Ok] only when the shadow script
   ran to its end in the namespace, left [path] not a regular file and printed
   the marker; anything else is a reason to skip. *)
let probe_shadow path =
  let script =
    Printf.sprintf "%s; [ ! -f %s ] && echo %s" (shadow path) path probe_marker
  in
  match run_shell ~namespace:true ~script [| "probe" |] with
  | exception Unix.Unix_error (error, call, _) ->
      Error (Printf.sprintf "%s: %s" call (Unix.error_message error))
  | Unix.WEXITED 0, stdout_text, _ when stdout_text = probe_marker ^ "\n" ->
      Ok ()
  | status, stdout_text, stderr_text ->
      Error
        (Printf.sprintf "probe gave %s, stdout %S, stderr %S"
           (status_text status) stdout_text stderr_text)

let linux_message feature =
  let capabilities =
    {
      Mesh_platform.process_table = true;
      foreground_agent = true;
      open_file_paths = true;
      isolated_agent = false;
      demo_sandbox = false;
    }
  in
  match
    Mesh_platform.For_testing.require_on ~platform:Mesh_platform.Linux
      ~capabilities feature
  with
  | Error message -> message
  | Ok () -> Alcotest.fail "expected a refusal"

(* [probe] is the result of [probe_shadow path], computed once per path. *)
let check_shadowed_refusal ~probe ~path feature ~sink () =
  if Result.is_error probe then Alcotest.skip ();
  let name = Mesh_platform.feature_name feature in
  let status, stdout_text, stderr_text =
    run_shell ~sink ~namespace:true
      ~script:(shadow path ^ "; " ^ exec_cli)
      [| "mesh-platform"; "require"; name |]
  in
  let message = linux_message feature in
  Alcotest.(check string) "status" "exit 78" (status_text status);
  Alcotest.(check string) "stderr" (message ^ "\n") stderr_text;
  if sink <> Piped then Alcotest.(check string) "no stdout" "" stdout_text
  else
    Alcotest.(check bool)
      "not available" true
      (Yojson.Safe.from_string stdout_text
      = `Assoc
          [
            ("kind", `String "unavailable");
            ("feature", `String name);
            ("available", `Bool false);
            ("error", `String message);
          ])

(* Success stays 0 and a platform error stays 1 whatever stdout does. *)
let check_code_with_failing_stdout ~sink ~expected argv () =
  let status, stdout_text, stderr_text =
    run_shell ~sink ~namespace:false ~script:exec_cli argv
  in
  Alcotest.(check string)
    "status"
    (status_text (Unix.WEXITED expected))
    (status_text status);
  Alcotest.(check string) "no stdout" "" stdout_text;
  Alcotest.(check string) "silent" "" stderr_text

let failing_stdout_cases =
  List.concat_map
    (fun sink ->
      List.map
        (fun (label, expected, argv) ->
          Alcotest.test_case
            (Printf.sprintf "%s keeps exit %d, stdout: %s" label expected
               (sink_name sink))
            `Quick
            (check_code_with_failing_stdout ~sink ~expected argv))
        [
          ("capabilities", 0, [| "mesh-platform"; "capabilities" |]);
          ("process error", 1, [| "mesh-platform"; "process"; "999999999" |]);
        ])
    failing_sinks

(* The probe runs here, before Alcotest captures the output, so that the
   reason for skipping is visible in the test run. *)
let shadowed_cases_for (path, feature) =
  let probe = probe_shadow path in
  Result.iter_error
    (Printf.eprintf "test_cli: skipping the tests that shadow %s: %s\n%!" path)
    probe;
  List.map
    (fun sink ->
      Alcotest.test_case
        (Printf.sprintf "%s refused when %s is shadowed, stdout: %s"
           (Mesh_platform.feature_name feature)
           path (sink_name sink))
        `Quick
        (check_shadowed_refusal ~probe ~path feature ~sink))
    (Piped :: failing_sinks)

(* Only Linux has these executables. *)
let shadowed_cases =
  if Mesh_platform.platform <> Mesh_platform.Linux then []
  else
    List.concat_map shadowed_cases_for
      [
        ("/usr/bin/setpriv", Mesh_platform.Isolated_agent);
        ("/usr/bin/bwrap", Mesh_platform.Demo_sandbox);
      ]

let tests =
  [
    Alcotest.test_case "require isolated-agent" `Quick
      (check_require Mesh_platform.Isolated_agent);
    Alcotest.test_case "require demo-sandbox" `Quick
      (check_require Mesh_platform.Demo_sandbox);
    Alcotest.test_case "require unknown feature is a usage error" `Quick
      test_require_unknown_feature;
    Alcotest.test_case "require without feature is a usage error" `Quick
      test_require_without_feature;
    Alcotest.test_case "empty argv is a usage error" `Quick
      test_empty_argv_is_usage_error;
    Alcotest.test_case "runtime_dir error kind" `Quick test_runtime_dir_kind;
    Alcotest.test_case "not_found error kind" `Quick test_not_found_kind;
    Alcotest.test_case "pid must be decimal digits" `Quick test_pid_is_decimal;
    Alcotest.test_case "invalid UTF-8 is replaced" `Quick
      test_invalid_utf_8_is_replaced;
  ]
  @ failing_stdout_cases @ shadowed_cases
