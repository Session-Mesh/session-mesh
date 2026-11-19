(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

module Tail = Mesh_jsonl_tail
module Lru = Mesh_lru.Make (String)

type 's entry = { path : string; tail : 's Tail.t }
type counters = { restarted : int; appended : int; unchanged : int }

type 's t = {
  limits : Tail.limits;
  fold : 's Tail.fold;
  lock : Mutex.t;
  entries : 's entry Lru.t;
  mutable counters : counters;
}

let create limits fold =
  {
    limits;
    fold;
    lock = Mutex.create ();
    entries = Lru.create ~max_entries:64 ();
    counters = { restarted = 0; appended = 0; unchanged = 0 };
  }

let locked cache f = Mutex.protect cache.lock f
let resize cache entries = locked cache (fun () -> Lru.set_max_entries cache.entries (max 1 entries))
let counters cache = locked cache (fun () -> cache.counters)

let count cache (outcome : Tail.outcome) =
  locked cache (fun () ->
      let counted = cache.counters in
      cache.counters <-
        (match outcome with
        | Restarted -> { counted with restarted = counted.restarted + 1 }
        | Appended -> { counted with appended = counted.appended + 1 }
        | Unchanged -> { counted with unchanged = counted.unchanged + 1 }))

let read cache ~key path =
  let previous =
    locked cache (fun () ->
        match Lru.find cache.entries key with Some entry when entry.path = path -> Some entry.tail | _ -> None)
  in
  match Tail.update cache.limits cache.fold path previous with
  | Ok (tail, outcome) ->
      count cache outcome;
      locked cache (fun () -> Lru.add cache.entries key { path; tail });
      Some tail
  | Error _ | (exception Unix.Unix_error _) ->
      locked cache (fun () -> Lru.remove cache.entries key);
      None
