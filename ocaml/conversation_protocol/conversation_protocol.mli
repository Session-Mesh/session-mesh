(* SPDX-License-Identifier: AGPL-3.0-or-later
   Copyright (c) 2026 Atacama <contact@atacama.tech> *)

(** Execute one version 1 registry request against an explicit store path.
    Responses contain either [result] or a fixed [error] code. Observe returns
    one aliases array per input session, in input order, or null with
    [project:false]. Enrich returns the fields to merge into the History item.

    Observe's optional [now] sets the observation time. The optional
    [clock_now] sets the wall clock for deterministic tests. On other
    operations, [now] is shorthand for [clock_now]. Both retain their JSON
    number representation when written to the store. Reads of an unreadable
    store return an empty snapshot. A mutation against an unreadable store
    returns [registry_unreadable] and preserves the file. Lock and other I/O
    failures return [registry_io]. *)
val execute :
  ?clock:(unit -> float) -> path:string -> Yojson.Safe.t -> Yojson.Safe.t

(** Parse one request and serialize its response. The caller provides framing
    and a transport size limit. *)
val handle : ?clock:(unit -> float) -> path:string -> string -> string
