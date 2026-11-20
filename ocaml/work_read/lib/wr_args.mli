(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(** Strict parsing of the command line. A subcommand, its flags and its one
    optional identifier are all validated; anything else (an unknown flag, a
    repeated flag, a flag without value, a stray argument, a value with a
    control, bidirectional or invisible character, a malformed identifier) is
    an [invalid_input] error. Nothing is read from the environment here. *)

type target = Product of string | Project of string | Task of string

type command =
  | Products
  | Projects of { product : string option; all : bool }
      (** [all]: also [done] and [dropped] projects *)
  | Project_detail of string  (** a [P-<hex>] reference *)
  | Task_detail of string  (** a [T-<hex>] reference *)
  | Resume of { product : string option; project : string option; all : bool }
      (** [all]: also the [todo] section *)
  | Sessions_of of target
  | Session_questions  (** the open questions of each session, by name *)
  | Ids  (** every task, project and question id with its title, for references *)

val parse : string list -> (command, Work_mcp.Work_err.t) result
(** The arguments after the program name. *)

val usage : string
(** One line listing the subcommands, for the [invalid_input] message. *)
