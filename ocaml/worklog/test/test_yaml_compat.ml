(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(* YAML 1.1 scalar typing and the taxonomy rules, against what PyYAML's safe
   loader (the one `wl` uses) does with the same text. The table below was
   checked against that loader once; the tests need no Python. *)

open Mesh_worklog
open Tutil

(* Plain scalars a YAML 1.1 loader reads as strings. *)
let strings =
  [ "2fa"; "3d"; "1e3"; "4b"; "0o17"; "08"; "0xZZ"; "0b2"; "_1"; "1.5e3"; "-.5"; "+.5"; "1e+3";
    "-.nan"; "1:60"; "0:30"; "2026-1-9"; "2026-11-19T10:00"; "2026-11-19T10:00:00+530";
    "1e3x"; "4ba"; "1a"; "0b"; "0x"; "+"; "."; ".."; "nUll"; "yEs"; "tRue"; "y"; "Y"; "n"; "N";
    "a-b"; "a.b"; "gateway-api"; "2fa-x"; "9a"; "9e"; "1e"; "1_e"; "0e0"; "1e-3"; "0.e0";
    "12abc"; "1:3a"; "relay-core" ]

(* Plain scalars it reads as numbers, booleans, null or dates (or refuses). *)
let typed =
  [ "12"; "0"; "007"; "0x1F"; "0b101"; "1_000"; "1__"; "1.5"; "1.5e+3"; "1.5E-3"; "1."; ".5";
    ".5e+3"; "1.e+3"; ".inf"; "-.inf"; "+.inf"; ".Inf"; ".INF"; ".nan"; ".NaN"; ".NAN"; "1:30";
    "1:30:00"; "12:30:45.5"; "1:5.5"; "-1:30"; "+1:30"; "2026-11-19"; "2026-11-19T10:00:00Z";
    "2026-11-19t10:00:00"; "2026-11-19 10:00:00"; "2026-11-19 10:00:00 +01:00";
    "2026-11-19 10:00:00 Z"; "2026-11-19T10:00:00.5-05:30"; "2026-11-19T10:00:00+5";
    "2026-13-45"; "20261119"; "0_"; "00"; "-0"; "+0"; "~"; "null"; "Null"; "NULL"; "yes"; "Yes";
    "YES"; "no"; "No"; "NO"; "true"; "True"; "TRUE"; "false"; "False"; "FALSE"; "on"; "On";
    "ON"; "off"; "Off"; "OFF"; "<<"; "="; "9"; "1.0e-3" ]

let test_scalar_table () =
  List.iter
    (fun s -> Alcotest.(check bool) (s ^ " is a string") true (Yaml_lite.is_plain_string s))
    strings;
  List.iter
    (fun s -> Alcotest.(check bool) (s ^ " is not a string") false (Yaml_lite.is_plain_string s))
    typed;
  Alcotest.(check bool) "empty is null" false (Yaml_lite.is_plain_string "")

let test_conservative_ids () =
  List.iter
    (fun s -> Alcotest.(check bool) (s ^ " refused for new ids") false (Yaml_lite.is_conservative_string s))
    [ "2fa"; "3d"; "1e3"; "12"; "yes"; "0o17" ];
  List.iter
    (fun s -> Alcotest.(check bool) (s ^ " fine for new ids") true (Yaml_lite.is_conservative_string s))
    [ "gateway"; "relay-core"; "a2"; "fa2" ]

let taxonomy products =
  "categories:\n  sec:\n    name: Security\n    products:\n" ^ products

let accepts name text =
  match Taxonomy.of_string text with
  | Ok t -> t
  | Error why -> Alcotest.failf "%s refused: %s" name why

let refuses name text =
  match Taxonomy.of_string text with
  | Ok _ -> Alcotest.failf "%s was accepted" name
  | Error _ -> ()

let test_numeric_looking_product_ids () =
  let t = accepts "hex-looking ids" (taxonomy "      - 2fa\n      - 3d\n      - 1e3\n      - 4b\n") in
  Alcotest.(check (list string)) "ids" [ "2fa"; "3d"; "1e3"; "4b" ] (Taxonomy.products t);
  refuses "a real number" (taxonomy "      - 12\n");
  refuses "a real float" (taxonomy "      - 1.5\n");
  refuses "a boolean" (taxonomy "      - yes\n");
  ignore (accepts "quoted number" (taxonomy "      - \"12\"\n"));
  let tree = accepts "tree root 2fa" (taxonomy "      - 2fa:\n          - 2fa-app\n") in
  Alcotest.(check (list string)) "tree" [ "2fa"; "2fa-app" ] (Taxonomy.products tree)

let test_editor_reads_numeric_looking_ids () =
  let text = taxonomy "      - 2fa\n" in
  match Taxonomy_edit.insert text ~id:"vault" ~category:"sec" ~parent:None with
  | Ok edited -> Alcotest.(check bool) "added" true (contains ~sub:"- vault" edited)
  | Error why -> Alcotest.failf "editor refused a valid taxonomy: %s" why

(* What wl refuses and the first version accepted. *)
let test_rejections_aligned_with_wl () =
  refuses "name: 12" "categories:\n  sec:\n    name: 12\n    products:\n      - x\n";
  refuses "name: yes" "categories:\n  sec:\n    name: yes\n    products:\n      - x\n";
  refuses "name: null" "categories:\n  sec:\n    name: null\n    products:\n      - x\n";
  refuses "name: a: b" "categories:\n  sec:\n    name: a: b\n    products:\n      - x\n";
  refuses "number root key" (taxonomy "      - 12: [x]\n");
  refuses "numeric category key" "categories:\n  12:\n    name: N\n    products:\n      - x\n";
  refuses "boolean category key" "categories:\n  yes:\n    name: N\n    products:\n      - x\n";
  ignore (accepts "quoted name" "categories:\n  sec:\n    name: \"12\"\n    products:\n      - x\n");
  ignore (accepts "quoted category key" "categories:\n  \"12\":\n    name: N\n    products:\n      - x\n");
  ignore (accepts "quoted root key" (taxonomy "      - \"12\": [x]\n"));
  ignore (accepts "name with a colon inside" "categories:\n  sec:\n    name: a:b\n    products:\n      - x\n");
  ignore (accepts "numeric-looking name is fine when it is a string" "categories:\n  sec:\n    name: 2fa\n    products:\n      - x\n")

let test_extra_numeric_keys_are_ignored_like_wl () =
  ignore (accepts "numeric key beside name" "categories:\n  sec:\n    name: N\n    12: ignored\n    products:\n      - x\n")

(* ---- depth --------------------------------------------------------------- *)

let test_nesting_depth_is_capped () =
  let deep_flow = taxonomy ("      - " ^ String.make 100_000 '[') in
  (match Yaml_lite.parse deep_flow with
  | Error why -> Alcotest.(check bool) "message" true (contains ~sub:"nesting" why)
  | Ok _ -> Alcotest.fail "deep flow nesting was accepted");
  let deep_seq = String.concat "" (List.init 5000 (fun _ -> "- ")) ^ "x\n" in
  (match Yaml_lite.parse deep_seq with
  | Error why -> Alcotest.(check bool) "block message" true (contains ~sub:"nesting" why)
  | Ok _ -> Alcotest.fail "deep block nesting was accepted");
  let deep_map =
    String.concat "" (List.init 3000 (fun i -> String.make (2 * i) ' ' ^ "k:\n")) ^ String.make 6000 ' ' ^ "v: 1\n"
  in
  (match Taxonomy.of_string deep_map with
  | Error _ -> ()
  | Ok _ -> Alcotest.fail "deep mapping was accepted");
  let shallow = String.make 20 '[' ^ String.make 20 ']' in
  Alcotest.(check bool) "20 levels are fine" true (Result.is_ok (Yaml_lite.parse shallow))

let () =
  Alcotest.run "worklog yaml compatibility"
    [ ( "scalars",
        [ Alcotest.test_case "PyYAML typing table" `Quick test_scalar_table;
          Alcotest.test_case "conservative ids" `Quick test_conservative_ids ] );
      ( "taxonomy",
        [ Alcotest.test_case "numeric-looking product ids" `Quick test_numeric_looking_product_ids;
          Alcotest.test_case "editor on such a taxonomy" `Quick test_editor_reads_numeric_looking_ids;
          Alcotest.test_case "rejections aligned with wl" `Quick test_rejections_aligned_with_wl;
          Alcotest.test_case "ignored extra keys" `Quick test_extra_numeric_keys_are_ignored_like_wl ] );
      ("depth", [ Alcotest.test_case "nesting cap" `Quick test_nesting_depth_is_capped ]) ]
