(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(* The legacy replay keeps the last two MiB of terminal output, cut on a
   newline or after a crossing escape sequence. The oracle below is the
   string-concatenation implementation it replaced, kept verbatim: the window
   must retain exactly the same bytes, while no longer copying the whole two
   MiB on every read once full. *)

module L = Mesh_pty_support.Mesh_pty_replay

module Oracle = struct
  type t = { mutable bytes : string; mutable trimmed : bool }

  let capacity = 2 * 1024 * 1024
  let span = 4096
  let create () = { bytes = ""; trimmed = false }
  let snapshot t = t.bytes
  let birth_bytes t = if t.trimmed then None else Some t.bytes

  let sequence_end bytes i =
    let n = String.length bytes in
    let limit = min n (i + span) in
    if i + 1 >= n then i + 1
    else
      match bytes.[i + 1] with
      | '[' ->
          let j = ref (i + 2) in
          while !j < limit && bytes.[!j] >= '\032' && bytes.[!j] <= '\063' do
            incr j
          done;
          if !j < limit && bytes.[!j] >= '\064' && bytes.[!j] <= '\126' then
            !j + 1
          else i + 1
      | ']' | 'P' | 'X' | '^' | '_' ->
          let rec scan j =
            if j >= limit then i + 1
            else if bytes.[j] = '\007' then j + 1
            else if bytes.[j] = '\027' && j + 1 < n && bytes.[j + 1] = '\\' then
              j + 2
            else scan (j + 1)
          in
          scan (i + 2)
      | _ ->
          let j = ref (i + 1) in
          while !j < limit && bytes.[!j] >= '\032' && bytes.[!j] <= '\047' do
            incr j
          done;
          if !j < limit && bytes.[!j] >= '\048' && bytes.[!j] <= '\126' then
            !j + 1
          else i + 1

  let feed t data =
    let bytes = t.bytes ^ data in
    let n = String.length bytes in
    let start = n - capacity in
    if start <= 0 then t.bytes <- bytes
    else (
      t.trimmed <- true;
      let cut =
        match String.index_from_opt bytes start '\n' with
        | Some i -> i + 1
        | None ->
            let i = ref (max 0 (start - span)) in
            while !i < start do
              i := if bytes.[!i] = '\027' then sequence_end bytes !i else !i + 1
            done;
            while !i < n && bytes.[!i] >= '\128' && bytes.[!i] <= '\191' do
              incr i
            done;
            !i
      in
      t.bytes <- String.sub bytes cut (n - cut))
end

(* Terminal-like chunks: plain runs, rare newlines, escape sequences (some
   unterminated), UTF-8 continuations, and occasional large bursts. *)
let chunk state =
  let piece () =
    match Random.State.int state 10 with
    | 0 -> "\n"
    | 1 -> "\027[" ^ string_of_int (Random.State.int state 100) ^ "m"
    | 2 -> "\027]0;title\007"
    | 3 -> "\027]8;;" ^ String.make (Random.State.int state 5000) 'u'
    | 4 -> "\xc3\xa9\xe2\x82\xac"
    | 5 -> "\027(B"
    | 6 -> String.make (Random.State.int state 70_000) 'a'
    | _ ->
        String.init (Random.State.int state 300) (fun _ ->
            Char.chr (32 + Random.State.int state 95))
  in
  String.concat ""
    (List.init (1 + Random.State.int state 8) (fun _ -> piece ()))

let same_as_oracle () =
  List.iter
    (fun seed ->
      let state = Random.State.make [| seed |] in
      let window = L.create () and oracle = Oracle.create () in
      for step = 1 to 400 do
        let data = chunk state in
        L.feed window data;
        Oracle.feed oracle data;
        if L.snapshot window <> Oracle.snapshot oracle then
          Alcotest.failf "seed %d step %d: retained bytes differ" seed step;
        if L.birth_bytes window <> Oracle.birth_bytes oracle then
          Alcotest.failf "seed %d step %d: birth completeness differs" seed step;
        if L.is_empty window <> (Oracle.snapshot oracle = "") then
          Alcotest.failf "seed %d step %d: emptiness differs" seed step
      done)
    [ 1; 2; 3; 4; 5; 6; 7; 8 ]

let single_feed_larger_than_capacity () =
  let window = L.create () and oracle = Oracle.create () in
  let data =
    String.init
      ((3 * Oracle.capacity) + 11)
      (fun n -> if n mod 997 = 0 then '\n' else Char.chr (32 + (n mod 90)))
  in
  L.feed window "head";
  Oracle.feed oracle "head";
  L.feed window data;
  Oracle.feed oracle data;
  Alcotest.(check bool)
    "same suffix" true
    (L.snapshot window = Oracle.snapshot oracle)

(* Once full, a 64 KiB read used to allocate the whole window twice (the
   concatenation and the cut). The window now allocates nothing per read. *)
let full_window_reads_do_not_copy_it () =
  let window = L.create () in
  let read = String.make 65536 'x' ^ "\n" in
  for _ = 1 to 80 do
    L.feed window read
  done;
  let before = Gc.allocated_bytes () in
  for _ = 1 to 100 do
    L.feed window read
  done;
  let allocated = Gc.allocated_bytes () -. before in
  if allocated > float_of_int (1024 * 1024) then
    Alcotest.failf "100 reads into a full replay allocated %.0f bytes" allocated

let () =
  Alcotest.run "PTY replay window"
    [
      ( "legacy replay",
        [
          Alcotest.test_case "retains exactly the former bytes" `Quick
            same_as_oracle;
          Alcotest.test_case "one feed larger than the capacity" `Quick
            single_feed_larger_than_capacity;
          Alcotest.test_case "a read into a full window copies no window" `Quick
            full_window_reads_do_not_copy_it;
        ] );
    ]
