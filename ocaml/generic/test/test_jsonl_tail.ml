(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

module Tail = Mesh_jsonl_tail

(* The fold keeps every line it accepted, newest first; a line with
   ["bad": true] makes the step raise, like a reader meeting a shape it does
   not expect. *)
let fold =
  {
    Tail.init = (fun () -> []);
    copy = Fun.id;
    step =
      (fun seen json ->
        if Yojson.Safe.Util.member "bad" json = `Bool true then
          raise (Yojson.Safe.Util.Type_error ("bad", json));
        Yojson.Safe.to_string json :: seen);
  }

let limits = Tail.limits ~max_line_bytes:64 ~max_depth:4 ~window:1024 ()

let update ?(limits = limits) path previous =
  match Tail.update limits fold path previous with
  | Ok result -> result
  | Error error -> Alcotest.fail (Mesh_safe_file.error_message error)

let seen t = List.rev (Tail.state t)

let outcome =
  Alcotest.testable
    (fun formatter outcome ->
      Format.pp_print_string formatter
        (match outcome with Tail.Unchanged -> "unchanged" | Appended -> "appended" | Restarted -> "restarted"))
    ( = )

let check_seen message expected t = Alcotest.(check (list string)) message expected (seen t)

let test_append_and_partial () =
  Support.with_directory (fun directory ->
      let path = Filename.concat directory "t.jsonl" in
      Support.write_file path "{\"a\":1}\n{\"a\":";
      let first, how = update path None in
      Alcotest.check outcome "first read" Tail.Restarted how;
      check_seen "partial line waits" [ {|{"a":1}|} ] first;
      Alcotest.(check int) "cursor at the partial line" 8 (Tail.offset first);
      let again, how = update path (Some first) in
      Alcotest.check outcome "nothing new" Tail.Unchanged how;
      Alcotest.(check bool) "same result" true (again == first);
      Support.append_file path "2}\n{\"b\":3}\n";
      let second, how = update path (Some first) in
      Alcotest.check outcome "appended" Tail.Appended how;
      check_seen "completed and new lines" [ {|{"a":1}|}; {|{"a":2}|}; {|{"b":3}|} ] second;
      check_seen "previous result unchanged" [ {|{"a":1}|} ] first)

let test_dropped_lines () =
  Support.with_directory (fun directory ->
      let path = Filename.concat directory "t.jsonl" in
      let long = Printf.sprintf {|{"x":"%s"}|} (String.make 100 'x') in
      let lines =
        [ long; {|[[[[[1]]]]]|}; "not json"; {|{"bad":true}|}; {|{"a":1,"a":2}|}; "" ]
      in
      Support.write_file path (String.concat "\n" lines ^ "\n");
      let t, _ = update path None in
      check_seen "only the good line, last key kept" [ {|{"a":2}|} ] t;
      Alcotest.(check (triple int int int)) "lines, dropped, resets" (1, 5, 0)
        (let stats = Tail.stats t in
         (stats.lines, stats.dropped, stats.resets)))

let test_truncation_and_rewrite () =
  Support.with_directory (fun directory ->
      let path = Filename.concat directory "t.jsonl" in
      Support.write_file path "{\"a\":1}\n{\"a\":2}\n";
      let first, _ = update path None in
      Support.write_file path "{\"c\":1}\n";
      let shorter, how = update path (Some first) in
      Alcotest.check outcome "shrunk: restarted" Tail.Restarted how;
      check_seen "from an empty state" [ {|{"c":1}|} ] shorter;
      Alcotest.(check int) "one reset" 1 (Tail.stats shorter).resets;
      (* Same inode, size grown, but the bytes before the cursor changed. *)
      Support.write_file path "{\"d\":1}\n{\"e\":1}\n";
      let rewritten, how = update path (Some shorter) in
      Alcotest.check outcome "content changed: restarted" Tail.Restarted how;
      check_seen "whole file again" [ {|{"d":1}|}; {|{"e":1}|} ] rewritten)

(* Rewrites that keep the bytes before the cursor are seen by the first
   bytes of the file. *)
let test_rewrite_of_the_head () =
  Support.with_directory (fun directory ->
      let path = Filename.concat directory "t.jsonl" in
      let body = "{\"a\":1}\n" ^ String.concat "" (List.init 40 (fun i -> Printf.sprintf "{\"n\":%03d}\n" i)) in
      Support.write_file path body;
      let first, _ = update ~limits:(Tail.limits ~max_line_bytes:64 ~max_depth:4 ()) path None in
      let later = (Tail.signature first).mtime +. 10. in
      let rewrite contents =
        Support.write_file path contents;
        Unix.utimes path later later;
        update ~limits:(Tail.limits ~max_line_bytes:64 ~max_depth:4 ()) path (Some first)
      in
      let same_size = "{\"a\":7}" ^ String.sub body 7 (String.length body - 7) in
      let _, how = rewrite same_size in
      Alcotest.check outcome "same size, first line changed: restarted" Tail.Restarted how;
      let t, how = rewrite (same_size ^ "{\"z\":1}\n") in
      Alcotest.check outcome "first line changed and a line appended: restarted" Tail.Restarted how;
      Alcotest.(check string) "the new first line" {|{"a":7}|} (List.hd (seen t));
      Support.write_file path (body ^ "{\"z\":1}\n");
      Unix.utimes path 1. 1.;
      let _, how = update path (Some first) in
      Alcotest.check outcome "time went back: restarted" Tail.Restarted how)

(* More than a window appended: one call skips to the window and is complete,
   since max_read is above the window; the state before is kept. *)
let test_large_append () =
  Support.with_directory (fun directory ->
      let path = Filename.concat directory "t.jsonl" in
      let limits = Tail.limits ~max_line_bytes:64 ~max_depth:4 ~window:1024 ~max_read:2048 () in
      Support.write_file path "{\"a\":1}\n";
      let first, _ = update ~limits path None in
      Support.append_file path (String.make 5000 'x' ^ "\n{\"z\":1}\n");
      let t, how = update ~limits path (Some first) in
      Alcotest.check outcome "appended" Tail.Appended how;
      Alcotest.(check bool) "complete in one call" true (Tail.complete t);
      check_seen "state kept, the window's line folded" [ {|{"a":1}|}; {|{"z":1}|} ] t)

let test_inode_change () =
  Support.with_directory (fun directory ->
      let path = Filename.concat directory "t.jsonl" in
      Support.write_file path "{\"a\":1}\n";
      let first, _ = update path None in
      let replacement = Filename.concat directory "new" in
      Support.write_file replacement "{\"a\":1}\n{\"z\":9}\n";
      Unix.rename replacement path;
      let replaced, how = update path (Some first) in
      Alcotest.check outcome "new inode: restarted" Tail.Restarted how;
      check_seen "read from the start" [ {|{"a":1}|}; {|{"z":9}|} ] replaced)

let test_window () =
  Support.with_directory (fun directory ->
      let path = Filename.concat directory "t.jsonl" in
      let line index = Printf.sprintf {|{"i":%d}|} (100 + index) in
      let all = List.init 20 line in
      Support.write_file path (String.concat "\n" all ^ "\n");
      (* 20 lines of 10 bytes: a window of 35 bytes starts 5 bytes into line
         16, which is dropped like Python's readline() after seek. *)
      let limits = Tail.limits ~max_line_bytes:64 ~max_depth:4 ~window:35 () in
      let t, _ = update ~limits path None in
      check_seen "the lines after the cut" [ line 17; line 18; line 19 ] t;
      (* A window that starts exactly on a line start drops that line too. *)
      let limits = Tail.limits ~max_line_bytes:64 ~max_depth:4 ~window:30 () in
      let t, _ = update ~limits path None in
      check_seen "python drops a full first line" [ line 18; line 19 ] t)

let test_max_read () =
  Support.with_directory (fun directory ->
      let path = Filename.concat directory "t.jsonl" in
      let long = String.make 30 'y' in
      Support.write_file path (String.concat "\n" [ {|{"a":1}|}; long; {|{"b":2}|} ] ^ "\n");
      let limits = Tail.limits ~max_line_bytes:10 ~max_depth:4 ~max_read:7 () in
      let rec drain previous calls =
        let t, _ = update ~limits path previous in
        if Tail.complete t then (t, calls) else drain (Some t) (calls + 1)
      in
      let t, calls = drain None 1 in
      check_seen "same lines as one read" [ {|{"a":1}|}; {|{"b":2}|} ] t;
      (* 47 bytes, at most 11 per call (max_line_bytes + 1 > max_read). *)
      Alcotest.(check bool) "several bounded calls" true (calls >= 5);
      Alcotest.(check int) "long line dropped once" 1 (Tail.stats t).dropped)

let test_refusals () =
  Support.with_directory (fun directory ->
      let fifo = Filename.concat directory "fifo" in
      Unix.mkfifo fifo 0o600;
      let link = Filename.concat directory "link" in
      let target = Filename.concat directory "target" in
      Support.write_file target "{}\n";
      Unix.symlink target link;
      let refused path =
        match Tail.update limits fold path None with
        | Error Mesh_safe_file.Not_regular -> true
        | _ -> false
      in
      Alcotest.(check bool) "fifo, without blocking" true (refused fifo);
      Alcotest.(check bool) "symbolic link" true (refused link))

(* A mutable state: the previous result keeps its own, thanks to [copy]. *)
let test_mutable_state () =
  let counts =
    {
      Tail.init = (fun () -> Hashtbl.create 8);
      copy = Hashtbl.copy;
      step =
        (fun table json ->
          Hashtbl.replace table (Yojson.Safe.to_string json) ();
          table);
    }
  in
  let update previous path =
    match Tail.update limits counts path previous with
    | Ok (result, _) -> result
    | Error error -> Alcotest.fail (Mesh_safe_file.error_message error)
  in
  Support.with_directory (fun directory ->
      let path = Filename.concat directory "t.jsonl" in
      Support.write_file path "{\"a\":1}\n";
      let first = update None path in
      Support.append_file path "{\"b\":2}\n";
      let second = update (Some first) path in
      Alcotest.(check int) "the new result has both" 2 (Hashtbl.length (Tail.state second));
      Alcotest.(check int) "the previous result kept its state" 1 (Hashtbl.length (Tail.state first)))

(* An unchanged file is recognised by lstat and not opened: once it cannot be
   read, the complete previous result is still returned. A change makes the
   update open the file, which then fails. *)
let test_unchanged_not_opened () =
  Support.with_directory (fun directory ->
      let path = Filename.concat directory "t.jsonl" in
      Support.write_file path "{\"a\":1}\n";
      let first, _ = update path None in
      Unix.chmod path 0o000;
      let outcome_now = Tail.update limits fold path (Some first) in
      Unix.chmod path 0o600;
      (match outcome_now with
      | Ok (again, how) ->
          Alcotest.check outcome "unchanged" Tail.Unchanged how;
          Alcotest.(check bool) "same result" true (again == first)
      | Error error -> Alcotest.fail (Mesh_safe_file.error_message error));
      if Unix.geteuid () <> 0 then begin
        Support.append_file path "{\"b\":2}\n";
        Unix.chmod path 0o000;
        let changed = Tail.update limits fold path (Some first) in
        Unix.chmod path 0o600;
        Alcotest.(check bool) "a changed file is opened" true
          (match changed with Error (Mesh_safe_file.Unreadable _) -> true | _ -> false)
      end)

let test_invalid_utf8 () =
  Support.with_directory (fun directory ->
      let path = Filename.concat directory "t.jsonl" in
      Support.write_file path "{\"a\":\"x\xffy\"}\n{\"b\":1}\n";
      let rejected, _ = update path None in
      check_seen "dropped, as history._feed" [ {|{"b":1}|} ] rejected;
      Alcotest.(check int) "counted" 1 (Tail.stats rejected).dropped;
      let limits = Tail.limits ~max_line_bytes:64 ~max_depth:4 ~invalid_utf8:Drop () in
      let stripped, _ = update ~limits path None in
      check_seen "stripped, as discover._tail_lines" [ {|{"a":"xy"}|}; {|{"b":1}|} ] stripped)

(* A8 (b): folding a file appended in arbitrary pieces, with an update after
   each piece and arbitrary read bounds, gives the state of one fold of the
   whole file. *)
let line_gen =
  QCheck.Gen.(
    oneof
      [
        map (fun n -> Printf.sprintf {|{"n":%d}|} n) nat_small;
        map (fun s -> Yojson.Safe.to_string (`Assoc [ ("s", `String s) ])) (string_size (int_bound 20));
        return "not json";
        return {|{"bad":true}|};
        return {|[[[[[0]]]]]|};
        map (fun n -> String.make (40 + n) 'z') nat_small;
        return {|{"k":1,"k":2}|};
      ])

let property_case =
  QCheck.make
    ~print:(fun (lines, cuts, max_read) ->
      Printf.sprintf "lines=%s cuts=%s max_read=%d" (String.concat "|" lines)
        (String.concat "," (List.map string_of_int cuts)) max_read)
    QCheck.Gen.(
      triple (list_size (int_bound 25) line_gen) (list_size (int_bound 12) (int_bound 600))
        (int_range 1 200))

let fold_in_pieces directory text cuts limits =
  let path = Filename.concat directory "pieces.jsonl" in
  Support.write_file path "";
  let rec go result from = function
    | [] ->
        Support.append_file path (String.sub text from (String.length text - from));
        let rec drain result =
          let t, _ = update ~limits path result in
          if Tail.complete t then t else drain (Some t)
        in
        drain result
    | cut :: rest ->
        let cut = max from (min cut (String.length text)) in
        Support.append_file path (String.sub text from (cut - from));
        let t, _ = update ~limits path result in
        go (Some t) cut rest
  in
  go None 0 (List.sort compare cuts)

let test_chunked_equals_whole () =
  Support.with_directory (fun directory ->
      Support.qcheck ~count:150 ~name:"pieces fold like the whole" property_case
        (fun (lines, cuts, max_read) ->
          let text = String.concat "\n" lines ^ if lines = [] then "" else "\n" in
          let limits = Tail.limits ~max_line_bytes:48 ~max_depth:4 ~max_read () in
          let whole_path = Filename.concat directory "whole.jsonl" in
          Support.write_file whole_path text;
          let whole, _ = update ~limits:(Tail.limits ~max_line_bytes:48 ~max_depth:4 ()) whole_path None in
          let pieces = fold_in_pieces directory text cuts limits in
          Tail.state pieces = Tail.state whole
          && (Tail.stats pieces).dropped = (Tail.stats whole).dropped
          && Tail.offset pieces = Tail.offset whole))

let () =
  Alcotest.run "mesh_jsonl_tail"
    [
      ( "tail",
        [
          Alcotest.test_case "append and partial line" `Quick test_append_and_partial;
          Alcotest.test_case "dropped lines" `Quick test_dropped_lines;
          Alcotest.test_case "truncation and rewrite" `Quick test_truncation_and_rewrite;
          Alcotest.test_case "inode change" `Quick test_inode_change;
          Alcotest.test_case "rewrite of the head" `Quick test_rewrite_of_the_head;
          Alcotest.test_case "large append" `Quick test_large_append;
          Alcotest.test_case "tail window" `Quick test_window;
          Alcotest.test_case "bounded reads" `Quick test_max_read;
          Alcotest.test_case "FIFO and link refused" `Quick test_refusals;
          Alcotest.test_case "mutable state copied" `Quick test_mutable_state;
          Alcotest.test_case "unchanged file not opened" `Quick test_unchanged_not_opened;
          Alcotest.test_case "invalid UTF-8 policy" `Quick test_invalid_utf8;
          Alcotest.test_case "pieces fold like the whole (property)" `Quick test_chunked_equals_whole;
        ] );
    ]
