(* SPDX-License-Identifier: AGPL-3.0-or-later *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech> *)

(* The Codex fixture holds an inherited rollout descriptor open while it waits. *)
let () = Unix.sleep (int_of_string Sys.argv.(1))
