(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

type 'a outcome = Ready of 'a | Slow | Failed of exn

module Progress = struct
  type t = int Atomic.t

  let create () = Atomic.make 0
  let tick t = Atomic.incr t
  let ticks t = Atomic.get t

  let watch ~clock ~idle t f =
    let rec watchdog seen =
      Eio.Time.sleep clock idle;
      let now = ticks t in
      if now = seen then Error `Stalled else watchdog now
    in
    Eio.Fiber.first (fun () -> Ok (f ())) (fun () -> watchdog (ticks t))
end

module Blocking = struct
  exception Saturated

  type t = { max_threads : int; in_flight : int Atomic.t; abandoned : int Atomic.t }

  (* Who finishes a call first: its thread ([Returned]) or its cancelled
     caller ([Abandoned]). Exactly one of them wins the transition. *)
  type call_state = Waiting | Returned | Abandoned

  let create ~max_threads =
    if max_threads < 1 then invalid_arg "Mesh_deadline_pool.Blocking.create";
    { max_threads; in_flight = Atomic.make 0; abandoned = Atomic.make 0 }

  let in_flight t = Atomic.get t.in_flight
  let abandoned t = Atomic.get t.abandoned
  let saturated t = in_flight t >= t.max_threads

  let rec reserve t =
    let current = Atomic.get t.in_flight in
    if current >= t.max_threads then raise Saturated
    else if not (Atomic.compare_and_set t.in_flight current (current + 1)) then reserve t

  let thread_returned t state =
    if not (Atomic.compare_and_set state Waiting Returned) then Atomic.decr t.abandoned;
    Atomic.decr t.in_flight

  let caller_cancelled t state =
    if Atomic.compare_and_set state Waiting Abandoned then Atomic.incr t.abandoned

  let call t fn =
    reserve t;
    let state = Atomic.make Waiting in
    let promise, resolver = Eio.Promise.create () in
    let body () =
      let result = match fn () with value -> Ok value | exception error -> Error error in
      thread_returned t state;
      Eio.Promise.resolve resolver result
    in
    (match Thread.create body () with
    | (_ : Thread.t) -> ()
    | exception error ->
        Atomic.decr t.in_flight;
        raise error);
    match Eio.Promise.await promise with
    | Ok value -> value
    | Error error -> raise error
    | exception (Eio.Cancel.Cancelled _ as cancelled) ->
        caller_cancelled t state;
        raise cancelled
end

let attempt ~clock ~deadline work item =
  match Eio.Time.with_timeout clock deadline (fun () -> Ok (work item)) with
  | Ok value -> Ready value
  | Error `Timeout -> Slow
  | exception (Eio.Cancel.Cancelled _ as cancelled) -> raise cancelled
  | exception error -> Failed error

let run ~clock ~max_concurrency ~deadline ?progress ~next ~work ~report () =
  if max_concurrency < 1 then invalid_arg "Mesh_deadline_pool.run: max_concurrency < 1";
  if not (deadline > 0.) then invalid_arg "Mesh_deadline_pool.run: deadline";
  let slots = Eio.Semaphore.make max_concurrency in
  Eio.Switch.run @@ fun switch ->
  let run_item item =
    Fun.protect
      ~finally:(fun () -> Eio.Semaphore.release slots)
      (fun () ->
        let outcome = attempt ~clock ~deadline work item in
        report item outcome;
        Option.iter Progress.tick progress)
  in
  let rec loop () =
    Eio.Semaphore.acquire slots;
    match next () with
    | None -> Eio.Semaphore.release slots
    | Some item ->
        Eio.Fiber.fork ~sw:switch (fun () -> run_item item);
        loop ()
  in
  loop ()
