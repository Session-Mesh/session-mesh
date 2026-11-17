(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

module C = Mesh_project_codec

exception Outcome of string * string

let outcome s c = raise (Outcome (s, c))

type stage = Locked | Read | Temp_synced | Published | Directory_synced

type t = {
  root : string;
  boot : string;
  machine : unit -> string;
  hook : stage -> unit;
  now : unit -> float;
  writer : Mutex.t;
  intents : Mutex.t;
  pending : (string * string, int) Hashtbl.t;
  mutable observe_revision : string -> unit;
}

let monotonic_now () = Mtime.Span.to_float_ns (Mtime_clock.elapsed ()) /. 1e9

let make ?(hook = fun _ -> ()) ?(now = monotonic_now) ~root ~boot ~machine () =
  {
    root;
    boot;
    machine;
    hook;
    now;
    writer = Mutex.create ();
    intents = Mutex.create ();
    pending = Hashtbl.create 4;
    observe_revision = (fun _ -> ());
  }

let guard_intents t f =
  Mutex.lock t.intents;
  Fun.protect ~finally:(fun () -> Mutex.unlock t.intents) f

let pending t key = guard_intents t (fun () -> Hashtbl.mem t.pending key)

let with_intent t key f =
  let change delta =
    guard_intents t (fun () ->
        let count =
          Option.value ~default:0 (Hashtbl.find_opt t.pending key) + delta
        in
        if count = 0 then Hashtbl.remove t.pending key
        else Hashtbl.replace t.pending key count)
  in
  change 1;
  Fun.protect ~finally:(fun () -> change (-1)) f

let startup_root () =
  match Sys.getenv_opt "MESH_CONF_DIR" with
  | Some s when s <> "" -> s
  | Some _ | None -> (
      try
        let home = (Unix.getpwuid (Unix.geteuid ())).Unix.pw_dir in
        Filename.concat home ".config/session-mesh"
      with Not_found -> "")

let s x = `String x
let assoc x = `Assoc x

let envelope t op status extra =
  assoc
    ([
       ("kind", s "mesh-project-reply");
       ("version", `Int 1);
       ("op", s op);
       ("boot", s t.boot);
       ("status", s status);
     ]
    @ extra)

let identifiers op fields =
  let bounded key =
    match List.assoc_opt key fields with
    | Some (`String value) when String.length value <= 80 -> Some (key, s value)
    | _ -> None
  in
  let ids = List.filter_map bounded [ "request_id"; "project_id" ] in
  if op = "project_create" && not (List.mem_assoc "project_id" ids) then
    match List.assoc_opt "request_id" ids with
    | Some v -> (
        try
          ignore (C.uuid v);
          ("project_id", v) :: ids
        with C.Invalid _ -> ids)
    | None -> ids
  else ids

let error ?(fields = []) t op status code =
  envelope t op status (("code", s code) :: identifiers op fields)

let safe_stat ?(directory = false) st =
  if
    (st.Unix.st_kind <> if directory then Unix.S_DIR else Unix.S_REG)
    || st.Unix.st_uid <> Unix.geteuid ()
    || st.Unix.st_perm land 0o077 <> 0
    || ((not directory) && st.Unix.st_nlink <> 1)
  then outcome "unavailable" "unsafe-store"

let same a b = a.Unix.st_dev = b.Unix.st_dev && a.Unix.st_ino = b.Unix.st_ino

let root t =
  if
    Filename.is_relative t.root
    || String.contains t.root '\000'
    || Unix.realpath t.root <> t.root
  then outcome "unavailable" "unsafe-store";
  let st = Unix.lstat t.root in
  safe_stat ~directory:true st;
  let rec ancestors p =
    let st = Unix.lstat p in
    if
      st.Unix.st_kind <> Unix.S_DIR
      || (not (List.mem st.Unix.st_uid [ 0; Unix.geteuid () ]))
      || st.Unix.st_perm land 0o022 <> 0
         && not (st.Unix.st_uid = 0 && st.Unix.st_perm land 0o1000 <> 0)
    then outcome "unavailable" "unsafe-store";
    let parent = Filename.dirname p in
    if parent <> p then ancestors parent
  in
  ancestors (Filename.dirname t.root);
  st

let file t = Filename.concat t.root "projects.json"

let with_fd fd f =
  Fun.protect ~finally:(fun () -> Unix.close fd) (fun () -> f fd)

let read_bytes descriptor initial_size =
  let buffer = Buffer.create initial_size and chunk = Bytes.create 8192 in
  let rec loop () =
    let count = Unix.read descriptor chunk 0 8192 in
    if count > 0 then (
      Buffer.add_subbytes buffer chunk 0 count;
      if Buffer.length buffer > C.config_bytes then
        outcome "unavailable" "invalid-config";
      loop ())
  in
  loop ();
  Buffer.contents buffer

let decode_config bytes =
  try C.parse_config bytes with
  | C.Invalid "unsupported-feature" -> outcome "refused" "unsupported-feature"
  | C.Invalid _ | Yojson.Json_error _ -> outcome "unavailable" "invalid-config"

let read t =
  ignore (root t);
  let initial =
    try Some (Unix.lstat (file t))
    with Unix.Unix_error (Unix.ENOENT, _, _) -> None
  in
  match initial with
  | None -> (None, None, "cfg1_missing")
  | Some st ->
      safe_stat st;
      if st.Unix.st_size > C.config_bytes then
        outcome "unavailable" "invalid-config";
      with_fd
        (Unix.openfile (file t) [ Unix.O_RDONLY; Unix.O_CLOEXEC ] 0)
        (fun fd ->
          let opened = Unix.fstat fd in
          safe_stat opened;
          if not (same st opened) then outcome "unavailable" "unsafe-store";
          let bytes = read_bytes fd st.Unix.st_size in
          if not (same opened (Unix.lstat (file t))) then
            outcome "unavailable" "unsafe-store";
          let value = decode_config bytes in
          (Some bytes, Some value, "cfg1_" ^ C.digest bytes))

let rows cfg =
  match C.get (C.obj cfg) "projects" with `List xs -> xs | _ -> assert false

let machine cfg = C.get (C.obj cfg) "machine_id"

let fields_count p k =
  match List.assoc_opt k (C.obj p) with
  | Some (`List xs) -> List.length xs
  | _ -> 0

let identity cfg revision =
  [ ("revision", s revision); ("machine_id", machine cfg) ]

let lock_path t = Filename.concat t.root "projects.lock"

let locked t =
  try
    ignore (Unix.lstat (lock_path t));
    true
  with Unix.Unix_error (Unix.ENOENT, _, _) -> false

let with_lock t f =
  ignore (root t);
  let fd =
    try
      Unix.openfile (lock_path t)
        [ Unix.O_WRONLY; Unix.O_CREAT; Unix.O_EXCL; Unix.O_CLOEXEC ]
        0o600
    with Unix.Unix_error (Unix.EEXIST, _, _) -> outcome "busy" "writer-busy"
  in
  let own = Unix.fstat fd in
  Fun.protect
    ~finally:(fun () ->
      Unix.close fd;
      try if same own (Unix.lstat (lock_path t)) then Unix.unlink (lock_path t)
      with Unix.Unix_error _ -> ())
    (fun () ->
      t.hook Locked;
      f ())

let write_temp temp bytes temp_identity =
  with_fd
    (Unix.openfile temp
       [ Unix.O_WRONLY; Unix.O_CREAT; Unix.O_EXCL; Unix.O_CLOEXEC ]
       0o600)
    (fun descriptor ->
      let identity = Unix.fstat descriptor in
      temp_identity := Some identity;
      let rec write offset =
        if offset < String.length bytes then (
          let count =
            Unix.write_substring descriptor bytes offset
              (String.length bytes - offset)
          in
          if count = 0 then failwith "write";
          write (offset + count))
      in
      write 0;
      Unix.fsync descriptor)

let cleanup_temp temp renamed identity =
  if not !renamed then
    Option.iter
      (fun own ->
        try if same own (Unix.lstat temp) then Unix.unlink temp
        with Unix.Unix_error _ -> ())
      !identity

let check_deadline store deadline =
  if store.now () > deadline then outcome "unavailable" "deadline"

let revalidate_publication store old deadline held_root temp identity =
  check_deadline store deadline;
  if not (same held_root (root store)) then outcome "unavailable" "unsafe-store";
  let latest, _, _ = read store in
  if latest <> old then outcome "conflict" "revision-conflict";
  check_deadline store deadline;
  if not (same held_root (root store)) then outcome "unavailable" "unsafe-store";
  let temp_stat = Unix.lstat temp in
  safe_stat temp_stat;
  if
    not
      (Option.fold ~none:false ~some:(fun own -> same own temp_stat) !identity)
  then outcome "unavailable" "unsafe-store"

let sync_directory store held_root =
  with_fd
    (Unix.openfile store.root [ Unix.O_RDONLY; Unix.O_CLOEXEC ] 0)
    (fun descriptor ->
      if not (same held_root (Unix.fstat descriptor)) then
        failwith "directory changed";
      Unix.fsync descriptor);
  store.hook Directory_synced

let publish store ~old ~deadline value =
  let bytes = C.encode (C.canonical (C.validate_config value)) ^ "\n" in
  if String.length bytes > C.config_bytes then outcome "refused" "capacity";
  let held_root = root store in
  let temp =
    Filename.concat store.root (".projects-" ^ store.machine () ^ ".tmp")
  in
  let renamed = ref false and identity = ref None in
  try
    Fun.protect
      ~finally:(fun () -> cleanup_temp temp renamed identity)
      (fun () ->
        write_temp temp bytes identity;
        store.hook Temp_synced;
        revalidate_publication store old deadline held_root temp identity;
        Unix.rename temp (file store);
        renamed := true;
        store.hook Published;
        sync_directory store held_root;
        "cfg1_" ^ C.digest bytes)
  with failure ->
    if !renamed then outcome "uncertain" "commit-uncertain" else raise failure
