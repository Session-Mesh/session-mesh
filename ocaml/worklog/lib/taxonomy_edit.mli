(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(** Adding a product to [taxonomy.yaml] by a textual edit that preserves every
    other byte (comments, quoting, line endings, blank lines). The edit is
    understood for a closed block-style layout only: [categories:], one key
    per category with [name:] and a [products:] or [projects:] list of plain
    or quoted ids or one-key mappings [id:] with a list of ids. Any other
    layout is refused, never rewritten. There is no rename, move or
    delete. *)

val insert :
  string -> id:string -> category:string -> parent:string option -> (string, string) result
(** The new text of a taxonomy file with the product added at the end of its
    category (or of its parent's children). The result is verified: it must
    read as the old taxonomy plus exactly the new product at the expected
    position. [Error] gives the reason (invalid id, duplicate, unknown
    category or parent, a parent that is itself a child, a layout outside the
    supported one, failed verification). *)

val check_id : string -> (unit, string) result
(** The rules for a new product id: a name of at most 64 characters that
    reads back as a string and does not look like a task, project, proposal
    or blocker id, a number, a YAML boolean, or the reserved [product:]
    prefix. *)

val add_product :
  Ctx.t -> id:string -> category:string -> ?parent:string -> unit -> (unit, Err.t) result
(** Under the repository lock, {!insert} into [taxonomy.yaml], write a
    temporary file in the same directory, verify it by loading it, then
    atomically replace the original. Commits only [taxonomy.yaml] with the
    message [wl: product add <id>] when the repository is a git repository. No
    event is written and no task is touched. *)
