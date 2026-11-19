(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(* The generic libraries' independence rule ({!Generic_guard}), run on the
   generic/ directory given as the first argument. *)

let () =
  match Generic_guard.check Sys.argv.(1) with
  | Ok () -> print_endline "generic libraries: dependencies allowed"
  | Error errors ->
      List.iter prerr_endline errors;
      exit 1
