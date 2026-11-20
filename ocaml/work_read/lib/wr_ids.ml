(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

module W = Mesh_worklog
module R = Work_mcp.Work_render
module Q = Work_mcp.Work_questions

let max_tasks = 4000
let max_projects = 1000
let max_questions = 1000
let max_title = 100

(* Most recent activity first, then by id: a cut list keeps the ids most
   likely to be printed in a terminal. *)
let by_activity ts_a id_a ts_b id_b =
  compare
    (Option.value ~default:0 ts_b, id_a)
    (Option.value ~default:0 ts_a, id_b)

let entry id title =
  `Assoc [ ("id", R.tstr ~max:40 id); ("title", R.tstr ~max:max_title title) ]

let tasks (world : W.Model.world) =
  W.Model.Smap.fold (fun _ t acc -> t :: acc) world.tasks []
  |> List.sort (fun (a : W.Model.task) (b : W.Model.task) ->
      by_activity a.last_ts a.id b.last_ts b.id)
  |> List.map (fun (t : W.Model.task) -> entry t.id t.title)

let projects (world : W.Model.world) =
  W.Model.Smap.fold (fun _ p acc -> p :: acc) world.projects []
  |> List.sort (fun (a : W.Model.project) (b : W.Model.project) ->
      by_activity a.last_ts_p a.pid b.last_ts_p b.pid)
  |> List.map (fun (p : W.Model.project) -> entry p.pid p.title_p)

(* The project a question is about, directly or through its task. *)
let project_of (world : W.Model.world) = function
  | Some id when W.Model.Smap.mem id world.tasks ->
      (W.Model.Smap.find id world.tasks).project_id
  | Some id when W.Model.Smap.mem id world.projects -> Some id
  | _ -> None

let question (world : W.Model.world) (q : Q.question) =
  `Assoc
    ([ ("id", R.tstr ~max:40 q.id); ("title", R.tstr ~max:max_title q.text) ]
    @ R.opt_tstr ~max:40 "about" q.about
    @ R.opt_tstr ~max:40 "project" (project_of world q.about))

(* The three lists share the output bound fairly (max-min): taken from the
   shortest to the longest, a list is kept whole when it fits in an equal share
   of what is left, else it keeps the head (the most recent items) that fits.
   Without this, the generic cut of {!Wr_fit} would empty the questions and the
   projects first. The slack leaves room for the rest of the document. *)
let budget = Wr_out.max_output_bytes - 10_000
let item_size item = String.length (Yojson.Safe.to_string item) + 1

let head_within share items =
  let rec go used acc = function
    | item :: rest when used + item_size item <= share ->
        go (used + item_size item) (item :: acc) rest
    | _ -> List.rev acc
  in
  go 0 [] items

let fair_shares lists =
  let sized =
    List.map
      (fun (key, items) ->
        (key, items, List.fold_left (fun n i -> n + item_size i) 0 items))
      lists
  in
  let rec go remaining left acc = function
    | [] -> acc
    | (key, items, size) :: rest ->
        let share = remaining / left in
        let kept, used =
          if size <= share then (items, size)
          else
            let kept = head_within share items in
            (kept, List.fold_left (fun n i -> n + item_size i) 0 kept)
        in
        go (remaining - used) (left - 1) ((key, kept) :: acc) rest
  in
  go budget (List.length sized) []
    (List.stable_sort (fun (_, _, a) (_, _, b) -> compare a b) sized)

(* [key: kept] and, when some were left out (by the count cap or the fair
   share), [key_omitted]. *)
let field shares (key, _, items) =
  let kept = List.assoc key shares in
  let omitted = List.length items - List.length kept in
  if omitted > 0 then Wr_out.mark_truncated ();
  (key, `List kept)
  :: (if omitted > 0 then [ (key ^ "_omitted", `Int omitted) ] else [])

let run (loaded : Wr_load.t) =
  let world = Wr_load.world loaded in
  let lists =
    [
      ("tasks", max_tasks, tasks world);
      ("projects", max_projects, projects world);
      ( "questions",
        max_questions,
        List.rev_map (question world) loaded.questions );
    ]
  in
  let capped =
    List.map (fun (key, cap, items) -> (key, fst (R.cap cap items))) lists
  in
  let shares = fair_shares capped in
  Ok (Wr_out.document "ids" (List.concat_map (field shares) lists))
