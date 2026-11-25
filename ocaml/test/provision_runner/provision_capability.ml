(* SPDX-License-Identifier: AGPL-3.0-or-later *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech> *)

(* Only the test executable sees this module. A real backend binary does not
   match this private synthetic witness; no command or credential is probed. *)
let witness =
  "#!/bin/sh\nset -eu\nprintf '%s' \"$MESH_SESSION\" > \"$CODEX_HOME/fixture-launch\"\n\
   record=\"$CODEX_HOME/fixture-argv-$MESH_SESSION\"\n\
   printf '%s\\n' \"$#\" \"$@\" > \"$record.tmp\"\n\
   mv \"$record.tmp\" \"$record\"\n\
   while IFS= read -r line; do printf '%s\\n' \"$line\" >> \"$CODEX_HOME/fixture-input\"; done\n"

let executable ~root backend =
  if backend <> "codex" then None
  else
    let path = Filename.concat root "synthetic-profile-witness" in
    try
      let st = Unix.lstat path in
      if st.Unix.st_kind <> Unix.S_REG || st.Unix.st_uid <> Unix.geteuid ()
         || st.Unix.st_size <> String.length witness || st.Unix.st_nlink <> 1
         || st.Unix.st_perm land 0o777 <> 0o700
         || In_channel.with_open_bin path In_channel.input_all <> witness
      then None
      else Some path
    with Unix.Unix_error _ | Sys_error _ -> None
