(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(* The retained bytes are [window.[off .. off + len - 1]]. Bytes are appended
   after the window and trimmed by advancing [off], so a read into a full
   replay copies only its own bytes; the window is moved back to the start of
   its storage once that storage is exhausted, about once per [capacity]
   bytes of output. *)
type t = {
  mutable window : Bytes.t;
  mutable off : int;
  mutable len : int;
  mutable trimmed : bool;
  modes : Mesh_pty_modes.t;
      (** The modes of the bytes trimmed so far: those of the window start. *)
}

let capacity = 2 * 1024 * 1024
let span = 4096

let create () =
  {
    window = Bytes.empty;
    off = 0;
    len = 0;
    trimmed = false;
    modes = Mesh_pty_modes.create ();
  }

let snapshot t = Bytes.sub_string t.window t.off t.len
let is_empty t = t.len = 0
let birth_bytes t = if t.trimmed then None else Some (snapshot t)

(* The end of the escape sequence starting at [i], or [i + 1] when it is not
   complete within [span] bytes. [byte] reads the [n] retained bytes. *)
let sequence_end byte n i =
  let limit = min n (i + span) in
  if i + 1 >= n then i + 1
  else
    match byte (i + 1) with
    | '[' ->
        let j = ref (i + 2) in
        while !j < limit && byte !j >= '\032' && byte !j <= '\063' do
          incr j
        done;
        if !j < limit && byte !j >= '\064' && byte !j <= '\126' then !j + 1
        else i + 1
    | ']' | 'P' | 'X' | '^' | '_' ->
        let rec scan j =
          if j >= limit then i + 1
          else if byte j = '\007' then j + 1
          else if byte j = '\027' && j + 1 < n && byte (j + 1) = '\\' then j + 2
          else scan (j + 1)
        in
        scan (i + 2)
    | _ ->
        let j = ref (i + 1) in
        while !j < limit && byte !j >= '\032' && byte !j <= '\047' do
          incr j
        done;
        if !j < limit && byte !j >= '\048' && byte !j <= '\126' then !j + 1
        else i + 1

(* Where to cut [n] retained bytes so that at most [capacity] remain: after
   the first newline at or past the excess, else after a crossing escape
   sequence and any UTF-8 continuation bytes. *)
let cut_point byte n =
  let start = n - capacity in
  let rec newline i =
    if i >= n then None
    else if byte i = '\n' then Some (i + 1)
    else newline (i + 1)
  in
  match newline start with
  | Some cut -> cut
  | None ->
      let i = ref (max 0 (start - span)) in
      while !i < start do
        i := if byte !i = '\027' then sequence_end byte n !i else !i + 1
      done;
      while !i < n && byte !i >= '\128' && byte !i <= '\191' do
        incr i
      done;
      !i

let reserve t extra =
  if t.off + t.len + extra > Bytes.length t.window then (
    if t.len + extra <= Bytes.length t.window / 2 then (
      Bytes.blit t.window t.off t.window 0 t.len;
      t.off <- 0)
    else
      let grown = Bytes.create (max 4096 (2 * (t.len + extra))) in
      Bytes.blit t.window t.off grown 0 t.len;
      t.window <- grown;
      t.off <- 0)

let feed t data =
  reserve t (String.length data);
  Bytes.blit_string data 0 t.window (t.off + t.len) (String.length data);
  t.len <- t.len + String.length data;
  if t.len > capacity then (
    t.trimmed <- true;
    let base = t.off in
    let cut = cut_point (fun i -> Bytes.unsafe_get t.window (base + i)) t.len in
    Mesh_pty_modes.feed t.modes t.window base cut;
    t.off <- t.off + cut;
    t.len <- t.len - cut)

module Raw = struct
  type error = Overflow | Invalid_cursor | Invalid_state | Gap
  type phase = New | First_append | Marked | Too_late

  type t = {
    bytes : bytes;
    mutable floor : int64;
    mutable head : int64;
    mutable replay_end : int64;
    mutable phase : phase;
    mutable sealed : bool;
  }

  let capacity = capacity

  let create () =
    {
      bytes = Bytes.create capacity;
      floor = 0L;
      head = 0L;
      replay_end = 0L;
      phase = New;
      sealed = false;
    }

  let floor t = t.floor
  let head t = t.head
  let replay_end t = t.replay_end

  let checked_advance ~offset ~length =
    if offset < 0L || length < 0 then Error Invalid_cursor
    else if offset > Int64.sub Int64.max_int (Int64.of_int length) then
      Error Overflow
    else Ok (Int64.add offset (Int64.of_int length))

  let position offset = Int64.to_int (Int64.rem offset (Int64.of_int capacity))

  let append t data =
    if t.sealed then Error Overflow
    else
      match checked_advance ~offset:t.head ~length:(String.length data) with
      | Error Overflow ->
          t.sealed <- true;
          Error Overflow
      | Error error -> Error error
      | Ok next ->
          let count = min capacity (String.length data) in
          let start = position (Int64.sub next (Int64.of_int count)) in
          let first = min count (capacity - start) in
          let source = String.length data - count in
          Bytes.blit_string data source t.bytes start first;
          Bytes.blit_string data (source + first) t.bytes 0 (count - first);
          t.head <- next;
          t.floor <-
            Int64.max t.floor
              (Int64.max 0L (Int64.sub next (Int64.of_int capacity)));
          t.phase <-
            (match t.phase with
            | New -> First_append
            | First_append -> Too_late
            | Marked -> Marked
            | Too_late -> Too_late);
          Ok ()

  let mark_initial_replay t =
    if t.sealed || t.phase <> First_append then Error Invalid_state
    else (
      t.replay_end <- t.head;
      t.phase <- Marked;
      Ok ())

  let read t ~offset ~maximum =
    if offset < 0L || offset > t.head || maximum < 1 || maximum > 32768 then
      Error Invalid_cursor
    else if offset < t.floor then Error Gap
    else
      let count = min maximum (Int64.to_int (Int64.sub t.head offset)) in
      let count =
        if offset < t.replay_end then
          min count (Int64.to_int (Int64.sub t.replay_end offset))
        else count
      in
      let result = Bytes.create count in
      let start = position offset in
      let first = min count (capacity - start) in
      Bytes.blit t.bytes start result 0 first;
      Bytes.blit t.bytes 0 result first (count - first);
      Ok (Bytes.unsafe_to_string result, count > 0 && offset < t.replay_end)
end

let replay t =
  let prefix = if t.trimmed then Mesh_pty_modes.prefix t.modes else "" in
  if prefix = "" then snapshot t
  else
    let length = String.length prefix in
    let bytes = Bytes.create (length + t.len) in
    Bytes.blit_string prefix 0 bytes 0 length;
    Bytes.blit t.window t.off bytes length t.len;
    Bytes.unsafe_to_string bytes
