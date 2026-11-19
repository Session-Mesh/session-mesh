(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(** JSON views of the data, bounded in size. Nothing here returns the folder a
    session worked in (a repository is shown by its name only); every string
    and every nested list is cut at a fixed length, with a [<key>_omitted]
    count. *)

val trunc : ?max:int -> string -> string
(** The text cleaned ({!Work_text.clean}: invalid UTF-8, control and invisible
    characters), then cut at [max] bytes (default 500) on a UTF-8 boundary,
    with [...] added. The cleaning comes first so unwanted characters never
    use up the bound. *)

val trunc_chars : max:int -> string -> string
(** Cut after [max] characters (not bytes) on a character boundary, with [...]
    added: for the texts whose write limit counts characters. *)

val repo_name : string -> string option
(** The last component of a folder: the name of a repository, never its
    absolute path; [None] for [/], an empty path or the home directory itself
    (its name would be the login). *)

val opt_repo : string option -> (string * Yojson.Safe.t) list
(** [repo: name] from a folder, nothing when there is none. *)

val opt : string -> ('a -> Yojson.Safe.t) -> 'a option -> (string * Yojson.Safe.t) list
val opt_str : string -> string option -> (string * Yojson.Safe.t) list
val tstr : ?max:int -> string -> Yojson.Safe.t
(** A string cut at [max] bytes (default 200). *)

val opt_tstr : ?max:int -> string -> string option -> (string * Yojson.Safe.t) list
val non_empty : string -> string list -> (string * Yojson.Safe.t) list
val ts : int -> Yojson.Safe.t
val strs : string list -> Yojson.Safe.t

val cap : int -> 'a list -> 'a list * int
(** The first [n] items and the number left out. *)

val capped : string -> int -> Yojson.Safe.t list -> (string * Yojson.Safe.t) list
(** [key: items] with at most [n] items, plus [key_omitted] when some were cut. *)

val bounded_strings :
  ?chars:bool -> string -> items:int -> len:int -> string list -> (string * Yojson.Safe.t) list
(** A list of strings inside an object: at most [items] strings of at most [len]
    bytes (characters with [~chars:true]), [key_omitted] counts the rest;
    nothing for an empty list. *)

val capped_newest : string -> int -> Yojson.Safe.t list -> (string * Yojson.Safe.t) list
(** Like {!capped} for a list in time order, but the {e newest} (last) [n] are
    kept, in order; [key_omitted] counts the older ones. *)

val blocker_json : Mesh_worklog.Model.blocker -> Yojson.Safe.t
val link_json : Mesh_worklog.Model.session_link -> Yojson.Safe.t
val task_row : ?project_title:string -> Mesh_worklog.Model.task -> Yojson.Safe.t
val task_full : ?project_title:string -> Mesh_worklog.Model.task -> Yojson.Safe.t
val event_json : Mesh_worklog.Event.t -> Yojson.Safe.t
val project_json : Mesh_worklog.Query.project_row -> Yojson.Safe.t
val question_json : Work_questions.question -> Yojson.Safe.t

val warnings_json : string list -> (string * Yojson.Safe.t) list
(** [data_warnings] for the read warnings that matter (the question and
    answer events are not reported), at most 10. Empty when there are none. *)
