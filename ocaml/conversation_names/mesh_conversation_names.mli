(* SPDX-License-Identifier: AGPL-3.0-or-later *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech> *)

(** Pure projections over a validated registry snapshot in its original order. *)

open Conversation_registry_model

type row = (string * Yojson.Safe.t) list

val aliases : entry list -> string list
(** The last 20 distinct nonempty aliases in chronological first-occurrence
    order. Entries with equal observation times retain their input order. *)

val enrich : row -> entry list -> row
(** Project the newest matching conversation onto a History row with [agent]
    and [id] fields. An unmatched row is returned as supplied. *)

val active_aliases : entry list -> row list -> row list
(** Set [aliases] on each session row using its [name] and [created] fields.
    A session without a matching incarnation gets an empty list. *)
