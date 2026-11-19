(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(** Loading the data repository, read-only. The repository is found by the
    library's discovery ([WL_HOME], else [~/worklog-data], else [~/worklog]) and
    is never created: a missing one is a [repository] error. Writes, locks and
    commits are not used. *)

type t = {
  ctx : Mesh_worklog.Ctx.t;
  snapshot : Mesh_worklog.Reader.snapshot;
  questions : Work_mcp.Work_questions.question list;  (** oldest first *)
  warnings : string list;  (** read, fold and question warnings *)
}

val load : ?getenv:(string -> string option) -> unit -> (t, Work_mcp.Work_err.t) result

val world : t -> Mesh_worklog.Model.world

val warnings_json : t -> (string * Yojson.Safe.t) list
(** [data_warnings] (at most 10, paths replaced) and the count of the others;
    nothing when there are none. *)
