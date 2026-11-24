(******************************************************************************)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(******************************************************************************)

let retire_v1 history =
  Hashtbl.iter
    (fun id (birth, seq, _) -> Hashtbl.replace history id (birth, seq, ""))
    history
