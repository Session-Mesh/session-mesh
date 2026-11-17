(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

module Sql = Mesh_history_sql

type error = { code : string; message : string }
type conn = (module Caqti_blocking.CONNECTION)
type t = { conn : conn }

let schema_version = 2
let tombstones_kept = 10_000
let ( let* ) = Result.bind

(* ---- errors ---- *)

let contains haystack needle =
  let n = String.length needle and h = String.length haystack in
  let rec at i = i + n <= h && (String.sub haystack i n = needle || at (i + 1)) in
  at 0

let classify message =
  let lower = String.lowercase_ascii message in
  let any words = List.exists (contains lower) words in
  if any [ "database is locked"; "busy"; "locked" ] then "busy"
  else if any [ "malformed"; "not a database"; "corrupt"; "file is encrypted" ] then "corrupt"
  else "db"

let error_of_message message = { code = classify message; message }
let bad_request message = { code = "bad_request"; message }

let lift result =
  Result.map_error (fun e -> error_of_message (Caqti_error.show e)) result

(* Any exception (an encoding failure inside a driver, say) becomes an error:
   a bad request must never take the process down. *)
let guard f =
  try f () with
  | (Out_of_memory | Stack_overflow) as e -> raise e
  | e -> Error (error_of_message (Printexc.to_string e))

let transact t f =
  let (module C : Caqti_blocking.CONNECTION) = t.conn in
  let* () = lift (C.start ()) in
  match guard f with
  | Ok v -> (
      match lift (C.commit ()) with
      | Ok () -> Ok v
      | Error _ as e ->
          ignore (C.rollback ());
          e)
  | Error _ as e ->
      ignore (C.rollback ());
      e

(* ---- migrations ---- *)

(* remove_diacritics 2 needs SQLite 3.27; older libraries (the manylinux_2_28
   one is 3.26) only know 1, which also folds French accents. *)
let tokenizers = [ "unicode61 remove_diacritics 2"; "unicode61 remove_diacritics 1" ]

let create_fts_table (module C : Caqti_blocking.CONNECTION) =
  let rec attempt = function
    | [] -> Error (error_of_message "no usable FTS5 tokenizer")
    | tokenizer :: rest -> (
        match C.exec (Sql.create_fts tokenizer) () with
        | Ok () -> Ok tokenizer
        | Error _ when rest <> [] -> attempt rest
        | Error e -> Error (error_of_message ("FTS5 unavailable: " ^ Caqti_error.show e)))
  in
  attempt tokenizers

let exec_all (module C : Caqti_blocking.CONNECTION) requests =
  List.fold_left
    (fun acc req -> let* () = acc in lift (C.exec req ()))
    (Ok ()) requests

let migration_1 t =
  let (module C : Caqti_blocking.CONNECTION) = t.conn in
  let* () =
    exec_all t.conn
      ([ Sql.create_state; Sql.create_conversations ] @ Sql.conversation_indexes
     @ [ Sql.create_tombstones ] @ Sql.tombstone_indexes @ [ Sql.create_chunks ])
  in
  let* tokenizer = create_fts_table t.conn in
  let* () = exec_all t.conn Sql.fts_triggers in
  (* Generations start at 0: a caller that owns the sequence passes its own. *)
  lift (C.exec Sql.init_state (0, 0, tokenizer))

(* Version 2: the epoch of the source the cursor stands for (how often the producer read it again from the start). *)
let migration_2 t = exec_all t.conn [ Sql.add_epoch ]

(* Later versions are appended here, e.g. a vector table for semantic search. *)
let migrations = [ (1, migration_1); (2, migration_2) ]

let apply_migration t (version, run) =
  let (module C : Caqti_blocking.CONNECTION) = t.conn in
  transact t (fun () ->
      let* () = run t in
      lift (C.exec Sql.record_migration (version, int_of_float (Unix.time ()))))

let migrate t =
  let (module C : Caqti_blocking.CONNECTION) = t.conn in
  let* () = lift (C.exec Sql.migrations_table ()) in
  let* applied = lift (C.collect_list Sql.applied_versions ()) in
  let newest = List.fold_left max 0 applied in
  if newest > schema_version then
    Error
      (bad_request
         (Printf.sprintf "database schema %d is newer than this build (%d)" newest schema_version))
  else
    List.fold_left
      (fun acc ((version, _) as m) ->
        let* () = acc in
        if List.mem version applied then Ok () else apply_migration t m)
      (Ok ()) migrations

(* ---- opening ---- *)

let ensure_private_file path =
  try
    let fd = Unix.openfile path [ Unix.O_RDWR; Unix.O_CREAT ] 0o600 in
    Unix.close fd;
    Ok ()
  with Unix.Unix_error (e, _, _) ->
    Error { code = "db"; message = path ^ ": " ^ Unix.error_message e }

let configure t ~busy_timeout_ms =
  let (module C : Caqti_blocking.CONNECTION) = t.conn in
  let* _ = lift (C.collect_list (Sql.set_busy_timeout busy_timeout_ms) ()) in
  let* _ = lift (C.collect_list Sql.set_wal ()) in
  lift (C.exec Sql.set_synchronous_normal ())

let close t =
  let (module C : Caqti_blocking.CONNECTION) = t.conn in
  C.disconnect ()

let open_ ?(busy_timeout_ms = 5000) ~path () =
  guard (fun () ->
      let* () = ensure_private_file path in
      let uri = Uri.make ~scheme:"sqlite3" ~path () in
      let* conn = lift (Caqti_blocking.connect uri) in
      let t = { conn } in
      match
        let* () = configure t ~busy_timeout_ms in
        migrate t
      with
      | Ok () -> Ok t
      | Error _ as e ->
          close t;
          e)

let applied_versions t =
  let (module C : Caqti_blocking.CONNECTION) = t.conn in
  guard (fun () -> lift (C.collect_list Sql.applied_versions ()))

let tokenizer t =
  let (module C : Caqti_blocking.CONNECTION) = t.conn in
  guard (fun () -> lift (C.find Sql.tokenizer ()))

let sqlite_version t =
  let (module C : Caqti_blocking.CONNECTION) = t.conn in
  guard (fun () -> lift (C.find Sql.sqlite_version ()))

(* ---- data ---- *)

type conversation = {
  agent : string;
  id : string;
  path : string;
  cwd : string;
  title : string;
  started : float option;
  updated : float option;
  tokens : int option;
  summary : string;
  meta : string;
}

type chunk = { seq : int; role : string; text : string }
type cursor = { offset : int; next_seq : int; epoch : int }

let next_generation t given =
  let (module C : Caqti_blocking.CONNECTION) = t.conn in
  let* gen =
    match given with
    | Some g -> Ok g
    | None ->
        let* current, _ = lift (C.find Sql.read_state ()) in
        Ok (current + 1)
  in
  let* () = lift (C.exec Sql.raise_gen gen) in
  Ok gen

let store_conversation t (c : conversation) gen =
  let (module C : Caqti_blocking.CONNECTION) = t.conn in
  let* () =
    lift
      (C.exec Sql.upsert_conversation
         ( c.agent, c.id, c.path, c.cwd, c.title, c.started, c.updated, c.tokens, c.summary,
           c.meta, gen ))
  in
  let* () = lift (C.exec Sql.drop_tombstones (c.agent, c.id)) in
  let* cid = lift (C.find_opt Sql.find_cid (c.agent, c.id)) in
  Option.to_result ~none:(error_of_message "conversation vanished") cid

let store_chunks t cid (c : conversation) ~replace chunks =
  let (module C : Caqti_blocking.CONNECTION) = t.conn in
  let* () = if replace then lift (C.exec Sql.drop_text_chunks cid) else Ok () in
  let* () =
    if c.title = "" then lift (C.exec Sql.drop_title_chunk cid)
    else lift (C.exec Sql.upsert_chunk (cid, -1, "title", c.title))
  in
  List.fold_left
    (fun acc (k : chunk) ->
      let* () = acc in
      if k.text = "" then lift (C.exec Sql.drop_chunk (cid, k.seq))
      else lift (C.exec Sql.upsert_chunk (cid, k.seq, k.role, k.text)))
    (Ok ()) chunks

let ingest t ?gen ?cursor ?(replace_chunks = false) (c : conversation) chunks =
  let (module C : Caqti_blocking.CONNECTION) = t.conn in
  if List.exists (fun (k : chunk) -> k.seq < 0) chunks then
    Error (bad_request "chunk seq must be non-negative")
  else
    guard (fun () ->
        transact t (fun () ->
            let* gen = next_generation t gen in
            let* cid = store_conversation t c gen in
            let* () = store_chunks t cid c ~replace:replace_chunks chunks in
            let* () =
              match cursor with
              | None -> Ok ()
              | Some k -> lift (C.exec Sql.set_cursor (k.offset, k.next_seq, k.epoch, cid))
            in
            Ok gen))

let prune_tombstones t =
  let (module C : Caqti_blocking.CONNECTION) = t.conn in
  let* () = lift (C.exec Sql.prune_floor tombstones_kept) in
  lift (C.exec Sql.prune_tombstones tombstones_kept)

let forget t ?gen ~agent ~id () =
  let (module C : Caqti_blocking.CONNECTION) = t.conn in
  guard (fun () ->
      transact t (fun () ->
          let* found = lift (C.find_opt Sql.find_cid (agent, id)) in
          match found with
          | None -> Ok None
          | Some cid ->
              let* gen = next_generation t gen in
              let* () = lift (C.exec Sql.drop_all_chunks cid) in
              let* () = lift (C.exec Sql.drop_conversation cid) in
              let* () = lift (C.exec Sql.add_tombstone (gen, agent, id)) in
              let* () = prune_tombstones t in
              Ok (Some gen)))

(* ---- reading ---- *)

type listed = { conversation : conversation; has_summary : bool; gen : int }

type listing = {
  current : int;
  full : bool;
  sessions : listed list;
  gone : (string * string) list;
}

let listed_of_row (r : Sql.conv_row) =
  {
    conversation =
      { agent = r.agent; id = r.id; path = r.path; cwd = r.cwd; title = r.title;
        started = r.started; updated = r.updated; tokens = r.tokens; summary = "";
        meta = r.meta };
    has_summary = r.summary_len > 0;
    gen = r.gen;
  }

let list t ?current ~since () =
  let (module C : Caqti_blocking.CONNECTION) = t.conn in
  guard (fun () ->
      let* stored, floor = lift (C.find Sql.read_state ()) in
      let current = Option.value current ~default:stored in
      let full = match since with None -> true | Some s -> s < floor || s > current in
      let* rows =
        match since with
        | Some s when not full -> lift (C.collect_list Sql.list_since s)
        | _ -> lift (C.collect_list Sql.list_all ())
      in
      let* gone =
        match since with
        | Some s when not full -> lift (C.collect_list Sql.gone_since s)
        | _ -> Ok []
      in
      Ok { current; full; sessions = List.map listed_of_row rows; gone })

let detail t ~agent ~id =
  let (module C : Caqti_blocking.CONNECTION) = t.conn in
  guard (fun () ->
      let* row = lift (C.find_opt Sql.one_conversation (agent, id)) in
      match row with
      | None -> Ok None
      | Some r ->
          let* summary = lift (C.find_opt Sql.summary_of (agent, id)) in
          Ok (Some (listed_of_row r, Option.value summary ~default:"")))

let cursors t =
  let (module C : Caqti_blocking.CONNECTION) = t.conn in
  guard (fun () ->
      let* rows = lift (C.collect_list Sql.all_cursors ()) in
      Ok
        (List.map
           (fun (agent, id, path, offset, next_seq, gen, epoch) ->
             ((agent, id, path), { offset; next_seq; epoch }, gen))
           rows))

(* ---- search ---- *)

type hit = { agent : string; id : string; score : float; snippet : string }

let max_limit = 200

(* One hit per conversation: the rows come best first, so the first row of a
   conversation is its best chunk. Chunk rows outnumber conversations, so
   more are fetched than asked for. *)
let dedupe ~limit rows =
  let seen = Hashtbl.create 64 in
  let rec go acc n = function
    | _ when n >= limit -> List.rev acc
    | [] -> List.rev acc
    | (agent, id, bm25, snippet) :: rest ->
        if Hashtbl.mem seen (agent, id) then go acc n rest
        else begin
          Hashtbl.add seen (agent, id) ();
          go ({ agent; id; score = -.bm25; snippet } :: acc) (n + 1) rest
        end
  in
  go [] 0 rows

let search t ~query ~limit =
  let (module C : Caqti_blocking.CONNECTION) = t.conn in
  let limit = max 1 (min max_limit limit) in
  match Mesh_history_query.match_expression query with
  | None -> Ok []
  | Some expression ->
      guard (fun () ->
          let* rows = lift (C.collect_list Sql.search (expression, limit * 10)) in
          Ok (dedupe ~limit rows))

type stats = { conversations : int; chunks : int; generation : int }

let stats t =
  let (module C : Caqti_blocking.CONNECTION) = t.conn in
  guard (fun () ->
      let* conversations = lift (C.find Sql.count_conversations ()) in
      let* chunks = lift (C.find Sql.count_chunks ()) in
      let* generation, _ = lift (C.find Sql.read_state ()) in
      Ok { conversations; chunks; generation })
