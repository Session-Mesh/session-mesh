(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(** [taxonomy.yaml]: categories holding products, as a flat list (legacy
    [projects:]) or a two-level tree ([products:], where an item is an id or a
    one-key mapping [root: [children]]). Product ids are unique across all
    categories; a root that has children is itself assignable. *)

type category = {
  key : string;
  name : string;
  products : string list;  (** roots first, then children, as in [wl] *)
  uses_projects_key : bool;  (** the category uses the legacy [projects:] list *)
}

type t = private {
  categories : category list;
  entries : (string * string option * string) list;
      (** (product id, parent, category key) in file order *)
}

val of_string : string -> (t, string) result
(** Load from the text of a file; the error is a one-line reason. *)

val load : string -> (t, Err.t) result
(** Load a file: a missing file is [Repo] (exit 6), an invalid one [Usage]. *)

val category_of : t -> string -> string option
val parent_of : t -> string -> string option
val root_of : t -> string -> string option
val children_of : t -> string -> string list
val descendants : t -> string -> string list
(** The product and its children, or [[]] for an unknown product. *)

val has_product : t -> string -> bool
val products : t -> string list
(** All product ids in file order. *)
