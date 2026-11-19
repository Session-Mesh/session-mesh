(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(** The row of one session ([discover.describe]): its working directory, its
    foreground command and its agent, the agent fields coming from the
    adapter registered for the agent's type. No agent type is named here. *)

type t =
  | Described of Yojson.Safe.t  (** Every field known. *)
  | Unsupported of Yojson.Safe.t
      (** No adapter for the agent's type: the row without the adapter's
          fields. *)

val row : Mesh_agent.Registry.t -> Mesh_agent_round.t -> sid:int -> t
(** Blocks on process and file reads: run it in a system thread. An
    adapter's exception propagates. *)

val max_cmd : int
(** 160 code points. *)
