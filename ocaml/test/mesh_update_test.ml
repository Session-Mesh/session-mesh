(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(* The update notice: semver order, release filtering, notice levels, the
   security marker, the cache and its ETag, the settings and failures. No test
   reaches the network: every request goes through a recording fake. *)

module V = Mesh_update_version
module C = Mesh_update_check
module R = Mesh_update_report

let version text = Option.get (V.parse text)

let with_root f =
  let root = Filename.temp_file "mesh-update" "" in
  Sys.remove root;
  Unix.mkdir root 0o700;
  let rec remove path =
    match (Unix.lstat path).Unix.st_kind with
    | Unix.S_DIR ->
        Sys.readdir path
        |> Array.iter (fun name -> remove (Filename.concat path name));
        Unix.rmdir path
    | _ -> Unix.unlink path
  in
  Fun.protect
    ~finally:(fun () -> remove root)
    (fun () -> f (Unix.realpath root))

(* ---- semver *)

let test_parse () =
  let accepted =
    [ "v1.2.3"; "0.1.0"; "v10.20.30"; "v1.0.0-rc.1"; "1.0.0-alpha-1" ]
  in
  List.iter
    (fun text -> Alcotest.(check bool) text true (V.parse text <> None))
    accepted;
  let refused =
    [
      "";
      "v";
      "1.2";
      "1.2.3.4";
      "01.2.3";
      "1.2.3+build";
      "1.2.3-";
      "1.2.3-01";
      "x1.2.3";
      "1.2.3-a..b";
    ]
  in
  List.iter
    (fun text -> Alcotest.(check bool) text true (V.parse text = None))
    refused

let test_order () =
  let ascending =
    [
      "1.0.0-alpha";
      "1.0.0-alpha.1";
      "1.0.0-alpha.beta";
      "1.0.0-beta";
      "1.0.0-rc.9";
      "1.0.0-rc.10";
      "1.0.0";
      "1.0.1";
      "1.9.0";
      "1.10.0";
      "2.0.0";
    ]
  in
  let rec pairs = function
    | a :: (b :: _ as rest) ->
        Alcotest.(check bool)
          (a ^ " < " ^ b)
          true
          (V.compare (version a) (version b) < 0);
        Alcotest.(check bool)
          (b ^ " > " ^ a)
          true
          (V.compare (version b) (version a) > 0);
        pairs rest
    | _ -> ()
  in
  pairs ascending;
  Alcotest.(check int)
    "v prefix ignored" 0
    (V.compare (version "v1.2.3") (version "1.2.3"))

(* ---- releases *)

let release ?(draft = false) ?(prerelease = false) ?(body = "") tag =
  `Assoc
    [
      ("tag_name", `String tag);
      ("draft", `Bool draft);
      ("prerelease", `Bool prerelease);
      ("body", `String body);
    ]

let body releases = Yojson.Safe.to_string (`List releases)
let tags releases = List.map (fun (r : C.release) -> r.tag) releases

let test_filtering () =
  let parsed =
    C.releases_of_body
      (body
         [
           release "v0.2.0";
           release ~draft:true "v0.3.0";
           release ~prerelease:true "v0.4.0";
           release "v0.5.0-rc.1";
           release "nightly";
           release "0.6.0";
           `String "junk";
         ])
  in
  Alcotest.(check (list string))
    "only published vX.Y.Z" [ "v0.2.0" ]
    (tags (Result.get_ok parsed));
  Alcotest.(check bool)
    "not a list" true
    (Result.is_error (C.releases_of_body "{}"));
  Alcotest.(check bool)
    "not JSON" true
    (Result.is_error (C.releases_of_body "<html>"))

let test_security_marker () =
  Alcotest.(check bool)
    "line" true
    (C.security_marked "Fixes.\n\nSecurity: yes\n");
  Alcotest.(check bool)
    "case and blanks" true
    (C.security_marked "  SECURITY: Yes \r\n");
  Alcotest.(check bool) "absent" false (C.security_marked "No security change.");
  Alcotest.(check bool) "other value" false (C.security_marked "Security: no");
  Alcotest.(check bool)
    "inside a sentence" false
    (C.security_marked "See Security: yes here")

(* ---- levels *)

let rel ?(security = false) tag =
  {
    C.tag;
    version = version tag;
    security;
    published = "";
    notes = "";
    truncated = false;
  }

let announced level current releases =
  Option.map
    (fun (notice : C.notice) -> (notice.latest.tag, notice.security))
    (C.announce level ~current:(version current) releases)

let result = Alcotest.(option (pair string bool))

let test_levels () =
  let releases = [ rel "v0.1.1"; rel "v0.2.0"; rel "v1.0.0"; rel "v1.0.1" ] in
  Alcotest.check result "all"
    (Some ("v1.0.1", false))
    (announced C.All "v0.1.0" releases);
  Alcotest.check result "minor: newest of a newer line"
    (Some ("v1.0.1", false))
    (announced C.Minor "v0.1.0" releases);
  Alcotest.check result "major: newest of a newer major"
    (Some ("v1.0.1", false))
    (announced C.Major "v0.1.0" releases);
  Alcotest.check result "minor: patches of the running line skipped"
    (Some ("v0.2.0", false))
    (announced C.Minor "v0.1.0" [ rel "v0.1.1"; rel "v0.2.0"; rel "v0.1.2" ]);
  Alcotest.check result "security" None
    (announced C.Security_only "v0.1.0" releases);
  Alcotest.check result "none" None (announced C.Off "v0.1.0" releases);
  let patches = [ rel "v0.1.1"; rel "v0.1.2" ] in
  Alcotest.check result "all: patch"
    (Some ("v0.1.2", false))
    (announced C.All "v0.1.0" patches);
  Alcotest.check result "minor: patch only" None
    (announced C.Minor "v0.1.0" patches);
  Alcotest.check result "minor: newer minor"
    (Some ("v0.2.0", false))
    (announced C.Minor "v0.1.5" [ rel "v0.1.6"; rel "v0.2.0" ]);
  Alcotest.check result "major: minor only" None
    (announced C.Major "v0.1.0" [ rel "v0.2.0" ])

let test_security_every_level () =
  let releases = [ rel ~security:true "v0.1.1" ] in
  List.iter
    (fun (name, level) ->
      Alcotest.check result name
        (Some ("v0.1.1", true))
        (announced level "v0.1.0" releases))
    [
      ("all", C.All);
      ("minor", C.Minor);
      ("major", C.Major);
      ("security", C.Security_only);
    ];
  Alcotest.check result "none" None (announced C.Off "v0.1.0" releases)

let test_intermediate_security () =
  let releases = [ rel ~security:true "v0.1.4"; rel "v0.1.5" ] in
  Alcotest.check result "security: the security release, not the latest"
    (Some ("v0.1.4", true))
    (announced C.Security_only "v0.1.3" releases);
  Alcotest.check result "all: the latest, not labelled by an older fix"
    (Some ("v0.1.5", false))
    (announced C.All "v0.1.3" releases);
  Alcotest.check result "fix already installed"
    (Some ("v0.1.5", false))
    (announced C.All "v0.1.4" releases);
  Alcotest.check result "security: fix already installed" None
    (announced C.Security_only "v0.1.4" releases)

let test_no_newer () =
  Alcotest.check result "no release" None (announced C.All "v0.1.0" []);
  Alcotest.check result "only older or equal" None
    (announced C.All "v0.2.0" [ rel "v0.1.9"; rel ~security:true "v0.2.0" ])

(* ---- cache and ETag *)

(* The ETag sent by each request, newest first. *)
let recording answer =
  let calls = ref [] in
  let fetch ~etag =
    calls := etag :: !calls;
    answer
  in
  (calls, fetch)

let list_body =
  body [ release "v0.2.0"; release ~body:"Security: yes" "v0.1.1" ]

let ok_answer = C.Body { etag = Some "\"abc\""; body = list_body }

let test_cache_and_etag () =
  with_root (fun root ->
      let cache_path =
        Filename.concat (Filename.concat root "cache") "update-check.json"
      in
      let calls, fetch = recording ok_answer in
      let cache, error = C.refresh ~now:1000. ~force:false ~cache_path ~fetch in
      Alcotest.(check (option string)) "no error" None error;
      Alcotest.(check int) "first request" 1 (List.length !calls);
      Alcotest.(check (option string))
        "no ETag sent the first time" None (List.hd !calls);
      Alcotest.(check (list string))
        "releases" [ "v0.2.0"; "v0.1.1" ]
        (tags (Option.get cache).releases);
      Alcotest.(check int)
        "mode 0600" 0o600
        ((Unix.stat cache_path).Unix.st_perm land 0o777);
      let _ =
        C.refresh ~now:(1000. +. C.period -. 1.) ~force:false ~cache_path ~fetch
      in
      Alcotest.(check int) "fresh cache: no request" 1 (List.length !calls);
      let _ = C.refresh ~now:1001. ~force:true ~cache_path ~fetch in
      Alcotest.(check int) "forced (startup): a request" 2 (List.length !calls);
      Alcotest.(check (option string))
        "ETag sent back" (Some "\"abc\"") (List.hd !calls);
      let calls, fetch = recording C.Not_modified in
      let later = 1001. +. C.period in
      let cache, _ = C.refresh ~now:later ~force:false ~cache_path ~fetch in
      Alcotest.(check int) "stale cache: a request" 1 (List.length !calls);
      Alcotest.(check (list string))
        "304 keeps the releases" [ "v0.2.0"; "v0.1.1" ]
        (tags (Option.get cache).releases);
      Alcotest.(check (float 0.))
        "304 dates the check" later
        (Option.get (C.read_cache cache_path)).checked_at;
      let calls, fetch = recording C.Not_modified in
      let _ = C.refresh ~now:0. ~force:false ~cache_path ~fetch in
      Alcotest.(check int)
        "a cache dated in the future is not trusted" 1 (List.length !calls))

let test_invalid_etag () =
  List.iter
    (fun (text, expected) ->
      Alcotest.(check bool) text expected (C.valid_etag text))
    [
      ("\"abc\"", true);
      ("W/\"abc\"", true);
      ("abc", false);
      ("\"a\r\nX: y\"", false);
      ("\"a\"b\"", false);
      ("\"" ^ String.make 200 'a' ^ "\"", false);
    ];
  with_root (fun root ->
      let cache_path = Filename.concat root "update-check.json" in
      let _, fetch =
        recording
          (C.Body { etag = Some "bad\r\nInjected: 1"; body = list_body })
      in
      let cache, _ = C.refresh ~now:1. ~force:false ~cache_path ~fetch in
      Alcotest.(check (option string))
        "unsafe ETag dropped" None (Option.get cache).etag)

let test_failure_keeps_releases () =
  with_root (fun root ->
      let cache_path = Filename.concat root "update-check.json" in
      let _, fetch = recording ok_answer in
      ignore (C.refresh ~now:1. ~force:false ~cache_path ~fetch);
      let later = 1. +. C.period in
      let _, fetch = recording (C.Failed "curl exited with 6") in
      let cache, error = C.refresh ~now:later ~force:false ~cache_path ~fetch in
      Alcotest.(check (option string))
        "reason kept for --debug" (Some "curl exited with 6") error;
      Alcotest.(check (list string))
        "releases kept" [ "v0.2.0"; "v0.1.1" ]
        (tags (Option.get cache).releases);
      let calls, fetch = recording (C.Failed "again") in
      ignore (C.refresh ~now:(later +. 60.) ~force:false ~cache_path ~fetch);
      Alcotest.(check int)
        "a failure is not retried before the period" 0 (List.length !calls);
      let _, fetch = recording (C.Body { etag = None; body = "not json" }) in
      let cache, error =
        C.refresh ~now:(later +. C.period) ~force:false ~cache_path ~fetch
      in
      Alcotest.(check bool) "garbage answer reported" true (error <> None);
      Alcotest.(check int)
        "garbage answer keeps the releases" 2
        (List.length (Option.get cache).releases))

(* ---- settings, installation and report *)

let env pairs name = List.assoc_opt name pairs

let installation =
  {
    R.tag = "v0.1.0";
    version = version "v0.1.0";
    share = "/srv/owner/.local/share/session-mesh";
  }

let check_with ?(installation = Some installation) pairs answer =
  with_root (fun root ->
      let calls, fetch = recording answer in
      let getenv = env (("MESH_CACHE_DIR", root) :: pairs) in
      let outcome, problem =
        R.check ~getenv ~installation ~request:true ~force:true ~now:1. ~fetch
      in
      (outcome, problem, List.length !calls))

let status outcome =
  Yojson.Safe.Util.(member "status" (R.to_json ~home:None outcome) |> to_string)

let test_opt_out () =
  let outcome, _, calls = check_with [ ("MESH_UPDATE_CHECK", "0") ] ok_answer in
  Alcotest.(check string) "disabled" "disabled" (status outcome);
  Alcotest.(check int) "MESH_UPDATE_CHECK=0: no request" 0 calls;
  let outcome, _, calls =
    check_with [ ("MESH_UPDATE_NOTICE", "none") ] ok_answer
  in
  Alcotest.(check string) "none" "disabled" (status outcome);
  Alcotest.(check int) "MESH_UPDATE_NOTICE=none: no request" 0 calls;
  let outcome, _, calls = check_with ~installation:None [] ok_answer in
  Alcotest.(check string) "source install" "unknown-version" (status outcome);
  Alcotest.(check int) "unknown version: no request" 0 calls

let test_levels_from_environment () =
  let latest pairs =
    match check_with pairs ok_answer with
    | R.Available { notice; _ }, _, _ ->
        Some (notice.latest.tag, notice.security)
    | _ -> None
  in
  Alcotest.check result "default all: the label belongs to the named release"
    (Some ("v0.2.0", false)) (latest []);
  Alcotest.check result "security"
    (Some ("v0.1.1", true))
    (latest [ ("MESH_UPDATE_NOTICE", "security") ]);
  Alcotest.check result "MAJOR"
    (Some ("v0.1.1", true))
    (latest [ ("MESH_UPDATE_NOTICE", "MAJOR") ]);
  let outcome, problem, _ =
    check_with [ ("MESH_UPDATE_NOTICE", "sometimes") ] ok_answer
  in
  Alcotest.(check string) "unknown value: default" "available" (status outcome);
  Alcotest.(check bool)
    "unknown value reported under --debug" true (problem <> None)

let test_no_release () =
  let outcome, problem, _ =
    check_with [] (C.Body { etag = Some "\"e\""; body = "[]" })
  in
  Alcotest.(check string) "silent without a release" "current" (status outcome);
  Alcotest.(check (option string)) "no line" None (R.line ~home:None outcome);
  Alcotest.(check (option string)) "no problem" None problem

let test_network_failure () =
  let outcome, problem, _ = check_with [] (C.Failed "curl exited with 6") in
  Alcotest.(check string) "silent on failure" "unavailable" (status outcome);
  Alcotest.(check (option string)) "no line" None (R.line ~home:None outcome);
  Alcotest.(check (option string))
    "reason for --debug" (Some "curl exited with 6") problem;
  Alcotest.(check (option string))
    "no cache directory" None
    (R.cache_path
       (env [ ("HOME", "relative"); ("MESH_CACHE_DIR", "also/relative") ]))

let test_report () =
  let outcome, _, _ = check_with [] ok_answer in
  let json = R.to_json ~home:(Some "/srv/owner") outcome in
  let field name = Yojson.Safe.Util.member name json in
  Alcotest.(check string)
    "latest" "v0.2.0"
    (Yojson.Safe.Util.to_string (field "latest"));
  Alcotest.(check string)
    "notes" "https://github.com/Session-Mesh/session-mesh/releases/tag/v0.2.0"
    (Yojson.Safe.Util.to_string (field "notes_url"));
  Alcotest.(check string)
    "command" "~/.local/share/session-mesh/current/install.sh --upgrade --to v0.2.0"
    (Yojson.Safe.Util.to_string (field "upgrade_command"));
  Alcotest.(check (option string))
    "line"
    (Some
       "Session Mesh v0.2.0 is available (running \
        v0.1.0): \
        https://github.com/Session-Mesh/session-mesh/releases/tag/v0.2.0. \
        Upgrade with: ~/.local/share/session-mesh/current/install.sh --upgrade --to v0.2.0")
    (R.line ~home:(Some "/srv/owner") outcome)

let test_installation_from_path () =
  with_root (fun root ->
      let share = Filename.concat root "share" in
      let release =
        Filename.concat (Filename.concat share "releases") "v0.3.1"
      in
      List.iter
        (fun dir -> Unix.mkdir dir 0o700)
        [
          share;
          Filename.dirname release;
          release;
          Filename.concat release "bin";
          Filename.concat release "libexec";
        ];
      let program =
        Filename.concat (Filename.concat release "bin") "mesh-platform"
      in
      close_out (open_out program);
      Unix.symlink "releases/v0.3.1" (Filename.concat share "current");
      let through_current =
        Filename.concat
          (Filename.concat (Filename.concat share "current") "bin")
          "mesh-platform"
      in
      (* the bundle's bin/mesh-ptyhost wrapper executes libexec/mesh-ptyhost *)
      let bundled_host =
        Filename.concat (Filename.concat release "libexec") "mesh-ptyhost"
      in
      close_out (open_out bundled_host);
      (match R.installation_of_executable through_current with
      | Some found ->
          Alcotest.(check string) "tag" "v0.3.1" found.tag;
          Alcotest.(check string) "share" share found.share
      | None -> Alcotest.fail "release install not recognised");
      match R.installation_of_executable bundled_host with
      | Some found -> Alcotest.(check string) "libexec tag" "v0.3.1" found.tag
      | None -> Alcotest.fail "bundled PTY host not recognised");

  Alcotest.(check bool)
    "source checkout" true
    (R.installation_of_executable "/nonexistent/bin/x" = None);
  Alcotest.(check bool)
    "pre-release dir" true
    (R.installation_of_release_dir "/s/releases/v1.0.0-rc.1" = None);
  Alcotest.(check bool)
    "not under releases" true
    (R.installation_of_release_dir "/s/other/v1.0.0" = None)

(* ---- the request line and the cache-only read *)

let test_curl_arguments () =
  let arguments =
    R.curl_arguments ~etag:(Some "\"abc\"") ~headers:"h" ~body:"b" ()
  in
  Alcotest.(check (list string))
    "-q right after curl" [ "curl"; "-q" ]
    (List.filteri (fun index _ -> index < 2) arguments);
  Alcotest.(check string)
    "fixed user agent" "session-mesh-update-check" R.user_agent;
  let rec after_flag flag = function
    | name :: value :: _ when name = flag -> Some value
    | _ :: rest -> after_flag flag rest
    | [] -> None
  in
  Alcotest.(check (option string))
    "-A" (Some R.user_agent) (after_flag "-A" arguments);
  Alcotest.(check bool)
    "no credential" false
    (List.exists
       (fun argument ->
         let argument = String.lowercase_ascii argument in
         String.starts_with ~prefix:"authorization" argument
         || argument = "--netrc" || argument = "-n" || argument = "-u")
       arguments)

(* A hostile ~/.curlrc (HOME and CURL_HOME point to it) asks curl to write a
   trace file. With -q first nothing is read, so no file appears; without -q the
   file does, which shows the test would notice a regression. *)
let test_curlrc_ignored () =
  with_root (fun root ->
      let trace = Filename.concat root "trace" in
      Out_channel.with_open_bin (Filename.concat root ".curlrc") (fun channel ->
          Printf.fprintf channel
            "trace-ascii = \"%s\"\n\
             user-agent = \"hostile\"\n\
             header = \"Authorization: Bearer hostile\"\n"
            trace);
      Unix.putenv "HOME" root;
      Unix.putenv "CURL_HOME" root;
      let run arguments =
        match R.run_curl arguments with
        | _ -> true
        | exception Unix.Unix_error (Unix.ENOENT, _, _) -> false
      in
      let arguments =
        R.curl_arguments ~url:"https://127.0.0.1:1/" ~etag:None
          ~headers:(Filename.concat root "headers")
          ~body:(Filename.concat root "body")
          ()
      in
      if run arguments then begin
        Alcotest.(check bool)
          "hostile .curlrc not read" false (Sys.file_exists trace);
        ignore (run (List.filter (fun argument -> argument <> "-q") arguments));
        Alcotest.(check bool)
          "without -q it would be read" true (Sys.file_exists trace)
      end)

let test_cache_only () =
  with_root (fun root ->
      let getenv = env [ ("MESH_CACHE_DIR", root) ] in
      let cache_file = Filename.concat root "update-check.json" in
      let calls, fetch = recording ok_answer in
      let check ~request ~now =
        R.check ~getenv ~installation:(Some installation) ~request ~force:false
          ~now ~fetch
      in
      let outcome, _ = check ~request:false ~now:1. in
      Alcotest.(check string) "no cache" "unavailable" (status outcome);
      Alcotest.(check bool) "nothing written" false (Sys.file_exists cache_file);
      let outcome, _ = check ~request:true ~now:1. in
      Alcotest.(check string) "requested" "available" (status outcome);
      let outcome, error = check ~request:false ~now:(1. +. (10. *. C.period)) in
      Alcotest.(check string) "stale cache is read" "available" (status outcome);
      Alcotest.(check (option string)) "no error" None error;
      Alcotest.(check int) "only the explicit request" 1 (List.length !calls);
      Alcotest.(check (float 0.))
        "the cache is not re-dated" 1.
        (Option.get (C.read_cache cache_file)).checked_at)

(* ---- working files and an unwritable cache *)

let listing directory = Array.to_list (Sys.readdir directory)

(* The request's files are made in the cache directory (not /tmp) and are gone
   afterwards, also when the command is interrupted. *)
let test_work_files_in_cache_directory () =
  with_root (fun root ->
      let directory = Filename.concat root "cache" in
      let seen = ref [] in
      let run arguments =
        let rec after flag = function
          | name :: value :: _ when name = flag -> value
          | _ :: rest -> after flag rest
          | [] -> failwith ("no " ^ flag)
        in
        let headers = after "-D" arguments and body = after "-o" arguments in
        seen := [ headers; body ];
        Out_channel.with_open_bin headers (fun channel ->
            output_string channel "HTTP/2 200\r\nETag: \"e1\"\r\n\r\n");
        Out_channel.with_open_bin body (fun channel ->
            output_string channel list_body);
        (Unix.WEXITED 0, "200")
      in
      (match R.fetch_with ~run ~directory ~etag:None with
      | C.Body { etag; body = _ } ->
          Alcotest.(check (option string)) "etag read" (Some "\"e1\"") etag
      | _ -> Alcotest.fail "expected a body");
      List.iter
        (fun path ->
          Alcotest.(check string) "made in the cache directory" directory
            (Filename.dirname path);
          Alcotest.(check bool) "removed" false (Sys.file_exists path))
        !seen;
      Alcotest.(check (list string)) "nothing left" [] (listing directory);
      let interrupted _ = raise Exit in
      (match R.fetch_with ~run:interrupted ~directory ~etag:None with
      | _ -> Alcotest.fail "the interruption must propagate"
      | exception Exit -> ());
      Alcotest.(check (list string)) "nothing left" [] (listing directory);
      let failed _ = (Unix.WEXITED 7, "") in
      Alcotest.(check bool)
        "a failing command is a failure" true
        (match R.fetch_with ~run:failed ~directory ~etag:None with
        | C.Failed "curl exited with 7" -> true
        | _ -> false);
      let file = Filename.concat root "not-a-directory" in
      Out_channel.with_open_bin file ignore;
      Alcotest.(check bool)
        "an unusable directory is a failure, not an exception" true
        (match R.fetch_with ~run ~directory:(Filename.concat file "x") ~etag:None with
        | C.Failed _ -> true
        | _ -> false))

(* What a killed process left behind is removed once it is old; recent files
   (another process's request) and other files stay. *)
let test_clean_stale () =
  with_root (fun root ->
      let touch ?(age = 0.) name =
        let path = Filename.concat root name in
        Out_channel.with_open_bin path ignore;
        let time = Unix.time () -. age in
        Unix.utimes path time time
      in
      touch ~age:3600. "update-fetch.abc.headers";
      touch ~age:3600. "update-fetch.abc.json";
      touch ~age:3600. "update-check.json.42.tmp";
      touch ~age:3600. "update-check.json";
      touch ~age:3600. "unrelated";
      touch "update-fetch.live.json";
      R.clean_stale ~directory:root;
      Alcotest.(check (list string))
        "only the old working files go"
        [ "unrelated"; "update-check.json"; "update-fetch.live.json" ]
        (List.sort compare (listing root));
      R.clean_stale ~directory:(Filename.concat root "missing"))

(* A cache that cannot be written makes no request at all: the attempt could
   not be dated, so every start would ask again. *)
let test_unwritable_cache () =
  if Unix.geteuid () = 0 then ()
  else
    with_root (fun root ->
        let directory = Filename.concat root "cache" in
        let cache_path = Filename.concat directory "update-check.json" in
        Unix.mkdir directory 0o500;
        Fun.protect
          ~finally:(fun () -> Unix.chmod directory 0o700)
          (fun () ->
            let calls, fetch = recording ok_answer in
            let cache, error =
              C.refresh ~now:1000. ~force:false ~cache_path ~fetch
            in
            Alcotest.(check int) "no request" 0 (List.length !calls);
            Alcotest.(check bool) "no answer" true (cache = None);
            Alcotest.(check bool) "the reason is reported" true (error <> None)))

(* ---- the settings file *)

let test_parse_settings () =
  let parsed text = R.parse_settings text in
  Alcotest.(check bool) "both keys" true
    (parsed "check=0\nnotice=security\n"
    = Ok { R.check = Some "0"; notice = Some "security" });
  Alcotest.(check bool)
    "comments, blank lines, unknown lines and keys, spaces, CRLF" true
    (parsed "# a comment\r\n\r\n  check = 1 \r\nfuture=7\nstray\n#notice=none\n"
    = Ok { R.check = Some "1"; notice = None });
  Alcotest.(check bool) "empty" true
    (parsed "" = Ok { R.check = None; notice = None });
  List.iter
    (fun text ->
      Alcotest.(check bool) (String.escaped text) true
        (match parsed text with Error _ -> true | Ok _ -> false))
    [
      "check=yes";
      "check=";
      "check=00";
      "notice=weekly";
      "check=0\ncheck=1";
      "notice=all\nnotice=none";
      "check=0\nnotice=";
    ]

let write_settings ?(mode = 0o600) dir text =
  (try Unix.mkdir dir 0o700 with Unix.Unix_error (Unix.EEXIST, _, _) -> ());
  let path = Filename.concat dir R.settings_name in
  (try Unix.unlink path with Unix.Unix_error _ -> ());
  Out_channel.with_open_bin path (fun channel -> output_string channel text);
  Unix.chmod path mode;
  path

(* the effective values and the reason the file was ignored *)
let effective pairs =
  let getenv, problem = R.with_settings (env pairs) in
  (getenv "MESH_UPDATE_CHECK", getenv "MESH_UPDATE_NOTICE", problem)

let triple = Alcotest.(triple (option string) (option string) (option string))

let test_settings_file_overrides_environment () =
  with_root (fun root ->
      let conf = Filename.concat root "conf" in
      let pairs =
        [
          ("MESH_CONF_DIR", conf);
          ("MESH_UPDATE_CHECK", "0");
          ("MESH_UPDATE_NOTICE", "major");
        ]
      in
      Alcotest.check triple "no file: the environment"
        (Some "0", Some "major", None)
        (effective pairs);
      ignore (write_settings conf "check=1\n");
      Alcotest.check triple "a key of the file replaces its variable only"
        (Some "1", Some "major", None)
        (effective pairs);
      ignore (write_settings conf "notice=none\n");
      Alcotest.check triple "the other key"
        (Some "0", Some "none", None)
        (effective pairs);
      let path = write_settings conf "check=1\n" in
      Alcotest.check triple "read again at every call: the new content"
        (Some "1", Some "major", None)
        (effective pairs);
      Unix.unlink path;
      Alcotest.check triple "removed: the environment again"
        (Some "0", Some "major", None)
        (effective pairs);
      (* with no MESH_CONF_DIR the directory is under HOME *)
      let home = Filename.concat root "home" in
      Unix.mkdir home 0o700;
      Unix.mkdir (Filename.concat home ".config") 0o700;
      ignore
        (write_settings
           (Filename.concat (Filename.concat home ".config") "session-mesh")
           "notice=minor\n");
      Alcotest.check triple "default directory ~/.config/session-mesh"
        (None, Some "minor", None)
        (effective [ ("HOME", home) ]))

let test_settings_file_refused () =
  with_root (fun root ->
      let conf = Filename.concat root "conf" in
      let pairs =
        [
          ("MESH_CONF_DIR", conf);
          ("MESH_UPDATE_CHECK", "0");
          ("MESH_UPDATE_NOTICE", "major");
        ]
      in
      let refused label =
        match effective pairs with
        | check, notice, Some reason ->
            Alcotest.(check (pair (option string) (option string)))
              (label ^ ": the environment values")
              (Some "0", Some "major")
              (check, notice);
            Alcotest.(check bool)
              (label ^ ": the reason names the file")
              true
              (String.starts_with ~prefix:"update-notice " reason)
        | _ -> Alcotest.fail (label ^ ": not refused")
      in
      ignore (write_settings conf "check=maybe\n");
      refused "invalid value";
      ignore (write_settings conf "check=1\ncheck=1\n");
      refused "duplicate key";
      ignore (write_settings ~mode:0o666 conf "check=1\n");
      refused "world-writable";
      ignore (write_settings ~mode:0o620 conf "check=1\n");
      refused "group-writable";
      ignore
        (write_settings conf ("check=1\n" ^ String.make R.settings_limit '#'));
      refused "oversized";
      let path = write_settings conf "check=1\n" in
      Unix.unlink path;
      let target = Filename.concat root "elsewhere" in
      Out_channel.with_open_bin target (fun channel ->
          output_string channel "check=1\n");
      Unix.chmod target 0o600;
      Unix.symlink target path;
      refused "symbolic link";
      Unix.unlink path;
      Unix.mkdir path 0o700;
      refused "directory";
      Unix.rmdir path;
      (* exactly the limit is accepted *)
      ignore
        (write_settings conf
           ("check=1\n" ^ String.make (R.settings_limit - 9) '#' ^ "\n"));
      Alcotest.check triple "at the limit"
        (Some "1", Some "major", None)
        (effective pairs))

(* [mesh-platform update-check] runs [R.check] through [with_settings], as the
   host does: with the file, the two take the same decision. *)
let test_settings_file_drives_the_check () =
  with_root (fun root ->
      let conf = Filename.concat root "conf" in
      let decide pairs =
        let calls, fetch = recording ok_answer in
        let getenv, _ =
          R.with_settings
            (env
               (("MESH_CACHE_DIR", root) :: ("MESH_CONF_DIR", conf) :: pairs))
        in
        let outcome, _ =
          R.check ~getenv ~installation:(Some installation) ~request:true
            ~force:true ~now:1. ~fetch
        in
        (status outcome, List.length !calls)
      in
      let pair = Alcotest.(pair string int) in
      Alcotest.check pair "no file" ("available", 1) (decide []);
      ignore (write_settings conf "check=0\n");
      Alcotest.check pair "check=0" ("disabled", 0) (decide []);
      ignore (write_settings conf "notice=none\n");
      Alcotest.check pair "notice=none" ("disabled", 0) (decide []);
      ignore (write_settings conf "check=1\n");
      Alcotest.check pair "the file overrides MESH_UPDATE_CHECK=0"
        ("available", 1)
        (decide [ ("MESH_UPDATE_CHECK", "0") ]);
      ignore (write_settings conf "check=nope\n");
      Alcotest.check pair "an invalid file falls back to the environment"
        ("disabled", 0)
        (decide [ ("MESH_UPDATE_CHECK", "0") ]))

(* ---- release notes: kept for the page, bounded *)

let test_notes_kept () =
  let parsed =
    C.releases_of_body
      (body
         [
           `Assoc
             [
               ("tag_name", `String "v0.2.0");
               ("draft", `Bool false);
               ("prerelease", `Bool false);
               ("published_at", `String "2026-11-19T10:00:00Z");
               ("body", `String "## New\r\n\x01Text\x7f\tend\r\nSecurity: yes");
             ];
           `Assoc
             [
               ("tag_name", `String "v0.1.0");
               ("published_at", `String "yesterday");
             ];
         ])
  in
  match Result.get_ok parsed with
  | [ first; second ] ->
      Alcotest.(check string)
        "line ends and control characters" "## New\nText\tend\nSecurity: yes"
        first.notes;
      Alcotest.(check bool) "security" true first.security;
      Alcotest.(check bool) "not cut" false first.truncated;
      Alcotest.(check string)
        "date" "2026-11-19T10:00:00Z" first.published;
      Alcotest.(check string) "no body" "" second.notes;
      Alcotest.(check string) "a date that is not one" "" second.published
  | _ -> Alcotest.fail "two releases"

let test_notes_capped () =
  (* two-byte characters: a cut at the limit falls inside one *)
  let long = String.concat "" (List.init 40000 (fun _ -> "\xc3\xa9")) ^ "x" in
  let notes, truncated = C.cap_notes ("a" ^ long) in
  Alcotest.(check bool) "cut" true truncated;
  Alcotest.(check bool)
    "within the limit" true
    (String.length notes <= C.notes_limit);
  Alcotest.(check bool)
    "valid UTF-8" true
    (String.is_valid_utf_8 notes);
  Alcotest.(check bool)
    "close to the limit" true
    (String.length notes >= C.notes_limit - 3);
  let short, cut = C.cap_notes "short" in
  Alcotest.(check string) "short notes unchanged" "short" short;
  Alcotest.(check bool) "not cut" false cut;
  let exact = String.make C.notes_limit 'a' in
  Alcotest.(check bool)
    "exactly the limit is kept" false
    (snd (C.cap_notes exact))

let test_cache_keeps_notes () =
  with_root (fun root ->
      let path = Filename.concat root "update-check.json" in
      let release =
        {
          (rel "v0.2.0") with
          notes = "## Notes\n| a | b |";
          published = "2026-11-19T10:00:00Z";
          truncated = true;
        }
      in
      C.write_cache path
        { checked_at = 1.; etag = Some "\"e\""; releases = [ release ] };
      let cache = Option.get (C.read_cache path) in
      Alcotest.(check (option string)) "etag" (Some "\"e\"") cache.etag;
      match cache.releases with
      | [ kept ] ->
          Alcotest.(check string) "notes" release.notes kept.notes;
          Alcotest.(check string) "date" release.published kept.published;
          Alcotest.(check bool) "cut" true kept.truncated
      | _ -> Alcotest.fail "one release")

(* A cache written before the notes were kept has none: its ETag is not sent
   back, so the next request gets the whole list (with the notes) once. *)
let test_old_cache_sends_no_etag () =
  with_root (fun root ->
      let path = Filename.concat root "update-check.json" in
      Out_channel.with_open_bin path (fun channel ->
          output_string channel
            {|{"checked_at":1.0,"etag":"\"old\"","releases":[{"tag":"v0.2.0","security":false}]}|});
      let cache = Option.get (C.read_cache path) in
      Alcotest.(check (option string)) "no etag" None cache.etag;
      Alcotest.(check int) "releases kept" 1 (List.length cache.releases);
      let sent = ref (Some "unset") in
      ignore
        (C.refresh ~now:(4. *. 3600.) ~force:false ~cache_path:path
           ~fetch:(fun ~etag ->
             sent := etag;
             C.Not_modified));
      Alcotest.(check (option string)) "nothing sent" None !sent)

let test_notes_reported () =
  let installation =
    { R.tag = "v0.1.0"; version = version "v0.1.0"; share = "/srv/share" }
  in
  let latest =
    {
      (rel "v0.2.0") with
      notes = "## New";
      published = "2026-11-19T10:00:00Z";
    }
  in
  let outcome =
    R.Available { notice = { latest; security = false }; installation }
  in
  let field name json = Yojson.Safe.Util.member name json in
  Alcotest.(check bool)
    "the notice says notes exist" true
    (field "notes" (R.to_json ~home:None outcome) = `Bool true);
  let notes = R.notes_json outcome in
  Alcotest.(check bool) "tag" true (field "tag" notes = `String "v0.2.0");
  Alcotest.(check bool) "body" true (field "body" notes = `String "## New");
  Alcotest.(check bool)
    "date" true
    (field "published" notes = `String "2026-11-19T10:00:00Z");
  Alcotest.(check bool) "cut" true (field "truncated" notes = `Bool false);
  Alcotest.(check bool)
    "link" true
    (field "notes_url" notes
    = `String "https://github.com/Session-Mesh/session-mesh/releases/tag/v0.2.0");
  let empty =
    R.Available
      {
        notice = { latest = { latest with notes = "" }; security = false };
        installation;
      }
  in
  Alcotest.(check bool)
    "no notes: said" true
    (field "notes" (R.to_json ~home:None empty) = `Bool false);
  Alcotest.(check bool) "no notes: null" true (R.notes_json empty = `Null);
  Alcotest.(check bool) "nothing announced" true (R.notes_json R.Current = `Null)

let () =
  Alcotest.run "mesh_update"
    [
      ( "settings file",
        [
          Alcotest.test_case "parse" `Quick test_parse_settings;
          Alcotest.test_case "overrides the environment" `Quick
            test_settings_file_overrides_environment;
          Alcotest.test_case "refused" `Quick test_settings_file_refused;
          Alcotest.test_case "drives the check" `Quick
            test_settings_file_drives_the_check;
        ] );
      ( "semver",
        [
          Alcotest.test_case "parse" `Quick test_parse;
          Alcotest.test_case "order" `Quick test_order;
        ] );
      ( "releases",
        [
          Alcotest.test_case "filtering" `Quick test_filtering;
          Alcotest.test_case "security marker" `Quick test_security_marker;
          Alcotest.test_case "notes kept" `Quick test_notes_kept;
          Alcotest.test_case "notes capped" `Quick test_notes_capped;
        ] );
      ( "levels",
        [
          Alcotest.test_case "levels" `Quick test_levels;
          Alcotest.test_case "security at every level" `Quick
            test_security_every_level;
          Alcotest.test_case "intermediate security release" `Quick
            test_intermediate_security;
          Alcotest.test_case "nothing newer" `Quick test_no_newer;
        ] );
      ( "cache",
        [
          Alcotest.test_case "cache and ETag" `Quick test_cache_and_etag;
          Alcotest.test_case "unsafe ETag" `Quick test_invalid_etag;
          Alcotest.test_case "failure keeps releases" `Quick
            test_failure_keeps_releases;
          Alcotest.test_case "notes kept" `Quick test_cache_keeps_notes;
          Alcotest.test_case "an older cache sends no ETag" `Quick
            test_old_cache_sends_no_etag;
        ] );
      ( "check",
        [
          Alcotest.test_case "curl arguments" `Quick test_curl_arguments;
          Alcotest.test_case "hostile .curlrc ignored" `Quick test_curlrc_ignored;
          Alcotest.test_case "cache only" `Quick test_cache_only;
          Alcotest.test_case "working files in the cache directory" `Quick
            test_work_files_in_cache_directory;
          Alcotest.test_case "stale working files" `Quick test_clean_stale;
          Alcotest.test_case "unwritable cache" `Quick test_unwritable_cache;
          Alcotest.test_case "opt-out" `Quick test_opt_out;
          Alcotest.test_case "levels from the environment" `Quick
            test_levels_from_environment;
          Alcotest.test_case "no release" `Quick test_no_release;
          Alcotest.test_case "network failure" `Quick test_network_failure;
          Alcotest.test_case "report" `Quick test_report;
          Alcotest.test_case "notes reported" `Quick test_notes_reported;
          Alcotest.test_case "installation from its path" `Quick
            test_installation_from_path;
        ] );
    ]
