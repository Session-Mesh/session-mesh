(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

module S = Mcp_kit.Schema

let max_output_bytes = 48_000

let string ?description ?(max = 200) () = S.string ?description ~min_length:1 ~max_length:max ()
let strings ?(max_items = 50) ?(max = 200) () = S.array ~max_items (string ~max ())
let enum values = S.enum (List.map (fun v -> `String v) values)
let boolean ?description () = S.bool ?description ()
let integer ?description ~minimum ~maximum () = S.integer ?description ~minimum ~maximum ()

let object_ properties ~required =
  S.object_ ~properties ~required ~additional_properties:false ()

let limit_property ~max = ("limit", integer ~description:"Most items returned." ~minimum:1. ~maximum:(float_of_int max) ())

let error_result (e : Work_err.t) =
  {
    Mcp_kit.Tool.content = [ Mcp_kit.Tool.Text (e.code ^ ": " ^ Work_err.safe_text e.message) ];
    is_error = true;
    structured_content = Some (Work_err.to_json e);
  }

let with_warnings json =
  match (json, Work_repo.take_warnings ()) with
  | _, [] -> json
  | `Assoc l, w -> `Assoc (l @ [ ("write_warnings", `List (List.map (fun s -> `String s) w)) ])
  | json, _ -> json

(* Data returned is untrusted: invalid UTF-8 is replaced by U+FFFD, and
   control, bidirectional, zero-width and tag characters are removed from
   every string and key, whatever wrote them. *)
let rec clean = function
  | `String s -> `String (Work_text.clean s)
  | `List items -> `List (List.map clean items)
  | `Assoc members -> `Assoc (List.map (fun (k, v) -> (Work_text.clean k, clean v)) members)
  | json -> json

let size json = String.length (Yojson.Safe.to_string json)
let shrinkable_string = 40

let replace_member fields key v = List.map (fun (k, old) -> if k = key then (k, v) else (k, old)) fields

let count_of fields key = match List.assoc_opt key fields with Some (`Int n) -> n | _ -> 0

(* A counter raised by [cut]; absent stays absent when nothing was cut. *)
let add_count fields key cut =
  if cut = 0 then fields
  else if List.mem_assoc key fields then replace_member fields key (`Int (count_of fields key + cut))
  else fields @ [ (key, `Int cut) ]

let keep_head n items = List.filteri (fun i _ -> i < n) items

let keep_tail n items =
  let total = List.length items in
  List.filteri (fun i _ -> i >= total - n) items

let owner_verified = function `Assoc m -> List.assoc_opt "owner_verified" m = Some (`Bool true) | _ -> false

(* The newest [n] answers, except that the last owner-verified one is always
   kept (then with the newest [n - 1]), as [Work_render.capped_answers] does:
   [owner_answered] must keep pointing at an answer in the list. *)
let keep_answers n items =
  let total = List.length items in
  let owner = List.fold_left (fun (i, found) a -> (i + 1, if owner_verified a then Some i else found)) (0, None) items |> snd in
  match owner with
  | Some o when o < total - n -> List.filteri (fun i _ -> i = o || i > total - n) items
  | _ -> keep_tail n items

(* One list halved, keeping the head or the tail: [<key>_omitted] counts the
   items cut, over the earlier cuts. Lists are newest first, except
   [answers], which is in time order and keeps its newest (last) items and
   the owner's answer. *)
let halve_list ~keep fields key items =
  let kept = keep (List.length items / 2) items in
  let cut = List.length items - List.length kept in
  add_count (replace_member fields key (`List kept)) (key ^ "_omitted") cut

let has_state state = function `Assoc m -> List.assoc_opt "state" m = Some (`String state) | _ -> false

(* The briefing's questions: open ones first, then answered ones. Each group
   is halved on its own, keeping at least one answered question while there is
   room, and the three counters are raised by what each group lost so that
   they agree with the list. *)
let halve_questions fields items =
  let opened, answered = List.partition (has_state "open") items in
  let n = List.length items and o = List.length opened and a = List.length answered in
  let keep = n / 2 in
  let share = keep * a / n in
  let share = if a > 0 && keep >= 2 then max 1 share else share in
  let open_keep = min o (keep - share) in
  let answered_keep = min a (keep - open_keep) in
  let fields = replace_member fields "my_questions" (`List (keep_head open_keep opened @ keep_head answered_keep answered)) in
  let fields = add_count fields "my_open_questions_omitted" (o - open_keep) in
  let fields = add_count fields "my_answered_questions_omitted" (a - answered_keep) in
  add_count fields "my_questions_omitted" (n - open_keep - answered_keep)

let halve fields key items =
  match key with
  | "my_questions" -> halve_questions fields items
  | "answers" -> halve_list ~keep:keep_answers fields key items
  | _ -> halve_list ~keep:keep_head fields key items

let largest_first pairs =
  List.map (fun ((_, v) as p) -> (size v, p)) pairs
  |> List.sort (fun (a, _) (b, _) -> compare b a)
  |> List.map snd

(* One reduction of a value, or [None] when nothing in it can be cut. A string
   loses half of its characters; a list of an object loses its second half;
   the value that takes most room is tried first, at any depth. *)
let rec shrink = function
  | `String s when String.length s > shrinkable_string ->
      Some (`String (Work_render.trunc ~max:(String.length s / 2) s))
  | `Assoc fields -> Option.map (fun f -> `Assoc f) (shrink_fields fields)
  | `List items -> shrink_items items
  | _ -> None

and shrink_fields fields =
  let by_size = largest_first fields in
  List.find_map
    (fun (key, v) ->
      match v with
      | `List (_ :: _ :: _ as items) -> Some (halve fields key items)
      | v -> Option.map (replace_member fields key) (shrink v))
    by_size

and shrink_items items =
  let by_size = largest_first (List.mapi (fun i v -> (i, v)) items) in
  List.find_map
    (fun (i, v) -> Option.map (fun v' -> `List (List.mapi (fun j old -> if i = j then v' else old) items)) (shrink v))
    by_size

let with_truncated = function
  | `Assoc fields -> `Assoc (List.filter (fun (k, _) -> k <> "truncated") fields @ [ ("truncated", `Bool true) ])
  | json -> json

(* The serialised result is a true bound: strings and lists are cut at every
   depth until it fits, and the result says so with [truncated]. *)
let fit ?(max_bytes = max_output_bytes) json =
  let rec go json shrunk =
    if size json <= max_bytes then Some (if shrunk then with_truncated json else json)
    else Option.bind (shrink json) (fun smaller -> go smaller true)
  in
  go json false

let ends_with suffix s =
  let n = String.length suffix and m = String.length s in
  m >= n && String.sub s (m - n) n = suffix

(* Whether any object, at any depth, says that it cut a list. *)
let rec has_omitted = function
  | `Assoc fields -> List.exists (fun (k, v) -> ends_with "_omitted" k || has_omitted v) fields
  | `List items -> List.exists has_omitted items
  | _ -> false

let mark_truncated = function
  | `Assoc fields as json when has_omitted json && not (List.mem_assoc "truncated" fields) ->
      `Assoc (fields @ [ ("truncated", `Bool true) ])
  | json -> json

let ok_result json =
  match fit (mark_truncated (clean (with_warnings json))) with
  | None -> error_result (Work_err.make "output_too_large" "the result is too large; narrow the query")
  | Some json ->
      {
        Mcp_kit.Tool.content = [ Mcp_kit.Tool.Text (Yojson.Safe.to_string json) ];
        is_error = false;
        structured_content = Some json;
      }

let run handler args =
  Work_repo.reset_warnings ();
  match Work_args.reject_unsafe_text args with
  | Error e -> error_result e
  | Ok () -> (
      match handler args with
      | Ok json -> ok_result json
      | Error e -> error_result e
      | exception Out_of_memory -> error_result (Work_err.internal "out of memory")
      | exception exn -> error_result (Work_err.internal (Printexc.to_string exn)))

let make ~name ~description ~input_schema handler =
  Mcp_kit.Tool.make ~description ~input_schema name (fun args -> Ok (run handler args))
