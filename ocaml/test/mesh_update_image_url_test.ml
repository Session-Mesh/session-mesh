(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(* Which image URLs of the release notes may be fetched: the allowlist,
   address literals in every spelling, the match against the notes, public
   addresses (IPv4, IPv6, IPv4-mapped) and redirect targets. *)

module U = Mesh_update_image_url

(* "@", apart: a userinfo URL written whole reads as an e-mail address to the
   leak guard. *)
let at = "@"
let address = Unix.inet_addr_of_string
let parse text = Option.get (U.image_url text)

(* ---- the URL *)

let test_allowlist () =
  List.iter
    (fun text ->
      Alcotest.(check bool) text true (Option.is_some (U.image_url text)))
    [
      "https://github.com/user-attachments/assets/ok";
      "https://github.com:443/user-attachments/assets/ok";
      "https://private-user-images.githubusercontent.com/1/a.png?jwt=x";
      "https://a-b.c.githubusercontent.com/x";
      "https://github.com?x";
    ];
  List.iter
    (fun text ->
      Alcotest.(check bool) text false (Option.is_some (U.image_url text)))
    [
      "http://github.com/x";
      "HTTPS://github.com/x";
      "https://GitHub.com/x";
      "javascript:alert(1)";
      "https://example.com/x";
      "https://github.com.example.com/x";
      "https://evilgithubusercontent.com/x";
      "https://.githubusercontent.com/x";
      "https://a..githubusercontent.com/x";
      "https://github.com:8443/x";
      "https://github.com:/x";
      "https://github.com:0443/x";
      "https://user:secret" ^ at ^ "github.com/x";
      "https://user" ^ at ^ "github.com/x";
      "https://github.com" ^ at ^ "evil.example/x";
      "https://github.com/a b";
      "https://github.com/a\tb";
      "https://github.com\\" ^ at ^ "evil.example/x";
      "https://github.com/" ^ String.make 2048 'a';
    ]

let test_address_literals () =
  (* every spelling of an address is refused before any lookup *)
  List.iter
    (fun text ->
      Alcotest.(check bool) text false (Option.is_some (U.image_url text)))
    [
      "https://127.0.0.1/x";
      "https://2130706433/x";
      "https://0177.0.0.1/x";
      "https://0x7f.0.0.1/x";
      "https://0x7f000001/x";
      "https://127.1/x";
      "https://[::1]/x";
      "https://[::ffff:127.0.0.1]/x";
      "https://[::ffff:7f00:1]/x";
      "https://169.254.169.254/latest/meta-data";
      "https://140.82.112.3/x";
    ]

let test_url_parts () =
  let url = parse "https://github.com:443/a/b.png?x=1#frag" in
  Alcotest.(check string) "host" "github.com" url.host;
  Alcotest.(check string) "rest" "/a/b.png?x=1" url.rest;
  Alcotest.(check string)
    "rest of a bare host" "/?q" (parse "https://github.com?q").rest

(* ---- the notes *)

let test_in_notes () =
  let notes =
    "![a](https://github.com/a.png)\n\
     <img src=\"https://github.com/b.png?x=1&amp;y=2\">\n\
     <img src=\"https://github.com/c.png?x=1&#38;y=2\">\n\
     <img src=\"https://github.com/d.png?x=1&#x26;y=2\">"
  in
  let check expected url =
    Alcotest.(check bool) url expected (U.in_notes ~notes url)
  in
  check true "https://github.com/a.png";
  check true "https://github.com/b.png?x=1&y=2";
  check true "https://github.com/b.png?x=1&amp;y=2";
  check true "https://github.com/c.png?x=1&y=2";
  check true "https://github.com/d.png?x=1&y=2";
  check false "https://github.com/e.png";
  check false "https://github.com/a.png.evil";
  check false "";
  Alcotest.(check string)
    "unknown references stay" "&bogus; &#0; &#xzz; &"
    (U.html_unescape "&bogus; &#0; &#xzz; &")

(* ---- public addresses *)

let test_public_addresses () =
  let check expected text =
    Alcotest.(check bool) text expected (U.public_address (address text))
  in
  List.iter (check true)
    [
      "140.82.112.3";
      "185.199.108.133";
      "8.8.8.8";
      "2606:50c0:8000::153";
      "::ffff:140.82.112.3";
      "2a00:1450::1";
    ];
  List.iter (check false)
    [
      "0.0.0.0";
      "10.1.2.3";
      String.concat "." [ "100"; "64"; "0"; "1" ] (* shared address space *);
      "127.0.0.1";
      "127.255.255.254";
      "169.254.169.254";
      "172.16.0.1";
      "172.31.255.255";
      "192.0.0.8";
      "192.0.2.1";
      "192.88.99.1";
      "192.168.1.1";
      "198.18.0.1";
      "198.51.100.1";
      "203.0.113.1";
      "224.0.0.1";
      "240.0.0.1";
      "255.255.255.255";
      "::";
      "::1";
      "::ffff:127.0.0.1";
      "::ffff:10.0.0.1";
      "::ffff:169.254.169.254";
      "::127.0.0.1";
      "64:ff9b::a00:1";
      "100::1";
      "2001::1";
      "2001:db8::1";
      "2002:7f00:1::1";
      "3fff::1";
      "fc00::1";
      "fd12:3456::1";
      "fe80::1";
      "fec0::1";
      "ff02::1";
    ]

let test_join () =
  let base = parse "https://github.com/a/b/c.png?x=1" in
  List.iter
    (fun (location, expected) ->
      Alcotest.(check string) location expected (U.join ~base location))
    [
      ("https://example.com/x", "https://example.com/x");
      ( "//private-user-images.githubusercontent.com/x",
        "https://private-user-images.githubusercontent.com/x" );
      ("/y", "https://github.com/y");
      ("d.png", "https://github.com/a/b/d.png");
      ("../d.png", "https://github.com/a/b/../d.png");
    ]

let () =
  Alcotest.run "mesh_update_image_url"
    [
      ( "url",
        [
          Alcotest.test_case "allowlist" `Quick test_allowlist;
          Alcotest.test_case "address literals" `Quick test_address_literals;
          Alcotest.test_case "parts" `Quick test_url_parts;
          Alcotest.test_case "in the notes" `Quick test_in_notes;
          Alcotest.test_case "redirect targets" `Quick test_join;
        ] );
      ( "addresses",
        [ Alcotest.test_case "public or not" `Quick test_public_addresses ] );
    ]
