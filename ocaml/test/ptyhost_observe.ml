(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

open Mesh_pty_support
module Observe = Mesh_pty_observe

let expect label condition = if not condition then failwith label

let stamp seconds =
  Mtime.of_uint64_ns (Int64.mul (Int64.of_int seconds) 1_000_000_000L)

let with_directory f =
  let path = Filename.temp_file "mesh-observe-" "" in
  Unix.unlink path;
  Unix.mkdir path 0o700;
  (* Canonical: the observer refuses a directory reached through a symbolic
     link, as the default temporary directory is on macOS. *)
  let path = Unix.realpath path in
  Fun.protect
    ~finally:(fun () ->
      Array.iter
        (fun name -> Unix.unlink (Filename.concat path name))
        (Sys.readdir path);
      Unix.rmdir path)
    (fun () -> f path)

let read path =
  let channel = open_in_bin path in
  Fun.protect
    ~finally:(fun () -> close_in channel)
    (fun () -> really_input_string channel (in_channel_length channel))

let () =
  with_directory (fun directory ->
      let path = Filename.concat directory "trace.ndjson" in
      let observer =
        Observe.create ~directory ~basename:"trace.ndjson" ~now:(stamp 10)
          ~lifetime:20. ~max_events:2
      in
      expect "private file" ((Unix.stat path).Unix.st_perm = 0o600);
      Observe.record observer ~now:(stamp 11) Observe.Attach;
      Observe.record observer ~now:(stamp 12) (Observe.Input 99);
      Observe.record observer ~now:(stamp 13) (Observe.Output 123);
      Observe.drain observer;
      let contents = read path in
      let lines = String.split_on_char '\n' (String.trim contents) in
      expect "two events plus header" (List.length lines = 3);
      let keys = function
        | `Assoc fields -> List.map fst fields
        | _ -> failwith "observation line is not an object"
      in
      expect "allowlisted header"
        (keys (Yojson.Basic.from_string (List.hd lines)) = [ "schema" ]);
      expect "allowlisted event fields"
        (List.for_all
           (fun line ->
             List.for_all
               (fun key -> List.mem key [ "seq"; "family"; "bytes" ])
               (keys (Yojson.Basic.from_string line)))
           (List.tl lines));
      Observe.tick observer ~now:(stamp 20);
      Observe.tick observer ~now:(stamp 15);
      expect "earlier wall-clock observation cannot expire monotonic sink"
        (Sys.file_exists path);
      Observe.record observer ~now:(stamp 30) Observe.Exit;
      expect "record expiry performs no filesystem I/O" (Sys.file_exists path);
      Observe.tick observer ~now:(stamp 15);
      expect "deadline removes file" (not (Sys.file_exists path));
      Observe.expire observer;
      expect "file expires" (not (Sys.file_exists path)));
  with_directory (fun directory ->
      let path = Filename.concat directory "trace.ndjson" in
      Unix.symlink "/tmp/do-not-follow" path;
      expect "symlink target rejected"
        (try
           ignore
             (Observe.create ~directory ~basename:"trace.ndjson" ~now:(stamp 0)
                ~lifetime:20. ~max_events:2);
           false
         with Unix.Unix_error _ | Invalid_argument _ -> true));
  with_directory (fun directory ->
      Unix.chmod directory 0o755;
      expect "public parent rejected"
        (try
           ignore
             (Observe.create ~directory ~basename:"trace.ndjson" ~now:(stamp 0)
                ~lifetime:20. ~max_events:2);
           false
         with Invalid_argument _ -> true));
  with_directory (fun directory ->
      let alias = directory ^ "-alias" in
      let nested = Filename.concat directory "nested" in
      Unix.mkdir nested 0o700;
      Unix.symlink directory alias;
      Fun.protect
        ~finally:(fun () ->
          Unix.unlink alias;
          Unix.rmdir nested)
        (fun () ->
          expect "symlink parent rejected"
            (try
               ignore
                 (Observe.create ~directory:alias ~basename:"trace.ndjson"
                    ~now:(stamp 0) ~lifetime:20. ~max_events:2);
               false
             with Invalid_argument _ -> true);
          expect "symlink ancestor rejected"
            (try
               ignore
                 (Observe.create
                    ~directory:(Filename.concat alias "nested")
                    ~basename:"trace.ndjson" ~now:(stamp 0) ~lifetime:20.
                    ~max_events:2);
               false
             with Invalid_argument _ -> true)));
  with_directory (fun directory ->
      let path = Filename.concat directory "ptyhost.sock" in
      expect "reserved socket basename rejected"
        (try
           ignore
             (Observe.create ~directory ~basename:"ptyhost.sock" ~now:(stamp 0)
                ~lifetime:20. ~max_events:2);
           false
         with Invalid_argument _ -> true);
      expect "rejected basename creates no socket target"
        (not (Sys.file_exists path)));
  with_directory (fun directory ->
      let path = Filename.concat directory "trace.ndjson" in
      expect "startup failure propagates"
        (try
           Observe.with_sink ~directory ~basename:"trace.ndjson" ~now:(stamp 0)
             ~lifetime:20. ~max_events:2 (fun _ ->
               failwith "simulated startup failure")
         with Failure message -> message = "simulated startup failure");
      expect "startup failure unlinks observation sink immediately"
        (not (Sys.file_exists path)));
  print_endline "Passive observer safety boundaries passed"
