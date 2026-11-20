(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

type mode = Take | Claim | Keep

let mode_of_fields fields =
  match List.assoc_opt "size" fields with
  | None -> Some Take
  | Some (`String "take") -> Some Take
  | Some (`String "claim") -> Some Claim
  | Some (`String "keep") -> Some Keep
  | Some _ -> None

type 'client decision = { apply : bool; owner : 'client option }

let resize ~same ~owner ~client = function
  | Take -> { apply = true; owner = Some client }
  | Keep -> { apply = true; owner }
  | Claim -> (
      match owner with
      | Some current when not (same current client) -> { apply = false; owner }
      | _ -> { apply = true; owner = Some client })

let detach ~same ~owner ~client =
  match owner with Some current when same current client -> None | _ -> owner

type role = You | Other | Nobody

let role ~same ~owner ~client =
  match owner with
  | None -> Nobody
  | Some current -> if same current client then You else Other

let frame_payload ~rows ~cols role =
  Yojson.Basic.to_string
    (`Assoc
       [
         ("rows", `Int rows);
         ("cols", `Int cols);
         ( "owner",
           `String
             (match role with
             | You -> "you"
             | Other -> "other"
             | Nobody -> "none") );
       ])
