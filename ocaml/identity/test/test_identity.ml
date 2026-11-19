(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

module I = Mesh_identity

(* The id formats respawn.py uses (CONVERSATION_RE). *)
let formats : I.formats =
  let uuid = I.Format.uuid in
  [
    ("claude", uuid);
    ("codex", uuid);
    ("pi", uuid);
    ("gemini", uuid);
    ("copilot", uuid);
    ("vibe", uuid);
    ("opencode", I.Format.prefixed ~prefix:"ses_" ~min:8 ~max:60);
    ("agy", I.Format.token ~min:8 ~max:64);
  ]

let member key json = Yojson.Safe.Util.member key json
let float_of json = Yojson.Safe.Util.to_number json

(* Numbers as floats and objects with sorted keys: 10 and 10.0 are one value,
   and the key order of the two implementations does not matter. *)
let rec normal : Yojson.Safe.t -> Yojson.Safe.t = function
  | `Int i -> `Float (float_of_int i)
  | `Assoc pairs -> `Assoc (List.sort compare (List.map (fun (k, v) -> (k, normal v)) pairs))
  | `List items -> `List (List.map normal items)
  | other -> other

let registry_json (r : I.registry) =
  match I.to_json r with
  | `Assoc pairs -> `Assoc (List.filter (fun (k, _) -> k <> "version") pairs)
  | other -> other

let start_of json =
  let with_version =
    match json with `Assoc pairs -> `Assoc (("version", `Int 1) :: pairs) | other -> other
  in
  fst (I.of_json ~formats with_version)

let step registry json =
  let now = float_of (member "now" json) in
  match member "claim" json with
  | `Null ->
      let keep = Yojson.Safe.Util.to_list (member "prune" json) |> List.filter_map I.incarnation_of_json in
      I.prune registry ~keep ~now
  | claim -> (
      let listed =
        match member "listed" json with
        | `Null -> None
        | l -> Some (Yojson.Safe.Util.to_list l |> List.filter_map I.incarnation_of_json)
      in
      match I.claim_of_json ~formats claim with
      | Some c -> I.merge ?listed ~formats registry c ~now
      | None -> registry)

let resolution_json = function
  | I.No_entry -> `List [ `String "none"; `Null ]
  | I.Resolved id -> `List [ `String "active"; `String id ]
  | I.Contested_entry -> `List [ `String "contested"; `Null ]

let check_resolve registry json =
  let name = Yojson.Safe.Util.to_string (member "name" json) in
  let created = float_of (member "created" json) in
  let agent = Yojson.Safe.Util.to_string (member "agent" json) in
  let got = resolution_json (I.resolve registry ~name ~created ~agent) in
  Alcotest.(check string)
    (Printf.sprintf "resolve %s" name)
    (Yojson.Safe.to_string (member "expect" json))
    (Yojson.Safe.to_string got)

let run_case json () =
  let final = List.fold_left step (start_of (member "start" json)) (Yojson.Safe.Util.to_list (member "steps" json)) in
  Alcotest.(check string) "registry"
    (Yojson.Safe.to_string (normal (member "expect" json)))
    (Yojson.Safe.to_string (normal (registry_json final)));
  match member "resolve" json with
  | `List queries -> List.iter (check_resolve final) queries
  | _ -> ()

let run_file json () =
  let text = Yojson.Safe.Util.to_string (member "text" json) in
  let registry, writable =
    match Yojson.Safe.from_string text with
    | parsed -> I.of_json ~formats parsed
    | exception Yojson.Json_error _ -> (I.empty, true)
  in
  Alcotest.(check bool) "writable" (Yojson.Safe.Util.to_bool (member "writable" json)) writable;
  Alcotest.(check string) "registry"
    (Yojson.Safe.to_string (normal (member "expect" json)))
    (Yojson.Safe.to_string (normal (registry_json registry)))

let vectors = Yojson.Safe.from_file "vectors/registry-v1.json"

let vector_tests key run =
  Yojson.Safe.Util.to_list (member key vectors)
  |> List.map (fun json ->
         Alcotest.test_case (Yojson.Safe.Util.to_string (member "name" json)) `Quick (run json))

(* ------------------------------------------------------------ store *)

let fresh_dir () =
  let dir = Filename.temp_file "identity" "" in
  Sys.remove dir;
  Unix.mkdir dir 0o700;
  dir

let id_a = "0e6c0000-1111-4222-8333-444444444444"

let claim name created id : I.Claim.t =
  {
    session = { name; created = Some created; nonce = None };
    agent = "codex";
    id;
    source = Observed;
    evidence = "observed:open_rollout";
    agent_started = None;
    holds_open = false;
  }

let add name created id registry = I.merge ~formats registry (claim name created id) ~now:10.

let entries path =
  match I.read ~formats path with I.Missing -> -1 | I.Read (r, _) -> List.length r.entries

let write_file path text perm =
  let out = open_out_gen [ Open_wronly; Open_creat; Open_trunc ] perm path in
  output_string out text;
  close_out out;
  Unix.chmod path perm

let test_missing_then_written () =
  let path = Filename.concat (fresh_dir ()) "session-identities.json" in
  Alcotest.(check int) "missing" (-1) (entries path);
  (match I.update ~formats path (add "x" 1. id_a) with
  | Ok r -> Alcotest.(check int) "one entry" 1 (List.length r.entries)
  | Error e -> Alcotest.fail e);
  Alcotest.(check int) "mode" 0o600 ((Unix.stat path).st_perm land 0o777);
  Alcotest.(check int) "read back" 1 (entries path)

let refused_as_empty make () =
  let dir = fresh_dir () in
  let path = Filename.concat dir "session-identities.json" in
  let valid = Yojson.Safe.to_string (I.to_json (add "x" 1. id_a I.empty)) in
  make dir path valid;
  Alcotest.(check int) "read as empty" 0 (entries path);
  match I.update ~formats path (add "y" 2. id_a) with
  | Ok r -> Alcotest.(check int) "replaced by a write" 1 (List.length r.entries)
  | Error e -> Alcotest.fail e

let world_readable _ path valid = write_file path valid 0o644
let truncated _ path valid = write_file path (String.sub valid 0 (String.length valid / 2)) 0o600
let too_large _ path _ = write_file path (String.make (I.max_bytes + 1) ' ') 0o600

let deeply_nested _ path _ =
  write_file path (String.make 200_000 '[' ^ String.make 200_000 ']') 0o600

let symlink dir path valid =
  let target = Filename.concat dir "elsewhere.json" in
  write_file target valid 0o600;
  Unix.symlink target path

let test_newer_version_kept () =
  let path = Filename.concat (fresh_dir ()) "session-identities.json" in
  let text = {|{"version": 2, "generation": 4, "entries": []}|} in
  write_file path text 0o600;
  (match I.update ~formats path (add "x" 1. id_a) with
  | Ok _ -> Alcotest.fail "a newer version was replaced"
  | Error _ -> ());
  let kept = In_channel.with_open_bin path In_channel.input_all in
  Alcotest.(check string) "left alone" text kept

let long_entry i : I.entry =
  {
    session = { name = Printf.sprintf "s%d" i; created = Some (float_of_int i); nonce = None };
    agent = "codex";
    id = Some (String.make 2000 'a');
    source = Observed;
    evidence = "observed:open_rollout";
    agent_started = None;
    observed_at = 10.;
    generation = 1;
    state = Active;
    holds_open = false;
  }

(* Ids of a caller's format can make the file larger than a reader accepts:
   such a result is never written. *)
let test_oversized_not_written () =
  let path = Filename.concat (fresh_dir ()) "session-identities.json" in
  ignore (I.update ~formats path (add "x" 1. id_a));
  let huge _ = { I.counter = 1; entries = List.init I.max_entries long_entry } in
  (match I.update ~formats path huge with
  | Ok _ -> Alcotest.fail "a file over max_bytes was written"
  | Error _ -> ());
  Alcotest.(check int) "the file is left alone" 1 (entries path)

(* At the cap, an incarnation the PTY host still lists is kept over older
   entries of ones it does not. *)
let test_cap_keeps_listed () =
  let id i = Printf.sprintf "0e6c0000-1111-4222-8333-%012d" i in
  let full =
    List.init I.max_entries (fun i ->
        I.merge ~formats I.empty
          (claim (Printf.sprintf "s%d" i) (float_of_int (i + 1)) (id i))
          ~now:(float_of_int (i + 1)))
    |> List.concat_map (fun (r : I.registry) -> r.entries)
  in
  let registry = { I.counter = I.max_entries; entries = full } in
  let oldest = (List.hd full).session in
  let after =
    I.merge ~listed:[ oldest ] ~formats registry (claim "new" 9999. (id 9999)) ~now:9999.
  in
  let names = List.map (fun (e : I.entry) -> e.session.name) after.entries in
  Alcotest.(check int) "capped" I.max_entries (List.length names);
  Alcotest.(check bool) "the listed oldest stays" true (List.mem "s0" names);
  Alcotest.(check bool) "the oldest unlisted goes" false (List.mem "s1" names)

(* Two processes, each adding its own entries one update at a time: with the
   lock, none is lost. *)
let test_concurrent_writers () =
  let path = Filename.concat (fresh_dir ()) "session-identities.json" in
  let per_writer = 25 in
  let writer prefix =
    match Unix.fork () with
    | 0 ->
        for i = 1 to per_writer do
          let id = Printf.sprintf "0e6c0000-1111-4222-8333-%012d" ((if prefix = "a" then 0 else 1000) + i) in
          ignore (I.update ~formats path (add (Printf.sprintf "%s%d" prefix i) (float_of_int i) id))
        done;
        Stdlib.exit 0
    | pid -> pid
  in
  let pids = [ writer "a"; writer "b" ] in
  List.iter (fun pid -> ignore (Unix.waitpid [] pid)) pids;
  Alcotest.(check int) "every entry kept" (2 * per_writer) (entries path)

let () =
  Alcotest.run "mesh_identity"
    [
      ("vectors", vector_tests "cases" run_case);
      ("files", vector_tests "files" run_file);
      ( "store",
        [
          Alcotest.test_case "a missing file is created 0600" `Quick test_missing_then_written;
          Alcotest.test_case "a world-readable file is refused" `Quick (refused_as_empty world_readable);
          Alcotest.test_case "a truncated file reads as empty" `Quick (refused_as_empty truncated);
          Alcotest.test_case "a too large file is refused" `Quick (refused_as_empty too_large);
          Alcotest.test_case "a deeply nested file reads as empty" `Quick
            (refused_as_empty deeply_nested);
          Alcotest.test_case "a symbolic link is not followed" `Quick (refused_as_empty symlink);
          Alcotest.test_case "a newer version is not replaced" `Quick test_newer_version_kept;
          Alcotest.test_case "two concurrent writers lose nothing" `Quick test_concurrent_writers;
          Alcotest.test_case "a result over max_bytes is not written" `Quick test_oversized_not_written;
          Alcotest.test_case "the cap drops unlisted entries first" `Quick test_cap_keeps_listed;
        ] );
    ]
