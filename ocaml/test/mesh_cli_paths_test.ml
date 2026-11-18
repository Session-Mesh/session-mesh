(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(* The rules of meshpaths.py in Mesh_paths: MESH_PORT is a port number and
   nothing else, the directories are absolute. *)

let environment pairs name = List.assoc_opt name pairs
let port_of value = Mesh_paths.port (environment [ ("MESH_PORT", value) ])

let check_port_accepted (value, expected) () =
  match port_of value with
  | Ok port ->
      Alcotest.(check int)
        (Printf.sprintf "MESH_PORT=%S" value)
        expected
        (Mesh_paths.port_number port)
  | Error message -> Alcotest.failf "MESH_PORT=%S refused: %s" value message

let check_port_refused value () =
  match port_of value with
  | Ok port ->
      Alcotest.failf "MESH_PORT=%S accepted as %d" value
        (Mesh_paths.port_number port)
  | Error message ->
      let prefix =
        "session-mesh: MESH_PORT must be a port number between 1 and 65535 \
         (got "
      in
      Alcotest.(check bool)
        (Printf.sprintf "message for %S: %s" value message)
        true
        (String.starts_with ~prefix message)

let accepted =
  [ ("1", 1); ("7690", 7690); ("65535", 65535); ("00080", 80); ("", 7690) ]

let refused =
  [
    "0";
    "65536";
    "-1";
    "1e3";
    "0x1E5A";
    "7_690";
    "+7690";
    " 7690";
    "7690 ";
    "\xd9\xa7\xd9\xa6\xd9\xa9\xd9\xa0" (* Arabic-Indic 7690 *);
    "@";
    "#";
    "?";
    "7690@localhost";
    "7690/x";
    "123456";
    "000080";
    "http";
    "0o17";
    "0b1";
    "7690\n";
  ]

let test_unset_port () =
  match Mesh_paths.port (environment []) with
  | Ok port -> Alcotest.(check int) "default" 7690 (Mesh_paths.port_number port)
  | Error message -> Alcotest.fail message

let test_port_message () =
  Alcotest.(check (result int string))
    "the meshpaths message, value shown by repr"
    (Error
       "session-mesh: MESH_PORT must be a port number between 1 and 65535 (got \
        '7690@x')")
    (Result.map Mesh_paths.port_number (port_of "7690@x"))

let conf pairs = Mesh_paths.conf_dir (environment pairs)

let test_conf_dir () =
  Alcotest.(check (result string string))
    "default under HOME" (Ok "/accounts/someone/.config/session-mesh")
    (conf [ ("HOME", "/accounts/someone") ]);
  Alcotest.(check (result string string))
    "empty means unset" (Ok "/accounts/someone/.config/session-mesh")
    (conf [ ("HOME", "/accounts/someone"); ("MESH_CONF_DIR", "") ]);
  Alcotest.(check (result string string))
    "normalised like pathlib" (Ok "/srv/mesh/conf")
    (conf [ ("MESH_CONF_DIR", "/srv//mesh/./conf/") ]);
  Alcotest.(check (result string string))
    "relative refused"
    (Error "session-mesh: MESH_CONF_DIR must be an absolute path (got 'conf')")
    (conf [ ("MESH_CONF_DIR", "conf") ])

let test_cache_dir () =
  Alcotest.(check (result string string))
    "default under HOME" (Ok "/accounts/someone/.cache/session-mesh")
    (Mesh_paths.cache_dir (environment [ ("HOME", "/accounts/someone") ]));
  Alcotest.(check (result string string))
    "relative refused"
    (Error
       "session-mesh: MESH_CACHE_DIR must be an absolute path (got './cache')")
    (Mesh_paths.cache_dir (environment [ ("MESH_CACHE_DIR", "./cache") ]))

let test_home_fallback () =
  match conf [] with
  | Ok path ->
      Alcotest.(check bool)
        "absolute, from the password database" true
        (String.length path > 0 && path.[0] = '/')
  | Error message -> Alcotest.fail message

let test_repr () =
  let check value expected =
    Alcotest.(check string) value expected (Mesh_python_text.repr value)
  in
  check "abc" "'abc'";
  check "it's" "\"it's\"";
  check "it's \"x\"" "'it\\'s \"x\"'";
  check "a\\b" "'a\\\\b'";
  check "\t\n\r\x01\x7f" "'\\t\\n\\r\\x01\\x7f'";
  check "\xd9\xa7" "'\xd9\xa7'"

let test_strip () =
  let check value expected =
    Alcotest.(check string)
      (String.escaped value) expected
      (Mesh_python_text.strip value)
  in
  check "  token\n" "token";
  check "\x0b\x0c\x1c\x1d\x1e\x1ftok en\r\t" "tok en";
  check " \n\t" "";
  check "" ""

let () =
  Alcotest.run "mesh_cli_paths"
    [
      ( "port",
        List.map
          (fun (value, port) ->
            Alcotest.test_case
              (Printf.sprintf "accepts %S" value)
              `Quick
              (check_port_accepted (value, port)))
          accepted
        @ List.map
            (fun value ->
              Alcotest.test_case
                (Printf.sprintf "refuses %S" value)
                `Quick (check_port_refused value))
            refused
        @ [
            Alcotest.test_case "unset is 7690" `Quick test_unset_port;
            Alcotest.test_case "message" `Quick test_port_message;
          ] );
      ( "directories",
        [
          Alcotest.test_case "MESH_CONF_DIR" `Quick test_conf_dir;
          Alcotest.test_case "MESH_CACHE_DIR" `Quick test_cache_dir;
          Alcotest.test_case "no HOME" `Quick test_home_fallback;
        ] );
      ( "python text",
        [
          Alcotest.test_case "repr" `Quick test_repr;
          Alcotest.test_case "strip" `Quick test_strip;
        ] );
    ]
