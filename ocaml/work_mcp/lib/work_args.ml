(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

open Work_err

let field j k = match j with `Assoc l -> List.assoc_opt k l | _ -> None
let wrong k what = Error (invalid "%s must be %s" k what)

let opt_string j k =
  match field j k with
  | None -> Ok None
  | Some (`String s) -> Ok (Some s)
  | Some _ -> wrong k "a string"

let string j k =
  let* v = opt_string j k in
  match v with Some s -> Ok s | None -> Error (invalid "%s is required" k)

let opt_int j k =
  match field j k with
  | None -> Ok None
  | Some (`Int n) -> Ok (Some n)
  | Some _ -> wrong k "an integer"

let opt_bool j k =
  match field j k with
  | None -> Ok None
  | Some (`Bool b) -> Ok (Some b)
  | Some _ -> wrong k "a boolean"

let strings_of k = function
  | `List l ->
      List.fold_right
        (fun v acc ->
          let* acc = acc in
          match v with `String s -> Ok (s :: acc) | _ -> wrong k "a list of strings")
        l (Ok [])
  | _ -> wrong k "a list of strings"

let opt_strings j k =
  match field j k with None -> Ok None | Some v -> Result.map Option.some (strings_of k v)

let strings j k = Result.map (Option.value ~default:[]) (opt_strings j k)

let opt_assoc j k =
  match field j k with
  | None -> Ok []
  | Some (`Assoc l) -> Ok l
  | Some _ -> wrong k "an object"

let limit j ~default ~max =
  let* n = opt_int j "limit" in
  match n with
  | None -> Ok default
  | Some n when n >= 1 && n <= max -> Ok n
  | Some _ -> Error (invalid "limit must be between 1 and %d" max)

(* Free text never carries a control character other than newline and tab: a
   terminal escape or a NUL stored in the data would be returned to every
   reader. The check covers every string of the arguments, at any depth. *)
let reject_unsafe_text args =
  let refuse where = function
    | Work_text.Control ->
        Error (invalid "%s contains a control character (only newline and tab are allowed in text)" where)
    | Work_text.Invisible ->
        Error
          (invalid
             "%s contains an invisible or bidirectional character (zero-width, bidi control, line separator or tag character); remove it"
             where)
  in
  let judge where s = match Work_text.first_unsafe s with Some kind -> refuse where kind | None -> Ok () in
  let rec check path = function
    | `String s -> judge (if path = "" then "an argument" else path) s
    | `List items -> List.fold_left (fun acc v -> let* () = acc in check path v) (Ok ()) items
    | `Assoc members ->
        List.fold_left
          (fun acc (k, v) ->
            let* () = acc in
            let* () = judge "a field name" k in
            check (if path = "" then k else path ^ "." ^ k) v)
          (Ok ()) members
    | _ -> Ok ()
  in
  check "" args
