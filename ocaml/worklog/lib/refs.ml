(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

open Model

let is_hex s =
  s <> "" && String.for_all (fun c -> (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f')) s

let strip_prefix ~prefix s =
  let n = String.length prefix in
  if String.length s >= n && String.lowercase_ascii (String.sub s 0 n) = prefix then
    Some (String.sub s n (String.length s - n))
  else None

let hex_part ~prefix ~noun ref_ =
  let ref_ = String.trim ref_ in
  let hex =
    String.lowercase_ascii (Option.value (strip_prefix ~prefix ref_) ~default:ref_)
  in
  if String.length hex >= 2 && is_hex hex then hex
  else
    Err.fail Err.Usage
      (Printf.sprintf "invalid %s reference %S (expected %s<hex>, at least 2 hex digits)" noun
         ref_ (String.uppercase_ascii prefix))

let hex_of id = String.sub id 2 (String.length id - 2)

let resolve ~prefix ~noun ids ref_ =
  Err.protect (fun () ->
      let want = hex_part ~prefix ~noun ref_ in
      match List.find_opt (fun id -> hex_of id = want) ids with
      | Some id -> id
      | None -> (
          let starts id =
            let h = hex_of id in
            String.length h >= String.length want && String.sub h 0 (String.length want) = want
          in
          match List.filter starts ids with
          | [ id ] -> id
          | [] -> Err.not_found "no %s matches %S" noun ref_
          | many ->
              Err.not_found "ambiguous %s reference %S; candidates: %s" noun ref_
                (String.concat ", " many)))

let wrong_namespace ~prefix ~this ~other ref_ =
  match strip_prefix ~prefix ref_ with
  | Some rest when is_hex (String.lowercase_ascii rest) ->
      Some
        (Err.make Err.Not_found
           (Printf.sprintf "%S is a %s id, not a %s (namespaces are separate)" ref_ other this))
  | _ -> None

let task world ref_ =
  match wrong_namespace ~prefix:"p-" ~this:"task" ~other:"project" (String.trim ref_) with
  | Some e -> Error e
  | None -> resolve ~prefix:"t-" ~noun:"task" (List.map fst (Smap.bindings world.tasks)) ref_

let project world ref_ =
  match wrong_namespace ~prefix:"t-" ~this:"project" ~other:"task" (String.trim ref_) with
  | Some e -> Error e
  | None ->
      resolve ~prefix:"p-" ~noun:"project" (List.map fst (Smap.bindings world.projects)) ref_

let describe_blocker b =
  Printf.sprintf "  %s [%s] on %s: %s" b.blocker_id b.kind
    (Option.value b.on ~default:"-") b.text

let blocker (t : task) ref_ =
  Err.protect (fun () ->
      let want = "B-" ^ String.lowercase_ascii (Option.value (strip_prefix ~prefix:"b-" ref_) ~default:ref_) in
      let matches =
        List.filter
          (fun b ->
            let n = String.length want in
            String.length b.blocker_id >= n && String.sub b.blocker_id 0 n = want)
          t.blockers
      in
      let exact = List.filter (fun b -> b.blocker_id = want) matches in
      match if exact <> [] then exact else matches with
      | [] -> Err.not_found "%s has no blocker %S" t.id ref_
      | [ b ] when b.resolved <> None ->
          Err.not_found "blocker %s of %s is already resolved" b.blocker_id t.id
      | [ b ] -> b
      | many ->
          Err.not_found "ambiguous blocker %S; candidates:\n%s" ref_
            (String.concat "\n" (List.map describe_blocker many)))

let open_blocker (t : task) = function
  | Some ref_ -> blocker t ref_
  | None -> (
      match List.filter (fun b -> b.resolved = None) t.blockers with
      | [ b ] -> Ok b
      | [] -> Error (Err.make Err.Not_found (t.id ^ " has no open blocker"))
      | many ->
          Error
            (Err.make Err.Not_found
               (Printf.sprintf "%s has %d open blockers; name one:\n%s" t.id (List.length many)
                  (String.concat "\n" (List.map describe_blocker many)))))
