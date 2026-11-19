(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(** UTC timestamps and calendar dates of the data format. A timestamp is
    [YYYY-MM-DDTHH:MM:SSZ]; the older minute precision [YYYY-MM-DDTHH:MMZ] is
    accepted when parsing. A date is [YYYY-MM-DD]. Epoch seconds are plain
    [int]s. *)

val parse : string -> int option
(** Epoch seconds of a timestamp string, or [None] for any other form. *)

val format : int -> string
(** [YYYY-MM-DDTHH:MM:SSZ]. *)

val month : int -> string
(** [YYYY-MM], the UTC month: the name part of an event file. *)

val date_of : int -> string
(** The UTC calendar date [YYYY-MM-DD]. *)

val valid_date : string -> bool
(** A real calendar date written [YYYY-MM-DD] (four-digit year from 0001). *)

val add_days : string -> int -> string
(** The date [n] days after (or before, if negative) a valid date. *)

val seconds_per_day : int
