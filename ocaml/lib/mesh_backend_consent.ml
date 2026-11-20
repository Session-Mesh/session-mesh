(******************************************************************************)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                  *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                            *)
(******************************************************************************)

type confirmation = Ask | Skip
type choice = Once | Remember_pair | Remember_global
type basis = Default | Global | Pair_ask | Pair_never

type error =
  | Invalid_policy
  | Invalid_account
  | Invalid_pair
  | Conflict
  | Revision_exhausted
  | Capacity

type account = {
  backend : Mesh_backend_profile.backend;
  id : string;
  context_revision : string;
}

type rule = { a : account; b : account; confirmation : confirmation }
type t = { revision : int; global : confirmation; pairs : rule list }
type decision = { confirmation : confirmation; basis : basis; revision : int }

let ( let* ) = Result.bind
let max_revision = 9007199254740991

let error_code = function
  | Invalid_policy -> "invalid-consent-policy"
  | Invalid_account -> "invalid-account-reference"
  | Invalid_pair -> "invalid-account-pair"
  | Conflict -> "consent-revision-conflict"
  | Revision_exhausted -> "consent-revision-exhausted"
  | Capacity -> "consent-rule-capacity"

let account ~backend ~id ~context_revision =
  if
    Mesh_backend_profile.valid_id id
    && String.length context_revision = 64
    && String.for_all
         (function '0' .. '9' | 'a' .. 'f' -> true | _ -> false)
         context_revision
  then Ok { backend; id; context_revision }
  else Error Invalid_account

let empty () = { revision = 0; global = Ask; pairs = [] }
let revision (state : t) = state.revision

let pair source target =
  if source.backend <> target.backend || source.id = target.id then
    Error Invalid_pair
  else if String.compare source.id target.id < 0 then Ok (source, target)
  else Ok (target, source)

let same rule a b =
  rule.a.backend = a.backend && rule.b.backend = b.backend && rule.a.id = a.id
  && rule.b.id = b.id

let decide state ~source ~target =
  let* a, b = pair source target in
  let confirmation, basis =
    match List.find_opt (fun r -> same r a b) state.pairs with
    | Some { confirmation = Ask; _ } -> (Ask, Pair_ask)
    | Some r
      when r.a.context_revision = a.context_revision
           && r.b.context_revision = b.context_revision ->
        (Skip, Pair_never)
    | _ -> (state.global, if state.global = Skip then Global else Default)
  in
  Ok { confirmation; basis; revision = state.revision }

let expected (state : t) revision =
  if state.revision = revision then Ok () else Error Conflict

let advance (state : t) ~expected_revision =
  let* () = expected state expected_revision in
  if state.revision = max_revision then Error Revision_exhausted
  else Ok (state.revision + 1)

let set_global state ~expected_revision ~confirmation =
  let* revision = advance state ~expected_revision in
  Ok { state with revision; global = confirmation }

let set_pair state ~expected_revision ~source ~target ~confirmation =
  let* revision = advance state ~expected_revision in
  let* a, b = pair source target in
  let others = List.filter (fun r -> not (same r a b)) state.pairs in
  if List.length others >= 1024 then Error Capacity
  else Ok { state with revision; pairs = { a; b; confirmation } :: others }

let remove_pair state ~expected_revision ~source ~target =
  let* revision = advance state ~expected_revision in
  let* a, b = pair source target in
  Ok
    {
      state with
      revision;
      pairs = List.filter (fun r -> not (same r a b)) state.pairs;
    }

let remove_pair_ids state ~expected_revision ~backend ~source_id ~target_id =
  let* revision = advance state ~expected_revision in
  if
    (not (Mesh_backend_profile.valid_id source_id))
    || (not (Mesh_backend_profile.valid_id target_id))
    || source_id = target_id
  then Error Invalid_pair
  else
    let a, b =
      if String.compare source_id target_id < 0 then (source_id, target_id)
      else (target_id, source_id)
    in
    Ok
      {
        state with
        revision;
        pairs =
          List.filter
            (fun r -> r.a.backend <> backend || r.a.id <> a || r.b.id <> b)
            state.pairs;
      }

let reset state ~expected_revision =
  let* revision = advance state ~expected_revision in
  Ok { revision; global = Ask; pairs = [] }

let commit_choice state ~expected_revision ~source ~target choice =
  let* () = expected state expected_revision in
  let* _ = pair source target in
  match choice with
  | Once -> Ok state
  | Remember_pair ->
      set_pair state ~expected_revision ~source ~target ~confirmation:Skip
  | Remember_global -> set_global state ~expected_revision ~confirmation:Skip

let encoded_confirmation = function
  | Ask -> `String "ask"
  | Skip -> `String "skip"

let encoded_account a =
  let backend =
    match a.backend with
    | Mesh_backend_profile.Claude -> "claude"
    | Codex -> "codex"
    | Opencode_v2 -> "opencode-v2"
    | Pi -> "pi"
  in
  `Assoc
    [
      ("backend", `String backend);
      ("id", `String a.id);
      ("context_revision", `String a.context_revision);
    ]

let to_string state =
  let pairs =
    List.sort
      (fun x y ->
        compare (x.a.backend, x.a.id, x.b.id) (y.a.backend, y.a.id, y.b.id))
      state.pairs
  in
  Yojson.Safe.to_string
    (`Assoc
       [
         ("version", `Int 1);
         ("revision", `Int state.revision);
         ("global", encoded_confirmation state.global);
         ( "pairs",
           `List
             (List.map
                (fun r ->
                  `Assoc
                    [
                      ("a", encoded_account r.a);
                      ("b", encoded_account r.b);
                      ("confirmation", encoded_confirmation r.confirmation);
                    ])
                pairs) );
       ])

let keys names = function
  | `Assoc fields
    when List.length fields = List.length names
         && List.sort_uniq String.compare (List.map fst fields)
            = List.sort String.compare names ->
      Ok fields
  | _ -> Error Invalid_policy

let field name fields =
  match List.assoc_opt name fields with
  | Some v -> Ok v
  | None -> Error Invalid_policy

let confirmation = function
  | `String "ask" -> Ok Ask
  | `String "skip" -> Ok Skip
  | _ -> Error Invalid_policy

let decode_account value =
  let* fields = keys [ "backend"; "id"; "context_revision" ] value in
  let* raw_backend = field "backend" fields in
  let* backend =
    match raw_backend with
    | `String "claude" -> Ok Mesh_backend_profile.Claude
    | `String "codex" -> Ok Mesh_backend_profile.Codex
    | `String "opencode-v2" -> Ok Mesh_backend_profile.Opencode_v2
    | `String "pi" -> Ok Mesh_backend_profile.Pi
    | _ -> Error Invalid_policy
  in
  let* id = field "id" fields in
  let* revision = field "context_revision" fields in
  match (id, revision) with
  | `String id, `String context_revision ->
      Result.map_error
        (fun _ -> Invalid_policy)
        (account ~backend ~id ~context_revision)
  | _ -> Error Invalid_policy

let decode_rule value =
  let* fields = keys [ "a"; "b"; "confirmation" ] value in
  let* raw_a = field "a" fields in
  let* a = decode_account raw_a in
  let* raw_b = field "b" fields in
  let* b = decode_account raw_b in
  let* raw_c = field "confirmation" fields in
  let* confirmation = confirmation raw_c in
  let* a, b = Result.map_error (fun _ -> Invalid_policy) (pair a b) in
  Ok { a; b; confirmation }

let of_json value =
  let* fields = keys [ "version"; "revision"; "global"; "pairs" ] value in
  let* version = field "version" fields in
  if version <> `Int 1 then Error Invalid_policy
  else
    let* raw_revision = field "revision" fields in
    let* revision =
      match raw_revision with
      | `Int n when n >= 0 && n <= max_revision -> Ok n
      | _ -> Error Invalid_policy
    in
    let* raw_global = field "global" fields in
    let* global = confirmation raw_global in
    let* raw_pairs = field "pairs" fields in
    let* rows =
      match raw_pairs with
      | `List rows when List.length rows <= 1024 -> Ok rows
      | _ -> Error Invalid_policy
    in
    let rec loop acc = function
      | [] -> Ok { revision; global; pairs = List.rev acc }
      | raw :: rest ->
          let* rule = decode_rule raw in
          if List.exists (fun r -> same r rule.a rule.b) acc then
            Error Invalid_policy
          else loop (rule :: acc) rest
    in
    loop [] rows

let of_string bytes =
  if String.length bytes > 1048576 then Error Invalid_policy
  else
    try of_json (Yojson.Safe.from_string bytes)
    with Yojson.Json_error _ -> Error Invalid_policy
