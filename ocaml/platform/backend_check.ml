(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(* Compile-time only: every backend is checked against the same module type
   on every build, whichever one dune copies to [backend.ml]. *)

module _ : Backend_contract.S = Backend_linux
module _ : Backend_contract.S = Backend_darwin
module _ : Backend_contract.S = Backend_unsupported
