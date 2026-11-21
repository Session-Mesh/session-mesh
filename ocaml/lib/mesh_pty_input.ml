(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

let capacity = 8 * 1024 * 1024

type frame = Data of string * (unit -> bool) option | Submit_delay | Submit_enter

exception Retired_input

type t = {
  name : string;
  frames : frame Queue.t;
  wake : Eio.Condition.t;
  stopped : unit Eio.Promise.t;
  stop : unit Eio.Promise.u;
  mutable bytes : int;
  mutable dropping : bool;
  mutable closed : bool;
  mutable guarded_write : (Eio.Cancel.t * unit Eio.Promise.t) option;
}

let create name =
  let stopped, stop = Eio.Promise.create () in
  {
    name;
    frames = Queue.create ();
    wake = Eio.Condition.create ();
    stopped;
    stop;
    bytes = 0;
    dropping = false;
    closed = false;
    guarded_write = None;
  }

let close t =
  if not t.closed then (
    t.closed <- true;
    Queue.clear t.frames;
    t.bytes <- 0;
    Eio.Promise.resolve t.stop ();
    Eio.Condition.broadcast t.wake)

(* A wake's Enter not yet written is withdrawn, its delay with it; the
   notice text already typed stays in the agent's editor, unsent. *)
let cancel_submit t =
  let enters =
    Queue.fold
      (fun count frame -> match frame with Submit_enter -> count + 1 | _ -> count)
      0 t.frames
  in
  if enters > 0 then (
    let kept = Queue.create () in
    Queue.iter
      (function
        | Submit_delay | Submit_enter -> ()
        | Data _ as frame -> Queue.add frame kept)
      t.frames;
    (* An Enter counts one byte; a delay counts none. *)
    t.bytes <- t.bytes - enters;
    Queue.clear t.frames;
    Queue.transfer kept t.frames;
    Eio.Condition.broadcast t.wake);
  enters > 0

(* Replies a terminal sends on its own, not keys: focus in/out (ESC [ I,
   ESC [ O), X10 mouse (ESC [ M and three bytes >= 0x20), SGR mouse
   (ESC [ < n ; n ; n M|m), cursor position (ESC [ n ; n R) and device status
   (ESC [ n n). *)
let terminal_reports_only data =
  let length = String.length data in
  let is_digit i = i < length && data.[i] >= '0' && data.[i] <= '9' in
  (* The index after one or more digits from [i], or None. *)
  let digits i =
    if not (is_digit i) then None
    else
      let rec skip j = if is_digit j then skip (j + 1) else j in
      Some (skip i)
  in
  let byte_is i c = i < length && data.[i] = c in
  (* The index after [n] digit groups separated by ';' from [i], or None. *)
  let rec groups i n =
    match digits i with
    | None -> None
    | Some j when n = 1 -> Some j
    | Some j -> if byte_is j ';' then groups (j + 1) (n - 1) else None
  in
  let report i =
    if not (byte_is i '\x1b' && byte_is (i + 1) '[') then None
    else
      let i = i + 2 in
      if byte_is i 'I' || byte_is i 'O' then Some (i + 1)
      else if byte_is i 'M' then
        if i + 3 < length && String.for_all (fun c -> c >= ' ') (String.sub data (i + 1) 3)
        then Some (i + 4)
        else None
      else if byte_is i '<' then
        match groups (i + 1) 3 with
        | Some j when byte_is j 'M' || byte_is j 'm' -> Some (j + 1)
        | _ -> None
      else
        match (groups i 2, digits i) with
        | Some j, _ when byte_is j 'R' -> Some (j + 1)
        | _, Some j when byte_is j 'n' -> Some (j + 1)
        | _ -> None
  in
  let rec all i =
    i = length || match report i with Some j -> all j | None -> false
  in
  length > 0 && all 0

let enqueue ?current t data =
  if t.closed then false
  else if data = "" then true
  else if String.length data > capacity - t.bytes then (
    if not t.dropping then (
      t.dropping <- true;
      Printf.eprintf
        "ptyhost: %s: input dropped, program not reading (%d bytes pending)\n%!"
        t.name t.bytes);
    false)
  else
    (* Input that arrives while a wake's Enter waits withdraws that Enter and
       erases the notice's line (Ctrl-U) before the input: whoever types may
       be answering something the notice must not answer. Terminal reports
       alone (focus, mouse) are not typing: they pass through and leave it. *)
    let data =
      if (not (terminal_reports_only data)) && cancel_submit t then "\x15" ^ data
      else data
    in
    t.bytes <- t.bytes + String.length data;
    Queue.add (Data (data, current)) t.frames;
    Eio.Condition.broadcast t.wake;
    true

let enqueue_submit t data =
  let length = String.length data + 1 in
  if t.closed then false
  else if length > capacity - t.bytes then (
    if not t.dropping then (
      t.dropping <- true;
      Printf.eprintf
        "ptyhost: %s: input dropped, program not reading (%d bytes pending)\n%!"
        t.name t.bytes);
    false)
  else (
    t.bytes <- t.bytes + length;
    Queue.add (Data (data, None)) t.frames;
    Queue.add Submit_delay t.frames;
    Queue.add Submit_enter t.frames;
    Eio.Condition.broadcast t.wake;
    true)

let rec next t =
  if t.closed then None
  else if Queue.is_empty t.frames then (
    Eio.Condition.await_no_mutex t.wake;
    next t)
  else Some (Queue.peek t.frames)

let retire_guarded t =
  let kept = Queue.create () in
  Queue.iter
    (function
      | Data (data, Some _) -> t.bytes <- t.bytes - String.length data
      | frame -> Queue.add frame kept)
    t.frames;
  Queue.clear t.frames;
  Queue.transfer kept t.frames;
  if Queue.is_empty t.frames then t.dropping <- false;
  match t.guarded_write with
  | None -> ()
  | Some (context, finished) ->
      Eio.Cancel.cancel context Retired_input;
      Eio.Promise.await finished

let run t clock sink =
  let guarded current data =
    if current () then
      let finished, finish = Eio.Promise.create () in
      Fun.protect
        ~finally:(fun () ->
          t.guarded_write <- None;
          Eio.Promise.resolve finish ())
        (fun () ->
          try
            Eio.Cancel.sub (fun context ->
                t.guarded_write <- Some (context, finished);
                Eio.Flow.write sink [Cstruct.of_string data])
          with Eio.Cancel.Cancelled Retired_input -> ())
  in
  let rec write () =
    match next t with
    | None -> ()
    | Some Submit_delay ->
        Eio.Time.sleep clock 0.25;
        (* Input during the delay may have withdrawn this frame. *)
        (if
           (not t.closed)
           && match Queue.peek_opt t.frames with Some Submit_delay -> true | _ -> false
         then
           ignore (Queue.take t.frames));
        write ()
    | Some Submit_enter ->
        (* Committed before the write, which may yield: input arriving
           meanwhile can no longer withdraw it, nor be taken in its place. *)
        ignore (Queue.take t.frames);
        t.bytes <- t.bytes - 1;
        if Queue.is_empty t.frames then t.dropping <- false;
        Eio.Flow.write sink [ Cstruct.of_string "\r" ];
        Eio.Fiber.yield ();
        write ()
    | Some (Data (data, current) as frame) ->
        (match current with
        | None -> Eio.Flow.write sink [ Cstruct.of_string data ]
        | Some current -> guarded current data);
        if
          not t.closed
          && Option.fold ~none:false ~some:(( == ) frame) (Queue.peek_opt t.frames)
        then (
          ignore (Queue.take t.frames);
          t.bytes <- t.bytes - String.length data;
          if Queue.is_empty t.frames then t.dropping <- false);
        Eio.Fiber.yield ();
        write ()
  in
  Eio.Fiber.first
    (fun () -> try write () with Eio.Io _ | Unix.Unix_error _ -> close t)
    (fun () -> Eio.Promise.await t.stopped)
