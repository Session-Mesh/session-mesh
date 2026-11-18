(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(* mesh-logout-all against a fake one-shot mesh: an answer other than 2xx is
   fatal and never touches the generation file; only a mesh that sends not one
   byte of an answer leads to the disk. *)

open Fake_mesh

(* A fatal answer: exit 1, one message on stderr, the file as it was. *)
let check_fatal ~expected behaviour () =
  with_conf (fun conf ->
      let result, request = with_mesh behaviour (fun port -> run conf port) in
      Alcotest.(check int) "exit" 1 result.code;
      Alcotest.(check (list string)) "stderr" [ expected ] result.err;
      Alcotest.(check (list string)) "stdout" [] result.out;
      Alcotest.(check string)
        "file unchanged" "5\n"
        (contents (generation_file conf));
      Alcotest.(check bool) "request sent" true (request <> "");
      check_no_token result)

let refusal status expected =
  Alcotest.test_case status `Quick
    (check_fatal
       ~expected:("mesh-logout-all: the mesh refused (" ^ expected ^ ")")
       (Answer (http status ~headers:"Location: http://localhost:9/x\r\n" "{}")))

let test_request_shape () =
  with_conf (fun conf ->
      let result, request =
        with_mesh
          (Answer (http "200 OK" {|{"ok":true,"generation":7}|}))
          (fun port -> run conf port)
      in
      Alcotest.(check int) "exit" 0 result.code;
      Alcotest.(check (list string))
        "stdout"
        [ "All devices are signed out (generation 7)." ]
        result.out;
      Alcotest.(check (list string)) "stderr" [] result.err;
      Alcotest.(check string)
        "file untouched" "5\n"
        (contents (generation_file conf));
      let lowered = String.lowercase_ascii request in
      Alcotest.(check bool)
        "POST /api/logout-all" true
        (String.starts_with ~prefix:"POST /api/logout-all HTTP/1.1\r\n" request);
      Alcotest.(check bool)
        "Bearer token" true
        (contains request ("authorization: Bearer " ^ token ^ "\r\n"));
      Alcotest.(check bool)
        "Content-Length: 0" true
        (contains lowered "content-length: 0\r\n");
      Alcotest.(check bool) "not chunked" false (contains lowered "chunked"))

let check_fallback ?timeout behaviour () =
  with_conf (fun conf ->
      let result, _ =
        with_mesh behaviour (fun port -> run ?timeout conf port)
      in
      Alcotest.(check int) "exit" 0 result.code;
      Alcotest.(check (list string))
        "stdout"
        [
          "The mesh is not responding: generation raised on disk (6). All \
           devices are signed out.";
        ]
        result.out;
      Alcotest.(check string) "raised" "6\n" (contents (generation_file conf)))

let test_chunked_body () =
  with_conf (fun conf ->
      let result, _ =
        with_mesh
          (Answer
             "HTTP/1.1 200 OK\r\n\
              Transfer-Encoding: chunked\r\n\
              \r\n\
              6\r\n\
              {\"gene\r\n\
              a;ext=1\r\n\
              ration\":8}\r\n\
              0\r\n\
              \r\n") (fun port -> run conf port)
      in
      Alcotest.(check int) "exit" 0 result.code;
      Alcotest.(check (list string))
        "stdout"
        [ "All devices are signed out (generation 8)." ]
        result.out)

(* The most this process may ever have held, flood cases included: far above
   what the tests need, far below what an unbounded read reaches in a second. *)
let memory_bound = 64 * 1024 * 1024

let check_memory () =
  let peak = (Gc.quick_stat ()).Gc.top_heap_words * (Sys.word_size / 8) in
  Alcotest.(check bool)
    (Printf.sprintf "peak heap bounded (%d bytes)" peak)
    true (peak < memory_bound)

(* Something answered, not with a readable HTTP/1.x response: exit 1 with one
   line, the file as it was, no disk fallback, bounded memory, and an end
   between [at_least] and [within] seconds: by default no wait for the
   deadline, even though the listener keeps the connection open or never stops
   sending. *)
let check_unreadable ?timeout ?(at_least = 0.) ?(within = 3.) ~detail behaviour
    () =
  with_conf (fun conf ->
      let started = Unix.gettimeofday () in
      let result, request =
        with_mesh behaviour (fun port -> run ?timeout conf port)
      in
      let elapsed = Unix.gettimeofday () -. started in
      Alcotest.(check int) "exit" 1 result.code;
      Alcotest.(check (list string))
        "stderr"
        [
          "mesh-logout-all: the mesh gave an unreadable answer (" ^ detail ^ ")";
        ]
        result.err;
      Alcotest.(check (list string)) "stdout" [] result.out;
      Alcotest.(check string)
        "file unchanged" "5\n"
        (contents (generation_file conf));
      Alcotest.(check bool) "request sent" true (request <> "");
      Alcotest.(check bool)
        (Printf.sprintf "ended in time (%.2f s)" elapsed)
        true
        (elapsed >= at_least && elapsed < within);
      check_memory ();
      check_no_token result)

let too_long = "a line of the answer is too long"
let too_many = "too many header lines"
let too_large = "the answer is too large"
let chunked_200 = "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n"

(* A listener that never stops sending: the answer is unreadable as soon as a
   limit is crossed, before the deadline. The deadline is short so that a
   reader without the limit fails here on the message, the time and the peak
   heap instead of exhausting the machine. *)
let flood name ~detail prefix again =
  Alcotest.test_case name `Quick
    (check_unreadable ~timeout:2. ~within:1.5 ~detail (Flood (prefix, again)))

(* Nothing the reader bounds is crossed here (each chunk is one byte, each
   chunk-size line under the limit), so only the deadline ends it, and it does
   although bytes never stop arriving. *)
let test_deadline_under_flood =
  check_unreadable ~timeout:1. ~at_least:1. ~within:2.5
    ~detail:"the answer was not complete within 1 s"
    (Flood (chunked_200, "1;" ^ String.make 60000 'e' ^ "\r\nx\r\n"))

(* An answer that began and then stops: never the disk fallback. *)
let begun name ?(detail = "the answer was not complete within 0.5 s") behaviour
    =
  Alcotest.test_case name `Quick
    (check_unreadable ~timeout:0.5 ~within:2. ~detail behaviour)

(* A body of exactly 1 MiB is read; one byte more is refused. *)
let test_largest_body () =
  with_conf (fun conf ->
      let padding = String.make ((1 lsl 20) - 16) ' ' in
      let result, _ =
        with_mesh
          (Answer (http "200 OK" ({|{"generation":9|} ^ padding ^ "}")))
          (fun port -> run conf port)
      in
      Alcotest.(check (list string)) "stderr" [] result.err;
      Alcotest.(check (list string))
        "stdout"
        [ "All devices are signed out (generation 9)." ]
        result.out)

let test_interim_answer () =
  with_conf (fun conf ->
      let result, _ =
        with_mesh
          (Answer
             ("HTTP/1.1 100 Continue\r\nX-A: b\r\n\r\n"
             ^ http "200 OK" {|{"generation":7}|}))
          (fun port -> run conf port)
      in
      Alcotest.(check (list string))
        "stdout"
        [ "All devices are signed out (generation 7)." ]
        result.out)

let unreadable status_line =
  Alcotest.test_case status_line `Quick
    (check_unreadable ~detail:"malformed status line"
       (Answer_then_stall (status_line ^ "\r\nContent-Length: 2\r\n\r\n{}")))

(* [count] more descriptors open, with [true]; when the limit on descriptors
   comes first, none is kept and the answer is [false]. *)
let hold_descriptors count =
  let null = Unix.openfile "/dev/null" [ Unix.O_RDONLY; Unix.O_CLOEXEC ] 0 in
  let rec hold held count =
    if count = 0 then (held, true)
    else
      match Unix.dup ~cloexec:true null with
      | descriptor -> hold (descriptor :: held) (count - 1)
      | exception Unix.Unix_error ((Unix.EMFILE | Unix.ENFILE), _, _) ->
          List.iter Unix.close held;
          ([], false)
  in
  let held, complete = hold [] count in
  (null :: held, complete)

(* With 1100 descriptors held, the socket's number is above FD_SETSIZE (1024),
   where [select] refuses it: the mesh is still asked and answers. Skipped
   where the limit on descriptors is too low to get there. *)
let test_many_descriptors () =
  with_conf (fun conf ->
      let result, request =
        with_mesh
          (Answer (http "200 OK" {|{"generation":42}|}))
          (fun port ->
            let held, complete = hold_descriptors 1100 in
            Fun.protect
              ~finally:(fun () -> List.iter Unix.close held)
              (fun () ->
                if not complete then Alcotest.skip ();
                run conf port))
      in
      Alcotest.(check (list string)) "stderr" [] result.err;
      Alcotest.(check (list string))
        "stdout"
        [ "All devices are signed out (generation 42)." ]
        result.out;
      Alcotest.(check bool) "request sent" true (request <> "");
      Alcotest.(check string)
        "file unchanged" "5\n"
        (contents (generation_file conf)))

(* The wall clock set back an hour 0.2 s after the start: a silent mesh, or one
   that stops after a status line, still ends the exchange after [timeout]
   seconds, not an hour later. The jump is timed from the first reading of the
   clock, and the exchange must have read it on both sides of the jump. *)
let check_clock_set_back behaviour expected () =
  let start = Unix.gettimeofday () in
  let first = ref None and before = ref false and after = ref false in
  let clock () =
    let now = Unix.gettimeofday () in
    let origin = Option.value !first ~default:now in
    first := Some origin;
    if now -. origin > 0.2 then (
      after := true;
      now -. 3600.)
    else (
      before := true;
      now)
  in
  let authorization = Result.get_ok (Mesh_local_http.bearer token) in
  let outcome, _ =
    with_mesh behaviour (fun port ->
        let getenv _ = Some (string_of_int port) in
        Mesh_local_http.post ~timeout:1. ~clock
          ~port:(Result.get_ok (Mesh_paths.port getenv))
          ~route:"/api/logout-all" authorization ())
  in
  let elapsed = Unix.gettimeofday () -. start in
  Alcotest.(check (pair bool bool))
    "clock read before and after the jump" (true, true) (!before, !after);
  Alcotest.(check bool)
    "outcome" true
    (match (outcome, expected) with
    | No_answer _, `No_answer | Unreadable _, `Unreadable -> true
    | _ -> false);
  Alcotest.(check bool)
    (Printf.sprintf "ended after the timeout (%.2f s)" elapsed)
    true
    (elapsed >= 1. && elapsed < 2.)

let test_closed_port () =
  with_conf (fun conf ->
      let result = run conf (closed_port ()) in
      Alcotest.(check int) "exit" 0 result.code;
      Alcotest.(check (list string)) "stderr" [] result.err;
      Alcotest.(check string) "raised" "6\n" (contents (generation_file conf)))

let test_control_character () =
  with_conf (fun conf ->
      write_file (Filename.concat conf "token") "the-master\001token\n";
      let result = run conf (closed_port ()) in
      Alcotest.(check int) "exit" 1 result.code;
      Alcotest.(check (list string))
        "stderr"
        [ "mesh-logout-all: the token holds a control character" ]
        result.err;
      Alcotest.(check string)
        "file unchanged" "5\n"
        (contents (generation_file conf)))

let test_arguments () =
  with_conf (fun conf ->
      let result, request =
        with_mesh Close (fun port ->
            run ~timeout:1. ~args:[ "--help" ] conf port)
      in
      Alcotest.(check int) "exit" 1 result.code;
      Alcotest.(check (list string))
        "usage" [ Mesh_logout_all.usage ] result.err;
      Alcotest.(check string) "nothing sent" "" request;
      Alcotest.(check string)
        "file unchanged" "5\n"
        (contents (generation_file conf)))

let test_unreadable_token_before_port () =
  with_conf (fun conf ->
      Unix.unlink (Filename.concat conf "token");
      let result = run ~extra:[ ("MESH_PORT", "0x1E5A") ] conf 1 in
      Alcotest.(check int) "exit" 1 result.code;
      Alcotest.(check (list string))
        "the token is checked first"
        [
          Printf.sprintf
            "mesh-logout-all: unreadable token (%s/token: No such file or \
             directory)"
            conf;
        ]
        result.err)

let test_relative_conf () =
  with_conf (fun conf ->
      let result = run ~extra:[ ("MESH_CONF_DIR", "conf") ] conf 1 in
      Alcotest.(check int) "exit" 1 result.code;
      Alcotest.(check (list string))
        "meshpaths message"
        [ "session-mesh: MESH_CONF_DIR must be an absolute path (got 'conf')" ]
        result.err)

let test_malformed_port () =
  with_conf (fun conf ->
      let result = run ~extra:[ ("MESH_PORT", "7_690") ] conf 1 in
      Alcotest.(check int) "exit" 1 result.code;
      Alcotest.(check string)
        "file unchanged" "5\n"
        (contents (generation_file conf)))

let refused =
  ( "refused",
    [
      refusal "401 Unauthorized" "401 Unauthorized";
      refusal "403 Forbidden" "403 Forbidden";
      refusal "404 Not Found" "404 Not Found";
      refusal "500 Internal Server Error" "500 Internal Server Error";
      refusal "301 Moved Permanently" "301 redirect refused";
      refusal "303 See Other" "303 redirect refused";
      refusal "307 Temporary Redirect" "307 redirect refused";
      refusal "308 Permanent Redirect" "308 redirect refused";
      Alcotest.test_case "2xx without generation" `Quick
        (check_fatal
           ~expected:"mesh-logout-all: the mesh answered without a generation"
           (Answer (http "200 OK" {|{"ok":true}|})));
      Alcotest.test_case "2xx not JSON" `Quick
        (check_fatal
           ~expected:
             "mesh-logout-all: the mesh answered with something other than JSON"
           (Answer (http "200 OK" "<html>")));
    ] )

let answered =
  ( "answered",
    [
      Alcotest.test_case "request and success" `Quick test_request_shape;
      Alcotest.test_case "chunked body" `Quick test_chunked_body;
      Alcotest.test_case "a body of exactly 1 MiB" `Quick test_largest_body;
      Alcotest.test_case "a socket above FD_SETSIZE" `Quick
        test_many_descriptors;
      Alcotest.test_case "100 Continue first" `Quick test_interim_answer;
    ] )

let unreadable_answers =
  ( "unreadable",
    [
      unreadable "HTTP/1.1 abc Weird";
      unreadable ("HELLO " ^ token);
      unreadable "HTTP/2 200 OK";
      unreadable "HTTP/1.1 42 Low";
      Alcotest.test_case "2xx body cut short" `Quick
        (check_unreadable ~detail:"the answer ended early"
           (Answer "HTTP/1.1 200 OK\r\nContent-Length: 50\r\n\r\n{\"gen"));
    ] )

let floods =
  ( "flood",
    [
      flood "endless status line" ~detail:too_long "HTTP/1.1 200 "
        (String.make 65536 'a');
      flood "endless header line" ~detail:too_long "HTTP/1.1 200 OK\r\nX: "
        (String.make 65536 'a');
      flood "endless headers" ~detail:too_many "HTTP/1.1 200 OK\r\n"
        "X-A: b\r\n";
      flood "endless chunk-size line" ~detail:too_long chunked_200
        (String.make 65536 '0');
      flood "200, endless lines without a colon" ~detail:too_many
        "HTTP/1.1 200 OK\r\n" "no colon here\r\n";
      flood "401, endless lines without a colon" ~detail:too_many
        "HTTP/1.1 401 Unauthorized\r\n" "no colon here\r\n";
      flood "endless trailers" ~detail:too_many (chunked_200 ^ "0\r\n")
        "X-A: b\r\n";
      flood "endless 100 Continue" ~detail:"too many interim answers" ""
        "HTTP/1.1 100 Continue\r\n\r\n";
      Alcotest.test_case "endless chunk extensions: the deadline" `Quick
        test_deadline_under_flood;
    ] )

let too_large_answers =
  ( "too large",
    [
      flood "endless body" ~detail:too_large "HTTP/1.1 200 OK\r\n\r\n"
        (String.make 65536 ' ');
      flood "endless chunks" ~detail:too_large chunked_200
        ("1000\r\n" ^ String.make 4096 ' ' ^ "\r\n");
      Alcotest.test_case "Content-Length one byte past 1 MiB" `Quick
        (check_unreadable ~detail:too_large
           (Answer_then_stall
              "HTTP/1.1 200 OK\r\nContent-Length: 1048577\r\n\r\n{"));
    ] )

let begun_answers =
  ( "answer begun, then nothing",
    [
      begun "401 status line, then silence"
        (Answer_then_stall "HTTP/1.1 401 Unauthorized\r\n");
      begun "part of a status line, then silence" (Answer_then_stall "HTT");
      begun "200 and part of the body, then silence"
        (Answer_then_stall "HTTP/1.1 200 OK\r\nContent-Length: 50\r\n\r\n{\"gen");
      begun "401 status line, then a reset"
        ~detail:"the connection failed during the answer"
        (Answer_then_reset "HTTP/1.1 401 Unauthorized\r\n");
      Alcotest.test_case "401 status line, then silence; clock set back" `Quick
        (check_clock_set_back
           (Answer_then_stall "HTTP/1.1 401 Unauthorized\r\n") `Unreadable);
      Alcotest.test_case "100 Continue, then the end" `Quick
        (check_unreadable ~detail:"the answer ended early"
           (Answer "HTTP/1.1 100 Continue\r\n\r\n"));
      Alcotest.test_case "401 status line, then the end" `Quick
        (check_fatal
           ~expected:"mesh-logout-all: the mesh refused (401 Unauthorized)"
           (Answer "HTTP/1.1 401 Unauthorized\r\n"));
    ] )

let no_answer =
  ( "no answer",
    [
      Alcotest.test_case "closed port" `Quick test_closed_port;
      Alcotest.test_case "closed without answer" `Quick (check_fallback Close);
      Alcotest.test_case "stalled before the answer" `Quick
        (check_fallback ~timeout:0.5 Stall);
      Alcotest.test_case "stalled, clock set back" `Quick
        (check_clock_set_back Stall `No_answer);
      Alcotest.test_case "reset without answer" `Quick (check_fallback Reset);
    ] )

let start_up =
  ( "start-up",
    [
      Alcotest.test_case "arguments" `Quick test_arguments;
      Alcotest.test_case "token before port" `Quick
        test_unreadable_token_before_port;
      Alcotest.test_case "relative MESH_CONF_DIR" `Quick test_relative_conf;
      Alcotest.test_case "malformed MESH_PORT" `Quick test_malformed_port;
      Alcotest.test_case "control character in the token" `Quick
        test_control_character;
    ] )

let () =
  Alcotest.run "mesh_logout_all"
    [
      refused;
      answered;
      unreadable_answers;
      floods;
      too_large_answers;
      begun_answers;
      no_answer;
      start_up;
    ]
