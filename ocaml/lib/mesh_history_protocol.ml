(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

module Store = Mesh_history_store
module J = Yojson.Safe
module U = Yojson.Safe.Util

let protocol_version = 1

type t = {
  open_store : unit -> (Store.t, Store.error) result;
  mutable store : Store.t option;
}

let create ~open_store = { open_store; store = None }
let ( let* ) = Result.bind

(* ---- decoding ---- *)

let bad message = Error { Store.code = "bad_request"; message }

let field name json = match json with `Assoc l -> List.assoc_opt name l | _ -> None

let required_string name json =
  match field name json with
  | Some (`String s) when s <> "" -> Ok s
  | _ -> bad (name ^ " must be a non-empty string")

let optional_string name ~default json =
  match field name json with
  | None | Some `Null -> Ok default
  | Some (`String s) -> Ok s
  | Some _ -> bad (name ^ " must be a string")

let optional_float name json =
  match field name json with
  | None | Some `Null -> Ok None
  | Some (`Int i) -> Ok (Some (float_of_int i))
  | Some (`Float f) -> Ok (Some f)
  | Some _ -> bad (name ^ " must be a number")

let optional_int name json =
  match field name json with
  | None | Some `Null -> Ok None
  | Some (`Int i) -> Ok (Some i)
  | Some (`Float f) when Float.is_integer f -> Ok (Some (int_of_float f))
  | Some _ -> bad (name ^ " must be an integer")

let optional_bool name json =
  match field name json with
  | None | Some `Null -> Ok false
  | Some (`Bool b) -> Ok b
  | Some _ -> bad (name ^ " must be a boolean")

let decode_meta json =
  match field "meta" json with
  | None | Some `Null -> Ok "{}"
  | Some (`Assoc _ as o) -> Ok (J.to_string o)
  | Some _ -> bad "meta must be an object"

let decode_conversation json =
  let* agent = required_string "agent" json in
  let* id = required_string "id" json in
  let* path = optional_string "path" ~default:"" json in
  let* cwd = optional_string "cwd" ~default:"" json in
  let* title = optional_string "title" ~default:"" json in
  let* summary = optional_string "summary" ~default:"" json in
  let* started = optional_float "started" json in
  let* updated = optional_float "updated" json in
  let* tokens = optional_int "tokens" json in
  let* meta = decode_meta json in
  Ok { Store.agent; id; path; cwd; title; started; updated; tokens; summary; meta }

let decode_chunk json =
  let* seq = optional_int "seq" json in
  let* role = optional_string "role" ~default:"" json in
  (* An empty text is a request to remove the chunk of that seq. *)
  let* text =
    match field "text" json with
    | Some (`String text) -> Ok text
    | _ -> bad "chunk text must be a string"
  in
  match seq with
  | Some seq -> Ok { Store.seq; role; text }
  | None -> bad "chunk seq must be an integer"

let decode_chunks json =
  match field "chunks" json with
  | None | Some `Null -> Ok []
  | Some (`List items) ->
      List.fold_right
        (fun item acc ->
          let* rest = acc in
          let* chunk = decode_chunk item in
          Ok (chunk :: rest))
        items (Ok [])
  | Some _ -> bad "chunks must be a list"

let decode_cursor json =
  match field "cursor" json with
  | None | Some `Null -> Ok None
  | Some c -> (
      let* offset = optional_int "offset" c in
      let* next_seq = optional_int "next_seq" c in
      let* epoch = optional_int "epoch" c in
      match (offset, next_seq) with
      | Some offset, Some next_seq ->
          Ok (Some { Store.offset; next_seq; epoch = Option.value epoch ~default:0 })
      | _ -> bad "cursor needs integer offset and next_seq")

(* ---- encoding ---- *)

let opt_float = function Some f -> `Float f | None -> `Null
let opt_int = function Some i -> `Int i | None -> `Null

let parse_meta text =
  match J.from_string text with `Assoc l -> l | _ -> [] | exception _ -> []

let listed_json ?(extra = []) (l : Store.listed) =
  let c = l.conversation in
  let core =
    [ ("agent", `String c.agent); ("id", `String c.id); ("path", `String c.path);
      ("cwd", `String c.cwd);
      ("title", `String c.title); ("started", opt_float c.started);
      ("updated", opt_float c.updated); ("tokens", opt_int c.tokens);
      ("has_summary", `Bool l.has_summary); ("gen", `Int l.gen) ]
    @ extra
  in
  (* The opaque meta fields complete the record but never override it. *)
  let free (k, _) = not (List.mem_assoc k core) in
  `Assoc (core @ List.filter free (parse_meta c.meta))

let hit_json (h : Store.hit) =
  `Assoc
    [ ("agent", `String h.agent); ("id", `String h.id); ("score", `Float h.score);
      ("snippet", `String h.snippet) ]

let error_json (e : Store.error) =
  `Assoc [ ("code", `String e.code); ("message", `String e.message) ]

(* ---- operations ---- *)

let op_ingest store json =
  let* conversation = decode_conversation json in
  let* chunks = decode_chunks json in
  let* gen = optional_int "gen" json in
  let* cursor = decode_cursor json in
  let* replace_chunks = optional_bool "replace_chunks" json in
  let* gen = Store.ingest store ?gen ?cursor ~replace_chunks conversation chunks in
  Ok [ ("gen", `Int gen) ]

let op_forget store json =
  let* agent = required_string "agent" json in
  let* id = required_string "id" json in
  let* gen = optional_int "gen" json in
  let* removed = Store.forget store ?gen ~agent ~id () in
  Ok [ ("removed", `Bool (removed <> None)); ("gen", opt_int removed) ]

let op_list store json =
  let* since = optional_int "since" json in
  let* current = optional_int "current" json in
  let* l = Store.list store ?current ~since () in
  Ok
    [ ("gen", `Int l.current); ("full", `Bool l.full);
      ("sessions", `List (List.map (fun s -> listed_json s) l.sessions));
      ("gone", `List (List.map (fun (a, i) -> `String (a ^ ":" ^ i)) l.gone)) ]

let op_detail store json =
  let* agent = required_string "agent" json in
  let* id = required_string "id" json in
  let* found = Store.detail store ~agent ~id in
  match found with
  | None -> Ok [ ("found", `Bool false) ]
  | Some (l, summary) ->
      let extra = [ ("summary", `String summary) ] in
      Ok [ ("found", `Bool true); ("session", listed_json ~extra l) ]

let op_search store json =
  let* query = optional_string "q" ~default:"" json in
  let* mode = optional_string "mode" ~default:"text" json in
  let* limit = optional_int "limit" json in
  if mode <> "text" then bad ("unsupported mode: " ^ mode)
  else
    let* hits = Store.search store ~query ~limit:(Option.value limit ~default:50) in
    Ok [ ("results", `List (List.map hit_json hits)) ]

let op_cursors store =
  let* rows = Store.cursors store in
  let row ((agent, id, path), (c : Store.cursor), gen) =
    `Assoc
      [ ("agent", `String agent); ("id", `String id); ("path", `String path);
        ("offset", `Int c.offset); ("next_seq", `Int c.next_seq); ("epoch", `Int c.epoch);
        ("gen", `Int gen) ]
  in
  Ok [ ("cursors", `List (List.map row rows)) ]

let op_stats store =
  let* s = Store.stats store in
  Ok
    [ ("conversations", `Int s.conversations); ("chunks", `Int s.chunks);
      ("gen", `Int s.generation) ]

let op_hello store =
  let* tokenizer = Store.tokenizer store in
  let* sqlite_version = Store.sqlite_version store in
  Ok
    [ ("protocol", `Int protocol_version); ("schema", `Int Store.schema_version);
      ("tokenizer", `String tokenizer); ("sqlite_version", `String sqlite_version);
      ("modes", `List [ `String "text" ]) ]

let dispatch store op json =
  match op with
  | "hello" -> op_hello store
  | "ingest" -> op_ingest store json
  | "forget" -> op_forget store json
  | "list" -> op_list store json
  | "detail" -> op_detail store json
  | "search" -> op_search store json
  | "cursors" -> op_cursors store
  | "stats" -> op_stats store
  | other -> bad ("unknown op: " ^ other)

(* ---- serving ---- *)

let ensure_store t =
  match t.store with
  | Some s -> Ok s
  | None ->
      let* s = t.open_store () in
      t.store <- Some s;
      Ok s

let respond id result =
  let head = match id with Some v -> [ ("req", v) ] | None -> [] in
  match result with
  | Ok fields -> `Assoc (head @ (("ok", `Bool true) :: fields))
  | Error e -> `Assoc (head @ [ ("ok", `Bool false); ("error", error_json e) ])

let run t json =
  match field "op" json with
  | Some (`String op) ->
      let* store = ensure_store t in
      dispatch store op json
  | _ -> bad "op must be a string"

let handle_line t line =
  match J.from_string line with
  | exception _ -> J.to_string (respond None (bad "request is not valid JSON"))
  | `Assoc _ as json -> J.to_string (respond (field "req" json) (run t json))
  | _ -> J.to_string (respond None (bad "request must be a JSON object"))

let serve t ic oc =
  let rec loop () =
    match In_channel.input_line ic with
    | None -> ()
    | Some line ->
        if String.trim line <> "" then begin
          output_string oc (handle_line t line);
          output_char oc '\n';
          flush oc
        end;
        loop ()
  in
  loop ()
