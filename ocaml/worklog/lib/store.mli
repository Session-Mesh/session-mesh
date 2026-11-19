(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(** Reading the data repository: event files, task files, and the folded
    world. Reads take no lock and never fail on malformed data: bad lines are
    skipped and reported as warnings with their file and line. Links and special files are never followed (see
    {!Safefs}): such entries are skipped with a warning. *)

type loaded = {
  world : Model.world;
  events : Event.t list;  (** every accepted event, in fold order *)
  warnings : string list;  (** in the order they were found *)
}

val parse_event_file_name : string -> (string * string) option
(** [(YYYY-MM, host)] of an [events/] file name [YYYY-MM.<host>.jsonl]. *)

val read_events : Ctx.t -> Event.t list * string list
(** All hosts' events and the warnings of the read: malformed lines, files
    with unexpected names, timestamps more than a day ahead of the clock.
    Byte-identical lines found in different files count once (the first file
    in name order keeps it); repeats inside one file are kept. *)

val scan_malformed : Ctx.t -> string list
(** Every malformed line as [file:line: reason]; the strict view for
    validating a repository. *)

val load : Ctx.t -> loaded
(** Read and fold everything; also warns about task files without a
    [created] event. *)

val task_file_hex_ids : Ctx.t -> string list
(** Lowercase hex part of the ids of every existing task file. *)

val find_task_file : Ctx.t -> product:string -> id:string -> string option
(** Path of the file of a task under [tasks/<product>/]. *)

val read_task_file : string -> (string * string) list * string
(** Frontmatter [key, value] pairs (unquoted) and the notes body of a task
    file; no frontmatter yields no pairs and the whole text. *)

val render_task_file : id:string -> product:string -> category:string -> created:string -> notes:string -> string
(** The text of a new task file: identity-only frontmatter, then the notes. *)
