(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

module Pool = Mesh_deadline_pool

(* Every Eio test below runs on a mock clock: time moves only when every
   fibre waits (run_full) or when the test advances it. Nothing sleeps. *)

let describe = function
  | Pool.Ready value -> "ready " ^ string_of_int value
  | Slow -> "slow"
  | Failed error -> "failed " ^ Printexc.to_string error

let next_of items =
  let remaining = ref items in
  fun () ->
    match !remaining with
    | [] -> None
    | item :: rest ->
        remaining := rest;
        Some item

let test_outcomes_and_bound () =
  Eio_mock.Backend.run_full @@ fun env ->
  let clock = env#clock in
  let running = ref 0 and highest = ref 0 and cancelled = ref [] in
  let reports = ref [] in
  let work (name, seconds) =
    incr running;
    highest := max !highest !running;
    Fun.protect
      ~finally:(fun () -> decr running)
      (fun () ->
        match Eio.Time.sleep clock seconds with
        | () -> if name = "raises" then failwith "boom" else int_of_float seconds
        | exception (Eio.Cancel.Cancelled _ as e) ->
            cancelled := name :: !cancelled;
            raise e)
  in
  let progress = Pool.Progress.create () in
  Pool.run ~clock ~max_concurrency:2 ~deadline:2. ~progress
    ~next:(next_of [ ("a", 1.); ("hangs", 10.); ("b", 1.5); ("raises", 0.5) ])
    ~work
    ~report:(fun (name, _) outcome -> reports := (name, describe outcome) :: !reports)
    ();
  let sorted = List.sort compare !reports in
  Alcotest.(check (list (pair string string)))
    "one outcome each"
    [ ("a", "ready 1"); ("b", "ready 1"); ("hangs", "slow"); ("raises", "failed Failure(\"boom\")") ]
    sorted;
  Alcotest.(check int) "never more than two at once" 2 !highest;
  Alcotest.(check (list string)) "the overdue fibre was cancelled" [ "hangs" ] !cancelled;
  Alcotest.(check int) "every item ticked" 4 (Pool.Progress.ticks progress);
  Alcotest.(check int) "nothing left running" 0 !running

let test_pull_order_follows_queue () =
  let module Queue = Mesh_priority.Make (String) (Int) in
  Eio_mock.Backend.run_full @@ fun env ->
  let clock = env#clock in
  let queue = Queue.create () in
  List.iter (fun key -> Queue.add queue key (Queue.priority 0) ()) [ "a"; "b"; "c"; "d" ];
  let started = ref [] in
  Pool.run ~clock ~max_concurrency:1 ~deadline:5.
    ~next:(fun () -> Option.map fst (Queue.pop queue))
    ~work:(fun key ->
      started := key :: !started;
      (* While "a" runs, the caller learns that "d" is wanted first. *)
      if key = "a" then ignore (Queue.bump queue "d");
      Eio.Time.sleep clock 1.)
    ~report:(fun _ _ -> ())
    ();
  Alcotest.(check (list string)) "bumped item pulled next" [ "a"; "d"; "b"; "c" ] (List.rev !started)

let test_watchdog () =
  Eio_mock.Backend.run_full @@ fun env ->
  let clock = env#clock in
  let progress = Pool.Progress.create () in
  let steady () =
    for _ = 1 to 5 do
      Eio.Time.sleep clock 1.;
      Pool.Progress.tick progress
    done;
    "done"
  in
  Alcotest.(check bool) "a round that progresses is not stopped" true
    (Pool.Progress.watch ~clock ~idle:2. progress steady = Ok "done");
  let start = Eio.Time.now clock in
  let stalled () =
    Eio.Time.sleep clock 100.;
    "never"
  in
  Alcotest.(check bool) "a silent round is stopped" true
    (Pool.Progress.watch ~clock ~idle:2. progress stalled = Error `Stalled);
  Alcotest.(check (float 0.001)) "after the idle time" 2. (Eio.Time.now clock -. start)

(* A gate a system thread blocks on until the test opens it. *)
type gate = { mutex : Mutex.t; condition : Condition.t; mutable opened : bool }

let gate () = { mutex = Mutex.create (); condition = Condition.create (); opened = false }

let wait_gate gate =
  Mutex.lock gate.mutex;
  while not gate.opened do
    Condition.wait gate.condition gate.mutex
  done;
  Mutex.unlock gate.mutex

let open_gate gate =
  Mutex.lock gate.mutex;
  gate.opened <- true;
  Condition.broadcast gate.condition;
  Mutex.unlock gate.mutex

let rec until_true ?(budget = 1_000_000) condition =
  if not (condition ()) then
    if budget = 0 then Alcotest.fail "condition never became true"
    else begin
      Thread.yield ();
      Eio.Fiber.yield ();
      until_true ~budget:(budget - 1) condition
    end

let test_blocking_results () =
  Eio_main.run @@ fun _ ->
  let blocking = Pool.Blocking.create ~max_threads:2 in
  Alcotest.(check int) "value" 42 (Pool.Blocking.call blocking (fun () -> 6 * 7));
  Alcotest.check_raises "exception re-raised" (Failure "inner") (fun () ->
      Pool.Blocking.call blocking (fun () -> failwith "inner"));
  until_true (fun () -> Pool.Blocking.in_flight blocking = 0)

let test_blocking_abandoned () =
  Eio_main.run @@ fun _ ->
  let clock = Eio_mock.Clock.make () in
  let blocking = Pool.Blocking.create ~max_threads:1 in
  let gate = gate () in
  let outcome = ref None in
  Eio.Fiber.both
    (fun () ->
      Pool.run ~clock ~max_concurrency:1 ~deadline:2.
        ~next:(next_of [ () ])
        ~work:(fun () ->
          Pool.Blocking.call blocking (fun () ->
              wait_gate gate;
              1))
        ~report:(fun () result -> outcome := Some (describe result))
        ())
    (fun () ->
      until_true (fun () -> Pool.Blocking.in_flight blocking = 1);
      (* The deadline's timer is registered once the item's fibres ran. *)
      until_true (fun () -> Eio_mock.Clock.try_advance clock));
  Alcotest.(check (option string)) "blocked call is slow" (Some "slow") !outcome;
  Alcotest.(check int) "thread abandoned" 1 (Pool.Blocking.abandoned blocking);
  Alcotest.(check bool) "pool saturated" true (Pool.Blocking.saturated blocking);
  Alcotest.check_raises "no thread for a new call" Pool.Blocking.Saturated (fun () ->
      Pool.Blocking.call blocking ignore);
  open_gate gate;
  until_true (fun () -> Pool.Blocking.in_flight blocking = 0);
  Alcotest.(check int) "returned thread no longer abandoned" 0 (Pool.Blocking.abandoned blocking);
  Alcotest.(check int) "usable again" 3 (Pool.Blocking.call blocking (fun () -> 3))

(* A fibre already cancelled starts no thread: the thread would block on the
   held mutex, so a started one would still be in flight at the check. *)
let test_blocking_cancelled_first () =
  Eio_mock.Backend.run @@ fun () ->
  let blocking = Pool.Blocking.create ~max_threads:1 in
  let held = Mutex.create () in
  Mutex.lock held;
  let started = Atomic.make false in
  let cancelled =
    match
      Eio.Cancel.sub (fun context ->
          Eio.Cancel.cancel context Exit;
          Pool.Blocking.call blocking (fun () ->
              Atomic.set started true;
              Mutex.lock held;
              Mutex.unlock held))
    with
    | () -> false
    | exception Eio.Cancel.Cancelled _ -> true
  in
  let in_flight = Pool.Blocking.in_flight blocking in
  Mutex.unlock held;
  Alcotest.(check bool) "the call is cancelled" true cancelled;
  Alcotest.(check int) "no thread started" 0 in_flight;
  Alcotest.(check bool) "the function never ran" false (Atomic.get started)

let test_arguments () =
  Alcotest.check_raises "concurrency" (Invalid_argument "Mesh_deadline_pool.run: max_concurrency < 1")
    (fun () ->
      Eio_mock.Backend.run_full @@ fun env ->
      Pool.run ~clock:env#clock ~max_concurrency:0 ~deadline:1. ~next:(fun () -> None)
        ~work:Fun.id ~report:(fun _ _ -> ()) ());
  Alcotest.check_raises "threads" (Invalid_argument "Mesh_deadline_pool.Blocking.create")
    (fun () -> ignore (Pool.Blocking.create ~max_threads:0))

let () =
  Alcotest.run "mesh_deadline_pool"
    [
      ( "pool",
        [
          Alcotest.test_case "outcomes, bound, cancellation" `Quick test_outcomes_and_bound;
          Alcotest.test_case "pulls follow the queue" `Quick test_pull_order_follows_queue;
          Alcotest.test_case "no-progress watchdog" `Quick test_watchdog;
          Alcotest.test_case "arguments" `Quick test_arguments;
        ] );
      ( "blocking",
        [
          Alcotest.test_case "results and exceptions" `Quick test_blocking_results;
          Alcotest.test_case "abandoned at the deadline" `Quick test_blocking_abandoned;
          Alcotest.test_case "cancelled before starting" `Quick test_blocking_cancelled_first;
        ] );
    ]
