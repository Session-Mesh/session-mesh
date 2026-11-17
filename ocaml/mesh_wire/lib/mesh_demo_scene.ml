(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

type error = Too_large | Malformed | Invalid

let max_bytes = 64 * 1024
let max_nodes = 100
let max_depth = 6
let max_states = 16
let max_choices = 32

let fields expected = function
  | `Assoc entries ->
      List.sort String.compare (List.map fst entries)
      = List.sort String.compare expected
  | _ -> false

let member name = function
  | `Assoc entries -> List.assoc name entries
  | _ -> assert false

let unicode_fold f initial text =
  Uutf.String.fold_utf_8
    (fun state _ character ->
      match (state, character) with
      | None, _ -> None
      | Some _, `Malformed _ -> None
      | Some state, `Uchar character -> Some (f state character))
    (Some initial) text

let text ?(nonblank = false) limit = function
  | `String value -> (
      match
        unicode_fold
          (fun (count, has_content, clean) character ->
            let scalar = Uchar.to_int character in
            ( count + 1,
              has_content || not (Uucp.White.is_white_space character),
              clean || (scalar < 32 && scalar <> 9 && scalar <> 10) ))
          (0, false, false) value
      with
      | Some (count, has_content, false) ->
          count <= limit && ((not nonblank) || has_content)
      | _ -> false)
  | _ -> false

let runtime_text ?(nonblank = false) limit = function
  | `String value when String.length value <= limit -> (
      match
        unicode_fold
          (fun (has_content, clean) character ->
            let forbidden =
              match Uucp.Gc.general_category character with
              | `Cc | `Cf | `Zl | `Zp -> true
              | _ -> false
            in
            ( has_content || not (Uucp.White.is_white_space character),
              clean && not forbidden ))
          (false, true) value
      with
      | Some (has_content, true) -> (not nonblank) || has_content
      | _ -> false)
  | _ -> false

let children = function `List values -> Some values | _ -> None

let short_id = function
  | `String value ->
      let length = String.length value in
      let alpha = function 'a' .. 'z' | 'A' .. 'Z' -> true | _ -> false in
      let rest = function
        | 'a' .. 'z' | 'A' .. 'Z' | '0' .. '9' | '_' | '-' -> true
        | _ -> false
      in
      length >= 1 && length <= 32
      && alpha value.[0]
      && String.for_all rest value
  | _ -> false

let validate_published ~expected_revision content =
  if String.length content > max_bytes then Error Too_large
  else if unicode_fold (fun () _ -> ()) () content = None then Error Malformed
  else
    let parsed =
      try Ok (Yojson.Safe.from_string content)
      with Yojson.Json_error _ | Stack_overflow -> Error Malformed
    in
    match parsed with
    | Error error -> Error error
    | Ok document ->
        let count = ref 0 in
        let rec node ~interactive ~view_version depth raw =
          incr count;
          if !count > max_nodes || depth > max_depth then false
          else
            match raw with
            | `Assoc entries -> (
                match List.assoc_opt "type" entries with
                | Some (`String ("heading" | "text" | "badge" | "shape")) ->
                    fields [ "type"; "text" ] raw
                    && (if interactive && view_version = 2 then runtime_text
                        else text)
                         2000 (member "text" raw)
                | Some (`String "divider") -> fields [ "type" ] raw
                | Some (`String "gear") when interactive && view_version = 2
                  -> (
                    match member "angle" raw with
                    | `Int angle ->
                        fields [ "type"; "angle" ] raw
                        && angle >= 0 && angle <= 359
                    | _ -> false)
                | Some (`String "disclosure") when not interactive ->
                    fields [ "type"; "summary"; "children" ] raw
                    && text ~nonblank:true 120 (member "summary" raw)
                    && nested ~interactive ~view_version depth
                         (member "children" raw)
                | Some (`String "checklist") when not interactive -> (
                    match children (member "items" raw) with
                    | Some values ->
                        fields [ "type"; "items" ] raw
                        && List.length values >= 1
                        && List.length values <= 20
                        && List.for_all
                             (fun value -> text ~nonblank:true 120 value)
                             values
                    | None -> false)
                | Some (`String "progress") when not interactive -> (
                    match (member "label" raw, member "value" raw) with
                    | `String label, `Int value ->
                        fields [ "type"; "label"; "value" ] raw
                        && text ~nonblank:true 120 (`String label)
                        && value >= 0 && value <= 100
                    | _ -> false)
                | Some (`String "metric") when not interactive -> (
                    match (member "label" raw, member "value" raw) with
                    | `String label, `String value ->
                        fields [ "type"; "label"; "value" ] raw
                        && text ~nonblank:true 120 (`String label)
                        && text ~nonblank:true 120 (`String value)
                    | _ -> false)
                | Some (`String "status") when not interactive -> (
                    match (member "label" raw, member "state" raw) with
                    | ( `String label,
                        `String ("info" | "success" | "warning" | "danger") ) ->
                        fields [ "type"; "label"; "state" ] raw
                        && text ~nonblank:true 120 (`String label)
                    | _ -> false)
                | Some (`String ("card" | "row" | "column")) ->
                    fields [ "type"; "children" ] raw
                    && nested ~interactive ~view_version depth
                         (member "children" raw)
                | _ -> false)
            | _ -> false
        and nested ~interactive ~view_version depth raw =
          match children raw with
          | Some values ->
              List.length values <= 30
              && List.for_all
                   (node ~interactive ~view_version (depth + 1))
                   values
          | None -> false
        in
        let valid_v0 () =
          fields [ "format"; "version"; "title"; "theme"; "nodes" ] document
          && member "format" document = `String "mesh-scene-v0"
          && member "version" document = `Int expected_revision
          && expected_revision > 0
          && text 120 (member "title" document)
          && (match member "theme" document with
            | `String ("dark" | "light") -> true
            | _ -> false)
          &&
          match children (member "nodes" document) with
          | Some values ->
              List.length values <= 30
              && List.for_all (node ~interactive:false ~view_version:0 0) values
          | None -> false
        in
        let valid_interactive scene_version =
          let view_text = if scene_version = 2 then runtime_text else text in
          if
            not
              (fields
                 [ "format"; "version"; "title"; "theme"; "initial"; "states" ]
                 document
              && member "format" document
                 = `String ("mesh-scene-v" ^ string_of_int scene_version)
              && member "version" document = `Int expected_revision
              && expected_revision > 0
              && view_text 120 (member "title" document)
              && short_id (member "initial" document)
              &&
              match member "theme" document with
              | `String ("dark" | "light") -> true
              | _ -> false)
          then false
          else
            match children (member "states" document) with
            | None -> false
            | Some states ->
                let choice_count = ref 0 in
                let state_id = function
                  | `Assoc entries -> (
                      match List.assoc_opt "id" entries with
                      | Some (`String id as value) when short_id value ->
                          Some id
                      | _ -> None)
                  | _ -> None
                in
                let ids = List.filter_map state_id states in
                let unique = List.sort_uniq String.compare ids in
                let valid_choice = function
                  | `Assoc _ as choice -> (
                      fields [ "label"; "target" ] choice
                      && view_text ~nonblank:true 120 (member "label" choice)
                      && short_id (member "target" choice)
                      &&
                      match member "target" choice with
                      | `String target -> List.mem target ids
                      | _ -> false)
                  | _ -> false
                in
                let valid_state = function
                  | `Assoc _ as state -> (
                      if
                        not
                          (fields [ "id"; "view"; "choices" ] state
                          && short_id (member "id" state))
                      then false
                      else
                        match (member "view" state, member "choices" state) with
                        | (`Assoc _ as view), `List choices ->
                            choice_count := !choice_count + List.length choices;
                            fields [ "format"; "nodes" ] view
                            && member "format" view
                               = `String
                                   ("mesh-view-v" ^ string_of_int scene_version)
                            && (match member "nodes" view with
                              | `List nodes ->
                                  List.length nodes <= 30
                                  && List.for_all
                                       (node ~interactive:true
                                          ~view_version:scene_version 0)
                                       nodes
                              | _ -> false)
                            && List.for_all valid_choice choices
                        | _ -> false)
                  | _ -> false
                in
                List.length states >= 1
                && List.length states <= max_states
                && List.length ids = List.length states
                && List.length unique = List.length ids
                && (match member "initial" document with
                  | `String initial -> List.mem initial ids
                  | _ -> false)
                && List.for_all valid_state states
                && !choice_count <= max_choices
        in
        if valid_v0 () || valid_interactive 1 || valid_interactive 2 then Ok ()
        else Error Invalid
