(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

module E = Work_mcp.Work_err
module T = Work_mcp.Work_text
open E

type target = Product of string | Project of string | Task of string

type command =
  | Products
  | Projects of { product : string option; all : bool }
  | Project_detail of string
  | Product_detail of string
  | Task_detail of string
  | Resume of { product : string option; project : string option; all : bool }
  | Sessions_of of target
  | Session_questions
  | Ids
  | Open_questions of { after : string option; limit : int }

let usage =
  "usage: work-read products | projects [--product P] [--all] | product P | project P-ID | task T-ID | resume \
   [--product P] [--project P-ID] [--all] | sessions-of (--product P | --project P-ID | --task T-ID) | \
   session-questions | ids | open-questions [--after N-ID] [--limit N]"

let max_value = 100
let is_hex c = (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')
let is_word c = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')

(* The prefix letter, a dash, then two to thirty-two hexadecimal digits: the
   forms the library resolves (exact id or prefix). *)
let valid_ref letter s =
  let n = String.length s in
  n >= 4 && n <= 34
  && Char.lowercase_ascii s.[0] = letter
  && s.[1] = '-'
  && String.for_all is_hex (String.sub s 2 (n - 2))

let valid_product s =
  s <> "" && is_word s.[0] && String.for_all (fun c -> is_word c || c = '.' || c = '_' || c = '-') s

let safe_value what s =
  if String.length s > max_value then Error (invalid "%s is longer than %d bytes" what max_value)
  else if (not (String.is_valid_utf_8 s)) || T.first_unsafe s <> None then
    Error (invalid "%s holds a control, bidirectional or invisible character" what)
  else Ok s

let check what ok s =
  let* s = safe_value what s in
  if ok s then Ok s else Error (invalid "%s is not valid: %s" what s)

let product_value = check "product" valid_product
let project_value = check "project" (valid_ref 'p')
let task_value = check "task" (valid_ref 't')

type flag_kind = Value | Switch

let looks_like_flag s = String.length s >= 2 && String.sub s 0 2 = "--"

(* Flags of a subcommand, each at most once. A value flag takes the next
   argument, which may not itself look like a flag. *)
let flags allowed args =
  let rec go seen acc = function
    | [] -> Ok (List.rev acc)
    | arg :: rest when looks_like_flag arg && String.length arg > 2 -> (
        let name = String.sub arg 2 (String.length arg - 2) in
        if List.mem name seen then Error (invalid "--%s is given twice" (T.clean name))
        else
          match List.assoc_opt name allowed with
          | None -> Error (invalid "unknown option --%s" (T.clean name))
          | Some Switch -> go (name :: seen) ((name, None) :: acc) rest
          | Some Value -> (
              match rest with
              | v :: rest' when not (looks_like_flag v) -> go (name :: seen) ((name, Some v) :: acc) rest'
              | _ -> Error (invalid "--%s needs a value" name)))
    | arg :: _ -> Error (invalid "unexpected argument %s" (T.clean (String.escaped arg)))
  in
  go [] [] args

let value_of parsed name check_value =
  match List.assoc_opt name parsed with
  | Some (Some v) -> Result.map Option.some (check_value v)
  | _ -> Ok None

let switch parsed name = List.mem_assoc name parsed

let projects args =
  let* parsed = flags [ ("product", Value); ("all", Switch) ] args in
  let* product = value_of parsed "product" product_value in
  Ok (Projects { product; all = switch parsed "all" })

let resume args =
  let* parsed = flags [ ("product", Value); ("project", Value); ("all", Switch) ] args in
  let* product = value_of parsed "product" product_value in
  let* project = value_of parsed "project" project_value in
  Ok (Resume { product; project; all = switch parsed "all" })

let question_value = check "after" Work_mcp.Work_questions.valid_id

(* A page size: one to {!Wr_open_questions.max_limit}, in decimal digits. *)
let limit_value s =
  let* s = safe_value "limit" s in
  match int_of_string_opt s with
  | Some n when String.for_all (fun c -> c >= '0' && c <= '9') s && n >= 1 && n <= Wr_open_questions.max_limit -> Ok n
  | _ -> Error (invalid "limit must be a number from 1 to %d" Wr_open_questions.max_limit)

let open_questions args =
  let* parsed = flags [ ("after", Value); ("limit", Value) ] args in
  let* after = value_of parsed "after" question_value in
  let* limit = value_of parsed "limit" limit_value in
  Ok (Open_questions { after; limit = Option.value limit ~default:Wr_open_questions.default_limit })

let sessions_of args =
  let* parsed = flags [ ("product", Value); ("project", Value); ("task", Value) ] args in
  let* product = value_of parsed "product" product_value in
  let* project = value_of parsed "project" project_value in
  let* task = value_of parsed "task" task_value in
  match (product, project, task) with
  | Some p, None, None -> Ok (Sessions_of (Product p))
  | None, Some p, None -> Ok (Sessions_of (Project p))
  | None, None, Some t -> Ok (Sessions_of (Task t))
  | None, None, None -> Error (invalid "give one of --product, --project or --task")
  | _ -> Error (invalid "give only one of --product, --project or --task")

let single what check_value make = function
  | [ v ] -> Result.map make (check_value v)
  | [] -> Error (invalid "%s needs an identifier" what)
  | _ -> Error (invalid "%s takes one identifier" what)

let parse = function
  | [] -> Error (invalid "%s" usage)
  | [ "products" ] -> Ok Products
  | "products" :: _ -> Error (invalid "products takes no argument")
  | "projects" :: rest -> projects rest
  | "product" :: rest -> single "product" product_value (fun id -> Product_detail id) rest
  | "project" :: rest -> single "project" project_value (fun id -> Project_detail id) rest
  | "task" :: rest -> single "task" task_value (fun id -> Task_detail id) rest
  | "resume" :: rest -> resume rest
  | "sessions-of" :: rest -> sessions_of rest
  | [ "session-questions" ] -> Ok Session_questions
  | "session-questions" :: _ -> Error (invalid "session-questions takes no argument")
  | [ "ids" ] -> Ok Ids
  | "ids" :: _ -> Error (invalid "ids takes no argument")
  | "open-questions" :: rest -> open_questions rest
  | cmd :: _ -> Error (invalid "unknown subcommand %s; %s" (T.clean (String.escaped cmd)) usage)
