(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(** The stdio loop of the server: the one of [Mcp_kit_stdio.run_channels]
    (one JSON-RPC line in, the frames out, until end of input), with a guard
    in front. A request line whose brackets nest deeper than {!max_nesting}
    is refused before it reaches mcp-kit, whose validation of tool arguments
    takes minutes and gigabytes on deeply nested input (known limit of the
    library). No request of the tools comes near the limit. *)

val max_nesting : int

val too_deep : string -> bool
(** Whether the raw nesting of brackets and braces (outside strings) of a line
    exceeds {!max_nesting}. *)

val run : Mcp_kit.Server.t -> in_channel -> out_channel -> unit
(** A too-deep line is answered with a JSON-RPC error [-32600] whose [id] is
    [null] (the id is not parsed). *)
