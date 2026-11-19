(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

module Smap = Map.Make (String)

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
  home_product : string;
  home_category : string;
  created : string;
  mutable product : string;
  mutable category : string;
  mutable title : string;
  mutable status : string;
  mutable priority : string;
  mutable due : string option;
  mutable tags : string list;
  mutable links : string list;
  mutable blocked_by : string list;
  mutable also : string list;
  mutable project_id : string option;
  mutable track : string option;
  mutable owner : string;
  mutable eta : string option;
  mutable size : string option;
  mutable origin : string option;
  mutable last_ts : int option;
  mutable last_note : string option;
  mutable sessions : session_link list;
  mutable blockers : blocker list;
  mutable timeline : Event.t list;
}

type project = {
  pid : string;
  mutable title_p : string;
  mutable product_p : string;
  mutable category_p : string;
  created_p : string;
  mutable status_p : string;
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
