(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

type registry_source = Chosen | Hook | Observed
type source = Registry of registry_source | Open | Launch | Guessed
type 'key claim = { key : 'key; id : string; source : source; holds_open : bool }
type verdict = Keep | Drop | Contested

let registry_source_name = function Chosen -> "chosen" | Hook -> "hook" | Observed -> "observed"

(* Launch and guessed claims never hold an id against an exact one. *)
let rank = function
  | Registry Chosen -> 3
  | Registry Hook -> 2
  | Registry Observed | Open -> 1
  | Launch | Guessed -> 0

let registered claim = match claim.source with Registry _ -> true | _ -> false

(* [discover.drop_duplicate_guessed_ids], on the claims of one id. *)
let python_verdict group claim =
  let exact = List.exists (fun (_, other) -> other.source <> Guessed) group in
  let guesses = List.length (List.filter (fun (_, other) -> other.source = Guessed) group) in
  let launched = List.exists (fun (_, other) -> other.source = Launch) group in
  if claim.source = Guessed && (exact || guesses > 1) then Drop
  else if launched && List.length group > 1 then Drop
  else Keep

(* Decision I4: the strongest source, then holding the file open. *)
let registry_verdict group index claim =
  if rank claim.source = 0 then Drop
  else
    let top = List.fold_left (fun best (_, other) -> max best (rank other.source)) 0 group in
    let leaders = List.filter (fun (_, other) -> rank other.source = top) group in
    let winners = match leaders with [ _ ] -> leaders | _ -> List.filter (fun (_, other) -> other.holds_open) leaders in
    match winners with [ (winner, _) ] when winner = index -> Keep | _ -> Contested

let check claims =
  let indexed = List.mapi (fun index claim -> (index, claim)) claims in
  let groups = Hashtbl.create 16 in
  List.iter
    (fun (index, claim) ->
      Hashtbl.replace groups claim.id ((index, claim) :: Option.value ~default:[] (Hashtbl.find_opt groups claim.id)))
    indexed;
  List.map
    (fun (index, claim) ->
      let group = Hashtbl.find groups claim.id in
      let verdict =
        if List.length group = 1 then Keep
        else if List.exists (fun (_, other) -> registered other) group then registry_verdict group index claim
        else python_verdict group claim
      in
      (claim.key, verdict))
    indexed
