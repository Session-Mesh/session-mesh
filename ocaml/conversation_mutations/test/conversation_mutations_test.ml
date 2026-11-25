(* SPDX-License-Identifier: AGPL-3.0-or-later
   Copyright (c) 2026 Atacama <contact@atacama.tech> *)

open Conversation_mutations

let time n = Int (Int64.of_int n)
let incarnation = { name = "mesh-name"; created = time 1 }
let reused_name = { incarnation with created = time 2 }
let other_incarnation = { name = "other-name"; created = time 1 }
let first = { agent = Codex; sid = "original-123" }
let second = { agent = Codex; sid = "different-456" }
let observation ?(id = incarnation) ?(identity = Known first) label =
  { incarnation = id; identity; label }

let row ?(id = incarnation) ?(binding = Exact first) ?(label = "")
    ?(aliases = [ incarnation.name ]) ?closed_at seen =
  { incarnation = id; binding; label; aliases; seen = time seen; closed_at }

let observe ?(listed = true) now sessions entries =
  apply entries (Observe { listed; now = time now; sessions })

let rename now old_label new_label entries =
  apply entries (Rename { incarnation; now = time now; old_label; new_label })

let check message expected actual =
  Alcotest.(check bool) message expected actual

let test_closures () =
  let initial = [ row 10; row ~binding:(Exact second) 11 ] in
  let failed = observe ~listed:false 12 [] initial in
  check "failed listing leaves every row open" true
    (failed.entries = initial && not failed.dirty);
  let stale = observe 9 [] initial in
  check "earlier listing cannot close a later observation" true
    (stale.entries = initial && not stale.dirty);
  let closed = observe 12 [] initial in
  check "successful omission closes all bindings" true
    (closed.dirty
    && List.for_all
         (fun e -> e.closed_at = Some (time 12) && e.seen = time 12)
         closed.entries);
  let explicit = apply initial (Close { incarnation; now = time 12 }) in
  check "explicit close updates every binding" true (explicit = closed);
  let no_match = apply initial (Close { incarnation = reused_name; now = time 12 }) in
  check "explicit close requests persistence even when unmatched" true
    (no_match.dirty && no_match.entries = initial);
  let late =
    observe 13
      [ observation ~identity:(Known second) "late"; observation ~id:reused_name "new" ]
      closed.entries
  in
  check "closure sticks to the old incarnation only" true
    (late.entries = closed.entries @ [ row ~id:reused_name ~label:"new"
                                        ~aliases:[ incarnation.name; "new" ] 13 ]);
  let renamed = rename 14 "" "after closure" closed.entries in
  check "a rename does not remove the tombstone" true
    ((List.hd renamed.entries).closed_at = Some (time 12))

let test_binding_transitions () =
  let unbound = (rename 10 "original" "renamed" []).entries in
  let exact = observe 11 [ observation "renamed" ] unbound in
  let exact_row =
    row ~label:"renamed" ~aliases:[ incarnation.name; "original"; "renamed" ] 11
  in
  check "exact discovery replaces the unbound row and inherits aliases" true
    (exact.dirty && exact.entries = [ exact_row ]);
  let shell = observe 12 [ observation ~identity:Shell "renamed" ] exact.entries in
  check "returning shell keeps the binding" true
    (shell.entries = exact.entries && not shell.dirty);
  let ambiguous =
    observe 13 [ observation ~identity:Ambiguous "unresolved" ] shell.entries
  in
  check "an ambiguous running agent cannot relabel the older conversation" true
    (ambiguous.entries =
     [ exact_row;
       row ~binding:Unbound ~label:"unresolved"
         ~aliases:[ incarnation.name; "original"; "renamed"; "unresolved" ] 13 ]);
  let second_observation = observation ~identity:(Known second) "second" in
  let switched = observe 14 [ second_observation ] ambiguous.entries in
  let second_row =
    row ~binding:(Exact second) ~label:"second"
      ~aliases:[ incarnation.name; "original"; "renamed"; "unresolved"; "second" ] 14
  in
  check "a new exact conversation supersedes the unresolved row" true
    (switched.entries = [ exact_row; second_row ]);
  let returned = observe 15 [ observation "renamed" ] switched.entries in
  check "returning to an older binding promotes it" true
    (returned.dirty && returned.entries = [ { exact_row with seen = time 15 }; second_row ]);
  let renamed = rename 16 "renamed" "current" returned.entries in
  check "rename only changes the current binding" true
    ((List.hd renamed.entries).label = "current" && List.nth renamed.entries 1 = second_row)

let test_alias_order () =
  let aliases = List.init 20 (fun i -> "alias-" ^ string_of_int i) in
  let initial = [ row ~aliases 10 ] in
  let renamed = rename 11 "alias-0" "latest" initial in
  check "retain first occurrences before taking the last twenty" true
    ((List.hd renamed.entries).aliases =
     List.drop 2 aliases @ [ incarnation.name; "latest" ]);
  let repeated = rename 11 "alias-0" "latest" renamed.entries in
  check "rename requests persistence even without a timestamp change" true repeated.dirty

let test_dirty_and_stale () =
  let other = row ~id:other_incarnation ~aliases:[ other_incarnation.name ] 10 in
  let initial = [ row 10; other ] in
  let unchanged =
    observe 11 [ observation ""; observation ~id:other_incarnation "" ] initial
  in
  check "an unchanged poll stays clean" true
    (unchanged.entries = initial && not unchanged.dirty);
  let changed =
    observe 11 [ observation "changed"; observation ~id:other_incarnation "" ] initial
  in
  check "a prior change refreshes later rows in the inventory" true
    (changed.dirty && (List.nth changed.entries 1).seen = time 11);
  let stale =
    observe 10 [ observation "old"; observation ~id:other_incarnation "" ] changed.entries
  in
  check "earlier inventory cannot undo newer observations" true
    (stale.entries = changed.entries && not stale.dirty);
  let refresh =
    observe 86_410 [ observation ""; observation ~id:other_incarnation "" ] initial
  in
  check "unchanged rows refresh after a day" true
    (refresh.dirty && List.for_all (fun e -> e.seen = time 86_410) refresh.entries)

let test_ties_and_forget () =
  let first_row = row 10 in
  let second_row = row ~binding:(Exact second) 10 in
  let tied = [ first_row; second_row ] in
  let renamed = rename 10 "" "winner" tied in
  check "the earliest row in input wins equal seen timestamps" true
    ((List.hd renamed.entries).label = "winner" && List.nth renamed.entries 1 = second_row);
  let duplicates = [ first_row; first_row ] in
  let changed = observe 10 [ observation "only first" ] duplicates in
  check "equal records remain distinct rows" true
    ((List.hd changed.entries).label = "only first" && List.nth changed.entries 1 = first_row);
  let changed = apply tied (Forget first) in
  check "forget removes all rows for the exact agent and id" true
    (changed.dirty && changed.entries = [ second_row ]);
  let unchanged = apply tied (Forget { first with agent = Pi }) in
  check "a matching id for another agent is unrelated" true
    (unchanged.entries = tied && not unchanged.dirty)

let test_timestamp_representation () =
  let int_creation = { incarnation with created = Int 9_007_199_254_740_993L } in
  let float_creation = { incarnation with created = Float 9_007_199_254_740_992. } in
  let changed =
    observe 11 [ observation ~id:float_creation "" ] [ row ~id:int_creation 10 ]
  in
  check "distinct large numeric identities never collapse through rounding" true
    (List.length changed.entries = 2);
  let initial = [ row 10; row ~binding:(Exact second) 10 ] in
  let session = observation ~id:{ incarnation with created = Float 1. }
      ~identity:(Known second) "" in
  let changed = apply initial (Observe { listed = true; now = Float 10.; sessions = [ session ] }) in
  check "numeric identity ignores representation, as dirty detection preserves it" true
    (changed.dirty
    && changed.entries = [ List.hd initial; { (List.nth initial 1) with seen = Float 10. } ])

let test_projection_accepts_mutations () =
  let changed = apply [] (Rename {
    incarnation; now = Int 10L; old_label = ""; new_label = "new label";
  }) in
  Alcotest.(check (list string)) "project reducer output directly"
    [ incarnation.name; "new label" ]
    (Mesh_conversation_names.aliases changed.entries)

let () =
  Alcotest.run "Conversation mutations"
    [ ("reducer",
       [ Alcotest.test_case "closures and incarnations" `Quick test_closures;
         Alcotest.test_case "binding transitions" `Quick test_binding_transitions;
         Alcotest.test_case "alias ordering" `Quick test_alias_order;
         Alcotest.test_case "dirty and stale listings" `Quick test_dirty_and_stale;
         Alcotest.test_case "stable ties and forgetting" `Quick test_ties_and_forget;
         Alcotest.test_case "timestamp representation" `Quick test_timestamp_representation;
         Alcotest.test_case "shared projection model" `Quick test_projection_accepts_mutations
       ]) ]
