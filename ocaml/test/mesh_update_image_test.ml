(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(* mesh-platform update-image (the URLs: mesh_update_image_url_test.ml): the
   notes, the pinned connection, redirects checked hop by hop, type, magic
   bytes and size, and the budget. No test reaches the network: names resolve
   through a table and curl is a recording fake. *)

module I = Mesh_update_image
module U = Mesh_update_image_url

let at = "@" (* apart: see mesh_update_image_url_test.ml *)
let address = Unix.inet_addr_of_string
let github = address "140.82.112.3"
let images = address "185.199.108.133"
let png = "\x89PNG\r\n\x1a\n" ^ String.make 16 'x'

(* A resolver from a table; the names it was asked, in order. *)
let resolver table =
  let asked = ref [] in
  ( (fun host ->
      asked := host :: !asked;
      Option.value ~default:[] (List.assoc_opt host table)),
    fun () -> List.rev !asked )

let default_table =
  [
    ("github.com", [ github ]);
    ("private-user-images.githubusercontent.com", [ images ]);
    ("raw.githubusercontent.com", [ address "10.0.0.7" ]);
    ("mixed.githubusercontent.com", [ images; address "127.0.0.1" ]);
    ("objects.githubusercontent.com", [ address "::ffff:127.0.0.1" ]);
  ]

(* curl's -D - -o - output for one response. *)
let response ?(status = "HTTP/2 200") headers body =
  String.concat "" (List.map (fun line -> line ^ "\r\n") (status :: headers))
  ^ "\r\n" ^ body

(* A curl that answers [answers] in turn and records each argument list. *)
let transport answers =
  let queue = ref answers and calls = ref [] in
  ( (fun arguments ->
      calls := arguments :: !calls;
      match !queue with
      | (code, output) :: rest ->
          queue := rest;
          (Unix.WEXITED code, output)
      | [] -> (Unix.WEXITED 7, "")),
    fun () -> List.rev !calls )

let parse text = Option.get (U.image_url text)

let fetch ?(table = default_table) ?stand_ins answers text =
  let resolve, asked = resolver table in
  let transport, calls = transport answers in
  let answer =
    I.fetch ~resolve ~transport ~stand_ins ~clock:Unix.gettimeofday (parse text)
  in
  (answer, calls (), asked ())

let ok_png = (0, response [ "content-type: image/png" ] png)
let status = Alcotest.(check int)

(* The value after [flag] in an argument list. *)
let after flag arguments =
  let rec go = function
    | name :: value :: _ when name = flag -> Some value
    | _ :: rest -> go rest
    | [] -> None
  in
  go arguments

(* ---- the request *)

let test_pinned_connection () =
  let answer, calls, asked =
    fetch [ ok_png ] "https://github.com/user-attachments/assets/ok"
  in
  status "fetched" 200 answer.status;
  Alcotest.(check string) "bytes" png answer.body;
  Alcotest.(check (list string)) "one lookup" [ "github.com" ] asked;
  let arguments = List.hd calls in
  Alcotest.(check (option string))
    "pinned to the checked address" (Some "github.com:443:140.82.112.3")
    (after "--resolve" arguments);
  Alcotest.(check (list string))
    "curl -q first" [ "curl"; "-q" ]
    (List.filteri (fun index _ -> index < 2) arguments);
  Alcotest.(check (option string))
    "https only" (Some "=https")
    (after "--proto" arguments);
  Alcotest.(check (option string))
    "no proxy" (Some "*")
    (after "--noproxy" arguments);
  Alcotest.(check (option string))
    "curl follows nothing" (Some "0")
    (after "--max-redirs" arguments);
  Alcotest.(check (option string))
    "fixed User-Agent" (Some "session-mesh-update-check") (after "-A" arguments);
  Alcotest.(check (option string))
    "size limit" (Some "5242880")
    (after "--max-filesize" arguments);
  Alcotest.(check bool) "no globbing" true (List.mem "--globoff" arguments);
  Alcotest.(check bool)
    "no cookie or credential" false
    (List.exists
       (fun a ->
         List.mem a
           [
             "-b";
             "--cookie";
             "-u";
             "--user";
             "--netrc";
             "-n";
             "-L";
             "--location";
           ])
       arguments);
  Alcotest.(check string)
    "the URL last" "https://github.com/user-attachments/assets/ok"
    (List.nth arguments (List.length arguments - 1))

let test_ipv6_pin () =
  let table = [ ("github.com", [ address "2606:50c0:8000::153" ]) ] in
  let _, calls, _ = fetch ~table [ ok_png ] "https://github.com/x" in
  Alcotest.(check (option string))
    "bracketed" (Some "github.com:443:[2606:50c0:8000::153]")
    (after "--resolve" (List.hd calls))

let test_private_after_dns () =
  List.iter
    (fun host ->
      let answer, calls, _ = fetch [ ok_png ] ("https://" ^ host ^ "/x") in
      status host 502 answer.status;
      Alcotest.(check int) (host ^ ": no connection") 0 (List.length calls))
    [
      "raw.githubusercontent.com";
      "mixed.githubusercontent.com";
      "objects.githubusercontent.com";
      "unknown.githubusercontent.com";
    ]

let redirect location =
  (0, response ~status:"HTTP/1.1 302 Found" [ "Location: " ^ location ] "")

let test_redirect_followed_and_rechecked () =
  let answer, calls, asked =
    fetch
      [
        redirect
          "https://private-user-images.githubusercontent.com/signed.png?jwt=x";
        ok_png;
      ]
      "https://github.com/moved"
  in
  status "followed" 200 answer.status;
  Alcotest.(check (list string))
    "each hop resolved"
    [ "github.com"; "private-user-images.githubusercontent.com" ]
    asked;
  Alcotest.(check (option string))
    "second hop pinned to its own address"
    (Some "private-user-images.githubusercontent.com:443:185.199.108.133")
    (after "--resolve" (List.nth calls 1))

let test_redirect_refused () =
  List.iter
    (fun (name, location) ->
      let answer, calls, _ =
        fetch [ redirect location; ok_png ] "https://github.com/x"
      in
      status name 502 answer.status;
      Alcotest.(check int) (name ^ ": not followed") 1 (List.length calls))
    [
      ("another host", "https://example.com/x.png");
      ("plain http", "http://github.com/x");
      ("a private address", "https://raw.githubusercontent.com/x");
      ("a mapped loopback", "https://objects.githubusercontent.com/x");
      ("userinfo", "https://u" ^ at ^ "github.com/x");
      ("empty", "");
    ];
  let answer, calls, _ =
    fetch
      [ (0, response ~status:"HTTP/1.1 301 Moved" [] "") ]
      "https://github.com/x"
  in
  status "no Location" 502 answer.status;
  Alcotest.(check int) "one request" 1 (List.length calls)

let test_redirect_limit () =
  let loop = redirect "/x" in
  let answer, calls, _ =
    fetch [ loop; loop; loop; loop; ok_png ] "https://github.com/x"
  in
  status "loop" 502 answer.status;
  Alcotest.(check int) "four requests: three redirects" 4 (List.length calls);
  let answer, _, _ =
    fetch [ loop; loop; loop; ok_png ] "https://github.com/x"
  in
  status "three redirects are allowed" 200 answer.status

(* ---- the content *)

let test_types_and_magic () =
  let case name expected kind body =
    let answer, _, _ =
      fetch
        [ (0, response [ "Content-Type: " ^ kind ] body) ]
        "https://github.com/x"
    in
    status name expected answer.status;
    if expected = 200 then
      Alcotest.(check string)
        (name ^ ": type")
        (String.lowercase_ascii (List.hd (String.split_on_char ';' kind)))
        answer.content_type
  in
  case "png" 200 "image/png" png;
  case "png with parameters" 200 "Image/PNG; charset=binary" png;
  case "jpeg" 200 "image/jpeg" "\xff\xd8\xff\xe0rest";
  case "gif" 200 "image/gif" "GIF89a....";
  case "gif87" 200 "image/gif" "GIF87a....";
  case "webp" 200 "image/webp" "RIFF\x00\x00\x00\x00WEBPVP8 ";
  case "svg never" 415 "image/svg+xml"
    "<svg xmlns=\"http://www.w3.org/2000/svg\"><script>alert(1)</script></svg>";
  case "html" 415 "text/html" "<script>alert(1)</script>";
  case "no type" 415 "" png;
  case "html labelled png" 502 "image/png" "<html><script>alert(1)</script>";
  case "png labelled jpeg" 502 "image/jpeg" png;
  case "RIFF that is not WebP" 502 "image/webp" "RIFF\x00\x00\x00\x00WAVEfmt ";
  case "empty" 502 "image/png" ""

let test_size () =
  let huge = png ^ String.make I.size_limit '\000' in
  let answer, _, _ =
    fetch
      [ (0, response [ "Content-Type: image/png" ] huge) ]
      "https://github.com/x"
  in
  status "streamed over the limit" 413 answer.status;
  let answer, _, _ =
    fetch
      [
        ( 63,
          response [ "Content-Type: image/png"; "Content-Length: 6291456" ] ""
        );
      ]
      "https://github.com/x"
  in
  status "declared over the limit" 413 answer.status;
  let answer, _, _ =
    fetch
      [ (63, response [ "Content-Type: image/png" ] png) ]
      "https://github.com/x"
  in
  status "curl's own limit" 413 answer.status;
  (* curl 8.5 (Ubuntu 24.04) stops on a declared length over --max-filesize
     before it writes the headers: exit 63 and no response at all *)
  let answer, _, _ = fetch [ (63, "") ] "https://github.com/x" in
  status "curl's limit, no headers written" 413 answer.status;
  let answer, _, _ = fetch [ (7, "") ] "https://github.com/x" in
  status "no response for another reason" 502 answer.status;
  let exact = png ^ String.make (I.size_limit - String.length png) '\000' in
  let answer, _, _ =
    fetch
      [ (0, response [ "Content-Type: image/png" ] exact) ]
      "https://github.com/x"
  in
  status "exactly the limit" 200 answer.status

let test_failures () =
  let answer, _, _ =
    fetch
      [
        ( 0,
          response ~status:"HTTP/1.1 404 Not Found"
            [ "Content-Type: image/png" ]
            png );
      ]
      "https://github.com/x"
  in
  status "an error answer" 502 answer.status;
  let answer, _, _ =
    fetch
      [ (28, response [ "Content-Type: image/png" ] png) ]
      "https://github.com/x"
  in
  status "curl failed (timeout)" 502 answer.status;
  let answer, _, _ = fetch [ (7, "") ] "https://github.com/x" in
  status "no answer" 502 answer.status;
  let answer, _, _ =
    fetch [ (0, "garbage\r\n\r\n" ^ png) ] "https://github.com/x"
  in
  status "no status line" 502 answer.status;
  let informational =
    response ~status:"HTTP/1.1 103 Early Hints" [ "Link: </x>" ] ""
  in
  let answer, _, _ =
    fetch [ (0, informational ^ snd ok_png) ] "https://github.com/x"
  in
  status "a 1xx block is skipped" 200 answer.status

(* ---- the test hook *)

let test_stand_ins () =
  let stand_ins =
    Some
      (I.stand_ins_of_string
         "github.com=127.0.0.1:8080,raw.githubusercontent.com=localhost:9,objects.githubusercontent.com=10.0.0.1:80")
  in
  let table = ("localhost", [ address "127.0.0.1" ]) :: default_table in
  let answer, calls, _ =
    fetch ~table ?stand_ins [ ok_png ] "https://github.com/a?b"
  in
  status "a loopback stand-in" 200 answer.status;
  let arguments = List.hd calls in
  Alcotest.(check string)
    "plain HTTP to it" "http://127.0.0.1:8080/a?b"
    (List.nth arguments (List.length arguments - 1));
  Alcotest.(check (option string))
    "http only" (Some "=http")
    (after "--proto" arguments);
  List.iter
    (fun (name, url) ->
      let answer, calls, _ = fetch ~table ?stand_ins [ ok_png ] url in
      status name 502 answer.status;
      Alcotest.(check int) (name ^ ": no request") 0 (List.length calls))
    [
      ( "a stand-in name resolving to loopback",
        "https://raw.githubusercontent.com/x" );
      ( "a stand-in address that is not loopback",
        "https://objects.githubusercontent.com/x" );
      ( "a name without stand-in",
        "https://private-user-images.githubusercontent.com/x" );
    ];
  Alcotest.(check int)
    "malformed items are dropped" 1
    (List.length (I.stand_ins_of_string "a=b:1,c,d=e,f=g:0,h=i:x"))

(* ---- the whole decision *)

let with_directory f =
  let root = Filename.temp_file "mesh-update-image" "" in
  Sys.remove root;
  Unix.mkdir root 0o700;
  Fun.protect
    ~finally:(fun () ->
      Array.iter
        (fun name -> Sys.remove (Filename.concat root name))
        (Sys.readdir root);
      Unix.rmdir root)
    (fun () -> f root)

let decide ?(notes = "![x](https://github.com/x)") ?(now = 1000.) directory url
    answers =
  let resolve, _ = resolver default_table in
  let transport, calls = transport answers in
  let getenv = function "MESH_CACHE_DIR" -> Some directory | _ -> None in
  let answer =
    I.answer ~getenv ~resolve ~transport ~clock:(fun () -> now) ~url ~notes
  in
  (answer, calls ())

let test_not_in_notes () =
  with_directory (fun directory ->
      let answer, calls = decide directory "https://github.com/y" [ ok_png ] in
      status "absent from the notes" 404 answer.status;
      Alcotest.(check int) "no request" 0 (List.length calls);
      let answer, calls =
        decide ~notes:"https://example.com/x" directory "https://example.com/x"
          [ ok_png ]
      in
      status "outside the allowlist" 404 answer.status;
      Alcotest.(check int) "no request either" 0 (List.length calls);
      Alcotest.(check bool)
        "nothing counted" false
        (Sys.file_exists (Filename.concat directory "update-image-fetches"));
      let answer, _ = decide directory "https://github.com/x" [ ok_png ] in
      status "written in the notes" 200 answer.status)

let test_budget () =
  with_directory (fun directory ->
      let fetched now =
        (fst (decide ~now directory "https://github.com/x" [ ok_png ])).status
      in
      for index = 1 to I.budget_count do
        status
          (Printf.sprintf "fetch %d" index)
          200
          (fetched (1000. +. float_of_int index))
      done;
      status "one more" 429 (fetched 1100.);
      status "still within the window" 429 (fetched (1000. +. I.budget_window));
      status "the window moved on" 200 (fetched (1002. +. I.budget_window));
      let file = Unix.stat (Filename.concat directory "update-image-fetches") in
      Alcotest.(check int) "private file" 0o600 (file.Unix.st_perm land 0o777))

let test_budget_symlink () =
  with_directory (fun directory ->
      Unix.symlink "/dev/null"
        (Filename.concat directory "update-image-fetches");
      status "a link is not followed" 502
        (fst (decide directory "https://github.com/x" [ ok_png ])).status)

let () =
  Alcotest.run "mesh_update_image"
    [
      ( "addresses",
        [
          Alcotest.test_case "pinned connection" `Quick test_pinned_connection;
          Alcotest.test_case "IPv6 pin" `Quick test_ipv6_pin;
          Alcotest.test_case "private after DNS" `Quick test_private_after_dns;
        ] );
      ( "redirects",
        [
          Alcotest.test_case "followed and rechecked" `Quick
            test_redirect_followed_and_rechecked;
          Alcotest.test_case "refused" `Quick test_redirect_refused;
          Alcotest.test_case "at most three" `Quick test_redirect_limit;
        ] );
      ( "content",
        [
          Alcotest.test_case "types and magic bytes" `Quick test_types_and_magic;
          Alcotest.test_case "size" `Quick test_size;
          Alcotest.test_case "failures" `Quick test_failures;
        ] );
      ( "decision",
        [
          Alcotest.test_case "stand-ins (tests only)" `Quick test_stand_ins;
          Alcotest.test_case "not in the notes" `Quick test_not_in_notes;
          Alcotest.test_case "budget" `Quick test_budget;
          Alcotest.test_case "budget file is not a link" `Quick
            test_budget_symlink;
        ] );
    ]
