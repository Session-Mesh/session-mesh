(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

module Reader = struct
  exception Stop_reader

  type t = {
    mutable started : bool;
    mutable stopped : bool;
    mutable cancel : (unit -> unit) option;
  }

  let create () = { started = false; stopped = false; cancel = None }

  let stop t =
    if not t.stopped then (
      t.stopped <- true;
      Option.iter (fun cancel -> cancel ()) t.cancel)

  let run t read =
    if t.started then invalid_arg "PTY output reader already run";
    t.started <- true;
    if not t.stopped then
      try
        Eio.Cancel.sub (fun context ->
            t.cancel <- Some (fun () -> Eio.Cancel.cancel context Stop_reader);
            Fun.protect ~finally:(fun () -> t.cancel <- None) read)
      with Eio.Cancel.Cancelled Stop_reader when t.stopped -> ()
end

(* A queued item is either an opaque encoded frame or live terminal output
   still open for appending. Consecutive live output coalesces into one D frame
   while it waits, so a reader that falls behind receives fewer, larger frames
   instead of one frame per PTY read. Nothing waits to coalesce: an item is
   encoded as soon as the writer takes it. *)
type live = {
  mutable shared : string;
  mutable merged : Bytes.t option;
  mutable length : int;
}
(* A live item starts as the string the producer handed to every client
   ([shared], not copied: clients that never need a merge keep sharing it).
   The first merge copies it into [merged], whose capacity is the needed
   length plus a quarter, never a doubling, so the retained memory stays
   within about 1.25 times the counted payload. [length] is the payload size. *)

type item = Frame of string | Output of live

type t = {
  queue : item Queue.t;
  mutable tail : live option;
  wake : Eio.Condition.t;
  mutable bytes : int;
  mutable finishing : bool;
  mutable closed : bool;
  aborted : unit Eio.Promise.t;
  abort : unit Eio.Promise.u;
  done_ : unit Eio.Promise.t;
  detach : unit Eio.Promise.u;
  mutable detached : bool;
}

let limit = 8 * 1024 * 1024

(* Never larger than one PTY read, so no reader sees a larger D frame than
   before coalescing. *)
let coalesce_limit = 65536
let header = String.length (Mesh_wire.encode { kind = 'D'; payload = "" })

let create () =
  let aborted, abort = Eio.Promise.create () in
  let done_, detach = Eio.Promise.create () in
  {
    queue = Queue.create ();
    tail = None;
    wake = Eio.Condition.create ();
    bytes = 0;
    finishing = false;
    closed = false;
    aborted;
    abort;
    done_;
    detach;
    detached = false;
  }

let close t =
  if not t.closed then (
    t.closed <- true;
    Queue.clear t.queue;
    t.tail <- None;
    Eio.Promise.resolve t.abort ();
    Eio.Condition.broadcast t.wake)

(* Pending accounting counts encoded bytes, headers included, until the
   write completes; adding [size] must keep it within [limit]. *)
let admit t size =
  if t.closed || t.finishing then false
  else if size > limit - t.bytes then (
    close t;
    false)
  else (
    t.bytes <- t.bytes + size;
    true)

let enqueue t frame =
  if not (admit t (String.length frame)) then false
  else (
    t.tail <- None;
    Queue.add (Frame frame) t.queue;
    Eio.Condition.broadcast t.wake;
    true)

(* Room for [needed] bytes plus a quarter of slack, capped at [coalesce_limit],
   the most a merged frame can hold: [Buffer]'s doubling growth and retained
   initial buffer hold up to three times the payload. *)
let capacity_for needed = min (needed + (needed / 4) + 16) coalesce_limit

(* The bytes of [live] with room for [total], copying only when it must. *)
let room live total =
  match live.merged with
  | Some bytes when Bytes.length bytes >= total -> bytes
  | previous ->
      let bytes = Bytes.create (capacity_for total) in
      (match previous with
      | Some old -> Bytes.blit old 0 bytes 0 live.length
      | None -> Bytes.blit_string live.shared 0 bytes 0 live.length);
      live.shared <- "";
      live.merged <- Some bytes;
      bytes

let append live data =
  let size = String.length data in
  let bytes = room live (live.length + size) in
  Bytes.blit_string data 0 bytes live.length size;
  live.length <- live.length + size

let payload live =
  match live.merged with
  | None -> live.shared
  | Some bytes -> Bytes.sub_string bytes 0 live.length

let enqueue_output t data =
  let size = String.length data in
  match t.tail with
  | Some live when live.length + size <= coalesce_limit ->
      if not (admit t size) then false
      else (
        append live data;
        true)
  | _ ->
      if not (admit t (header + size)) then false
      else
        let live = { shared = data; merged = None; length = size } in
        t.tail <- Some live;
        Queue.add (Output live) t.queue;
        Eio.Condition.broadcast t.wake;
        true

let encode t = function
  | Frame frame -> frame
  | Output live ->
      (match t.tail with
      | Some tail when tail == live -> t.tail <- None
      | _ -> ());
      Mesh_wire.encode { kind = 'D'; payload = payload live }

let rec next t =
  if t.closed then None
  else if not (Queue.is_empty t.queue) then Some (encode t (Queue.take t.queue))
  else if t.finishing then None
  else (
    Eio.Condition.await_no_mutex t.wake;
    next t)

let sent t frame = t.bytes <- t.bytes - String.length frame

let finish t =
  t.finishing <- true;
  Eio.Condition.broadcast t.wake

let aborted t = t.aborted
let done_ t = t.done_

let detached t =
  close t;
  if not t.detached then (
    t.detached <- true;
    Eio.Promise.resolve t.detach ())
