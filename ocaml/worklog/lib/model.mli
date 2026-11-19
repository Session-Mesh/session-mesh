(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(** The folded state of a data repository. All values are produced by
    {!Fold}; treat them as read-only. *)

module Smap : Map.S with type key = string
(** Maps keyed by task or project id. *)

type session_link = {
  agent : string;
  session : string;
  cwd : string option;
  link_host : string option;
  repo : string option;
  branch : string option;
  linked_at : int;
}

type blocker = {
  blocker_id : string;
  kind : string;
  on : string option;
  text : string;
  opened : int;
  mutable resolved : int option;
  mutable resolution : string option;
}

type task = {
  id : string;
  home_product : string;  (** product of the [created] event; locates the task file *)
  home_category : string;
  created : string;  (** timestamp text of the [created] event *)
  mutable product : string;  (** current product: latest [set product], else home *)
  mutable category : string;
  mutable title : string;
  mutable status : string;
  mutable priority : string;
  mutable due : string option;
  mutable tags : string list;  (** sorted, no duplicates *)
  mutable links : string list;
  mutable blocked_by : string list;
  mutable also : string list;
  mutable project_id : string option;
  mutable track : string option;
  mutable owner : string;  (** default [me] *)
  mutable eta : string option;
  mutable size : string option;
  mutable origin : string option;
  mutable last_ts : int option;  (** timestamp of the latest event of any type *)
  mutable last_note : string option;  (** latest [progress] or [note] text *)
  mutable sessions : session_link list;  (** unique by (agent, session), oldest first *)
  mutable blockers : blocker list;  (** oldest first *)
  mutable timeline : Event.t list;  (** applied events, in fold order *)
}

type project = {
  pid : string;
  mutable title_p : string;
  mutable product_p : string;
  mutable category_p : string;
  created_p : string;
  mutable status_p : string;  (** [active] by default *)
  mutable quarter : string option;
  mutable owner_p : string option;
  mutable hlp : string option;
  mutable goal : string option;
  mutable milestones : string list;
  mutable risks : string list;
  mutable last_ts_p : int option;
  mutable timeline_p : Event.t list;
}

type world = { tasks : task Smap.t; projects : project Smap.t }
