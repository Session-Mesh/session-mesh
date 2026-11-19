(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

type fields = (string * Yojson.Safe.t) list

let size json = String.length (Yojson.Safe.to_string json)

let order =
  [
    [ "questions" ];
    [ "timeline" ];
    [ "dependencies" ];
    [ "sessions" ];
    [ "reprise"; "todo" ];
    [ "reprise"; "due" ];
    [ "reprise"; "stale" ];
    [ "reprise"; "in_progress" ];
    [ "reprise"; "blocked" ];
    [ "todo" ];
    [ "due" ];
    [ "stale" ];
    [ "in_progress" ];
    [ "blocked" ];
    [ "blocking" ];
    [ "blocked_by" ];
    [ "no_project" ];
    [ "projects" ];
    [ "tasks" ];
  ]

let count fields key = match List.assoc_opt key fields with Some (`Int n) -> n | _ -> 0

let set fields key v =
  if List.mem_assoc key fields then List.map (fun (k, old) -> if k = key then (k, v) else (k, old)) fields
  else fields @ [ (key, v) ]

let add_omitted fields key cut =
  if cut = 0 then fields else set fields (key ^ "_omitted") (`Int (count fields (key ^ "_omitted") + cut))

(* The list at [path] loses its second half; its head is kept. *)
let rec halve path (fields : fields) =
  match path with
  | [ key ] -> (
      match List.assoc_opt key fields with
      | Some (`List items) when List.length items >= 2 ->
          let n = List.length items in
          let kept = List.filteri (fun i _ -> i < n / 2) items in
          Some (add_omitted (set fields key (`List kept)) key (n - List.length kept))
      | _ -> None)
  | key :: rest -> (
      match List.assoc_opt key fields with
      | Some (`Assoc inner) -> Option.map (fun inner -> set fields key (`Assoc inner)) (halve rest inner)
      | _ -> None)
  | [] -> None

let row_id = function
  | `Assoc m -> ( match List.assoc_opt "id" m with Some (`String id) -> Some id | _ -> None)
  | _ -> None

let add_omitted_column omitted name cut =
  if cut = 0 then omitted
  else
    let previous = match List.assoc_opt name omitted with Some (`Int n) -> n | _ -> 0 in
    set omitted name (`Int (previous + cut))

(* After [tasks] is cut, a column names only the rows still shown; the ids it
   loses are counted in [columns_omitted]. *)
let prune_columns (fields : fields) =
  match (List.assoc_opt "tasks" fields, List.assoc_opt "columns" fields) with
  | Some (`List rows), Some (`Assoc columns) ->
      let shown = List.filter_map row_id rows in
      let omitted = match List.assoc_opt "columns_omitted" fields with Some (`Assoc m) -> m | _ -> [] in
      let columns, omitted =
        List.fold_left
          (fun (cols, omitted) (name, ids) ->
            match ids with
            | `List ids ->
                let kept = List.filter (function `String id -> List.mem id shown | _ -> false) ids in
                ((name, `List kept) :: cols, add_omitted_column omitted name (List.length ids - List.length kept))
            | other -> ((name, other) :: cols, omitted))
          ([], omitted) columns
      in
      let fields = set fields "columns" (`Assoc (List.rev columns)) in
      if omitted = [] then fields else set fields "columns_omitted" (`Assoc omitted)
  | _ -> fields

let rec shrink_along max fields path =
  if size (`Assoc fields) <= max then fields
  else
    match halve path fields with
    | None -> fields
    | Some cut -> shrink_along max (if path = [ "tasks" ] then prune_columns cut else cut) path

let with_truncated fields = List.filter (fun (k, _) -> k <> "truncated") fields @ [ ("truncated", `Bool true) ]

let fit ~max json =
  if size json <= max then Some json
  else
    match json with
    | `Assoc fields ->
        let json = `Assoc (with_truncated (List.fold_left (shrink_along max) fields order)) in
        if size json <= max then Some json else Work_mcp.Work_tool.fit ~max_bytes:max json
    | json -> Work_mcp.Work_tool.fit ~max_bytes:max json
