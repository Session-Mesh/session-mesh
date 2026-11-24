(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

module S = Mesh_agent_settings

let test_codex () =
  let options =
    [
      [ "codex" ];
      [ "resume" ];
      [ "thread" ];
      [ "--sandbox"; "read-only" ];
      [ "--ask-for-approval=on-request" ];
      [ "-c"; "sandbox_workspace_write.network_access=false" ];
      [ "-mold" ];
      [ "--config=model=\"explicit\"" ];
      [ "-c=model_reasoning_effort='low'" ];
    ]
  in
  Alcotest.(check (pair (option string) (option string)))
    "explicit launch settings" (Some "old", Some "low")
    (S.inspect S.Codex options);
  let argv =
    Result.get_ok (S.apply S.Codex ~model:None ~effort:(Some "high") options)
  in
  Alcotest.(check (list string))
    "only the effort changes"
    [
      "codex";
      "resume";
      "thread";
      "--sandbox";
      "read-only";
      "--ask-for-approval=on-request";
      "-c";
      "sandbox_workspace_write.network_access=false";
      "-mold";
      "--config=model=\"explicit\"";
      "-c";
      "model_reasoning_effort=\"high\"";
    ]
    argv

let test_claude () =
  let options =
    [
      [ "claude" ];
      [ "--resume"; "conversation" ];
      [ "--system-prompt"; "--model" ];
      [ "--permission-mode"; "plan" ];
      [ "--model=sonnet" ];
      [ "--effort=medium" ];
    ]
  in
  Alcotest.(check (pair (option string) (option string)))
    "report an explicit launch effort" (None, Some "xhigh")
    (S.inspect S.Claude [ [ "--effort=xhigh" ] ]);
  let argv =
    Result.get_ok (S.apply S.Claude ~model:(Some "opus") ~effort:None options)
  in
  Alcotest.(check (list string))
    "preserve a flag-shaped option value, permissions and effort"
    [
      "claude";
      "--resume";
      "conversation";
      "--system-prompt";
      "--model";
      "--permission-mode";
      "plan";
      "--effort=medium";
      "--model";
      "opus";
    ]
    argv

let test_invalid () =
  let errors =
    [
      S.apply S.Claude ~model:None ~effort:None [];
      S.apply S.Codex ~model:(Some "--sandbox") ~effort:None [];
      S.apply S.Codex ~model:None ~effort:(Some "unsupported") [];
    ]
  in
  List.iter
    (fun result ->
      Alcotest.(check bool) "invalid request" true (Result.is_error result))
    errors;
  Alcotest.(check (pair (option string) (option string)))
    "unknown settings" (None, None)
    (S.inspect S.Claude
       [ [ "--model"; "invalid model" ]; [ "--effort"; "unsafe text" ] ])

let () =
  Alcotest.run "mesh-agent-settings"
    [
      ( "launch arguments",
        [
          Alcotest.test_case "Codex effort only" `Quick test_codex;
          Alcotest.test_case "Claude model only" `Quick test_claude;
          Alcotest.test_case "invalid and unknown settings" `Quick test_invalid;
        ] );
    ]
