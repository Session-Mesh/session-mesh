(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

type backend = Codex | Claude
type setting = Model_flag | Model_config | Effort

let backend = function
  | "codex" -> Some Codex
  | "claude" -> Some Claude
  | _ -> None

let efforts = [ "low"; "medium"; "high" ]

let alphanumeric = function
  | 'a' .. 'z' | 'A' .. 'Z' | '0' .. '9' -> true
  | _ -> false

let valid_model text =
  String.length text > 0
  && String.length text <= 128
  && alphanumeric text.[0]
  && String.for_all
       (function '.' | '_' | ':' | '/' | '-' -> true | c -> alphanumeric c)
       text

let literal text =
  let text = String.trim text in
  let length = String.length text in
  if
    length >= 2
    && (text.[0] = '"' || text.[0] = '\'')
    && text.[0] = text.[length - 1]
  then String.sub text 1 (length - 2)
  else text

let codex_config value =
  match String.index_opt value '=' with
  | None -> None
  | Some i -> (
      let key = String.trim (String.sub value 0 i) in
      let value =
        literal (String.sub value (i + 1) (String.length value - i - 1))
      in
      match key with
      | "model" -> Some (Model_config, value)
      | "model_reasoning_effort" -> Some (Effort, value)
      | _ -> None)

let after prefix word =
  String.sub word (String.length prefix)
    (String.length word - String.length prefix)

(* Each list is one parsed option or positional. Its value can never be
   confused with a separate flag. *)
let setting backend = function
  | [ ("--model" | "-m"); value ] -> Some (Model_flag, value)
  | [ "--effort"; value ] when backend = Claude -> Some (Effort, value)
  | [ ("-c" | "--config"); value ] when backend = Codex -> codex_config value
  | [ word ] ->
      if String.starts_with ~prefix:"--model=" word then
        Some (Model_flag, after "--model=" word)
      else if backend = Claude && String.starts_with ~prefix:"--effort=" word
      then Some (Effort, after "--effort=" word)
      else if backend = Codex && String.starts_with ~prefix:"--config=" word
      then codex_config (after "--config=" word)
      else if backend = Codex && String.starts_with ~prefix:"-c" word then
        codex_config
          (after
             (if String.starts_with ~prefix:"-c=" word then "-c=" else "-c")
             word)
      else if
        backend = Codex
        && String.length word > 2
        && String.starts_with ~prefix:"-m" word
      then
        Some
          ( Model_flag,
            after
              (if String.starts_with ~prefix:"-m=" word then "-m=" else "-m")
              word )
      else None
  | _ -> None

let inspect backend options =
  let capture (model_flag, model_config, effort) option =
    match setting backend option with
    | Some (Model_flag, value) -> (Some value, model_config, effort)
    | Some (Model_config, value) -> (model_flag, Some value, effort)
    | Some (Effort, value) -> (model_flag, model_config, Some value)
    | None -> (model_flag, model_config, effort)
  in
  let model_flag, model_config, effort =
    List.fold_left capture (None, None, None) options
  in
  let model =
    match model_flag with Some _ -> model_flag | None -> model_config
  in
  let safe_setting = function
    | Some value when valid_model value -> Some value
    | _ -> None
  in
  (safe_setting model, safe_setting effort)

let apply backend ~model ~effort options =
  if model = None && effort = None then
    Error "Specify a model or reasoning effort"
  else if not (Option.fold ~none:true ~some:valid_model model) then
    Error "Invalid model"
  else if
    not
      (Option.fold ~none:true
         ~some:(fun value -> List.mem value efforts)
         effort)
  then Error "Unsupported reasoning effort"
  else
    let keep words =
      match setting backend words with
      | Some ((Model_flag | Model_config), _) -> model = None
      | Some (Effort, _) -> effort = None
      | None -> true
    in
    let model_args =
      match model with Some value -> [ "--model"; value ] | None -> []
    in
    let effort_args =
      match (backend, effort) with
      | _, None -> []
      | Claude, Some value -> [ "--effort"; value ]
      | Codex, Some value ->
          [ "-c"; "model_reasoning_effort=\"" ^ value ^ "\"" ]
    in
    Ok (List.concat (List.filter keep options) @ model_args @ effort_args)
