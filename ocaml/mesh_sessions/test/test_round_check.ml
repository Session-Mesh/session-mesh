(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(* Rounds over several runs: corrections of a cross-session check that
   settle (one [same] event per session), a [describe] that sees the other
   sessions of the last round, and the counts and [degraded] fields of rounds
   whose rows fail, are refused or block every thread. *)

open Round_support

let codex_table = [ Fake.process ~pid:100 ~sid:100 "codex"; Fake.process ~pid:101 ~sid:101 "codex" ]
let checked = Mesh_agent.Registry.create [ Mesh_agent.adapter (module Checked) (Mesh_agent_roots.of_home "/x") ]
let older = `Assoc [ ("name", `String "old"); ("created", `Float 1.); ("pid", `Int 100) ]
let newer = `Assoc [ ("name", `String "new"); ("created", `Float 2.); ("pid", `Int 101) ]
let agent event = U.member "row" event |> U.member "agent"
let session_id event = U.member "session_id" (agent event)
let last name events = event_of name (List.rev events)

(* A corrected row is sent wrong at most once: the next rounds send it
   corrected at once, then [same], one event per session. *)
let test_corrections_settle () =
  with_engine ~registry:checked (Fake.platform codex_table) (fun engine ->
      let first, _ = round engine (request [ older; newer ]) in
      Alcotest.(check int) "first round: the correction is a second event" 3 (List.length first);
      for number = 2 to 3 do
        let events, final = round engine (request [ older; newer ]) in
        let label = Printf.sprintf "round %d: " number in
        Alcotest.(check (list string)) (label ^ "one event per session") [ "new"; "old" ] (List.sort compare (names events));
        Alcotest.(check bool) (label ^ "both same") true (List.for_all is_same events);
        Alcotest.(check bool) (label ^ "counted") true (U.member "counts" final |> U.member "ready" = `Int 2)
      done;
      (* The correction no longer holds: the row is sent corrected, then as described. *)
      let events, _ = round engine (request [ newer ]) in
      Alcotest.(check int) "withdrawn: sent again" 2 (List.length events);
      Alcotest.(check bool) "withdrawn: the id comes back" true (session_id (last "new" events) = `String "shared"))

(* A [describe] of one session checks it against the other sessions of the
   last round: it returns the id the round gives, not the one it withdraws. *)
let test_describe_sees_the_round () =
  with_engine ~registry:checked (Fake.platform codex_table) (fun engine ->
      ignore (round engine (request [ older; newer ]));
      let described sessions = Round.describe engine (request sessions) |> List.assoc "rows" |> U.to_list |> List.hd in
      Alcotest.(check bool) "newer alone: corrected" true (session_id (described [ newer ]) = `Null);
      Alcotest.(check bool) "older alone: keeps the id" true (session_id (described [ older ]) = `String "shared"));
  let gone = ref false in
  let full = Fake.platform codex_table and without_old = Fake.platform [ List.nth codex_table 1 ] in
  let current () = if !gone then without_old else full in
  let platform : Mesh_pty_processes.platform =
    {
      scan = (fun () -> (current ()).scan ());
      process = (fun pid -> (current ()).process pid);
      command_line = (fun pid -> (current ()).command_line pid);
      working_directory = (fun pid -> (current ()).working_directory pid);
      open_file_paths = (fun pid -> (current ()).open_file_paths pid);
    }
  in
  with_engine ~registry:checked platform (fun engine ->
      ignore (round engine (request [ older; newer ]));
      gone := true;
      let rows = Round.describe engine (request [ newer ]) |> List.assoc "rows" |> U.to_list in
      Alcotest.(check bool) "a session whose process is gone is no context" true
        (session_id (List.hd rows) = `String "shared"))

(* Session 100 is slow in rounds 1, 2 and 4 and raises in round 3. *)
let test_failed_resets_backoff () =
  let mode = Atomic.make `Slow in
  let on_read pid =
    if pid = 100 then match Atomic.get mode with `Slow -> Unix.sleepf 0.2 | `Raise -> failwith "unreadable"
  in
  with_engine ~config:(Round.config ~deadline:0.05 ()) (Fake.platform ~on_read (shells 2)) (fun engine ->
      let parsed = request [ session "s0" 100; session "s1" 101 ] in
      let state_in_round setting =
        Atomic.set mode setting;
        let events, _ = round engine parsed in
        Unix.sleepf 0.3;
        let event = event_of "s0" events in
        U.to_string (U.member "state" event) ^ Option.value ~default:"" (U.to_string_option (U.member "reason" event))
      in
      let states = List.map state_in_round [ `Slow; `Slow; `Raise; `Slow ] in
      Alcotest.(check (list string)) "a failure ends the slow streak" [ "slow"; "slow"; "errorfailed"; "slow" ] states)

(* An [emit] that refuses the rows of session [name] as too large. *)
let refuse name _ fields =
  if List.assoc_opt "name" fields = Some (`String name) && List.mem_assoc "row" fields then Error `Too_large
  else Ok ()

let test_too_large_counted () =
  with_engine (Fake.platform (shells 2)) (fun engine ->
      let events, final = round ~emit:(refuse "s1") engine (request [ session "s0" 100; session "s1" 101 ]) in
      Alcotest.(check bool) "replaced by an error" true (U.member "reason" (event_of "s1" events) = `String "too_large");
      Alcotest.(check bool) "counted as an error" true (U.member "counts" final |> U.member "error" = `Int 1);
      Alcotest.(check bool) "not as ready" true (U.member "counts" final |> U.member "ready" = `Int 1);
      Alcotest.(check bool) "incomplete" true (U.member "complete" final = `Bool false))

(* The corrected row of [new] is refused: the session counts as an error. *)
let test_correction_too_large_counted () =
  let emit _ fields =
    match List.assoc_opt "row" fields with
    | Some row when U.member "agent" row |> U.member "session_id" = `Null -> Error `Too_large
    | _ -> Ok ()
  in
  with_engine ~registry:checked (Fake.platform codex_table) (fun engine ->
      let events, final = round ~emit engine (request [ older; newer ]) in
      Alcotest.(check bool) "the correction is refused" true (U.member "reason" (last "new" events) = `String "too_large");
      Alcotest.(check bool) "counted as an error" true (U.member "counts" final |> U.member "error" = `Int 1);
      Alcotest.(check bool) "one ready" true (U.member "counts" final |> U.member "ready" = `Int 1))

(* Two slow rows take both threads: none is left for the next round, though
   no row of this one was refused for lack of a thread. *)
let test_restart_no_thread_left () =
  let on_read pid = if pid = 100 || pid = 101 then Unix.sleepf 0.5 in
  let config = Round.config ~deadline:0.1 ~max_threads:2 ~concurrency:2 () in
  with_engine ~config (Fake.platform ~on_read (shells 2)) (fun engine ->
      let events, final = round engine (request [ session "s0" 100; session "s1" 101 ]) in
      Alcotest.(check bool) "no row saturated" true (List.for_all (fun e -> U.member "reason" e <> `String "saturated") events);
      Alcotest.(check bool) "restart asked" true (U.member "degraded" final |> U.member "restart" = `Bool true);
      Unix.sleepf 0.6)

(* A round that starts while another is sending: each reports its own number. *)
let test_round_number () =
  with_engine (Fake.platform (shells 1)) (fun engine ->
      let parsed = request [ session "s0" 100 ] in
      let inner = ref `Null in
      let emit _ _ =
        if !inner = `Null then inner := U.member "round" (snd (round engine parsed));
        Ok ()
      in
      let _, outer = round ~emit engine parsed in
      Alcotest.(check bool) "the inner round is 2" true (!inner = `Int 2);
      Alcotest.(check bool) "the outer round is 1" true (U.member "round" outer = `Int 1))

let () =
  Alcotest.run "mesh_sessions_round_check"
    [
      ( "corrections",
        [
          Alcotest.test_case "settle after one round" `Quick test_corrections_settle;
          Alcotest.test_case "describe sees the round" `Quick test_describe_sees_the_round;
          Alcotest.test_case "refused correction counted" `Quick test_correction_too_large_counted;
        ] );
      ( "counts",
        [
          Alcotest.test_case "a failure resets the backoff" `Quick test_failed_resets_backoff;
          Alcotest.test_case "too large counted as error" `Quick test_too_large_counted;
          Alcotest.test_case "restart when no thread is left" `Quick test_restart_no_thread_left;
          Alcotest.test_case "round number" `Quick test_round_number;
        ] );
    ]
