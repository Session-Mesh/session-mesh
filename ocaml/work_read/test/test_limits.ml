(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

open Work_read_runner
module U = Yojson.Safe.Util

let slist = Alcotest.(list string)
let sorted = List.sort compare
let str_list j = List.map U.to_string (U.to_list j)
let ids key doc = List.map (fun t -> U.to_string (U.member "id" t)) (U.to_list (U.member key doc))

let ok ?input repo args =
  let r = run ?input repo args in
  if r.code <> 0 then Alcotest.failf "%s: exit %d: %s" (String.concat " " args) r.code r.out;
  (r, json r)

(* Four bytes per character: the largest text a writer can store per character. *)
let emoji n = String.concat "" (List.init n (fun _ -> "\xf0\x9f\x98\x80"))
let at i = Printf.sprintf "2026-11-09T%02d:%02d:%02dZ" (i / 3600) (i / 60 mod 60) (i mod 60)

(* [n] questions about [about], each with the largest text, options and
   assumption, and five answers of the largest text. *)
let maximal_questions ~first ~about n =
  List.concat
    (List.init n (fun k ->
         let i = first + k and id = Printf.sprintf "N-%08x" (first + k) in
         let options = String.concat "," (List.init 8 (fun _ -> "\"" ^ emoji 100 ^ "\"")) in
         Printf.sprintf
           {|{"ts":"%s","task":"%s","type":"question","id":"%s","text":"%s","options":[%s],"assumption":"%s","agent":"codex","session":"s-q"}|}
           (at (2 * i)) about id (emoji 2000) options (emoji 1000)
         :: List.init 5 (fun _ ->
                Printf.sprintf {|{"ts":"%s","task":"%s","type":"answer","question":"%s","text":"%s","by":"owner"}|}
                  (at ((2 * i) + 1)) about id (emoji 2000))))

(* 400 tasks in P-5e6f with long titles and five dependencies each. *)
let many_tasks ~first =
  List.concat
    (List.init 400 (fun k ->
         let i = first + k and id = Printf.sprintf "T-%04x" (0xa000 + k) in
         [
           Printf.sprintf
             {|{"ts":"%s","task":"%s","type":"created","title":"%s","project":"gateway","category":"platform","priority":"P2","status":"%s"}|}
             (at i) id (emoji 200) (if k mod 3 = 0 then "blocked" else "todo");
           Printf.sprintf {|{"ts":"%s","task":"%s","type":"set","field":"project","to":"P-5e6f"}|} (at i) id;
         ]
         @ List.init 5 (fun d ->
               Printf.sprintf {|{"ts":"%s","task":"%s","type":"add","field":"blocked_by","value":"T-%04x"}|} (at i) id
                 (0xa000 + ((k + d + 1) mod 400)))))

let size_ok label (r : result) = Alcotest.(check bool) (label ^ " within the bound") true (String.length r.out <= 1_000_001)

let test_maximal_project () =
  let repo = copy_fixture () in
  let old_open =
    {|{"ts":"2026-11-09T00:00:00Z","task":"P-5e6f","type":"question","id":"N-0000aaaa","text":"Old and open?","agent":"codex","session":"s-q"}|}
  in
  append_events repo
    ((old_open :: many_tasks ~first:10)
    @ maximal_questions ~first:1000 ~about:"P-5e6f" 50
    @ maximal_questions ~first:2000 ~about:"T-1a2b" 50);
  let r, doc = ok repo [ "project"; "P-5e6f" ] in
  size_ok "project" r;
  Alcotest.(check bool) "truncated" true (U.to_bool (U.member "truncated" doc));
  Alcotest.(check int) "open questions counted" 1 (U.to_int (U.member "open_questions" doc));
  Alcotest.(check bool) "every question was read" true (U.to_int (U.member "questions_omitted" doc) >= 81);
  Alcotest.check slist "the old open question comes first" [ "N-0000aaaa" ]
    [ List.hd (ids "questions" doc) ];
  let shown = ids "tasks" doc in
  let columns = U.member "columns" doc in
  List.iter
    (fun (name, column) ->
      List.iter
        (fun id -> Alcotest.(check bool) (name ^ " names a shown task") true (List.mem id shown))
        (str_list column))
    (U.to_assoc columns);
  let in_columns = List.fold_left (fun n (_, c) -> n + List.length (U.to_list c)) 0 (U.to_assoc columns) in
  let omitted = List.fold_left (fun n (_, c) -> n + U.to_int c) 0 (U.to_assoc (U.member "columns_omitted" doc)) in
  Alcotest.(check int) "every task is in a column or counted" 402 (in_columns + omitted);
  Alcotest.(check int) "shown tasks are in the columns" (List.length shown) in_columns;
  let r, task = ok repo [ "task"; "T-1a2b" ] in
  size_ok "task" r;
  Alcotest.(check bool) "task truncated" true (U.to_bool (U.member "truncated" task));
  Alcotest.(check bool) "task keeps questions" true (U.to_list (U.member "questions" task) <> []);
  let r, _ = ok repo [ "resume"; "--all" ] in
  size_ok "resume" r

let test_blocked_is_one_notion () =
  let repo = copy_fixture () in
  let created id status project =
    Printf.sprintf
      {|{"ts":"2026-11-09T09:00:00Z","task":"%s","type":"created","title":"Wait %s","project":"relay","category":"platform","priority":"P2","status":"%s"}|}
      id id status
    :: (match project with
       | Some p -> [ Printf.sprintf {|{"ts":"2026-11-09T09:01:00Z","task":"%s","type":"set","field":"project","to":"%s"}|} id p ]
       | None -> [])
  in
  append_events repo
    (created "T-aa01" "blocked" (Some "P-5e6f") @ created "T-aa02" "waiting" (Some "P-5e6f") @ created "T-aa03" "blocked" None);
  let _, doc = ok repo [ "project"; "P-5e6f" ] in
  let column = sorted (str_list (U.member "blocked" (U.member "columns" doc))) in
  let reprise = sorted (ids "blocked" (U.member "reprise" doc)) in
  Alcotest.check slist "column and reprise agree" reprise column;
  Alcotest.(check bool) "status blocked and waiting are blocked" true (List.mem "T-aa01" column && List.mem "T-aa02" column);
  Alcotest.(check int) "the count agrees" (List.length column)
    (U.to_int (U.member "blocked_tasks" (U.member "project" doc)));
  Alcotest.(check bool) "dependency count present" true
    (U.member "dependency_open_tasks" (U.member "project" doc) <> `Null);
  let _, products = ok repo [ "products" ] in
  let relay =
    List.find
      (fun p -> U.to_string (U.member "id" p) = "relay")
      (List.concat_map (fun c -> U.to_list (U.member "products" c)) (U.to_list (U.member "categories" products)))
  in
  Alcotest.(check int) "a product counts its blocked task" 3 (U.to_int (U.member "blocked_tasks" relay))

let test_other_column () =
  let repo = copy_fixture () in
  append_events repo
    [
      {|{"ts":"2026-11-09T09:00:00Z","task":"T-bb01","type":"created","title":"Odd","project":"relay","category":"platform","priority":"P2","status":"todo"}|};
      {|{"ts":"2026-11-09T09:01:00Z","task":"T-bb01","type":"set","field":"project","to":"P-5e6f"}|};
      {|{"ts":"2026-11-09T09:02:00Z","task":"T-bb01","type":"set","field":"status","to":"review"}|};
    ];
  let _, doc = ok repo [ "project"; "P-5e6f" ] in
  let columns = U.member "columns" doc in
  Alcotest.check slist "column names" [ "todo"; "in_progress"; "blocked"; "done"; "other" ] (List.map fst (U.to_assoc columns));
  let all = List.concat_map (fun (_, c) -> str_list c) (U.to_assoc columns) in
  Alcotest.check slist "every task in exactly one column" (sorted (ids "tasks" doc)) (sorted all);
  (* The library refuses an unknown status in an event, so [other] stays a
     guard for hand-edited data: the task keeps its last valid status. *)
  Alcotest.(check bool) "an unknown status does not hide the task" true
    (List.mem "T-bb01" (str_list (U.member "todo" columns)))

let test_resume_scoped_questions () =
  let repo = copy_fixture () in
  append_events repo
    [
      {|{"ts":"2026-11-09T10:04:00Z","task":"P-5e6f","type":"question","id":"N-0000beef","text":"Keep the pilot?","agent":"codex","session":"s-new"}|};
    ];
  let count args = U.to_int (U.member "open_questions" (snd (ok repo ("resume" :: args)))) in
  Alcotest.(check int) "everything" 1 (count []);
  Alcotest.(check int) "its project" 1 (count [ "--project"; "P-5e6f" ]);
  Alcotest.(check int) "its product" 1 (count [ "--product"; "relay" ]);
  Alcotest.(check int) "another product" 0 (count [ "--product"; "gateway" ])

let good_requests =
  [
    ({|{"op":"project","args":{"id":"P-5e6f"}}|}, "project");
    ({|{"op":"resume","args":{"all":true}}|}, "resume");
    ({|{"op":"products"}|}, "products");
    ({|{"op":"sessions-of","args":{"product":"relay"}}|}, "sessions-of");
  ]

let bad_requests =
  [
    "not json"; "[1]"; "{}"; {|{"op":"nope"}|}; {|{"op":5}|}; {|{"op":"products","args":{"extra":"x"}}|};
    {|{"op":"projects","args":[]}|}; {|{"op":"projects","args":{"product":5}}|}; {|{"op":"projects","args":{"product":""}}|};
    {|{"op":"projects","args":{"all":"yes"}}|}; {|{"op":"projects","args":{"all":false}}|};
    Printf.sprintf {|{"op":"projects","args":{"product":"%s"}}|} (String.make 101 'a');
    {|{"op":"task","args":{"argv":["--help"]}}|}; {|{"op":"sessions-of","args":{"id":"T-1a2b"}}|};
    {|{"op":"task","args":{"id":"T-1a2b\u0000x"}}|}; {|{"op":"task","args":{"id":"\ud800"}}|};
    {|{"op":"project","args":{"id":"--all"}}|}; {|{"op":"projects","args":{"product":"--all"}}|};
    {|{"op":"projects","args":{"id":"--all"}}|}; {|{"op":"projects","args":{"id":"--product","id":"relay"}}|};
    {|{"op":"sessions-of","args":{"id":"--task","id":"T-3c4d"}}|}; {|{"op":"sessions-of","args":{"id":"--all"}}|};
    {|{"op":"projects","args":{"product":"a","product":"b"}}|}; {|{"op":"task","args":{"id":"-T-1a2b"}}|};
    {|{"op":"products","op":"products"}|}; {|{"op":"products","x":1}|}; {|{"op":"project","args":{"id":"../../etc/passwd"}}|};
    {|{"op":"products"}|} ^ String.make 5000 ' ';
  ]

let test_request () =
  let repo = copy_fixture () in
  List.iter
    (fun (input, command) ->
      let _, doc = ok ~input repo [ "--request" ] in
      Alcotest.(check string) input command (U.to_string (U.member "command" doc)))
    good_requests;
  List.iter
    (fun input ->
      let r = run ~input repo [ "--request" ] in
      let label = String.escaped (if String.length input > 80 then String.sub input 0 80 else input) in
      Alcotest.(check int) ("exit code of " ^ label) 2 r.code;
      Alcotest.(check string) ("code of " ^ label) "invalid_input" (U.to_string (U.member "code" (U.member "error" (json r)))))
    bad_requests;
  Alcotest.(check int) "not found" 3 (run ~input:{|{"op":"project","args":{"id":"P-ffff"}}|} repo [ "--request" ]).code;
  Alcotest.(check int) "an extra word" 2 (run ~input:{|{"op":"products"}|} repo [ "--request"; "x" ]).code

let tests =
  [
    Alcotest.test_case "maximal questions and tasks stay readable" `Quick test_maximal_project;
    Alcotest.test_case "blocked is one notion" `Quick test_blocked_is_one_notion;
    Alcotest.test_case "every task in one column" `Quick test_other_column;
    Alcotest.test_case "resume questions are scoped" `Quick test_resume_scoped_questions;
    Alcotest.test_case "request on standard input" `Quick test_request;
  ]
