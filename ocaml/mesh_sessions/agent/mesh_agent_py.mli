(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(** Python's value semantics on decoded JSON, as the Python listing
    ([discover.py]) applies them to the files it reads, so that an adapter
    ported from it gives the same answers. *)

val truthy : Yojson.Safe.t -> bool
(** Python's [bool(value)]: [null], [false], [0], [0.0], [""], [[]] and [{}]
    are false. *)

val get : string -> Yojson.Safe.t -> Yojson.Safe.t
(** [d.get(key)] when the value is an object, else [`Null] (the caller checks
    [isinstance(d, dict)] with {!is_object} where Python does). The last
    occurrence of a duplicated key wins, as in Python. *)

val is_object : Yojson.Safe.t -> bool
val string : Yojson.Safe.t -> string option
(** The text of a JSON string. *)

val first_truthy : Yojson.Safe.t list -> Yojson.Safe.t
(** Python's [a or b or c]: the first truthy value, else the last one ([`Null]
    for an empty list). *)

val str : Yojson.Safe.t -> string
(** Python's [str(value)] of a decoded value: a string as it is; [True],
    [False], [None]; an integer in decimal; a float as Python's [repr] gives
    it for usual values (an integral float below 1e16 keeps [.0]; others take
    the shortest decimal form that reads back the same number); a list or
    object in Python's display form, strings in {!Mesh_python_text.repr}. *)
