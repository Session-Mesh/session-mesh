(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(** The agent guide: docs/agent-guide.md, embedded at build time, and the
    read-only [mesh-board] tool that returns it.

    The tool reads nothing at run time, accepts no argument and makes no request
    to the Mesh server. *)

val tool_name : string
(** ["agent_guide_read"]. *)

val text : string
(** The exact bytes of docs/agent-guide.md at build time. *)

val instructions : string
(** One sentence for the server's MCP instructions: the agent runs in a
    session-mesh session and [tool_name] returns the guide. *)

val tool : Mcp_kit.Tool.t
(** The [agent_guide_read] declaration. *)
