(* SPDX-License-Identifier: AGPL-3.0-or-later *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech> *)

(* This is a build-time allowlist, not a runner setting or a client claim.
   There are no qualified first-launch modes in the distributed helper. *)
let executable ~root:_ (_backend : string) : string option = None
