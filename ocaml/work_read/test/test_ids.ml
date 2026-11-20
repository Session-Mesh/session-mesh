(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(* [ids]: every task, project and question id with its title only, for the
   references of the terminal. The fixture has tasks T-1a2b, T-3c4d, ... and
   the project P-5e6f "Delivery rollout"; the events below add two questions
   and a task whose session worked in a folder that must never be shown. *)

open Work_read_runner
module U = Yojson.Safe.Util

let contains haystack needle =
  let n = String.length needle and m = String.length haystack in
  let rec at i =
    i + n <= m && (String.sub haystack i n = needle || at (i + 1))
  in
  n = 0 || at 0

let ok ?input repo args =
  let r = run ?input repo args in
  if r.code <> 0 then
    Alcotest.failf "%s: exit %d: %s" (String.concat " " args) r.code r.out;
  json r

let tracker () =
  let repo = copy_fixture () in
  append_events repo
    [
      {|{"ts":"2026-11-09T10:01:00Z","task":"T-3c4d","type":"session_linked","agent":"codex","session":"s-new","cwd":"/srv/zed/secretrepo","host":"hostc","repo":"/srv/zed/secretrepo","branch":"feat/x"}|};
      {|{"ts":"2026-11-09T10:02:00Z","task":"T-3c4d","type":"question","id":"N-0000abcd","text":"Which harbour slot, morning or evening?","agent":"codex","session":"s-new"}|};
      {|{"ts":"2026-11-09T10:03:00Z","task":"P-5e6f","type":"question","id":"N-0000beef","text":"Ship in December?","agent":"codex","session":"s-new"}|};
      {|{"ts":"2026-11-09T10:04:00Z","task":"N-00000a02","type":"question","id":"N-00000a02","text":"Free question","agent":"codex","session":"s-lone"}|};
    ];
  repo

let entries key doc = U.to_list (U.member key doc)

let ids key doc =
  List.map (fun e -> U.to_string (U.member "id" e)) (entries key doc)

let find key id doc =
  match
    List.find_opt (fun e -> U.member "id" e = `String id) (entries key doc)
  with
  | Some e -> e
  | None -> Alcotest.failf "no %s %s" key id

let field key e =
  match U.member key e with `String s -> s | `Null -> "-" | _ -> "?"

let test_document () =
  let doc = ok (tracker ()) [ "ids" ] in
  Alcotest.(check string) "command" "ids" (U.to_string (U.member "command" doc));
  Alcotest.(check bool)
    "every task" true
    (List.mem "T-1a2b" (ids "tasks" doc) && List.mem "T-3c4d" (ids "tasks" doc));
  Alcotest.(check string)
    "project title" "Delivery rollout"
    (field "title" (find "projects" "P-5e6f" doc));
  Alcotest.(check bool)
    "task title" true
    (field "title" (find "tasks" "T-3c4d" doc) <> "-");
  let q = find "questions" "N-0000abcd" doc in
  Alcotest.(check (pair string string))
    "about a task: its project" ("T-3c4d", "P-5e6f")
    (field "about" q, field "project" q);
  Alcotest.(check string)
    "question title is its text" "Which harbour slot, morning or evening?"
    (field "title" q);
  let p = find "questions" "N-0000beef" doc in
  Alcotest.(check (pair string string))
    "about a project" ("P-5e6f", "P-5e6f")
    (field "about" p, field "project" p);
  let free = find "questions" "N-00000a02" doc in
  Alcotest.(check (pair string string))
    "about nothing" ("-", "-")
    (field "about" free, field "project" free);
  Alcotest.(check bool) "truncated" false (U.to_bool (U.member "truncated" doc))

(* Only ids and titles: no status, note, session, folder or timeline. *)
let test_only_ids_and_titles () =
  let repo = tracker () in
  let r = run repo [ "ids" ] in
  let doc = json r in
  let keys e = List.sort compare (U.keys e) in
  List.iter
    (fun e ->
      Alcotest.(check (list string)) "task keys" [ "id"; "title" ] (keys e))
    (entries "tasks" doc);
  List.iter
    (fun e ->
      Alcotest.(check (list string)) "project keys" [ "id"; "title" ] (keys e))
    (entries "projects" doc);
  List.iter
    (fun e ->
      Alcotest.(check bool)
        "question keys" true
        (List.for_all
           (fun k -> List.mem k [ "id"; "title"; "about"; "project" ])
           (keys e)))
    (entries "questions" doc);
  List.iter
    (fun needle ->
      Alcotest.(check bool) ("no " ^ needle) false (contains r.out needle))
    [ repo.home; repo.wl_home; "/srv/zed"; "secretrepo"; "s-new"; "hostc" ]

let test_titles_cut () =
  let repo = copy_fixture () in
  let long = String.make 150 'x' in
  append_events repo
    [
      Printf.sprintf
        {|{"ts":"2026-11-09T10:00:00Z","task":"T-abcd","type":"created","title":"%s","project":"gateway","category":"platform","priority":"P2","status":"todo"}|}
        long;
    ];
  let title = field "title" (find "tasks" "T-abcd" (ok repo [ "ids" ])) in
  Alcotest.(check bool)
    "cut" true
    (String.length title <= Work_read.Wr_ids.max_title + 3)

let test_request_form () =
  let repo = tracker () in
  let doc = ok ~input:{|{"op":"ids"}|} repo [ "--request" ] in
  Alcotest.(check bool)
    "same document" true
    (List.mem "P-5e6f" (ids "projects" doc));
  List.iter
    (fun (input, args) ->
      let r = run ?input repo args in
      Alcotest.(check int) ("refused: " ^ String.concat " " args) 2 r.code)
    [
      (None, [ "ids"; "extra" ]);
      (None, [ "ids"; "--all" ]);
      (Some {|{"op":"ids","args":{"all":true}}|}, [ "--request" ]);
      (Some {|{"op":"ids","args":{"id":"T-3c4d"}}|}, [ "--request" ]);
      (Some {|{"op":"ids","args":{"product":"gateway"}}|}, [ "--request" ]);
    ]

let test_read_only () =
  let repo = tracker () in
  let before = tree_state repo.wl_home in
  ignore (ok repo [ "ids" ]);
  Alcotest.(check bool) "nothing written" true (before = tree_state repo.wl_home)

let test_caps () =
  let repo = copy_fixture () in
  let extra = 5 in
  let n = Work_read.Wr_ids.max_tasks + extra in
  append_events repo
    (List.init n (fun i ->
         Printf.sprintf
           {|{"ts":"2026-11-09T%02d:%02d:%02dZ","task":"T-%06x","type":"created","title":"Task %d","project":"gateway","category":"platform","priority":"P2","status":"todo"}|}
           (i / 3600 mod 24)
           (i / 60 mod 60)
           (i mod 60) (0x100000 + i) i));
  let doc = ok repo [ "ids" ] in
  Alcotest.(check int)
    "at most max_tasks" Work_read.Wr_ids.max_tasks
    (List.length (entries "tasks" doc));
  Alcotest.(check bool)
    "the others counted" true
    (U.to_int (U.member "tasks_omitted" doc) >= extra);
  Alcotest.(check bool) "truncated" true (U.to_bool (U.member "truncated" doc))

let tests =
  [
    Alcotest.test_case "ids and titles" `Quick test_document;
    Alcotest.test_case "nothing but ids and titles" `Quick
      test_only_ids_and_titles;
    Alcotest.test_case "titles cut" `Quick test_titles_cut;
    Alcotest.test_case "request form and strict arguments" `Quick
      test_request_form;
    Alcotest.test_case "read only" `Quick test_read_only;
    Alcotest.test_case "caps" `Slow test_caps;
  ]
