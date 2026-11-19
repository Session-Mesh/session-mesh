(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(** Agent detection and the shape of one terminal session, ported once for
    every adapter from [discover.py] ([AGENTS], [PROCESS_AGENTS],
    [is_agent], [_agent_of_argv], [session_agent], [foreground]). *)

val agent_types : string list
(** Every agent type the mesh knows, whether or not an adapter describes it. *)

val kind_of : Mesh_agent_round.t -> Mesh_agent_round.process -> string option
(** The agent type of a process: by its name, else by its command line (the
    basename of [argv.(0)], or the script a [node] process runs for Pi and
    Gemini). *)

type frame = {
  leader : Mesh_agent_round.process option;  (** The session leader, if listed. *)
  foreground : int;
      (** The terminal's foreground process group when it is a listed pid,
          else the session id. *)
  agent : (Mesh_agent_round.process * string) option;
      (** The outermost agent process of the session (one whose parent in the
          session is not itself an agent), preferring the foreground process
          group, then the lowest pid; with its type. *)
}

val frame : Mesh_agent_round.t -> sid:int -> frame

val agent_in_foreground : frame -> bool
(** Whether the agent's process group is the terminal's foreground group. *)

val argv_text : string -> string
(** One command-line word as text: invalid UTF-8 bytes dropped, as Python's
    [decode(errors="ignore")]. *)

val name_text : string -> string
(** A process name as text: invalid UTF-8 replaced by U+FFFD, as Python's
    [decode(errors="replace")]. *)
