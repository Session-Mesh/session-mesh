(******************************************************************************)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                  *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                            *)
(******************************************************************************)

module T = Mesh_opencode_transfer

let s value = `String value
let obj fields = `Assoc fields
let data value = obj [ ("data", value) ]
let id = "ses_fixtureTransfer20261122"
let path = "/api/experimental/session/" ^ id ^ "/export"
let info location =
  obj
    [
      ("id", s id);
      ("projectID", s "project");
      ("location", obj [ ("directory", s location) ]);
      ("time", obj [ ("created", `Int 1); ("updated", `Int 2) ]);
      ("cost", `Int 0);
      ("tokens", obj []);
    ]

let messages =
  `List
    [
      obj
        [
          ("id", s "msg_user");
          ("type", s "user");
          ("time", obj [ ("created", `Int 1) ]);
          ("text", s "private text");
        ];
      obj
        [
          ("id", s "msg_assistant");
          ("type", s "assistant");
          ("agent", s "build");
          ("model", obj [ ("providerID", s "fixture"); ("id", s "offline") ]);
          ("time", obj [ ("created", `Int 2); ("completed", `Int 3) ]);
          ("finish", s "stop");
          ( "content",
            `List [ obj [ ("type", s "text"); ("text", s "full answer") ] ] );
        ];
      obj
        [
          ("id", s "msg_idle");
          ("type", s "idle");
          ("time", obj [ ("created", `Int 4) ]);
          ("outcome", s "succeeded");
        ];
    ]

let export location = data (obj [ ("info", info location); ("messages", messages) ])
let response location = export location
let empty = data (`List [])
let active = data (obj [])

let mock ?(before = fun _ -> None) () =
  let context location =
    {
      T.home = location;
      config = location;
      data = location;
      state = location;
      cache = location;
      runtime = location;
      location;
    }
  in
  let source = context "/source" and target = context "/target" in
  let requests = ref [] in
  let imported = ref false in
  let request context verb route body =
    let side = if context == source then `Source else `Target in
    requests := (side, verb, route, body) :: !requests;
    match before (side, verb, route, body) with
    | Some value -> value
    | None ->
        let location = if side = `Source then "/source" else "/target" in
        if verb = `Get && route = "/api/info" then
          Ok (200, obj [ ("version", s "2.3.2") ])
        else if verb = `Get && route = "/api/session/active" then
          Ok (200, active)
        else if
          verb = `Get
          && List.mem route
               [
                 "/api/session/" ^ id ^ "/inbox";
                  "/api/session/" ^ id ^ "/permission";
                  "/api/session/" ^ id ^ "/form";
                  "/api/experimental/session/" ^ id ^ "/instructions/entries";
               ]
        then Ok (200, empty)
        else if verb = `Get && route = "/api/session/" ^ id ^ "/context"
        then Ok (200, data messages)
        else if verb = `Get && route = path then
          if side = `Source || !imported then Ok (200, response location)
          else Ok (404, obj [])
        else if
          side = `Target && verb = `Post
          && route = "/api/experimental/session/import"
        then (
          imported := true;
          Ok (200, data (info "/target")))
        else Alcotest.fail ("unexpected request " ^ route)
  in
  (source, target, request, requests, imported)

let code expected = function
  | Error actual -> Alcotest.(check string) "refusal" expected actual
  | Ok _ -> Alcotest.fail ("expected " ^ expected)

let success () =
  let source, target, request, requests, imported = mock () in
  let result = T.transfer ~request ~source ~target ~session_id:id in
  Alcotest.(check bool) "verified transfer" true
    (result = Ok { T.messages = 3 });
  Alcotest.(check bool) "one import" true !imported;
  let imports =
    List.filter
      (fun (side, verb, _, _) -> side = `Target && verb = `Post)
      !requests
  in
  Alcotest.(check int) "exactly one import" 1 (List.length imports);
  match imports with
  | [ (_, _, _, Some bytes) ] ->
      let value = Yojson.Safe.from_string bytes in
      Alcotest.(check bool) "native messages intact" true
        (Yojson.Safe.Util.member "messages" value = messages)
  | _ -> Alcotest.fail "complete import body expected"

let settled_busy_timestamp () =
  let imported = ref false in
  let source, target, request, _, _ =
    mock
      ~before:(function
        | side, `Get, route, _ when route = path ->
            if side = `Target && not !imported then Some (Ok (404, obj []))
            else
              let location = if side = `Source then "/source" else "/target" in
              let info =
                match info location with
                | `Assoc fields ->
                    obj
                      (("time",
                        obj
                          [
                            ("created", `Int 1);
                            ("updated", `Int 2);
                            ("busy", `Int 1);
                            ("idle", `Int 2);
                          ])
                      :: List.remove_assoc "time" fields)
                | _ -> Alcotest.fail "fixture info"
              in
              let payload = obj [ ("info", info); ("messages", messages) ] in
              Some (Ok (200, data payload))
        | `Target, `Post, "/api/experimental/session/import", _ ->
            imported := true;
            let acknowledgement = data (info "/target") in
            Some (Ok (200, acknowledgement))
        | _ -> None)
      ()
  in
  Alcotest.(check bool) "completed busy epoch is idle" true
    (T.transfer ~request ~source ~target ~session_id:id
    = Ok { T.messages = 3 })

let viewed_import_normalization () =
  let with_viewed location viewed =
    match info location with
    | `Assoc fields ->
        let time =
          obj
            [
              ("created", `Int 1);
              ("updated", `Int 20);
              ("busy", `Int 6);
              ("idle", `Int 10);
              ("viewed", viewed);
            ]
        in
        obj (("time", time) :: List.remove_assoc "time" fields)
    | _ -> Alcotest.fail "fixture info"
  in
  let run ?(source_viewed = `Int 15) ?(expected_imports = 1) target_viewed =
    let imported = ref false and imports = ref 0 in
    let source, target, request, _, _ =
      mock
        ~before:(function
          | side, `Get, route, _ when route = path ->
              if side = `Target && not !imported then
                Some (Ok (404, obj []))
              else
                let location = if side = `Source then "/source" else "/target" in
                let viewed =
                  if side = `Source then source_viewed else target_viewed
                in
                Some
                  (Ok
                     (200,
                      data
                        (obj
                           [
                             ("info", with_viewed location viewed);
                             ("messages", messages);
                           ])))
          | `Target, `Post, "/api/experimental/session/import", _ ->
              incr imports;
              imported := true;
              Some (Ok (200, data (with_viewed "/target" target_viewed)))
          | _ -> None)
        ()
    in
    let result = T.transfer ~request ~source ~target ~session_id:id in
    Alcotest.(check int) "import count, no retry" expected_imports !imports;
    result
  in
  Alcotest.(check bool) "2.3.2 clamp preserves imported viewed watermark" true
    (run (`Int 10) = Ok { T.messages = 3 });
  code "transfer_uncertain" (run (`Int 9));
  code "transfer_uncertain" (run (`Int 11));
  code "transfer_uncertain" (run (`String "10"));
  code "transfer_unsupported_state"
    (run ~source_viewed:(`String "15") ~expected_imports:0 (`Int 10))

let reject_busy_timestamp () =
  let source, target, request, requests, _ =
    mock
      ~before:(function
        | `Source, `Get, route, _ when route = path ->
            let busy_info =
              match info "/source" with
              | `Assoc fields ->
                  obj
                    (("time",
                      obj
                        [
                          ("created", `Int 1);
                          ("updated", `Int 3);
                          ("idle", `Int 2);
                          ("busy", `Int 3);
                        ])
                    :: List.remove_assoc "time" fields)
              | _ -> Alcotest.fail "fixture info"
            in
            Some
              (Ok
                 (200, data (obj [ ("info", busy_info); ("messages", messages) ])))
        | _ -> None)
      ()
  in
  code "transfer_unsupported_state"
    (T.transfer ~request ~source ~target ~session_id:id);
  Alcotest.(check bool) "newer busy epoch never imports" false
    (List.exists
       (function `Target, `Post, _, _ -> true | _ -> false)
       !requests)

let reject_before_import name before expected =
  let source, target, request, requests, _ = mock ~before () in
  code expected (T.transfer ~request ~source ~target ~session_id:id);
  Alcotest.(check bool) name false
    (List.exists
       (fun (side, verb, _, _) -> side = `Target && verb = `Post)
       !requests)

let refusals () =
  reject_before_import "unsupported version"
    (function
      | `Source, `Get, "/api/info", _ ->
          Some (Ok (200, obj [ ("version", s "2.3.3") ]))
      | _ -> None)
    "transfer_unsupported_version";
  reject_before_import "active source"
    (function
      | `Source, `Get, "/api/session/active", _ ->
          Some (Ok (200, data (obj [ (id, obj [ ("type", s "running") ]) ])))
      | _ -> None)
    "transfer_busy";
  reject_before_import "pending inbox"
    (function
      | `Source, `Get, route, _ when String.ends_with ~suffix:"/inbox" route ->
          Some (Ok (200, data (`List [ obj [] ])))
      | _ -> None)
    "transfer_pending";
  reject_before_import "pending permission"
    (function
      | `Source, `Get, route, _ when String.ends_with ~suffix:"/permission" route ->
          Some (Ok (200, data (`List [ obj [] ])))
      | _ -> None)
    "transfer_pending";
  reject_before_import "pending form"
    (function
      | `Source, `Get, route, _ when String.ends_with ~suffix:"/form" route ->
          Some (Ok (200, data (`List [ obj [] ])))
      | _ -> None)
    "transfer_pending";
  reject_before_import "active instruction entries"
    (function
      | `Source, `Get, route, _
        when String.ends_with ~suffix:"/instructions/entries" route ->
          Some (Ok (200, data (`List [ obj [ ("key", s "local") ] ])))
      | _ -> None)
    "transfer_unsupported_state";
  reject_before_import "unreadable instruction entries"
    (function
      | `Source, `Get, route, _
        when String.ends_with ~suffix:"/instructions/entries" route ->
          Some (Ok (404, obj []))
      | _ -> None)
    "transfer_unavailable";
  reject_before_import "partial context"
    (function
      | `Source, `Get, route, _ when String.ends_with ~suffix:"/context" route ->
          Some (Ok (200, empty))
      | _ -> None)
    "transfer_unsupported_state";
  reject_before_import "unsupported export schema"
    (function
      | `Source, `Get, route, _ when route = path ->
          Some
            (Ok
               ( 200,
                 data
                   (obj
                      [
                        ( "info",
                          obj
                            [
                              ("id", s id);
                              ("location", obj [ ("directory", s "/source") ]);
                            ] );
                        ("messages", `List []);
                      ]) ))
      | _ -> None)
    "transfer_schema";
  reject_before_import "target collision"
    (function
      | `Target, `Get, route, _ when route = path ->
          Some (Ok (200, export "/target"))
      | _ -> None)
    "transfer_diverged";
  reject_before_import "unsupported revert"
    (function
      | `Source, `Get, route, _ when route = path ->
          let value = export "/source" in
          let info =
            Yojson.Safe.Util.member "info"
              (Yojson.Safe.Util.member "data" value)
          in
          Some
            (Ok
               ( 200,
                 data
                   (obj
                      [
                        ( "info",
                          (match info with
                          | `Assoc fields ->
                              obj
                                (("revert", obj [ ("messageID", s "msg_user") ])
                                :: fields)
                           | _ -> Alcotest.fail "invalid fixture") );
                        ("messages", messages);
                      ]) ))
      | _ -> None)
    "transfer_unsupported_state"

let incomplete_transcript () =
  let idle =
    match messages with
    | `List rows -> List.hd (List.rev rows)
    | _ -> Alcotest.fail "invalid fixture"
  in
  List.iter
    (fun injected ->
      reject_before_import "incomplete or dependent native transcript"
        (function
          | `Source, `Get, route, _ when route = path ->
              Some
                (Ok
                   ( 200,
                     data
                       (obj
                          [
                            ("info", info "/source");
                            ("messages", `List [ injected; idle ]);
                          ]) ))
          | `Source, `Get, route, _
            when route = "/api/session/" ^ id ^ "/context" ->
              Some (Ok (200, data (`List [ injected; idle ])))
          | _ -> None)
        "transfer_unsupported_state")
    [
      obj
        [
          ("id", s "msg_pending");
          ("type", s "shell");
          ("status", s "running");
          ("time", obj [ ("created", `Int 1) ]);
        ];
      obj
        [
          ("id", s "msg_pending");
          ("type", s "assistant");
          ("time", obj [ ("created", `Int 1) ]);
        ];
      obj
        [
          ("id", s "msg_pending");
          ("type", s "synthetic");
          ("time", obj [ ("created", `Int 1) ]);
        ];
      obj
        [
          ("id", s "msg_pending");
          ("type", s "location-switched");
          ("time", obj [ ("created", `Int 1) ]);
        ];
      obj
        [
          ("id", s "msg_pending");
          ("type", s "compaction");
          ("time", obj [ ("created", `Int 1) ]);
          ("status", s "running");
        ];
    ]

let terminal_shell_statuses () =
  List.iter
    (fun status ->
      let shell =
        obj
          [
            ("id", s "msg_shell");
            ("type", s "shell");
            ("shellID", s "sh_fixture");
            ("command", s "printf ok");
            ("status", s status);
            ("time", obj [ ("created", `Int 3); ("completed", `Int 4) ]);
          ]
      in
      let transcript =
        match messages with
        | `List [ user; assistant; idle ] ->
            `List [ user; assistant; shell; idle ]
        | _ -> Alcotest.fail "invalid fixture"
      in
      let imported = ref false in
      let source, target, request, _, _ =
        mock
          ~before:(function
            | side, `Get, route, _ when route = path ->
                if side = `Target && not !imported then
                  Some (Ok (404, obj []))
                else
                  let location = if side = `Source then "/source" else "/target" in
                  Some
                    (Ok
                       (200, data (obj [ ("info", info location); ("messages", transcript) ])))
            | (`Source | `Target), `Get, route, _
              when route = "/api/session/" ^ id ^ "/context" ->
                Some (Ok (200, data transcript))
            | `Target, `Post, "/api/experimental/session/import", _ ->
                imported := true;
                Some (Ok (200, data (info "/target")))
            | _ -> None)
          ()
      in
      Alcotest.(check bool) ("terminal shell " ^ status) true
        (T.transfer ~request ~source ~target ~session_id:id
         = Ok { T.messages = 4 }))
    [ "exited"; "timeout"; "killed" ]

let after_import_uncertain () =
  let source, target, request, requests, _ =
    mock
      ~before:(function
        | `Target, `Get, route, _
          when String.ends_with ~suffix:"/instructions/entries" route ->
            Some (Ok (200, data (`List [ obj [ ("key", s "local") ] ])))
        | _ -> None)
      ()
  in
  code "transfer_uncertain"
    (T.transfer ~request ~source ~target ~session_id:id);
  Alcotest.(check int) "one import before target instruction refusal" 1
    (List.length
       (List.filter
          (fun (side, verb, _, _) -> side = `Target && verb = `Post)
          !requests));
  let source, target, request, _, _ =
    mock
      ~before:(function
        | `Target, `Get, route, _
          when String.ends_with ~suffix:"/context" route ->
            Some (Ok (200, empty))
        | _ -> None)
      ()
  in
  code "transfer_uncertain"
    (T.transfer ~request ~source ~target ~session_id:id);
  let calls = ref 0 in
  let source, target, request, _, _ =
    mock
      ~before:(function
        | `Source, `Get, route, _ when route = path ->
            incr calls;
            if !calls = 2 then
              let changed = export "/source" in
              let original = Yojson.Safe.Util.member "data" changed in
              let info = Yojson.Safe.Util.member "info" original in
              let info =
                match info with
                | `Assoc fields ->
                    obj (("title", s "changed") :: fields)
                | _ -> Alcotest.fail "invalid fixture"
              in
              Some (Ok (200, data (obj [ ("info", info); ("messages", messages) ])))
            else None
        | _ -> None)
      ()
  in
  code "transfer_uncertain"
    (T.transfer ~request ~source ~target ~session_id:id)

let tool_compaction () =
  let tool =
    obj
      [
        ("type", s "tool");
        ("id", s "tool_fixture");
        ("name", s "read");
        ( "state",
          obj
            [
              ("status", s "completed");
              ("input", obj []);
              ("content", `List [ obj [ ("type", s "text"); ("text", s "ok") ] ]);
            ] );
        ("time", obj [ ("created", `Int 2); ("completed", `Int 3) ]);
      ]
  in
  let assisted =
    match messages with
    | `List [ user; `Assoc fields; idle ] ->
        let assistant =
          obj
            (("content", `List [ tool ])
            :: List.remove_assoc "content" fields)
        in
        `List
          [
            user;
            assistant;
            obj
              [
                ("type", s "compaction");
                ("id", s "msg_compaction");
                ("time", obj [ ("created", `Int 3) ]);
                ("status", s "completed");
                ("reason", s "manual");
                ("summary", s "complete summary");
              ];
            idle;
          ]
    | _ -> Alcotest.fail "invalid fixture"
  in
  let context =
    match assisted with
    | `List [ _; _; compact; idle ] -> `List [ compact; idle ]
    | _ -> Alcotest.fail "invalid compaction fixture"
  in
  let imported = ref false in
  let source, target, request, requests, _ =
    mock
      ~before:(function
        | `Source, `Get, route, _ when route = path ->
            Some
              (Ok
                 (200, data (obj [ ("info", info "/source"); ("messages", assisted) ])))
        | `Target, `Get, route, _ when route = path && !imported ->
            Some
              (Ok
                 (200, data (obj [ ("info", info "/target"); ("messages", assisted) ])))
        | (`Source | `Target), `Get, route, _
          when String.ends_with ~suffix:"/context" route ->
            Some (Ok (200, data context))
        | `Target, `Post, "/api/experimental/session/import", _ ->
            imported := true;
            Some (Ok (200, data (info "/target")))
        | _ -> None)
      ()
  in
  Alcotest.(check bool) "tool and compaction preserved" true
    (T.transfer ~request ~source ~target ~session_id:id
    = Ok { T.messages = 4 });
  let body =
    List.find_map
      (function
        | `Target, `Post, _, Some body -> Some body
        | _ -> None)
      !requests
  in
  match body with
  | Some body ->
      Alcotest.(check bool) "full projected content imported" true
        (Yojson.Safe.Util.member "messages" (Yojson.Safe.from_string body)
        = assisted)
  | None -> Alcotest.fail "import expected"

let uncertain () =
  List.iter
    (fun answer ->
      let source, target, request, requests, _ =
        mock
          ~before:(function
            | `Target, `Post, "/api/experimental/session/import", _ ->
                Some answer
            | _ -> None)
          ()
      in
      code "transfer_uncertain"
        (T.transfer ~request ~source ~target ~session_id:id);
      Alcotest.(check int) "one import despite lost acknowledgement" 1
        (List.length
           (List.filter
              (fun (side, verb, _, _) -> side = `Target && verb = `Post)
              !requests)))
    [
      Error "transport";
      Ok (409, obj []);
      Ok (200, data (obj [ ("id", s "ses_wrong") ]));
    ]

let fork_lineage () =
  let child = "ses_fixtureFork20261122" in
  let child_info location =
    match info location with
    | `Assoc fields ->
        obj
          (("fork",
            obj
              [
                ("sessionID", s id);
                ( "boundary",
                  obj [ ("type", s "through"); ("messageID", s "msg_idle") ] );
              ])
          :: ("id", s child)
          :: List.remove_assoc "id" fields)
    | _ -> Alcotest.fail "fixture info"
  in
  let without_fork location =
    match child_info location with
    | `Assoc fields -> obj (List.remove_assoc "fork" fields)
    | _ -> Alcotest.fail "fixture info"
  in
  let default_child_transcript =
    match messages with
    | `List rows ->
        `List
          (List.mapi
             (fun index -> function
               | `Assoc fields ->
                   obj
                     (List.map
                        (fun (key, value) ->
                          ( key,
                            if key = "id" then
                              s
                                ("msg_204cc8580001CHYiFCo98b5wDN_"
                               ^ string_of_int (index + 1))
                            else value ))
                        fields)
               | _ -> Alcotest.fail "fixture message")
             rows)
    | _ -> Alcotest.fail "fixture transcript"
  in
  let run_case ?(notice_error = false) ?(notice_text = T.native_fork_notice)
      ?disturb ?(parent_transcript = messages)
      ?(child_transcript = default_child_transcript) fork_answer import_answer =
    let directory = Test_scratch.private_directory "mesh-opencode-receipt-" in
    let held = directory ^ "-held" in
    let foreign = Test_scratch.private_directory "mesh-opencode-foreign-" in
    let sentinel = Filename.concat foreign "sentinel" in
    let oc = open_out_bin sentinel in
    output_string oc "leave foreign files intact";
    close_out oc;
    let disturbed = ref false in
    let restore () =
      if !disturbed then (
        (match disturb with
        | Some ("after-fork-mode" | "after-notice-mode") ->
            Unix.chmod directory 0o700
        | Some "after-import-replace" ->
            Unix.unlink directory;
            Unix.rename held directory
        | _ -> ());
        disturbed := false)
    in
    let spoil stage =
      if not !disturbed && disturb = Some stage then (
        disturbed := true;
        if stage = "after-import-replace" then (
          Unix.rename directory held;
          Unix.symlink foreign directory)
        else Unix.chmod directory 0o755)
    in
    Fun.protect
      ~finally:(fun () ->
        restore ();
        Array.iter
          (fun name -> Unix.unlink (Filename.concat directory name))
          (Sys.readdir directory);
        Unix.rmdir directory;
        Unix.unlink sentinel;
        Unix.rmdir foreign)
      (fun () ->
        let imported = ref false and forks = ref 0 and child_reads = ref 0
        and notice_restored = ref false in
        let repeat_busy = ref false in
        let notice =
          obj
            [
              ("id", s ("msg_fork_notice_" ^ child));
              ("sessionID", s child);
              ("type", s "synthetic");
              ("time", obj [ ("created", `Int 3) ]);
              ("delivery", s "steer");
              ( "payload",
                obj
                  [
                    ("text", s notice_text);
                    ("description", s "Fork notice");
                  ] );
            ]
        in
        let source, target, request, requests, _ =
          let context transcript =
            let rows =
              match transcript with
              | `List rows -> rows
              | _ -> Alcotest.fail "fixture transcript"
            in
            match List.rev rows with
            | idle :: compact :: _
              when Yojson.Safe.Util.member "type" compact = s "compaction" ->
                `List [ compact; idle ]
            | _ -> transcript
          in
          mock
            ~before:(function
              | `Source, `Get, route, _ when route = path ->
                  Some
                    (Ok
                       (200,
                        data
                          (obj
                             [
                               ("info", info "/source");
                               ("messages", parent_transcript);
                             ])))
              | `Source, `Get, route, _
                when route = "/api/session/" ^ id ^ "/context" ->
                  Some (Ok (200, data (context parent_transcript)))
              | `Source, `Get, "/api/session/active", _ when !repeat_busy ->
                  Some (Ok (200, data (obj [ (id, obj []) ])))
              | `Source, `Post, route, _
                when route = "/api/session/" ^ id ^ "/fork" ->
                  incr forks;
                  spoil "after-fork-mode";
                  Some fork_answer
              | `Source, `Get, route, _
                when route = "/api/experimental/session/" ^ child ^ "/export" ->
                  incr child_reads;
                  let child_messages =
                    if disturb = Some "child-drift" && !child_reads > 1 then
                      match child_transcript with
                      | `List (`Assoc fields :: tail) ->
                          `List
                            (obj
                               (("text", s "changed after validation")
                               :: List.remove_assoc "text" fields)
                            :: tail)
                      | _ -> Alcotest.fail "invalid fixture"
                    else child_transcript
                  in
                  Some
                    (Ok
                       (200,
                        data
                          (obj
                             [
                               ("info", child_info "/source");
                               ("messages", child_messages);
                             ])))
              | `Target, `Get, route, _
                when route = "/api/experimental/session/" ^ child ^ "/export" ->
                  if !imported then
                    Some
                      (Ok
                         (200,
                          data
                            (obj
                                 [
                                   ("info", without_fork "/target");
                                   ("messages", child_transcript);
                                 ])))
                  else Some (Ok (404, obj []))
              | `Target, `Get, route, _
                when route = "/api/session/" ^ child ^ "/context" ->
                  Some (Ok (200, data (context child_transcript)))
              | `Source, `Get, route, _
                when route = "/api/session/" ^ child ^ "/context" ->
                  Some (Ok (200, data (context child_transcript)))
              | side, `Get, route, _
                when route = "/api/session/" ^ child ^ "/inbox" ->
                  if side = `Source then spoil "after-notice-mode"
                  else if !notice_restored then spoil "after-import-replace";
                  Some
                    (Ok
                       (200,
                        data
                          (if side = `Source || !notice_restored then
                             `List [ notice ]
                           else `List [])))
              | `Target, `Post, route, Some body
                when route = "/api/session/" ^ child ^ "/synthetic" ->
                  let value = Yojson.Safe.from_string body in
                  Alcotest.(check bool) "native fork notice copied exactly" true
                    (Yojson.Safe.Util.member "text" value
                    = s T.native_fork_notice);
                  if notice_error then Some (Error "lost notice acknowledgement")
                  else (
                    notice_restored := true;
                    Some (Ok (200, data notice)))
              | (`Source | `Target), `Get, route, _
                when List.exists
                       (fun suffix ->
                         route = "/api/session/" ^ child ^ suffix
                         || route
                            = "/api/experimental/session/" ^ child ^ suffix)
                       [ "/permission"; "/form"; "/instructions/entries" ]
                  ->
                  Some (Ok (200, empty))
              | `Target, `Post, "/api/experimental/session/import", Some body ->
                  Alcotest.(check bool) "validated child is imported" true
                    (Yojson.Safe.Util.member "messages"
                       (Yojson.Safe.from_string body)
                    = child_transcript);
                  (match import_answer with
                  | Ok _ -> imported := true
                  | Error _ -> ());
                  Some import_answer
              | _ -> None)
            ()
        in
        let transfer () =
          T.fork_transfer ~request ~source ~target ~parent_native_id:id
            ~logical_id:"mesh-logical-1" ~epoch:1 ~source_profile:"alpha"
            ~target_profile:"beta" ~receipt_directory:directory
            ~operation_id:"operation-1"
        in
        let result = transfer () in
        Alcotest.(check bool) "foreign sentinel remains intact" true
          (let channel = open_in_bin sentinel in
           Fun.protect ~finally:(fun () -> close_in channel) (fun () ->
               input_line channel = "leave foreign files intact"));
        Alcotest.(check bool) "no receipts in foreign directory" true
          (Sys.readdir foreign = [| "sentinel" |]);
        restore ();
        let receipts = Array.to_list (Sys.readdir directory) in
        Alcotest.(check int) "one native fork" 1 !forks;
        Alcotest.(check int) "one prepared operation" 1
          (List.length (List.filter (String.ends_with ~suffix:"-prepared") receipts));
        repeat_busy := true;
        code "transfer_uncertain" (transfer ());
        Alcotest.(check int) "duplicate operation never forks again" 1 !forks;
        Alcotest.(check bool) "source original is intact" true
          (request source `Get path None
          = Ok
              (200,
               data
                 (obj
                    [
                      ("info", info "/source");
                      ("messages", parent_transcript);
                    ])));
        (result, receipts, !requests))
  in
  let result, receipts, requests =
    run_case (Ok (200, data (child_info "/source")))
      (Ok (200, data (without_fork "/target")))
  in
  (match result with
  | Ok lineage ->
      Alcotest.(check string) "Mesh logical identity" "mesh-logical-1"
        lineage.T.logical_id;
      Alcotest.(check string) "source native fork id" child lineage.native_id;
      Alcotest.(check string) "source native parent" id
        lineage.parent_native_id;
      Alcotest.(check string) "real fork boundary" "msg_idle"
        lineage.boundary_message_id
  | Error error -> Alcotest.fail error);
  Alcotest.(check int) "prepared, forked, validated and verified receipts" 4
    (List.length receipts);
  Alcotest.(check int) "one native import" 1
    (List.length
       (List.filter
          (function
            | `Target, `Post, "/api/experimental/session/import", _ -> true
            | _ -> false)
          requests));
  let parent_compaction =
    obj
      [
        ("id", s "msg_compaction");
        ("type", s "compaction");
        ("status", s "completed");
        ("reason", s "manual");
        ("summary", s "kept prior answer");
        ("metadata", obj [ ("keepID", s "msg_assistant"); ("other", s "exact") ]);
        ("time", obj [ ("created", `Int 5) ]);
      ]
  in
  let parent_transcript =
    match messages with
    | `List [ user; assistant; idle ] ->
        `List [ user; assistant; parent_compaction; idle ]
    | _ -> Alcotest.fail "fixture transcript"
  in
  let fork_prefix = "msg_204cc8580001CHYiFCo98b5wDN" in
  let fork_id seq = fork_prefix ^ "_" ^ string_of_int seq in
  let forked_transcript ids kept_id =
    match parent_transcript with
    | `List rows ->
        `List
          (List.map2
             (fun row id ->
               match row with
               | `Assoc fields ->
                   let fields =
                     ("id", s id) :: List.remove_assoc "id" fields
                   in
                   if Yojson.Safe.Util.member "type" row = s "compaction" then
                     obj
                       (List.map
                          (fun (key, value) ->
                            ( key,
                              if key = "metadata" then
                                obj
                                  [
                                    ("keepID", s kept_id);
                                    ("other", s "exact");
                                  ]
                              else value ))
                          fields)
                   else obj fields
               | _ -> Alcotest.fail "fixture message")
             rows ids)
    | _ -> Alcotest.fail "fixture transcript"
  in
  let child_transcript =
    forked_transcript
      [ fork_id 1; fork_id 2; fork_id 3; fork_id 4 ]
      (fork_id 2)
  in
  let mutate_child key value =
    match child_transcript with
    | `List [ user; assistant; `Assoc compact; idle ] ->
        `List
          [
            user;
            assistant;
            obj
              (List.map
                 (fun (field, existing) ->
                   (field, if field = key then value else existing))
                 compact);
            idle;
          ]
    | _ -> Alcotest.fail "fixture transcript"
  in
  let fork_response = Ok (200, data (child_info "/source"))
  and imported_response = Ok (200, data (without_fork "/target")) in
  let result, receipts, requests =
    run_case ~parent_transcript ~child_transcript fork_response
      imported_response
  in
  (match result with
  | Ok lineage ->
      Alcotest.(check int) "native positional keepID mapping accepted" 4
        lineage.T.messages
  | Error code ->
      Alcotest.fail
        ("mapping rejected: " ^ code ^ " receipts="
       ^ String.concat "," receipts));
  Alcotest.(check int) "mapping verified once before import" 4
    (List.length receipts);
  Alcotest.(check int) "mapped transcript imported exactly once" 1
    (List.length
       (List.filter
          (function
            | `Target, `Post, "/api/experimental/session/import", _ -> true
            | _ -> false)
          requests));
  let gapped = [ fork_id 7; fork_id 9; fork_id 10; fork_id 12 ] in
  let gapped_result, _, _ =
    run_case ~parent_transcript
      ~child_transcript:(forked_transcript gapped (fork_id 9))
      fork_response imported_response
  in
  (match gapped_result with
  | Ok lineage ->
      Alcotest.(check int) "numeric sequence order permits gaps and 9 before 10"
        4 lineage.T.messages
  | Error code -> Alcotest.fail ("gapped native IDs rejected: " ^ code));
  List.iter
    (fun (name, parent, child) ->
      let result, receipts, requests =
        run_case ~parent_transcript:parent ~child_transcript:child
          fork_response imported_response
      in
      code "transfer_uncertain" result;
      Alcotest.(check int) (name ^ " stops after fork") 2
        (List.length receipts);
      Alcotest.(check bool) (name ^ " never imports") false
        (List.exists
           (function
             | `Target, `Post, "/api/experimental/session/import", _ -> true
             | _ -> false)
           requests))
    [
      ( "wrong mapped reference",
        parent_transcript,
        mutate_child "metadata"
          (obj [ ("keepID", s (fork_id 1)); ("other", s "exact") ]) );
      ( "swapped native child IDs, matching remapped keepID",
        parent_transcript,
        forked_transcript
          [ fork_id 2; fork_id 1; fork_id 3; fork_id 4 ]
          (fork_id 1) );
      ( "wrong timestamp",
        parent_transcript,
        mutate_child "time" (obj [ ("created", `Int 99) ]) );
      ( "changed metadata",
        parent_transcript,
        mutate_child "metadata"
          (obj
              [
                ("keepID", s (fork_id 2));
               ("other", s "changed");
             ]) );
      ( "unknown parent reference",
        (match parent_transcript with
        | `List [ user; assistant; `Assoc compact; idle ] ->
            `List
              [
                user;
                assistant;
                obj
                  (List.map
                     (fun (key, value) ->
                       ( key,
                         if key = "metadata" then
                           obj [ ("keepID", s "msg_unknown"); ("other", s "exact") ]
                         else value ))
                     compact);
                idle;
              ]
        | _ -> Alcotest.fail "fixture transcript"),
        child_transcript );
    ];
  let result, receipts, requests =
    run_case (Error "lost fork acknowledgement")
      (Ok (200, data (without_fork "/target")))
  in
  code "transfer_uncertain" result;
  Alcotest.(check int) "no fork receipt after lost acknowledgement" 1
    (List.length receipts);
  Alcotest.(check bool) "no import after lost fork acknowledgement" false
    (List.exists
       (function
         | `Target, `Post, "/api/experimental/session/import", _ -> true
         | _ -> false)
       requests);
  let result, receipts, _ =
    run_case (Ok (200, data (child_info "/source")))
      (Error "lost import acknowledgement")
  in
  code "transfer_uncertain" result;
  Alcotest.(check int) "fork receipt retained after lost import acknowledgement" 4
    (List.length receipts);
  let result, receipts, _ =
    run_case ~notice_error:true
      (Ok (200, data (child_info "/source")))
      (Ok (200, data (without_fork "/target")))
  in
  code "transfer_uncertain" result;
  Alcotest.(check int) "no completion receipt after notice acknowledgement loss" 3
    (List.length receipts);
  let result, receipts, requests =
    run_case ~notice_text:"<fork-notice>\ntampered\n</fork-notice>"
      (Ok (200, data (child_info "/source")))
      (Ok (200, data (without_fork "/target")))
  in
  code "transfer_uncertain" result;
  Alcotest.(check int) "unknown notice stops before import" 2
    (List.length receipts);
  Alcotest.(check bool) "unknown notice never imports" false
    (List.exists
       (function
         | `Target, `Post, "/api/experimental/session/import", _ -> true
         | _ -> false)
       requests);
  let result, receipts, requests =
    run_case (Ok (200, data (without_fork "/source")))
      (Ok (200, data (without_fork "/target")))
  in
  code "transfer_uncertain" result;
  Alcotest.(check int) "missing native fork provenance stops early" 1
    (List.length receipts);
  Alcotest.(check bool) "missing provenance never imports" false
    (List.exists
       (function
         | `Target, `Post, "/api/experimental/session/import", _ -> true
         | _ -> false)
       requests);
  List.iter
    (fun (stage, expected_receipts, expected_imports) ->
      let result, receipts, requests =
        run_case ~disturb:stage (Ok (200, data (child_info "/source")))
          (Ok (200, data (without_fork "/target")))
      in
      code "transfer_uncertain" result;
      Alcotest.(check int) ("retained phase receipts after " ^ stage)
        expected_receipts (List.length receipts);
      Alcotest.(check int) ("imports never repeated after " ^ stage)
        expected_imports
        (List.length
           (List.filter
              (function
                | `Target, `Post, "/api/experimental/session/import", _ -> true
                | _ -> false)
              requests)))
    [
      ("child-drift", 4, 0);
      ("after-fork-mode", 1, 0);
      ("after-notice-mode", 2, 0);
      ("after-import-replace", 3, 1);
    ];
  let directory = Test_scratch.private_directory "mesh-opencode-preflight-" in
  Fun.protect
    ~finally:(fun () -> Unix.rmdir directory)
    (fun () ->
      let source, target, request, requests, _ = mock () in
      code "transfer_invalid_input"
        (T.fork_transfer ~request ~source ~target ~parent_native_id:id
           ~logical_id:"mesh-logical-1" ~epoch:1 ~source_profile:"alpha"
           ~target_profile:"beta"
           ~receipt_directory:(Filename.concat directory "missing")
           ~operation_id:"operation-1");
      Alcotest.(check bool) "pre-effect invalid custody never forks" false
        (List.exists
           (function `Source, `Post, _, _ -> true | _ -> false)
           !requests))

let rec remove_tree path =
  let stats = Unix.lstat path in
  if stats.Unix.st_kind = Unix.S_DIR then (
    Array.iter
      (fun name -> remove_tree (Filename.concat path name))
      (Sys.readdir path);
    Unix.rmdir path)
  else Unix.unlink path

(* Opt-in real native 2.3.2 fixture: seed the isolated source with the native
   import API without any provider, then run this test with
   MESH_OC_TRANSFER_BINARY, MESH_OC_TRANSFER_SOURCE and MESH_OC_TRANSFER_ID.
   Target state belongs to this test and is never reused. *)
let real_roundtrip () =
  match
    ( Sys.getenv_opt "MESH_OC_TRANSFER_BINARY",
      Sys.getenv_opt "MESH_OC_TRANSFER_SOURCE",
      Sys.getenv_opt "MESH_OC_TRANSFER_ID" )
  with
  | Some binary, Some root, Some session_id ->
      let expected =
        match Sys.getenv_opt "MESH_OC_TRANSFER_EXPECTED" with
        | Some "4" -> 4
        | None | Some "3" -> 3
        | Some _ -> Alcotest.fail "expected fixture count is 3 or 4"
      in
      let existing root =
        {
          T.home = Filename.concat root "home";
          config = Filename.concat root "config";
          data = Filename.concat root "data";
          state = Filename.concat root "state";
          cache = Filename.concat root "cache";
          runtime = Filename.concat root "runtime";
          location = Filename.concat root "workspace";
        }
      in
      (* Both profile XDG trees live below one runner HOME. This is a fixture
         choice, not a profile HOME role or an isolation mechanism. *)
      let runner_home = Filename.dirname root in
      let target_root =
        Filename.temp_dir ~temp_dir:runner_home ~perms:0o700
          "mesh-opencode-target-" ""
      in
      Fun.protect
        ~finally:(fun () -> remove_tree target_root)
        (fun () ->
          let target = { (existing target_root) with T.home = runner_home } in
          List.iter
            (fun path -> Unix.mkdir path 0o700)
            [
              target.config;
              target.data;
              target.state;
              target.cache;
              target.runtime;
              target.location;
            ];
          let source = { (existing root) with T.home = runner_home } in
          let refused target =
            Alcotest.(check bool) "overlapping profile roots refused" true
              (T.run ~binary ~source ~target ~session_id
              = Error "transfer_invalid_input")
          in
          refused { target with T.config = source.config };
          refused { target with T.data = source.data };
          refused { target with T.state = source.state };
          refused { target with T.cache = source.cache };
          refused { target with T.config = root };
          refused { target with T.runtime = source.runtime };
          refused { target with T.runtime = source.config };
          match T.run ~binary ~source ~target ~session_id with
          | Ok { T.messages } when messages = expected -> ()
          | Ok _ -> Alcotest.fail "unexpected native transcript length"
          | Error code -> Alcotest.fail code);
      Alcotest.(check bool) "target scratch removed" false
        (Sys.file_exists target_root)
  | None, None, None -> Alcotest.skip ()
  | _ -> Alcotest.fail "real native fixture requires all three opt-in variables"

let () =
  Alcotest.run "opencode native transfer"
    [
      ( "adapter",
        [
          Alcotest.test_case "complete transcript and context" `Quick success;
          Alcotest.test_case "completed busy timestamp is idle" `Quick
            settled_busy_timestamp;
          Alcotest.test_case "native viewed import normalization" `Quick
            viewed_import_normalization;
          Alcotest.test_case "newer busy timestamp blocks import" `Quick
            reject_busy_timestamp;
          Alcotest.test_case "refuse unsafe preconditions" `Quick refusals;
          Alcotest.test_case "unfinished and dependent native states" `Quick
            incomplete_transcript;
          Alcotest.test_case "terminal native shell rows" `Quick
            terminal_shell_statuses;
          Alcotest.test_case "lost import acknowledgement" `Quick uncertain;
          Alcotest.test_case "post-import divergence" `Quick
            after_import_uncertain;
          Alcotest.test_case "tool and completed compaction" `Quick
            tool_compaction;
          Alcotest.test_case "isolated installed native roundtrip" `Quick
            real_roundtrip;
          Alcotest.test_case "fork lineage and uncertain receipts" `Quick
            fork_lineage;
        ] );
    ]
