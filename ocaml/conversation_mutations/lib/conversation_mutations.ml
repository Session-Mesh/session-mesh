(* SPDX-License-Identifier: AGPL-3.0-or-later
   Copyright (c) 2026 Atacama <contact@atacama.tech> *)

(** Pure registry mutations. The caller supplies validated strings and finite
    timestamps, in the order returned by registry loading. *)

include Conversation_registry_model

type observed_binding = Shell | Ambiguous | Known of conversation

type observation = {
  incarnation : incarnation;
  identity : observed_binding;
  label : string;
}

type action =
  | Observe of { listed : bool; now : timestamp; sessions : observation list }
  | Rename of {
      incarnation : incarnation;
      now : timestamp;
      old_label : string;
      new_label : string;
    }
  | Close of { incarnation : incarnation; now : timestamp }
  | Forget of conversation

type result = { entries : entry list; dirty : bool }

let matching (incarnation : incarnation) entries =
  List.filter_map
    (fun (index, (entry : entry)) ->
      if same_incarnation incarnation entry.incarnation then Some (index, entry)
      else None)
    (List.mapi (fun index entry -> (index, entry)) entries)

let newest = function
  | [] -> None
  | first :: rest ->
      Some
        (List.fold_left
           (fun ((_, latest) as current) ((_, entry) as candidate) ->
             if compare_time entry.seen latest.seen > 0 then candidate
             else current)
           first rest)

let aliases_with aliases additional =
  bounded_aliases (List.to_seq (aliases @ additional))

let make_entry incarnation now binding aliases =
  { incarnation; binding; label = ""; aliases; seen = now; closed_at = None }

let replace entries index replacement =
  List.mapi (fun i entry -> if i = index then replacement else entry) entries

let observe_one now result (session : observation) =
  let matched = matching session.incarnation result.entries in
  if List.exists (fun (_, entry) -> Option.is_some entry.closed_at) matched then
    result
  else
    let binding =
      match session.identity with Known conversation -> Exact conversation
      | Shell | Ambiguous -> Unbound
    in
    let latest = newest matched in
    let selected =
      match List.find_opt (fun (_, entry) -> entry.binding = binding) matched with
      | None when session.identity = Shell -> latest
      | found -> found
    in
    match selected with
    | Some (_, entry) when compare_time entry.seen now > 0 -> result
    | _ ->
        let entry =
          match selected with
          | Some (_, entry) -> entry
          | None ->
              let aliases = Option.fold ~none:[] ~some:(fun (_, e) -> e.aliases) latest in
              make_entry session.incarnation now binding aliases
        in
        let promoted =
          match (selected, latest) with
          | Some (index, _), Some (latest_index, _) -> index <> latest_index
          | _ -> false
        in
        let aliases =
          aliases_with entry.aliases
            [ session.incarnation.name; entry.label; session.label ]
        in
        let seen = if promoted then now else entry.seen in
        (* The Python observation carries its dirty bit through the entire
           inventory, so later observations can refresh even unchanged rows. *)
        let dirty =
          result.dirty || Option.is_none selected || seen <> entry.seen
          || aliases <> entry.aliases || session.label <> entry.label
        in
        let seen = if dirty || elapsed_day ~now ~seen then now else seen in
        let updated = { entry with aliases; label = session.label; seen } in
        let entries =
          match selected with
          | Some (index, _) -> replace result.entries index updated
          | None ->
              let kept =
                match binding with
                | Exact _ ->
                    List.filter
                      (fun (entry : entry) ->
                        match entry.binding with
                        | Exact _ -> true
                        | Unbound | Agent_only _ ->
                            not (same_incarnation entry.incarnation session.incarnation))
                      result.entries
                | Unbound | Agent_only _ -> result.entries
              in
              kept @ [ updated ]
        in
        { entries; dirty = dirty || seen <> entry.seen }

let close_entry now entry = { entry with seen = now; closed_at = Some now }

let close_gone now sessions result =
  let dirty, entries =
    List.fold_left_map
      (fun dirty entry ->
        if Option.is_none entry.closed_at && compare_time entry.seen now <= 0
           && not (List.exists
                     (fun (session : observation) ->
                       same_incarnation entry.incarnation session.incarnation)
                     sessions)
        then (true, close_entry now entry)
        else (dirty, entry))
      result.dirty result.entries
  in
  { entries; dirty }

let rename entries incarnation now old_label new_label =
  let updated entry =
    { entry with
      aliases = aliases_with entry.aliases [ incarnation.name; old_label; new_label ];
      label = new_label;
      seen = now;
    }
  in
  let entries =
    match newest (matching incarnation entries) with
    | Some (index, entry) -> replace entries index (updated entry)
    | None -> entries @ [ updated (make_entry incarnation now Unbound []) ]
  in
  { entries; dirty = true }

let apply entries = function
  | Observe { listed = false; _ } -> { entries; dirty = false }
  | Observe { listed = true; now; sessions } ->
      List.fold_left (observe_one now) { entries; dirty = false } sessions
      |> close_gone now sessions
  | Rename { incarnation; now; old_label; new_label } ->
      rename entries incarnation now old_label new_label
  | Close { incarnation; now } ->
      let entries =
        List.map
          (fun (entry : entry) ->
            if same_incarnation entry.incarnation incarnation then close_entry now entry
            else entry)
          entries
      in
      { entries; dirty = true }
  | Forget conversation ->
      let kept = List.filter (fun entry -> entry.binding <> Exact conversation) entries in
      { entries = kept; dirty = List.length kept <> List.length entries }
