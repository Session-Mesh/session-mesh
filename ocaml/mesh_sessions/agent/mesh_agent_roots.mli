(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(** Where each agent keeps its files, resolved in one place for every adapter.

    This version knows Claude's and Codex's directories. The roots of the other agents
    ([PI_CODING_AGENT_DIR], [XDG_DATA_HOME], [VIBE_HOME], [GEMINI_CLI_HOME],
    [COPILOT_HOME], [OPENCODE_DB]) are added here with their adapters, so that
    the listing and the History index stop resolving them twice. *)

type t

val of_environment : (string -> string option) -> (t, string) result
(** From an environment lookup ([Sys.getenv_opt]). [Error] when [HOME] is
    unset, empty or relative. *)

val of_home : string -> t
(** Tests: the roots of a fixture home. *)

val home : t -> string

val claude : t -> string
(** [$HOME/.claude]. *)

val codex : t -> string
(** [$HOME/.codex], as [discover.py] reads it ([CODEX_HOME] is not read). *)
