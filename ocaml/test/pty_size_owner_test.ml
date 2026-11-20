(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(* Who owns the size of a shared PTY (Mesh_pty_size): the first client that
   attaches with a claim sets it, a later claim while another client owns it
   changes nothing, an explicit take-over always wins (the last one), a redraw
   (keep) never moves the ownership, and the owner's departure frees it. *)

open Mesh_pty_support.Mesh_pty_size

let same = String.equal

let decision =
  Alcotest.testable
    (fun formatter { apply; owner } ->
      Format.fprintf formatter "{apply=%b; owner=%s}" apply
        (Option.value ~default:"-" owner))
    ( = )

let check label expected ~owner ~client mode =
  Alcotest.check decision label expected (resize ~same ~owner ~client mode)

let first_attach_sets_it () =
  check "nobody owns: the claim applies and the claimant owns"
    { apply = true; owner = Some "phone" }
    ~owner:None ~client:"phone" Claim

let later_claim_changes_nothing () =
  check "another client owns: a claim is ignored"
    { apply = false; owner = Some "desk" }
    ~owner:(Some "desk") ~client:"phone" Claim;
  check "the owner's own claim applies"
    { apply = true; owner = Some "desk" }
    ~owner:(Some "desk") ~client:"desk" Claim

let last_take_over_wins () =
  check "an explicit take-over moves the size to the taker"
    { apply = true; owner = Some "phone" }
    ~owner:(Some "desk") ~client:"phone" Take;
  check "and back: the last take-over wins"
    { apply = true; owner = Some "desk" }
    ~owner:(Some "phone") ~client:"desk" Take;
  check "a take-over with no owner"
    { apply = true; owner = Some "desk" }
    ~owner:None ~client:"desk" Take

let keep_never_moves_it () =
  check "a follower's redraw applies and keeps the owner"
    { apply = true; owner = Some "desk" }
    ~owner:(Some "desk") ~client:"phone" Keep;
  check "a redraw with no owner leaves it free"
    { apply = true; owner = None }
    ~owner:None ~client:"phone" Keep

let departure_frees_it () =
  Alcotest.(check (option string))
    "the owner leaves: nobody owns" None
    (detach ~same ~owner:(Some "desk") ~client:"desk");
  Alcotest.(check (option string))
    "a follower leaves: the owner stays" (Some "desk")
    (detach ~same ~owner:(Some "desk") ~client:"phone")

let roles () =
  let role_text = function
    | You -> "you"
    | Other -> "other"
    | Nobody -> "none"
  in
  let check_role label expected ~owner ~client =
    Alcotest.(check string)
      label expected
      (role_text (role ~same ~owner ~client))
  in
  check_role "the owner" "you" ~owner:(Some "desk") ~client:"desk";
  check_role "a follower" "other" ~owner:(Some "desk") ~client:"phone";
  check_role "nobody" "none" ~owner:None ~client:"phone"

let modes () =
  let parse fields = mode_of_fields fields in
  let mode =
    Alcotest.testable
      (fun formatter value ->
        Format.pp_print_string formatter
          (match value with
          | Some Take -> "take"
          | Some Claim -> "claim"
          | Some Keep -> "keep"
          | None -> "invalid"))
      ( = )
  in
  Alcotest.check mode "no field: the former protocol, take" (Some Take)
    (parse [ ("rows", `Int 2); ("cols", `Int 2) ]);
  Alcotest.check mode "claim" (Some Claim) (parse [ ("size", `String "claim") ]);
  Alcotest.check mode "keep" (Some Keep) (parse [ ("size", `String "keep") ]);
  Alcotest.check mode "take" (Some Take) (parse [ ("size", `String "take") ]);
  Alcotest.check mode "anything else is refused" None
    (parse [ ("size", `String "steal") ]);
  Alcotest.check mode "not a string" None (parse [ ("size", `Bool true) ])

let payload () =
  Alcotest.(check string)
    "the frame a client receives" {|{"rows":24,"cols":80,"owner":"other"}|}
    (frame_payload ~rows:24 ~cols:80 Other)

let () =
  Alcotest.run "PTY size owner"
    [
      ( "rule",
        [
          Alcotest.test_case "the first claim sets the size" `Quick
            first_attach_sets_it;
          Alcotest.test_case "a later claim changes nothing" `Quick
            later_claim_changes_nothing;
          Alcotest.test_case "the last explicit take-over wins" `Quick
            last_take_over_wins;
          Alcotest.test_case "a redraw never moves the ownership" `Quick
            keep_never_moves_it;
          Alcotest.test_case "the owner's departure frees the size" `Quick
            departure_frees_it;
          Alcotest.test_case "each client's role" `Quick roles;
        ] );
      ( "wire",
        [
          Alcotest.test_case "the size field of an R frame" `Quick modes;
          Alcotest.test_case "the S frame payload" `Quick payload;
        ] );
    ]
