(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(** Independent bounded native observation lane. Hooks are constructor-only.
    Accounting reserves disjoint compartments before work: 128 two-KiB
    records, four two-MiB retained results (including borrowed retired data),
    two 6.5-MiB capture/collector staging reservations and four 512-KiB control
    builders: 23.25 MiB in total, below the 24-MiB manager limit. Captured raw,
    parser staging, parsed payload strings and serialization buffers fit the
    worker compartment through explicit phase boundaries; the raw collector
    envelope is dropped before catalog serialization. A finished page DTO is
    transferred to the existing socket transport at return. This accounts
    bounded payloads, not allocator overhead, language heap or RSS. *)
type stage = Capture | Control | Borrow | Settled | Child_started of int | Child_exited of int | Pipes_drained | Charge of string * int

type t
val operations : string list
val is_operation : string -> bool
val make : ?hook:(stage -> unit) -> ?now:(unit -> float) -> boot:string -> store:Mesh_project_store.t -> unit -> t
val capability : t -> Yojson.Basic.t
val tick : t -> stopping:bool -> unit
val run : t -> isolated:bool -> stopping:bool -> (string * Yojson.Basic.t) list -> Yojson.Basic.t
