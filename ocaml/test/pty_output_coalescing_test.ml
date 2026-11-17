(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(* Coalescing of live terminal output in Mesh_pty_output (issue #578). The queue
   is single-domain and [next] never blocks while a frame is pending, so these
   tests need no scheduler. *)

module Output = Mesh_pty_support.Mesh_pty_output

let header = 5

let encode kind payload =
  Mesh_wire.encode { Mesh_wire.kind; payload }

let decode wire =
  match Mesh_wire.decode wire with
  | Ok (frame, "") -> frame
  | Ok (_, _) -> Alcotest.fail "trailing bytes after one frame"
  | Error _ -> Alcotest.fail "undecodable frame"

(* Take every pending item. Each [next] result is one writer batch. *)
let take_all client =
  Output.finish client;
  let rec loop acc =
    match Output.next client with
    | None -> List.rev acc
    | Some wire -> loop (decode wire :: acc)
  in
  loop []

let accepted label ok = Alcotest.(check bool) label true ok
let refused label ok = Alcotest.(check bool) label false ok

let kinds frames = List.map (fun (f : Mesh_wire.frame) -> f.kind) frames
let payloads frames = List.map (fun (f : Mesh_wire.frame) -> f.payload) frames

let ceiling_respected () =
  let client = Output.create () in
  let chunk = String.make 1000 'a' in
  for _ = 1 to 200 do
    accepted "chunk accepted" (Output.enqueue_output client chunk)
  done;
  let frames = take_all client in
  let sizes = List.map String.length (payloads frames) in
  Alcotest.(check bool)
    "no D payload above one PTY read" true
    (List.for_all (fun n -> n <= Output.coalesce_limit) sizes);
  Alcotest.(check int) "payload bytes preserved" 200_000
    (List.fold_left ( + ) 0 sizes);
  Alcotest.(check int) "first frame fills the ceiling" 65_000 (List.hd sizes);
  Alcotest.(check (list char)) "only D frames" (List.map (fun _ -> 'D') sizes)
    (kinds frames)

let exact_ceiling () =
  let client = Output.create () in
  let half = String.make (Output.coalesce_limit / 2) 'b' in
  accepted "first half" (Output.enqueue_output client half);
  accepted "second half" (Output.enqueue_output client half);
  accepted "one more byte" (Output.enqueue_output client "z");
  let sizes = List.map String.length (payloads (take_all client)) in
  Alcotest.(check (list int))
    "exactly the ceiling, then a new frame"
    [ Output.coalesce_limit; 1 ]
    sizes

let never_merged_into_opaque_frames () =
  let client = Output.create () in
  let snapshot = "snapshot" in
  accepted "C" (Output.enqueue client (encode 'C' "{}"));
  accepted "snapshot" (Output.enqueue client (encode 'D' snapshot));
  accepted "live" (Output.enqueue_output client "abc");
  accepted "live 2" (Output.enqueue_output client "def");
  accepted "G" (Output.enqueue client (encode 'G' "g"));
  accepted "live after G" (Output.enqueue_output client "ghi");
  accepted "X" (Output.enqueue client (encode 'X' "x"));
  let frames = take_all client in
  Alcotest.(check (list char))
    "frame kinds in order" [ 'C'; 'D'; 'D'; 'G'; 'D'; 'X' ] (kinds frames);
  Alcotest.(check (list string))
    "snapshot first and exact, live merged, others untouched"
    [ "{}"; snapshot; "abcdef"; "g"; "ghi"; "x" ]
    (payloads frames)

let taken_frame_is_closed () =
  let client = Output.create () in
  accepted "first" (Output.enqueue_output client "abc");
  (match Output.next client with
  | Some wire -> Alcotest.(check string) "writer frame" (encode 'D' "abc") wire
  | None -> Alcotest.fail "expected a frame");
  accepted "second" (Output.enqueue_output client "def");
  Alcotest.(check (list string))
    "bytes after the take start a new frame" [ "def" ]
    (payloads (take_all client))

(* Pending bytes are headers plus payload, counted once per frame. Probe the
   exact budget edge with an opaque filler frame of the remaining size. *)
let filler remaining = String.make remaining 'f'

let accounting_after_merge () =
  let client = Output.create () in
  accepted "a" (Output.enqueue_output client "abc");
  accepted "b" (Output.enqueue_output client "defg");
  let used = header + 7 in
  accepted "filler up to the exact limit"
    (Output.enqueue client (filler (Output.limit - used)));
  refused "one byte beyond" (Output.enqueue client "x");
  let client = Output.create () in
  ignore (Output.enqueue_output client "abc");
  ignore (Output.enqueue_output client "defg");
  refused "one byte over the exact limit"
    (Output.enqueue client (filler (Output.limit - used + 1)))

let accounting_after_writer_take () =
  let take_one client =
    match Output.next client with
    | Some wire -> wire
    | None -> Alcotest.fail "expected a frame"
  in
  let client = Output.create () in
  ignore (Output.enqueue_output client "abc");
  ignore (take_one client);
  ignore (Output.enqueue_output client "defg");
  let used = (header + 3) + (header + 4) in
  accepted "taken frame still counted, new frame separate"
    (Output.enqueue client (filler (Output.limit - used)));
  refused "no slack" (Output.enqueue client "x");
  let client = Output.create () in
  ignore (Output.enqueue_output client "abc");
  let wire = take_one client in
  Output.sent client wire;
  ignore (Output.enqueue_output client "defg");
  accepted "sent frame no longer counted"
    (Output.enqueue client (filler (Output.limit - (header + 4))));
  refused "no slack after sent" (Output.enqueue client "x")

let blocked_reader_evicted () =
  let client = Output.create () in
  let chunk = String.make 100 'q' in
  let rec fill total =
    if Output.enqueue_output client chunk then fill (total + 100) else total
  in
  let payload = fill 0 in
  let frames = (payload + Output.coalesce_limit - 1) / Output.coalesce_limit in
  let pending = payload + (frames * header) in
  Alcotest.(check bool) "within the budget" true (pending <= Output.limit);
  Alcotest.(check bool)
    "refused only when the next chunk would not fit" true
    (pending + 100 + header > Output.limit);
  Alcotest.(check bool) "aborted" true
    (Eio.Promise.is_resolved (Output.aborted client));
  Alcotest.(check (option string)) "queue dropped" None (Output.next client);
  refused "closed refuses more" (Output.enqueue_output client "x")

let blocked_reader_evicted_while_writer_stalled () =
  let client = Output.create () in
  let chunk = String.make 100 'q' in
  accepted "first" (Output.enqueue_output client chunk);
  ignore (Output.next client);
  let rec fill n =
    if Output.enqueue_output client chunk then fill (n + 1) else n
  in
  let n = fill 0 in
  Alcotest.(check bool) "bounded despite a stalled write" true
    (n * 100 < Output.limit);
  Alcotest.(check bool) "aborted" true
    (Eio.Promise.is_resolved (Output.aborted client))

let finished_refuses_new_frames () =
  let client = Output.create () in
  accepted "before finish" (Output.enqueue_output client "abc");
  Output.finish client;
  refused "enqueue after finish" (Output.enqueue client (encode 'G' "g"));
  refused "enqueue_output after finish" (Output.enqueue_output client "def");
  Alcotest.(check (list string))
    "only what was queued before finish drains" [ "abc" ]
    (payloads (take_all client));
  Alcotest.(check bool) "finish alone does not abort" false
    (Eio.Promise.is_resolved (Output.aborted client))

(* Retained memory (reachable heap) against counted payload, with the
   chunk patterns that made a doubling Buffer retain up to three times the
   budget. Reachable words count a string shared between clients once. *)
let reachable_bytes value =
  Obj.reachable_words (Obj.repr value) * (Sys.word_size / 8)

(* Feed [clients] the same strings until [target] payload bytes were offered,
   far enough under the budget that no client is evicted. The patterns return
   a fresh string at each step, as the PTY reader does. Acceptance is
   accumulated and checked once, to keep the test output short. *)
let feed_clients clients pattern target =
  let offered = ref 0 and step = ref 0 and all_accepted = ref true in
  while !offered < target do
    let data = pattern !step in
    incr step;
    List.iter
      (fun client ->
        if not (Output.enqueue_output client data) then all_accepted := false)
      clients;
    offered := !offered + String.length data
  done;
  accepted "every chunk offered was accepted" !all_accepted;
  !offered

let alternating step =
  if step mod 2 = 0 then String.make 32768 'b' else String.make 1 'c'
let small_chunks _ = String.make 100 'a'
let whole_reads _ = String.make Output.coalesce_limit 'w'
let mib bytes = float_of_int bytes /. 1048576.

let retained_close_to_counted name pattern () =
  let client = Output.create () in
  let payload = feed_clients [ client ] pattern (6 * 1024 * 1024) in
  let retained = reachable_bytes client in
  Printf.printf "%s: %.2f MiB payload, %.2f MiB retained\n%!" name
    (mib payload) (mib retained);
  Alcotest.(check bool)
    "retained within 1.3 times the payload plus 256 KiB" true
    (retained * 10 <= (payload * 13) + (2_560 * 1024))

(* Four lagging readers. Output that has nothing to merge stays one shared
   string; merged output is one copy per client. *)
let lagging_clients () =
  let clients = List.init 4 (fun _ -> Output.create ()) in
  let payload = feed_clients clients whole_reads (6 * 1024 * 1024) in
  let shared = reachable_bytes clients in
  Printf.printf
    "4 clients, nothing to merge: %.2f MiB payload each, %.2f MiB retained\n%!"
    (mib payload) (mib shared);
  Alcotest.(check bool) "unmerged output is shared between clients" true
    (shared * 10 <= (payload * 12) + (1024 * 1024));
  let clients = List.init 4 (fun _ -> Output.create ()) in
  let payload = feed_clients clients small_chunks (6 * 1024 * 1024) in
  let copies = reachable_bytes clients in
  Printf.printf
    "4 clients, merged: %.2f MiB payload each, %.2f MiB retained\n%!"
    (mib payload) (mib copies);
  Alcotest.(check bool) "merged output costs one bounded copy per client" true
    (copies * 10 <= (4 * payload * 13) + (4 * 256 * 1024))

(* Client A merges a string it shares with client B, whose own copy is closed
   by an opaque frame and so is never merged. A write into the shared string
   after the copy would show in B's bytes. *)
let merge_does_not_touch_the_other_client () =
  let a = Output.create () and b = Output.create () in
  let first = Bytes.to_string (Bytes.of_string "EEEE") in
  accepted "A first" (Output.enqueue_output a first);
  accepted "B first" (Output.enqueue_output b first);
  accepted "B closes its tail" (Output.enqueue b (encode 'G' "g"));
  let second = Bytes.to_string (Bytes.of_string "DD") in
  accepted "A second" (Output.enqueue_output a second);
  accepted "B second" (Output.enqueue_output b second);
  Alcotest.(check (list string)) "A merged" [ "EEEEDD" ]
    (payloads (take_all a));
  Alcotest.(check (list string)) "B exact" [ "EEEE"; "g"; "DD" ]
    (payloads (take_all b))

(* Bytes that differ at every offset, offered in chunks that force many
   reallocations of the merge buffer up to the ceiling. A short copy on
   growth would lose or alter some of them. *)
let content_survives_reallocation () =
  let client = Output.create () in
  let expected = Buffer.create 65536 in
  let counter = ref 0 in
  let all_accepted = ref true in
  for _ = 1 to 65 do
    let chunk =
      String.init 1000 (fun _ ->
          incr counter;
          Char.chr (!counter * 131 mod 251))
    in
    Buffer.add_string expected chunk;
    if not (Output.enqueue_output client chunk) then all_accepted := false
  done;
  accepted "every chunk accepted" !all_accepted;
  Alcotest.(check bool) "content identical after concatenation" true
    (String.equal (Buffer.contents expected)
       (String.concat "" (payloads (take_all client))))

let () =
  Alcotest.run "pty_output_coalescing"
    [
      ( "coalescing",
        [
          Alcotest.test_case "ceiling respected" `Quick ceiling_respected;
          Alcotest.test_case "exact ceiling" `Quick exact_ceiling;
          Alcotest.test_case "never merged into opaque frames" `Quick
            never_merged_into_opaque_frames;
          Alcotest.test_case "taken frame is closed" `Quick
            taken_frame_is_closed;
          Alcotest.test_case "merge leaves the other client's bytes" `Quick
            merge_does_not_touch_the_other_client;
          Alcotest.test_case "content survives reallocation" `Quick
            content_survives_reallocation;
        ] );
      ( "finish",
        [
          Alcotest.test_case "refuses new frames" `Quick
            finished_refuses_new_frames;
        ] );
      ( "memory",
        [
          Alcotest.test_case "alternating 32 KiB and 1 byte" `Quick
            (retained_close_to_counted "alternating" alternating);
          Alcotest.test_case "100-byte chunks" `Quick
            (retained_close_to_counted "100B chunks" small_chunks);
          Alcotest.test_case "whole PTY reads" `Quick
            (retained_close_to_counted "whole reads" whole_reads);
          Alcotest.test_case "four lagging clients" `Quick lagging_clients;
        ] );
      ( "accounting",
        [
          Alcotest.test_case "after merge" `Quick accounting_after_merge;
          Alcotest.test_case "after writer take and sent" `Quick
            accounting_after_writer_take;
          Alcotest.test_case "blocked reader evicted at the limit" `Quick
            blocked_reader_evicted;
          Alcotest.test_case "evicted while the writer is stalled" `Quick
            blocked_reader_evicted_while_writer_stalled;
        ] );
    ]
