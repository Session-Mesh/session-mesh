(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(* The refusal of Linux-only features, as one decision callers can share. *)

open Types

type t = Isolated_agent | Demo_sandbox

let all = [ Isolated_agent; Demo_sandbox ]

let name = function
  | Isolated_agent -> "isolated-agent"
  | Demo_sandbox -> "demo-sandbox"

let of_string text = List.find_opt (fun feature -> name feature = text) all

let words = function
  | Isolated_agent -> "the isolated agent launcher"
  | Demo_sandbox -> "the demo compiler sandbox"

let available capabilities = function
  | Isolated_agent -> capabilities.isolated_agent
  | Demo_sandbox -> capabilities.demo_sandbox

(* The executable a Linux build needs, and the package that provides it. *)
let linux_requirement = function
  | Isolated_agent -> ("/usr/bin/setpriv", "util-linux")
  | Demo_sandbox -> ("/usr/bin/bwrap", "bubblewrap")

let refusal ~platform ~platform_name feature =
  let subject = words feature in
  match platform with
  | Linux ->
      let executable, package = linux_requirement feature in
      Printf.sprintf
        "%s is unavailable on %s: %s is missing, not a regular file, or not \
         executable (install the %s package)"
        subject platform_name executable package
  | Macos | Other _ ->
      Printf.sprintf "%s is unavailable on %s: it is Linux-only on this release"
        subject platform_name

let require ~platform ~platform_name ~capabilities feature =
  if available capabilities feature then Ok ()
  else Error (refusal ~platform ~platform_name:(platform_name platform) feature)
