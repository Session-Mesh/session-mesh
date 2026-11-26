(* SPDX-License-Identifier: AGPL-3.0-or-later *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech> *)

module W = Mesh_worklog
module E = Work_mcp.Work_err
open E

(* Explicit operator identity, with filesystem replacement guards. Never enroll
   from a path/hash, write the tracker, or expose its filesystem location. *)
let registration root =
  try
    let file = Sys.getenv "MESH_WORK_INSTANCE_REGISTRATION" in
    if Filename.is_relative file then raise Exit;
    let before = Unix.lstat file in
    if before.Unix.st_kind <> Unix.S_REG then raise Exit;
    let fd = Unix.openfile file [ Unix.O_RDONLY; Unix.O_CLOEXEC ] 0 in
    Fun.protect
      ~finally:(fun () -> Unix.close fd)
      (fun () ->
        let st = Unix.fstat fd in
        if
          st.Unix.st_kind <> Unix.S_REG
          || st.st_uid <> Unix.geteuid ()
          || st.st_dev <> before.st_dev || st.st_ino <> before.st_ino
          || st.st_nlink <> 1
          || st.st_perm land 0o077 <> 0
          || st.st_size > 4096
        then raise Exit;
        let bytes = Bytes.create st.st_size in
        let rec read at =
          if at < Bytes.length bytes then
            let n = Unix.read fd bytes at (Bytes.length bytes - at) in
            if n = 0 then raise Exit else read (at + n)
        in
        read 0;
        let fields =
          match Yojson.Safe.from_string (Bytes.to_string bytes) with
          | `Assoc a -> a
          | _ -> raise Exit
        in
        let keys =
          [
            "version";
            "instance_id";
            "root_dev";
            "root_ino";
            "git_dev";
            "git_ino";
          ]
        in
        if
          List.sort compare (List.map fst fields) <> List.sort compare keys
          || List.assoc "version" fields <> `Int 1
        then raise Exit;
        let instance =
          match List.assoc "instance_id" fields with
          | `String s
            when String.length s = 64
                 && String.for_all
                      (function '0' .. '9' | 'a' .. 'f' -> true | _ -> false)
                      s ->
              s
          | _ -> raise Exit
        in
        let guard prefix path =
          let stat = Unix.lstat path in
          if stat.Unix.st_kind <> Unix.S_DIR then raise Exit;
          let same key value =
            List.assoc (prefix ^ key) fields = `String (string_of_int value)
          in
          if not (same "_dev" stat.st_dev && same "_ino" stat.st_ino) then
            raise Exit
        in
        guard "root" root;
        guard "git" (Filename.concat root ".git");
        Ok instance)
  with _ ->
    Error
      (E.make "instance_unavailable"
         "The work source has no matching private instance registration")

let run (loaded : Wr_load.t) project product =
  let* instance = registration loaded.ctx.root in
  let* () =
    match loaded.snapshot.taxonomy with
    | None ->
        Error (E.make "repository" "The work product taxonomy is unavailable")
    | Some _ -> Ok ()
  in
  let* () = Wr_scope.check_product loaded (Some product) in
  let* row = lift (W.Query.get_project (Wr_load.world loaded) project) in
  let p = row.project in
  if p.pid <> project || p.product_p <> product then
    Error
      (E.make "not_found" "The exact project does not belong to this product")
  else
    let* again = registration loaded.ctx.root in
    if instance <> again then
      Error (E.make "instance_unavailable" "The work instance changed")
    else
      Ok
        (Wr_out.document "attachment-context"
           [
             ("instance_id", `String instance);
             ("project_id", `String p.pid);
             ("product_id", `String p.product_p);
             ("project_created", `String p.created_p);
           ])
