(******************************************************************************)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                  *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                            *)
(******************************************************************************)

open Caqti_type.Std
open Caqti_request.Infix
module Consent = Mesh_backend_consent

type error =
  | Unsafe_store
  | Unavailable
  | Conflict
  | Invalid_state
  | Unsupported_version
  | Aborted
  | Busy
  | Capacity

type connection = (module Caqti_blocking.CONNECTION)

type t = {
  conn : connection;
  mutex : Mutex.t;
  mutable closed : bool;
  root : string;
  path : string;
  root_identity : Unix.stats;
  file_identity : Unix.stats;
}

type transaction = {
  store : t;
  base : Consent.t;
  mutable pending : Consent.t;
  mutable live : bool;
  mutable failed : error option;
}

let ( let* ) = Result.bind

let error_code = function
  | Unsafe_store -> "unsafe-backend-store"
  | Unavailable -> "backend-store-unavailable"
  | Conflict -> "consent-revision-conflict"
  | Invalid_state -> "invalid-backend-state"
  | Unsupported_version -> "unsupported-backend-store-version"
  | Aborted -> "backend-transaction-aborted"
  | Busy -> "backend-store-busy"
  | Capacity -> "backend-journal-capacity"

let lift result = Result.map_error (fun _ -> Unavailable) result

let ddl sql =
  Caqti_request.create ~oneshot:true unit unit Caqti_mult.zero (fun _ ->
      Caqti_query.L sql)

let user_version = (unit ->! int) "PRAGMA user_version"

let schema_object_count =
  (unit ->! int)
    "SELECT count(*) FROM sqlite_master WHERE name NOT GLOB 'sqlite_*'"

let begin_immediate = ddl "BEGIN IMMEDIATE"

let meta =
  (unit ->! t2 string int) "SELECT kind, version FROM backend_meta WHERE id=1"

let read =
  (unit ->! t2 int string)
    "SELECT revision, payload FROM backend_policy WHERE id=1"

let write =
  (t3 int string int ->. unit)
    "UPDATE backend_policy SET revision=?, payload=? WHERE id=1 AND revision=?"

let changes = (unit ->! int) "SELECT changes()"

let find_operation =
  (string ->? t2 string bool)
    "SELECT payload,finished FROM backend_operations WHERE id=?"

let count_operations = (unit ->! int) "SELECT count(*) FROM backend_operations"

let unfinished_schema =
  (unit ->! int)
    "SELECT count(*) FROM backend_operations WHERE finished NOT IN (0,1)"

let write_operation =
  (t2 string string ->. unit)
    "INSERT INTO backend_operations (id,payload) VALUES (?,?) ON CONFLICT(id) \
     DO UPDATE SET payload=excluded.payload"

let finish_operation_query =
  (string ->. unit) "UPDATE backend_operations SET finished=1 WHERE id=?"

let purge_finished_query =
  (unit ->. unit) "DELETE FROM backend_operations WHERE finished=1"

let insert_policy =
  (string ->. unit)
    "INSERT INTO backend_policy(id,revision,payload) VALUES(1,0,?)"

let busy_timeout = (unit ->* int) "PRAGMA busy_timeout=5000"
let wal = (unit ->* string) "PRAGMA journal_mode=WAL"

let schema =
  [
    ddl
      "CREATE TABLE backend_meta(id INTEGER PRIMARY KEY CHECK(id=1),kind TEXT \
       NOT NULL,version INTEGER NOT NULL)";
    ddl
      "INSERT INTO backend_meta(id,kind,version) \
       VALUES(1,'mesh-backend-state',1)";
    ddl
      "CREATE TABLE backend_policy(id INTEGER PRIMARY KEY CHECK(id=1),revision \
       INTEGER NOT NULL CHECK(revision>=0),payload TEXT NOT NULL)";
    ddl
      "CREATE TABLE backend_operations(id TEXT PRIMARY KEY,payload TEXT NOT \
       NULL,finished INTEGER NOT NULL DEFAULT 0 CHECK(finished IN (0,1)))";
    ddl "PRAGMA user_version=1";
  ]

let private_file st =
  st.Unix.st_kind = Unix.S_REG
  && st.Unix.st_uid = Unix.geteuid ()
  && st.Unix.st_perm land 0o077 = 0
  && st.Unix.st_nlink = 1

let same a b = a.Unix.st_dev = b.Unix.st_dev && a.Unix.st_ino = b.Unix.st_ino

let prepare_path root =
  let* () =
    Result.map_error
      (fun _ -> Unsafe_store)
      (Mesh_backend_profile.validate_private_root root)
  in
  try
    let root_identity = Unix.lstat root in
    let path = Filename.concat root "backend-accounts.sqlite" in
    let stat =
      match Unix.lstat path with
      | st -> st
      | exception Unix.Unix_error (Unix.ENOENT, _, _) -> (
          match
            Unix.openfile path [ Unix.O_CREAT; Unix.O_EXCL; Unix.O_RDWR ] 0o600
          with
          | fd ->
              Fun.protect
                ~finally:(fun () -> Unix.close fd)
                (fun () -> Unix.fstat fd)
          | exception Unix.Unix_error (Unix.EEXIST, _, _) -> Unix.lstat path)
    in
    if private_file stat then Ok (path, stat, root_identity)
    else Error Unsafe_store
  with Unix.Unix_error _ | Sys_error _ -> Error Unsafe_store

let parse_policy stored_revision bytes =
  match Consent.of_string bytes with
  | Ok policy when Consent.revision policy = stored_revision -> Ok policy
  | _ -> Error Invalid_state

let read_connection (module C : Caqti_blocking.CONNECTION) =
  let* revision, payload = lift (C.find read ()) in
  parse_policy revision payload

let initialize conn =
  let (module C : Caqti_blocking.CONNECTION) = conn in
  let* _ = lift (C.collect_list busy_timeout ()) in
  let* () = lift (C.exec begin_immediate ()) in
  let locked () =
    let* version = lift (C.find user_version ()) in
    let* () =
      if version = 1 then
        let* kind, version = lift (C.find meta ()) in
        if kind = "mesh-backend-state" && version = 1 then Ok ()
        else Error Unsupported_version
      else if version <> 0 then Error Unsupported_version
      else
        let* count = lift (C.find schema_object_count ()) in
        if count <> 0 then Error Invalid_state
        else
          let* () =
            List.fold_left
              (fun acc query ->
                let* () = acc in
                lift (C.exec query ()))
              (Ok ()) schema
          in
          lift (C.exec insert_policy (Consent.to_string (Consent.empty ())))
    in
    let* invalid_journal =
      Result.map_error (fun _ -> Invalid_state) (C.find unfinished_schema ())
    in
    if invalid_journal <> 0 then Error Invalid_state
    else
      let* _ = read_connection conn in
      lift (C.commit ())
  in
  let* () =
    match locked () with
    | Ok () -> Ok ()
    | Error _ as error ->
        ignore (C.rollback ());
        error
    | exception exn ->
        ignore (C.rollback ());
        raise exn
  in
  let* _ = lift (C.collect_list wal ()) in
  lift (C.exec (ddl "PRAGMA synchronous=FULL") ())

let custody store =
  let* () =
    Result.map_error
      (fun _ -> Unsafe_store)
      (Mesh_backend_profile.validate_private_root store.root)
  in
  try
    let root = Unix.lstat store.root and file = Unix.lstat store.path in
    if
      same root store.root_identity
      && same file store.file_identity
      && private_file file
    then Ok ()
    else Error Unsafe_store
  with Unix.Unix_error _ | Sys_error _ -> Error Unsafe_store

let open_ ~root () =
  let* path, expected, root_identity = prepare_path root in
  try
    let* conn =
      lift (Caqti_blocking.connect (Uri.make ~scheme:"sqlite3" ~path ()))
    in
    let (module C : Caqti_blocking.CONNECTION) = conn in
    let accepted = ref false in
    Fun.protect
      ~finally:(fun () -> if not !accepted then C.disconnect ())
      (fun () ->
        let valid =
          try
            let actual = Unix.lstat path in
            same expected actual && private_file actual
          with Unix.Unix_error _ -> false
        in
        let store =
          {
            conn;
            mutex = Mutex.create ();
            closed = false;
            root;
            path;
            root_identity;
            file_identity = expected;
          }
        in
        let result =
          if valid then
            let* () = custody store in
            let* () = initialize conn in
            custody store
          else Error Unsafe_store
        in
        match result with
        | Ok () ->
            accepted := true;
            Ok store
        | Error _ as error -> error)
  with
  | (Out_of_memory | Stack_overflow) as exn -> raise exn
  | _ -> Error Unavailable

let with_lock ?(verify = true) store f =
  if not (Mutex.try_lock store.mutex) then Error Busy
  else
    Fun.protect
      ~finally:(fun () -> Mutex.unlock store.mutex)
      (fun () ->
        if store.closed then Error Invalid_state
        else
          try
            let* () = if verify then custody store else Ok () in
            f ()
          with
          | (Out_of_memory | Stack_overflow) as exn -> raise exn
          | _ -> Error Unavailable)

let close store =
  with_lock ~verify:false store (fun () ->
      let (module C : Caqti_blocking.CONNECTION) = store.conn in
      C.disconnect ();
      store.closed <- true;
      Ok ())

let read_policy store = with_lock store (fun () -> read_connection store.conn)

let in_transaction tx f =
  if not tx.live then Error Invalid_state
  else
    match tx.failed with
    | Some error -> Error error
    | None -> (
        match f () with
        | Error error as result ->
            tx.failed <- Some error;
            result
        | Ok _ as result -> result)

let policy tx = in_transaction tx (fun () -> Ok tx.pending)

let set_policy tx next =
  in_transaction tx (fun () ->
      let before = Consent.revision tx.base and after = Consent.revision next in
      if
        (after = before && Consent.to_string next = Consent.to_string tx.base)
        || (before < 9007199254740991 && after = before + 1)
      then (
        tx.pending <- next;
        Ok ())
      else Error Invalid_state)

let utf8 text =
  let rec loop offset =
    if offset = String.length text then true
    else
      let decoded = String.get_utf_8_uchar text offset in
      Uchar.utf_decode_is_valid decoded
      && loop (offset + Uchar.utf_decode_length decoded)
  in
  loop 0

let valid_key text =
  String.length text > 0
  && String.length text <= 80
  && String.for_all
       (function
         | 'a' .. 'z' | 'A' .. 'Z' | '0' .. '9' | '_' | '-' -> true | _ -> false)
       text

let rec valid_json depth = function
  | _ when depth > 32 -> false
  | `Null | `Bool _ | `Int _ -> true
  | `Float x -> classify_float x <> FP_nan && classify_float x <> FP_infinite
  | `String text -> String.length text <= 65536 && utf8 text
  | `List values ->
      List.length values <= 1024 && List.for_all (valid_json (depth + 1)) values
  | `Assoc fields ->
      List.length fields <= 128
      && List.length fields
         = List.length (List.sort_uniq String.compare (List.map fst fields))
      && List.for_all
           (fun (key, value) -> valid_key key && valid_json (depth + 1) value)
           fields
  | _ -> false

let get_operation tx ~id =
  in_transaction tx (fun () ->
      if not (valid_key id) then Error Invalid_state
      else
        let (module C : Caqti_blocking.CONNECTION) = tx.store.conn in
        let* raw = lift (C.find_opt find_operation id) in
        match raw with
        | None -> Ok None
        | Some (raw, _) when String.length raw <= 65536 -> (
            try
              let body = Yojson.Safe.from_string raw in
              match body with
              | `Assoc _ when valid_json 0 body -> Ok (Some body)
              | _ -> Error Invalid_state
            with Yojson.Json_error _ -> Error Invalid_state)
        | Some _ -> Error Invalid_state)

let put_operation tx ~id body =
  in_transaction tx (fun () ->
      let object_body = match body with `Assoc _ -> true | _ -> false in
      if (not (valid_key id)) || (not object_body) || not (valid_json 0 body)
      then Error Invalid_state
      else
        let raw = Yojson.Safe.to_string body in
        if String.length raw > 65536 then Error Invalid_state
        else
          let (module C : Caqti_blocking.CONNECTION) = tx.store.conn in
          let* existing = lift (C.find_opt find_operation id) in
          let* count = lift (C.find count_operations ()) in
          if Option.fold ~none:false ~some:snd existing then Error Invalid_state
          else if existing = None && count >= 1024 then Error Capacity
          else lift (C.exec write_operation (id, raw)))

let finish_operation tx ~id =
  in_transaction tx (fun () ->
      if not (valid_key id) then Error Invalid_state
      else
        let (module C : Caqti_blocking.CONNECTION) = tx.store.conn in
        let* existing = lift (C.find_opt find_operation id) in
        match existing with
        | None -> Error Invalid_state
        | Some _ -> lift (C.exec finish_operation_query id))

let purge_finished tx =
  in_transaction tx (fun () ->
      let (module C : Caqti_blocking.CONNECTION) = tx.store.conn in
      let* () = lift (C.exec purge_finished_query ()) in
      lift (C.find changes ()))

let transaction store ~expected_revision callback =
  with_lock store (fun () ->
      let (module C : Caqti_blocking.CONNECTION) = store.conn in
      let* () = lift (C.exec begin_immediate ()) in
      let tx = ref None in
      let rollback () =
        Option.iter (fun t -> t.live <- false) !tx;
        ignore (C.rollback ())
      in
      let run () =
        let* base = read_connection store.conn in
        if Consent.revision base <> expected_revision then Error Conflict
        else
          let current =
            { store; base; pending = base; live = true; failed = None }
          in
          tx := Some current;
          let result =
            try callback current with
            | (Out_of_memory | Stack_overflow) as exn -> raise exn
            | _ -> Error Aborted
          in
          current.live <- false;
          let* value = result in
          let* () =
            match current.failed with Some e -> Error e | None -> Ok ()
          in
          let* () = custody store in
          (* Even Once/unchanged policy performs the CAS: no journal-only commit can
       rely on an older policy snapshot after a management edit wins the race. *)
          let* () =
            lift
              (C.exec write
                 ( Consent.revision current.pending,
                   Consent.to_string current.pending,
                   expected_revision ))
          in
          let* changed = lift (C.find changes ()) in
          if changed <> 1 then Error Conflict
          else
            let* () = custody store in
            let* () = lift (C.commit ()) in
            Ok value
      in
      match run () with
      | Ok _ as result -> result
      | Error _ as result ->
          rollback ();
          result
      | exception exn ->
          rollback ();
          raise exn)
