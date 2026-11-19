(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

type snapshot = {
  loaded : Store.loaded;
  taxonomy : Taxonomy.t option;
  warnings : string list;
}

let ( let* ) = Result.bind

(* Every reader returns [Error]: an unreadable directory or file never raises. *)
let guarded f = match Err.protect f with Ok r -> r | Error e -> Error e

let snapshot ctx =
  Err.protect (fun () ->
      let loaded = Store.load ctx in
      match Taxonomy.load (Ctx.taxonomy_path ctx) with
      | Ok tax -> { loaded; taxonomy = Some tax; warnings = loaded.warnings }
      | Error e ->
          {
            loaded;
            taxonomy = None;
            warnings = loaded.warnings @ [ e.Err.message ^ "; product filters match exactly (no roll-up)" ];
          })

let world s = s.loaded.world

let list_tasks ctx filter =
  guarded (fun () ->
      let* s = snapshot ctx in
      Result.map (fun tasks -> (tasks, s.warnings)) (Query.list_tasks (world s) ?taxonomy:s.taxonomy filter))

let get_task ctx reference =
  guarded (fun () ->
      let* s = snapshot ctx in
      Result.map
        (fun view -> (view, s.warnings @ view.Query.warnings))
        (Query.get_task ctx (world s) reference))

let resume ctx ?where ?stale_days ?show_all ?(filter = Query.no_filter) () =
  guarded (fun () ->
      let* s = snapshot ctx in
      let w = world s in
      let* project =
        match filter.Query.project with
        | None -> Ok None
        | Some r -> Result.map Option.some (Refs.project w r)
      in
      let keep t = Query.matches ~world:w ?taxonomy:s.taxonomy ~project filter t in
      Ok (Resume.build w ~now:(ctx.Ctx.now ()) ?where ?stale_days ?show_all ~keep (), s.warnings))

let list_projects ctx ?product ?status ?quarter ?include_closed () =
  guarded (fun () ->
      let* s = snapshot ctx in
      Ok
        ( Query.list_projects (world s) ?taxonomy:s.taxonomy ?product ?status ?quarter ?include_closed (),
          s.warnings ))

let get_project ctx reference =
  guarded (fun () ->
      let* s = snapshot ctx in
      Result.map
        (fun (row : Query.project_row) ->
          (row, Query.tasks_of_project (world s) row.project.Model.pid, s.warnings))
        (Query.get_project (world s) reference))
