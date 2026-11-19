(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(** A reader for the small YAML subset used by [taxonomy.yaml] and the
    frontmatter of task files: block mappings and sequences (indentless
    sequences allowed), flow sequences and mappings, plain and quoted scalars,
    and comments. Anchors, tags, block scalars, multi-line scalars and
    documents markers are refused with an error, never misread. *)

type t =
  | Null  (** an empty value *)
  | Scalar of { text : string; quoted : bool }
  | Seq of t list
  | Map of { fields : (string * t) list; typed_keys : string list }
      (** [fields] in file order (a repeated key keeps its first position and last value);
          [typed_keys] are the plain keys that a YAML 1.1 loader would not read as strings
          (for example [12], [yes], [null]) *)

val parse : string -> (t, string) result
(** Parse one document. The error names the line. *)

val is_plain_string : string -> bool
(** Whether an unquoted scalar reads as a string under YAML 1.1 typing (see
    {!Yaml_scalar.is_plain_string}): [false] for booleans, null, integers,
    floats and timestamps; [2fa], [3d] and [1e3] are strings. *)

val is_conservative_string : string -> bool
(** {!is_plain_string} and not even number-shaped: for new ids written to a file. *)

val max_depth : int
(** Nesting deeper than this (flow and block collections) is an error. *)
