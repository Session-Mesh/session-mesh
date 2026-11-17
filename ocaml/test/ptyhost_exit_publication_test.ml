(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

module Host = Ptyhost_exit_impl
module Protocol = Mesh_pty_support.Mesh_pty_protocol
module Output = Mesh_pty_support.Mesh_pty_output

(* Two checks read another process's kernel state through /proc, which only
   Linux has; elsewhere they are skipped with a printed reason and the rest of
   their test still runs. *)
let linux = Mesh_platform.platform = Mesh_platform.Linux

let skip_check what source =
  Printf.printf "skipped check (%s): needs %s, Linux only\n%!" what source

let exit_publication () =
  Eio_main.run (fun env ->
      Eio.Time.Timeout.run_exn (Eio.Time.Timeout.seconds env#mono_clock 5.)
        (fun () ->
          Eio.Switch.run (fun sw ->
              let sessions = ref [] and owned = ref [] in
              let reservations = Hashtbl.create 2 and pending = ref [] in
              let stopping = ref false in
              let dispatch =
                Host.dispatch env sw sessions owned reservations pending
                  stopping None
              in
              let new_session () =
                dispatch
                  [
                    ("op", `String "new_bound");
                    ("name", `String "quick");
                    ("meta", `Assoc [ ("legacy_origin", `Bool true) ]);
                    ("cwd", `String (Sys.getcwd ()));
                    ( "deadline_ns",
                      `String
                        (Int64.to_string
                           (Mtime.to_uint64_ns
                              (Option.get
                                 (Mtime.add_span
                                    (Eio.Time.Mono.now env#mono_clock)
                                    (Mtime.Span.of_uint64_ns 2_000_000_000L)))))
                    );
                  ]
              in
              let check_new reply =
                Alcotest.(check bool)
                  "same name is available after observed X" true
                  (Yojson.Basic.Util.member "ok" reply = `Bool true);
                let receipt =
                  match Yojson.Basic.Util.member "creation_receipt" reply with
                  | `String value -> value
                  | _ -> ""
                in
                Alcotest.(check bool)
                  "successful physical creation supplies canonical \
                   boot/generation receipt"
                  true
                  (String.length receipt = 81
                  && receipt.[64] = ':'
                  && String.for_all
                       (function
                         | '0' .. '9' | 'a' .. 'f' | ':' -> true | _ -> false)
                       receipt)
              in
              let release, unblock = Eio.Promise.create () in
              let cleanup () =
                Eio.Cancel.protect (fun () ->
                    let first = ref None in
                    let attempt action =
                      try action ()
                      with exn ->
                        if !first = None then
                          first := Some (exn, Printexc.get_raw_backtrace ())
                    in
                    attempt (fun () ->
                        if not (Eio.Promise.is_resolved release) then
                          Eio.Promise.resolve unblock ());
                    List.iter
                      (fun (s : Host.session) ->
                        attempt (fun () -> Host.signal s Sys.sigkill);
                        attempt s.close)
                      !owned;
                    match !first with
                    | None -> ()
                    | Some (exn, bt) -> Printexc.raise_with_backtrace exn bt)
              in
              let exercise () =
                Alcotest.check_raises
                  "expired original deadline refuses before child"
                  (Invalid_argument "deadline") (fun () ->
                    ignore
                      (dispatch
                         [
                           ("op", `String "new_bound");
                           ("name", `String "expired");
                           ("cwd", `String (Sys.getcwd ()));
                           ("deadline_ns", `String "1");
                         ]));
                Alcotest.(check int)
                  "expired request created zero children" 0 (List.length !owned);
                let legacy =
                  dispatch
                    [
                      ("op", `String "new");
                      ("name", `String "legacy");
                      ("meta", `Assoc [ ("legacy_origin", `Bool false) ]);
                      ("cwd", `String (Sys.getcwd ()));
                    ]
                in
                Alcotest.(check bool)
                  "legacy reply remains exact" true
                  (legacy
                  = `Assoc [ ("ok", `Bool true); ("name", `String "legacy") ]);
                let legacy_session =
                  List.find
                    (fun (s : Host.session) -> s.name = "legacy")
                    !sessions
                in
                let legacy_lookup receipt =
                  dispatch
                    [
                      ("op", `String "lookup_legacy_bound");
                      ("creation_receipt", `String receipt);
                    ]
                in
                Alcotest.(check bool)
                  "legacy birth admits exact legacy lookup" true
                  (Yojson.Basic.Util.member "ok"
                     (legacy_lookup legacy_session.creation_receipt)
                  = `Bool true);
                Alcotest.(check (option (pair int int)))
                  "native birth geometry precedes any resize"
                  (Some (50, 200))
                  (legacy_session.birth_geometry ());
                (* An explicit owner resize establishes a nondefault kernel
                   value; the new operation must only observe that same FD. *)
                legacy_session.resize 61 190;
                Alcotest.(check (option (pair int int)))
                  "resize invalidates raw-screen birth geometry" None
                  (legacy_session.birth_geometry ());
                legacy_session.resize 50 200;
                Alcotest.(check (option (pair int int)))
                  "resize back cannot restore birth geometry" None
                  (legacy_session.birth_geometry ());
                legacy_session.resize 61 190;
                let geometry_fields =
                  [
                    ("op", `String "geometry_bound");
                    ("creation_receipt", `String legacy_session.creation_receipt);
                    ("name", `String "legacy");
                  ]
                in
                let geometry = dispatch geometry_fields in
                Alcotest.(check bool)
                  "geometry response has only the closed sample fields" true
                  (match geometry with
                  | `Assoc fields ->
                      List.sort String.compare (List.map fst fields)
                      = [
                          "cols";
                          "creation_receipt";
                          "kind";
                          "name";
                          "ok";
                          "rows";
                        ]
                  | _ -> false);
                Alcotest.(check string)
                  "sample never claims output/bootstrap coherence"
                  "kernel-sample"
                  Yojson.Basic.Util.(geometry |> member "kind" |> to_string);
                Alcotest.(check (pair int int))
                  "exact live native kernel geometry" (61, 190)
                  Yojson.Basic.Util.
                    ( geometry |> member "rows" |> to_int,
                      geometry |> member "cols" |> to_int );
                Alcotest.(check string)
                  "sample binds the exact legacy native receipt"
                  legacy_session.creation_receipt
                  Yojson.Basic.Util.(
                    geometry |> member "creation_receipt" |> to_string);
                Alcotest.check_raises "dimensions are not resize arguments"
                  (Invalid_argument "keys") (fun () ->
                    ignore (dispatch (("rows", `Int 62) :: geometry_fields)));
                Alcotest.check_raises "name is only a consistency check"
                  (Invalid_argument "incarnation") (fun () ->
                    ignore
                      (dispatch
                         (("name", `String "other")
                         :: List.remove_assoc "name" geometry_fields)));
                Alcotest.(check (pair int int))
                  "sample/refused arguments changed no kernel geometry" (61, 190)
                  (legacy_session.geometry ());
                Alcotest.(check int)
                  "passive sample spawned no extra native object" 1
                  (List.length !owned);
                Alcotest.(check int)
                  "passive sample created no terminal attachment" 0
                  (List.length legacy_session.clients);
                Alcotest.(check bool)
                  "legacy child gets no demo publication capability" true
                  ((List.find
                      (fun (s : Host.session) -> s.name = "legacy")
                      !sessions)
                     .demo_capability = None);
                Alcotest.(check bool)
                  "legacy list never exposes receipt" true
                  (match dispatch [ ("op", `String "list") ] with
                  | `List xs ->
                      List.for_all
                        (fun row ->
                          Yojson.Basic.Util.member "creation_receipt" row
                          = `Null)
                        xs
                  | _ -> false);
                check_new (new_session ());
                let old =
                  List.find
                    (fun (s : Host.session) -> s.name = "quick")
                    !sessions
                in
                Alcotest.check_raises
                  "bound birth cannot masquerade as legacy before any journal"
                  (Invalid_argument "incarnation") (fun () ->
                    ignore (legacy_lookup old.creation_receipt));
                Alcotest.(check bool)
                  "legacy discovery excludes bound allocations" true
                  (dispatch [ ("op", `String "list_legacy_bound") ]
                  = `List
                      [
                        `Assoc
                          [
                            ("name", `String "legacy");
                            ( "creation_receipt",
                              `String legacy_session.creation_receipt );
                            ("created", `Float legacy_session.created);
                          ];
                      ]);
                Alcotest.check_raises "legacy discovery rejects injected fields"
                  (Invalid_argument "keys") (fun () ->
                    ignore
                      (dispatch
                         [
                           ("op", `String "list_legacy_bound");
                           ("origin", `String "legacy");
                         ]));
                let lookup receipt =
                  dispatch
                    [
                      ("op", `String "lookup_bound");
                      ("creation_receipt", `String receipt);
                    ]
                in
                Alcotest.(check bool)
                  "exact receipt selects original object" true
                  (Yojson.Basic.Util.member "ok" (lookup old.creation_receipt)
                  = `Bool true);
                Alcotest.check_raises
                  "wrong boot cannot select by homonymous name"
                  (Invalid_argument "incarnation") (fun () ->
                    ignore (lookup (String.make 64 '0' ^ ":0000000000000001")));
                Alcotest.check_raises "duplicate receipt keys refuse"
                  (Invalid_argument "keys") (fun () ->
                    ignore
                      (dispatch
                         [
                           ("op", `String "lookup_bound");
                           ("creation_receipt", `String old.creation_receipt);
                           ("creation_receipt", `String old.creation_receipt);
                         ]));
                (* Three concurrent readers: origin metadata is opt-in, and
                   invalidation shares the exact byte/EOF output queue. *)
                let start_reader origin =
                  let peer, flow = Eio_unix.Net.socketpair_stream ~sw () in
                  let stopped, finish = Eio.Promise.create () in
                  Eio.Fiber.fork ~sw (fun () ->
                      Fun.protect
                        ~finally:(fun () ->
                          Eio.Flow.close flow;
                          Eio.Promise.resolve finish ())
                        (fun () ->
                          try
                            Host.conditional_attach env None sessions
                              [
                                ( "op",
                                  `String
                                    (if origin then "attach_origin_bound"
                                     else "attach_bound") );
                                ( "creation_receipt",
                                  `String old.creation_receipt );
                              ]
                              flow
                          with End_of_file -> ()));
                  let control = Host.read_frame peer in
                  Alcotest.(check char) "initial frame is C" 'C' control.kind;
                  let header = Yojson.Basic.from_string control.payload in
                  Alcotest.(check bool)
                    "origin metadata is explicitly opted in" origin
                    (Yojson.Basic.Util.member "terminal_origin" header <> `Null);
                  if origin then
                    Alcotest.(check bool)
                      "ready birth view has exact metadata" true
                      (Yojson.Basic.Util.member "terminal_origin" header
                      = `Assoc
                          [
                            ("status", `String "ready");
                            ("revision", `String "1");
                            ("rows", `Int 50);
                            ("cols", `Int 200);
                          ]);
                  Alcotest.(check char)
                    "captured initial snapshot follows C" 'D'
                    (Host.read_frame peer).kind;
                  (peer, stopped)
                in
                let close_reader (peer, stopped) =
                  Eio.Flow.close peer;
                  Eio.Promise.await stopped
                in
                let a = start_reader true in
                let b = start_reader true in
                let local = start_reader false in
                Alcotest.(check int)
                  "two origin subscribers" 2
                  (List.length !(old.birth_clients));
                close_reader a;
                Alcotest.(check int)
                  "detach removes only its own subscription" 1
                  (List.length !(old.birth_clients));
                let a = start_reader true in
                old.resize 60 180;
                let marker = "__origin_after_resize__" in
                let publish text =
                  List.iter
                    (fun client ->
                      ignore
                        (Output.enqueue client
                           (Mesh_wire.encode { kind = 'D'; payload = text })))
                    old.clients
                in
                publish marker;
                let rec through_marker peer text count =
                  let frame = Host.read_frame peer in
                  if frame.kind = 'D' && frame.payload = text then count
                  else if frame.kind = 'G' then (
                    Alcotest.(check string)
                      "closed invalidation payload"
                      "{\"status\":\"unavailable\",\"revision\":\"2\"}"
                      frame.payload;
                    through_marker peer text (count + 1))
                  else through_marker peer text count
                in
                List.iter
                  (fun (peer, _) ->
                    Alcotest.(check int)
                      "G precedes subsequent bytes for every origin reader" 1
                      (through_marker peer marker 0))
                  [ a; b ];
                Alcotest.(check int)
                  "legacy reader receives no G" 0
                  (through_marker (fst local) marker 0);
                old.resize 50 200;
                publish "__origin_still_invalid__";
                List.iter
                  (fun (peer, _) ->
                    Alcotest.(check int)
                      "invalidation is one-shot, including resize back" 0
                      (through_marker peer "__origin_still_invalid__" 0))
                  [ a; b; local ];
                List.iter close_reader [ a; b; local ];
                Alcotest.(check int)
                  "all opted-in readers detached" 0
                  (List.length !(old.birth_clients));
                let peer, flow = Eio_unix.Net.socketpair_stream ~sw () in
                let parked, park = Eio.Promise.create () in
                let module Provider = struct
                  type t = unit

                  let single_read () = Eio.Flow.single_read flow
                  let read_methods = []

                  let single_write () buffers =
                    let terminal =
                      match buffers with
                      | first :: _ when Cstruct.length first > 0 ->
                          Cstruct.get_char first 0 = 'X'
                      | _ -> false
                    in
                    Eio.Flow.write flow buffers;
                    if terminal then (
                      (* Bytes have reached the real peer, but this writer has not
                       returned/sent/detached. No kernel capacity assumption. *)
                      Eio.Promise.resolve park ();
                      Eio.Promise.await release);
                    List.fold_left (fun n b -> n + Cstruct.length b) 0 buffers

                  let copy t ~src = Eio.Flow.Pi.simple_copy ~single_write t ~src
                  let shutdown () = Eio.Flow.shutdown flow
                  let close () = Eio.Flow.close flow
                end in
                let blocked =
                  Eio.Resource.T
                    ( (),
                      Eio.Resource.handler
                        [
                          Eio.Resource.H (Eio.Flow.Pi.Source, (module Provider));
                          Eio.Resource.H (Eio.Flow.Pi.Sink, (module Provider));
                          Eio.Resource.H
                            (Eio.Flow.Pi.Shutdown, (module Provider));
                          Eio.Resource.H (Eio.Resource.Close, Provider.close);
                        ] )
                in
                let attachment_done, attachment_finish =
                  Eio.Promise.create ()
                in
                Eio.Fiber.fork ~sw (fun () ->
                    Host.attach env None old blocked;
                    Eio.Promise.resolve attachment_finish ());
                let initial = Protocol.read_frame peer in
                Alcotest.(check char) "attach succeeds" 'C' initial.kind;
                ignore (Protocol.read_frame peer);
                let input =
                  Mesh_wire.encode { kind = 'D'; payload = "exit 3\r" }
                in
                Eio.Flow.copy_string input peer;
                let rec await_exit () =
                  let frame = Protocol.read_frame peer in
                  if frame.kind = 'X' then frame
                  else (
                    Alcotest.(check char)
                      "only output precedes X" 'D' frame.kind;
                    await_exit ())
                in
                let ending = await_exit () in
                Alcotest.(check string)
                  "actual child exit code" "{\"code\":3}" ending.payload;
                Eio.Promise.await parked;
                Alcotest.(check bool)
                  "old writer remains attached" false
                  (Eio.Promise.is_resolved (Output.done_ (List.hd old.clients)));
                check_new (new_session ());
                let replacement =
                  List.find
                    (fun (s : Host.session) -> s.name = "quick")
                    !sessions
                in
                Alcotest.(check bool)
                  "same-name replacement receipt differs" true
                  (replacement.creation_receipt <> old.creation_receipt);
                Alcotest.check_raises
                  "terminal receipt never selects replacement"
                  (Invalid_argument "incarnation") (fun () ->
                    ignore (lookup old.creation_receipt));
                let replacement_geometry = replacement.geometry () in
                Alcotest.check_raises
                  "stale geometry receipt never observes same-name replacement"
                  (Invalid_argument "incarnation") (fun () ->
                    ignore
                      (dispatch
                         [
                           ("op", `String "geometry_bound");
                           ("creation_receipt", `String old.creation_receipt);
                           ("name", `String "quick");
                         ]));
                Alcotest.(check (pair int int))
                  "refused stale geometry leaves replacement unchanged"
                  replacement_geometry (replacement.geometry ());
                Alcotest.(check bool)
                  "replacement is a distinct physical incarnation" true
                  (replacement != old);
                let reservation = Hashtbl.find reservations "quick" in
                Eio.Promise.resolve unblock ();
                Eio.Promise.await attachment_done;
                Eio.Promise.await old.done_;
                Alcotest.(check bool)
                  "old cleanup keeps replacement session" true
                  (List.exists (fun s -> s == replacement) !sessions);
                Alcotest.(check bool)
                  "old cleanup keeps replacement reservation" true
                  (match Hashtbl.find_opt reservations "quick" with
                  | Some current -> current == reservation
                  | None -> false);
                Alcotest.check_raises "replacement name remains reserved"
                  (Invalid_argument "duplicate") (fun () ->
                    ignore (new_session ()))
              in
              match exercise () with
              | () -> cleanup ()
              | exception exn ->
                  let bt = Printexc.get_raw_backtrace () in
                  (try cleanup () with _ -> ());
                  Printexc.raise_with_backtrace exn bt)))

let held_private_preset () =
  Eio_main.run (fun env ->
      Eio.Time.Timeout.run_exn (Eio.Time.Timeout.seconds env#mono_clock 5.)
        (fun () ->
          Eio.Switch.run (fun sw ->
              List.iter
                (fun directory ->
                  Alcotest.check_raises
                    "relative startup path is closed refusal"
                    (Invalid_argument "private preset directory") (fun () ->
                      ignore (Host.open_private_preset env sw directory)))
                [ "."; "relativefoo" ];
              let directory = Test_scratch.private_directory "held-preset-" in
              let moved = directory ^ "-original" in
              let expected = Unix.stat directory in
              let unsafe_parent = directory ^ "-unsafe" in
              Unix.mkdir unsafe_parent 0o700;
              let unsafe_child = Filename.concat unsafe_parent "child" in
              Unix.mkdir unsafe_child 0o700;
              Unix.chmod unsafe_parent 0o777;
              Fun.protect
                ~finally:(fun () ->
                  Unix.rmdir unsafe_child;
                  Unix.rmdir unsafe_parent)
                (fun () ->
                  Alcotest.check_raises "writable nonsticky ancestor refused"
                    (Invalid_argument "private preset ancestor") (fun () ->
                      ignore (Host.open_private_preset env sw unsafe_child)));
              let preset = Host.open_private_preset env sw directory in
              let sessions = ref [] and owned = ref [] in
              let dispatch =
                Host.dispatch ~preset:(Some preset) env sw sessions owned
                  (Hashtbl.create 2) (ref []) (ref false) None
              in
              let cleanup () =
                List.iter
                  (fun (session : Host.session) ->
                    Host.signal session Sys.sigkill;
                    session.close ())
                  !owned;
                (try Unix.unlink directory
                 with Unix.Unix_error (Unix.EISDIR, _, _) ->
                   Unix.rmdir directory);
                if Sys.file_exists moved then Unix.rmdir moved
              in
              Fun.protect ~finally:cleanup (fun () ->
                  Unix.rename directory moved;
                  Unix.symlink (Sys.getcwd ()) directory;
                  let deadline =
                    Int64.to_string
                      (Mtime.to_uint64_ns
                         (Option.get
                            (Mtime.add_span
                               (Eio.Time.Mono.now env#mono_clock)
                               (Mtime.Span.of_uint64_ns 2_000_000_000L))))
                  in
                  let request =
                    [
                      ("op", `String "new_preset_bound");
                      ("name", `String "held");
                      ("preset", `String "shell");
                      ("deadline_ns", `String deadline);
                    ]
                  in
                  Alcotest.check_raises "caller command refused"
                    (Invalid_argument "keys") (fun () ->
                      ignore
                        (dispatch (("command", `String "false") :: request)));
                  Alcotest.(check int)
                    "closed request has zero child" 0 (List.length !owned);
                  let reply = dispatch request in
                  Alcotest.(check bool)
                    "preset created" true
                    (Yojson.Basic.Util.member "ok" reply = `Bool true);
                  let session = List.hd !owned in
                  Alcotest.(check bool)
                    "preset bound origin is never legacy" false
                    session.legacy_origin;
                  Unix.kill session.pid 0;
                  if not linux then
                    skip_check "kernel cwd identity" "/proc/<pid>/cwd"
                  else
                    let actual =
                      Unix.stat (Printf.sprintf "/proc/%d/cwd" session.pid)
                    in
                    Alcotest.(check bool)
                      "kernel cwd is held original, never symlink replacement"
                      true
                      (actual.st_dev = expected.st_dev
                      && actual.st_ino = expected.st_ino)))))

let preset_readiness () =
  let directory =
    Filename.temp_file ~temp_dir:(Sys.getenv "HOME") "mesh-ready-" ""
  in
  Sys.remove directory;
  Unix.mkdir directory 0o700;
  Fun.protect
    ~finally:(fun () ->
      Unix.chmod directory 0o700;
      Unix.rmdir directory)
    (fun () ->
      Eio_main.run (fun env ->
          Eio.Switch.run (fun sw ->
              let preset = Host.open_private_preset env sw directory in
              let sessions = ref [] and owned = ref [] and pending = ref [] in
              let stopping = ref false in
              let module Observe = Mesh_pty_support.Mesh_pty_observe in
              Observe.with_sink ~directory ~basename:"ready.ndjson"
                ~now:(Eio.Time.Mono.now env#mono_clock)
                ~lifetime:5. ~max_events:64 (fun observer ->
                  let dispatch =
                    Host.dispatch ~preset:(Some preset) env sw sessions owned
                      (Hashtbl.create 2) pending stopping (Some observer)
                  in
                  let request =
                    [
                      ("op", `String "preset_ready"); ("preset", `String "shell");
                    ]
                  in
                  let expected =
                    `Assoc [ ("version", `Int 1); ("ready", `Bool true) ]
                  in
                  Eio.Fiber.both
                    (fun () ->
                      Alcotest.(check bool)
                        "first ready" true
                        (dispatch request = expected))
                    (fun () ->
                      Alcotest.(check bool)
                        "concurrent ready retains held capability" true
                        (dispatch request = expected));
                  Alcotest.(check int)
                    "readiness creates zero children" 0 (List.length !owned);
                  Alcotest.check_raises "unknown preset refuses"
                    (Invalid_argument "preset") (fun () ->
                      ignore
                        (dispatch
                           [
                             ("op", `String "preset_ready");
                             ("preset", `String "other");
                           ]));
                  Alcotest.check_raises "duplicate field refuses"
                    (Invalid_argument "keys") (fun () ->
                      ignore (dispatch (("preset", `String "shell") :: request)));
                  Alcotest.check_raises "extra field refuses"
                    (Invalid_argument "keys") (fun () ->
                      ignore (dispatch (("path", `String directory) :: request)));
                  Unix.chmod directory 0o755;
                  Alcotest.check_raises "held directory mode revalidated"
                    (Invalid_argument "private preset identity") (fun () ->
                      ignore (dispatch request));
                  Unix.chmod directory 0o700;
                  Alcotest.(check bool)
                    "same held lease remains usable" true
                    (dispatch request = expected);
                  stopping := true;
                  Alcotest.check_raises "stopping refuses"
                    (Invalid_argument "stopping") (fun () ->
                      ignore (dispatch request));
                  Alcotest.(check int)
                    "all refusal paths create zero children" 0
                    (List.length !owned);
                  Observe.drain observer;
                  Alcotest.(check bool)
                    "cumulative observer remains active" true
                    (Observe.active observer);
                  let channel =
                    open_in_bin (Filename.concat directory "ready.ndjson")
                  in
                  let contents =
                    Fun.protect
                      ~finally:(fun () -> close_in channel)
                      (fun () ->
                        really_input_string channel (in_channel_length channel))
                  in
                  let creates =
                    String.split_on_char '\n' contents
                    |> List.filter (fun line -> line <> "")
                    |> List.filter (fun line ->
                        Yojson.Basic.Util.member "family"
                          (Yojson.Basic.from_string line)
                        = `String "create")
                  in
                  Alcotest.(check int)
                    "zero cumulative successfully published creations" 0
                    (List.length creates)))))

let demo_self_binding () =
  let directory =
    Filename.temp_file ~temp_dir:(Sys.getenv "HOME") "mesh-demo-self-" ""
  in
  Sys.remove directory;
  Unix.mkdir directory 0o700;
  Fun.protect
    ~finally:(fun () -> Unix.rmdir directory)
    (fun () ->
      Eio_main.run (fun env ->
          Eio.Time.Timeout.run_exn (Eio.Time.Timeout.seconds env#mono_clock 5.)
            (fun () ->
              Eio.Switch.run (fun sw ->
                  let preset = Host.open_private_preset env sw directory in
                  let sessions = ref [] and owned = ref [] in
                  let dispatch =
                    Host.dispatch ~preset:(Some preset) env sw sessions owned
                      (Hashtbl.create 2) (ref []) (ref false) None
                  in
                  let create () =
                    dispatch
                      [
                        ("op", `String "new_preset_bound");
                        ("name", `String "same-name");
                        ("preset", `String "shell");
                        ( "deadline_ns",
                          `String
                            (Int64.to_string
                               (Mtime.to_uint64_ns
                                  (Option.get
                                     (Mtime.add_span
                                        (Eio.Time.Mono.now env#mono_clock)
                                        (Mtime.Span.of_uint64_ns 2_000_000_000L)))))
                        );
                      ]
                  in
                  let lookup capability =
                    dispatch
                      [
                        ("op", `String "lookup_demo_self");
                        ("capability", `String capability);
                      ]
                  in
                  let cleanup () =
                    List.iter
                      (fun (session : Host.session) ->
                        Host.signal session Sys.sigkill;
                        session.close ())
                      !owned
                  in
                  Fun.protect ~finally:cleanup (fun () ->
                      let reply = create () in
                      let first = List.hd !sessions in
                      let capability = Option.get first.demo_capability in
                      Alcotest.(check bool)
                        "private capability is canonical" true
                        (String.length capability = 64
                        && String.for_all
                             (function
                               | '0' .. '9' | 'a' .. 'f' -> true | _ -> false)
                             capability);
                      if not linux then
                        skip_check "child environment" "/proc/<pid>/environ"
                      else begin
                        let child_environment =
                          In_channel.with_open_bin
                            (Printf.sprintf "/proc/%d/environ" first.pid)
                            In_channel.input_all
                          |> String.split_on_char '\000'
                        in
                        Alcotest.(check bool)
                          "actual child receives only its minted capability"
                          true
                          (List.mem
                             (Host.demo_capability_variable ^ "=" ^ capability)
                             child_environment)
                      end;
                      Alcotest.(check bool)
                        "public creation reply omits capability" true
                        (Yojson.Basic.Util.member "demo_capability" reply
                        = `Null);
                      Alcotest.(check bool)
                        "public session listing omits capability" true
                        (match dispatch [ ("op", `String "list") ] with
                        | `List [ row ] ->
                            Yojson.Basic.Util.member "demo_capability" row
                            = `Null
                        | _ -> false);
                      Alcotest.(check bool)
                        "self lookup returns only the exact native receipt" true
                        (lookup capability
                        = `Assoc
                            [
                              ("ok", `Bool true);
                              ( "creation_receipt",
                                `String first.creation_receipt );
                            ]);
                      Alcotest.check_raises "name cannot select demo self"
                        (Invalid_argument "keys") (fun () ->
                          ignore
                            (dispatch
                               [
                                 ("op", `String "lookup_demo_self");
                                 ("capability", `String capability);
                                 ("name", `String first.name);
                               ]));
                      Alcotest.check_raises "duplicate capability fields refuse"
                        (Invalid_argument "keys") (fun () ->
                          ignore
                            (dispatch
                               [
                                 ("op", `String "lookup_demo_self");
                                 ("capability", `String capability);
                                 ("capability", `String capability);
                               ]));
                      Alcotest.check_raises "malformed capability refuses"
                        (Invalid_argument "capability") (fun () ->
                          ignore (lookup first.creation_receipt));
                      Alcotest.check_raises "other capability refuses"
                        (Invalid_argument "incarnation") (fun () ->
                          ignore (lookup (String.make 64 '0')));
                      first.kill_requested <- true;
                      Alcotest.check_raises
                        "kill-pending incarnation refuses before reaping"
                        (Invalid_argument "incarnation") (fun () ->
                          ignore (lookup capability));
                      first.kill_requested <- false;
                      Alcotest.check_raises
                        "caller cannot inject the reserved capability key"
                        (Invalid_argument "env") (fun () ->
                          ignore
                            (dispatch
                               [
                                 ("op", `String "new_bound");
                                 ("name", `String "injected");
                                 ("cwd", `String directory);
                                 ( "env",
                                   `Assoc
                                     [
                                       ( Host.demo_capability_variable,
                                         `String capability );
                                     ] );
                                 ( "deadline_ns",
                                   `String
                                     (Int64.to_string
                                        (Mtime.to_uint64_ns
                                           (Option.get
                                              (Mtime.add_span
                                                 (Eio.Time.Mono.now
                                                    env#mono_clock)
                                                 (Mtime.Span.of_uint64_ns
                                                    2_000_000_000L))))) );
                               ]));
                      Host.signal first Sys.sigkill;
                      Eio.Promise.await first.done_;
                      Alcotest.check_raises "dead incarnation refuses"
                        (Invalid_argument "incarnation") (fun () ->
                          ignore (lookup capability));
                      ignore (create ());
                      let replacement = List.hd !sessions in
                      Alcotest.(check bool)
                        "homonymous replacement gets a new capability" true
                        (replacement.demo_capability <> Some capability);
                      Alcotest.check_raises
                        "old capability never selects the replacement"
                        (Invalid_argument "incarnation") (fun () ->
                          ignore (lookup capability)))))))

let () =
  if not linux then
    print_endline
      "skipped checks: the kernel cwd check (lifecycle 1) and the child \
       environment check (lifecycle 3) read /proc, Linux only; the rest of \
       both tests runs";
  Alcotest.run "PTY exit publication"
    [
      ( "lifecycle",
        [
          Alcotest.test_case
            "bound geometry and X publication preserve identity" `Quick
            exit_publication;
          Alcotest.test_case
            "private preset retains original directory capability" `Quick
            held_private_preset;
          Alcotest.test_case "readonly preset readiness retains lease" `Quick
            preset_readiness;
          Alcotest.test_case "demo self binds only the live native incarnation"
            `Quick demo_self_binding;
        ] );
    ]
