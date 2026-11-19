(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(** The independence rule of the generic libraries (ocaml/README.md, "Generic
    libraries"), checked on the dune files of a [generic/] directory.

    The rule is an allow list, so that a dune construct it does not know is
    refused rather than missed:
    - the directory holds only the directories listed in {!generic} and
      [test], and no [dune] file of its own;
    - a library directory holds no sub-directory, and its dune file holds one
      stanza, [(library ...)], named as listed, whose fields are among
      {!allowed_fields}: no [rule], [copy_files], [include_subdirs] or
      [subdir] stanza can bring code or build steps in;
    - [libraries] names only generic libraries and {!external_allowed}
      ([select] alternatives and [re_export] included);
    - [preprocess] is [no_preprocessing] or [pps] of {!ppx_allowed} (empty);
    - the flag fields do not [:include] a file.

    The [test] directory may hold no sub-directory; its dune file is not
    checked (tests may use any test library). *)

val generic : (string * string) list
(** Each generic directory and the library its dune file defines. *)

val external_allowed : string list
val ppx_allowed : string list
val allowed_fields : string list

val check : string -> (unit, string list) result
(** [check root] checks the [generic/] directory [root]: [Error] lists every
    violation, each naming its file. *)
