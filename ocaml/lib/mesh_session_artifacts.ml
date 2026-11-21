(* SPDX-License-Identifier: AGPL-3.0-or-later *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech> *)

(* Trusted callers supply an already authenticated incarnation. No public API
   accepts observations directly from an agent. *)
exception Invalid

let fail () = raise Invalid

let fields = function
  | `Assoc xs
    when List.length xs
         = List.length (List.sort_uniq String.compare (List.map fst xs)) ->
      xs
  | _ -> fail ()

let get k v = Option.value ~default:`Null (List.assoc_opt k (fields v))

let text limit = function
  | `String s
    when s <> ""
         && String.length s <= limit
         && not (String.exists (fun c -> Char.code c < 32 || c = '\127') s) ->
      s
  | _ -> fail ()

let string k n v = text n (get k v)

let number = function
  | `Int i -> float_of_int i
  | `Float f when Float.is_finite f -> f
  | _ -> fail ()

let exact keys v =
  let xs = fields v in
  if List.sort String.compare (List.map fst xs) <> List.sort String.compare keys
  then fail ()

let list = function `List xs -> xs | _ -> fail ()

let safe_url s =
  let uri = Uri.of_string s in
  let loopback =
    List.mem
      (Option.value ~default:"" (Uri.host uri))
      [ "127.0.0.1"; "::1"; "localhost" ]
  in
  if
    Uri.userinfo uri <> None
    || Uri.host uri = None
    || Uri.host uri = Some ""
    || (not
          (Uri.scheme uri = Some "https"
          || (loopback && Uri.scheme uri = Some "http")))
    || String.contains s '\\' || String.contains s ' '
  then fail ();
  uri

let reference v =
  exact
    ([
       "connector";
       "id";
       "kind";
       "title";
       "url";
       "availability";
       "created_at";
       "updated_at";
     ]
    @ if List.mem_assoc "generation" (fields v) then [ "generation" ] else [])
    v;
  (match get "generation" v with
  | `Null -> ()
  | `Int n when n >= 0 -> ()
  | _ -> fail ());
  ignore (string "connector" 80 v);
  ignore (string "id" 256 v);
  ignore (string "kind" 80 v);
  ignore (string "title" 512 v);
  let state = string "availability" 32 v in
  if not (List.mem state [ "observed-present"; "pending-target"; "revoked" ])
  then fail ();
  (match (state, get "url" v) with
  | "revoked", `Null -> ()
  | ("observed-present" | "pending-target"), `String url ->
      ignore (safe_url (text 8192 (`String url)))
  | _ -> fail ());
  ignore (number (get "created_at" v));
  ignore (number (get "updated_at" v));
  v

let identity v =
  exact [ "name"; "created" ] v;
  ignore (string "name" 256 v);
  ignore (number (get "created" v));
  v

let same a b =
  get "name" a = get "name" b
  && number (get "created" a) = number (get "created" b)

let refs entry = list (get "references" entry)
let entry id rs = `Assoc [ ("session", id); ("references", `List rs) ]
let session entry = get "session" entry

let entry_refs e rs =
  `Assoc (("references", `List rs) :: List.remove_assoc "references" (fields e))

let state entries barriers generation =
  `Assoc
    [
      ("version", `Int 3);
      ("sessions", `List entries);
      ("revocations", `List barriers);
      ("generation", `Int generation);
    ]

let validate v =
  let legacy = get "version" v = `Int 1 in
  exact
    (if legacy then [ "version"; "sessions" ]
     else [ "version"; "sessions"; "revocations"; "generation" ])
    v;
  if not (List.mem (get "version" v) [ `Int 1; `Int 2; `Int 3 ]) then fail ();
  let entries = list (get "sessions" v) in
  if List.length entries > 256 then fail ();
  List.iter
    (fun e ->
      let proof = List.mem_assoc "restored_from" (fields e) in
      exact
        ([ "session"; "references" ] @ if proof then [ "restored_from" ] else [])
        e;
      ignore (identity (session e));
      if proof then (
        if get "version" v <> `Int 3 then fail ();
        ignore (identity (get "restored_from" e));
        if same (session e) (get "restored_from" e) then fail ());
      let rs = refs e in
      if List.length rs > 128 then fail ();
      List.iter (fun r -> ignore (reference r)) rs;
      let keys = List.map (fun r -> (get "connector" r, get "id" r)) rs in
      if List.length keys <> List.length (List.sort_uniq compare keys) then
        fail ())
    entries;
  let keys =
    List.map
      (fun e -> session e |> fun s -> (get "name" s, number (get "created" s)))
      entries
  in
  if List.length keys <> List.length (List.sort_uniq compare keys) then fail ();
  let barriers, generation =
    if legacy then
      let revoked =
        List.concat_map
          (fun e ->
            List.filter
              (fun r -> get "availability" r = `String "revoked")
              (refs e))
          entries
      in
      ( List.sort_uniq compare
          (List.map
             (fun r ->
               `Assoc
                 [
                   ("connector", get "connector" r);
                   ("id", get "id" r);
                   ("barrier", `Int 0);
                 ])
             revoked),
        0 )
    else
      ( list (get "revocations" v),
        match get "generation" v with
        | `Int n when n >= 0 && n < max_int -> n
        | _ -> fail () )
  in
  if List.length barriers > 4096 then fail ();
  List.iter
    (fun r ->
      exact [ "connector"; "id"; "barrier" ] r;
      ignore (string "connector" 80 r);
      ignore (string "id" 256 r);
      match get "barrier" r with
      | `Int n when n >= 0 && n <= generation -> ()
      | _ -> fail ())
    barriers;
  let keys = List.map (fun r -> (get "connector" r, get "id" r)) barriers in
  if List.length keys <> List.length (List.sort_uniq compare keys) then fail ();
  let entries =
    List.map
      (fun e ->
        let references =
          List.map
            (fun r ->
              let observed =
                match get "generation" r with `Int n -> n | _ -> 0
              in
              if observed > generation then fail ();
              let revoked =
                List.exists
                  (fun b ->
                    get "connector" b = get "connector" r
                    && get "id" b = get "id" r
                    && observed
                       <=
                       match get "barrier" b with
                       | `Int n -> n
                       | _ -> fail ())
                  barriers
              in
              if revoked then
                `Assoc
                  (("url", `Null)
                  :: ("availability", `String "revoked")
                  :: List.filter
                       (fun (k, _) ->
                         not (List.mem k [ "url"; "availability" ]))
                       (fields r))
              else r)
            (refs e)
        in
        entry_refs e references)
      entries
  in
  (entries, barriers, generation)

let private_stat kind st =
  if
    st.Unix.st_kind <> kind
    || st.Unix.st_uid <> Unix.geteuid ()
    || st.Unix.st_perm land 0o077 <> 0
    || (kind = Unix.S_REG && st.Unix.st_nlink <> 1)
  then fail ()

let open_private path flags =
  let fd = Unix.openfile path flags 0o600 in
  try
    let a = Unix.lstat path and b = Unix.fstat fd in
    private_stat Unix.S_REG a;
    private_stat Unix.S_REG b;
    if a.Unix.st_ino <> b.Unix.st_ino || a.Unix.st_dev <> b.Unix.st_dev then
      fail ();
    fd
  with e ->
    Unix.close fd;
    raise e

let with_store ?(require_existing = false) root f =
  private_stat Unix.S_DIR (Unix.lstat root);
  if Unix.realpath root <> root then fail ();
  let path = Filename.concat root "session-artifacts.json" in
  let lock =
    open_private (path ^ ".lock") [ Unix.O_CREAT; Unix.O_RDWR; Unix.O_CLOEXEC ]
  in
  Fun.protect
    ~finally:(fun () -> Unix.close lock)
    (fun () ->
      Unix.lockf lock Unix.F_LOCK 0;
      let stored =
        try
          let fd = open_private path [ Unix.O_RDONLY; Unix.O_CLOEXEC ] in
          let ch = Unix.in_channel_of_descr fd in
          Fun.protect
            ~finally:(fun () -> close_in_noerr ch)
            (fun () ->
              let size = in_channel_length ch in
              if size > 4 * 1024 * 1024 then fail ();
              validate (Yojson.Safe.from_string (really_input_string ch size)))
        with Unix.Unix_error (Unix.ENOENT, _, _) ->
          if require_existing then fail () else ([], [], 0)
      in
      let result, changed = f stored in
      (match changed with
      | None -> ()
      | Some (entries, barriers, generation) ->
          let encoded =
            Yojson.Safe.to_string (state entries barriers generation)
          in
          ignore (validate (state entries barriers generation));
          if String.length encoded > 4 * 1024 * 1024 then fail ();
          let tmp, ch =
            Filename.open_temp_file ~temp_dir:root ~perms:0o600 ".artifacts-"
              ".tmp"
          in
          Fun.protect
            ~finally:(fun () ->
              close_out_noerr ch;
              if Sys.file_exists tmp then Sys.remove tmp)
            (fun () ->
              output_string ch encoded;
              flush ch;
              Unix.fsync (Unix.descr_of_out_channel ch);
              close_out ch;
              Unix.rename tmp path;
              let dir =
                Unix.openfile root [ Unix.O_RDONLY; Unix.O_CLOEXEC ] 0
              in
              Fun.protect
                ~finally:(fun () -> Unix.close dir)
                (fun () -> Unix.fsync dir)));
      result)

let catalogue root id =
  ignore (identity id);
  with_store ~require_existing:true root (fun (entries, _, _) ->
      let source = List.find_opt (fun e -> same id (session e)) entries in
      let rs = match source with None -> [] | Some e -> refs e in
      ( `Assoc
          [
            ("references", `List rs);
            ("catalogue_present", `Bool true);
            ("source_present", `Bool (Option.is_some source));
          ],
        None ))

let begin_observation root =
  with_store root (fun (entries, barriers, generation) ->
      if generation >= max_int - 1 then fail ();
      ( `Assoc [ ("generation", `Int (generation + 1)) ],
        Some (entries, barriers, generation + 1) ))

let tombstone r =
  `Assoc
    (("url", `Null)
    :: ("availability", `String "revoked")
    :: ("updated_at", `Float (Unix.gettimeofday ()))
    :: List.filter
         (fun (k, _) ->
           not (List.mem k [ "url"; "availability"; "updated_at" ]))
         (fields r))

let observe ?generation root id r =
  ignore (identity id);
  ignore (reference r);
  with_store root (fun (entries, barriers, counter) ->
      let counter, generation =
        match generation with
        | None ->
            if counter >= max_int - 1 then fail ();
            (counter + 1, counter + 1)
        | Some n when n > 0 && n <= counter -> (counter, n)
        | _ -> fail ()
      in
      let rs =
        match List.find_opt (fun e -> same id (session e)) entries with
        | None -> []
        | Some e -> refs e
      in
      let same_ref x =
        get "connector" x = get "connector" r && get "id" x = get "id" r
      in
      let previous = List.find_opt same_ref rs in
      let previous_generation =
        match previous with
        | Some x -> ( match get "generation" x with `Int n -> n | _ -> 0)
        | None -> 0
      in
      let created =
        match List.find_opt same_ref rs with
        | None -> get "created_at" r
        | Some x -> get "created_at" x
      in
      let r =
        `Assoc
          (("generation", `Int generation)
          :: ("created_at", created)
          :: List.filter
               (fun (k, _) -> not (List.mem k [ "generation"; "created_at" ]))
               (fields r))
      in
      let r =
        match List.find_opt same_ref barriers with
        | Some b
          when generation
               <= match get "barrier" b with `Int n -> n | _ -> fail () ->
            tombstone r
        | _ -> r
      in
      let rs =
        if previous_generation > generation then rs
        else r :: List.filter (fun x -> not (same_ref x)) rs
      in
      let others = List.filter (fun e -> not (same id (session e))) entries in
      let updated =
        match List.find_opt (fun e -> same id (session e)) entries with
        | Some e -> entry_refs e rs
        | None -> entry id rs
      in
      ( `Assoc [ ("ok", `Bool true) ],
        Some (updated :: others, barriers, counter) ))

let revoke root id connector upstream_id =
  ignore (identity id);
  ignore (text 80 (`String connector));
  ignore (text 256 (`String upstream_id));
  with_store root (fun (entries, barriers, counter) ->
      let same_ref r =
        get "connector" r = `String connector
        && get "id" r = `String upstream_id
      in
      let barrier =
        `Assoc
          [
            ("connector", `String connector);
            ("id", `String upstream_id);
            ("barrier", `Int counter);
          ]
      in
      let entries =
        List.map
          (fun e ->
            entry_refs e
              (List.map
                 (fun r -> if same_ref r then tombstone r else r)
                 (refs e)))
          entries
      in
      ( `Assoc [ ("ok", `Bool true) ],
        Some
          ( entries,
            barrier :: List.filter (fun b -> not (same_ref b)) barriers,
            counter ) ))

let remove root id =
  ignore (identity id);
  with_store root (fun (entries, barriers, counter) ->
      ( `Assoc [ ("ok", `Bool true) ],
        Some
          ( List.filter (fun e -> not (same id (session e))) entries,
            barriers,
            counter ) ))

let transfer root before after =
  ignore (identity before);
  ignore (identity after);
  with_store ~require_existing:true root (fun (entries, barriers, counter) ->
      let outcome status moved =
        `Assoc
          [
            ("transferred", `Bool moved);
            ("transfer_status", `String status);
            ("catalogue_present", `Bool true);
          ]
      in
      match List.find_opt (fun e -> same before (session e)) entries with
      | None ->
          let previous =
            List.exists
              (fun e ->
                same after (session e)
                && get "restored_from" e <> `Null
                && same before (get "restored_from" e))
              entries
          in
          ( outcome (if previous then "already-moved" else "source-absent") false,
            None )
      | Some old when refs old = [] -> (outcome "source-empty" false, None)
      | Some old ->
          if
            same before after
            || List.exists (fun e -> same after (session e)) entries
          then fail ();
          ( outcome "moved" true,
            Some
              ( `Assoc
                  (("restored_from", before) :: fields (entry after (refs old)))
                :: List.filter (fun e -> not (same before (session e))) entries,
                barriers,
                counter ) ))

let restore_probe root id =
  let empty =
    try
      let value = catalogue root id in
      get "catalogue_present" value = `Bool true
      && get "source_present" value = `Bool true
      && get "references" value = `List []
    with _ -> false
  in
  `Assoc [ ("required", `Bool (not empty)) ]

let restore_transfer root before after =
  let value = transfer root before after in
  let complete =
    get "catalogue_present" value = `Bool true
    &&
    match (get "transfer_status" value, get "transferred" value) with
    | `String "moved", `Bool true
    | `String ("already-moved" | "source-empty"), `Bool false ->
        true
    | _ -> false
  in
  `Assoc [ ("complete", `Bool complete) ]

let notes_authorized root id nonce tool =
  try
    ignore (identity id);
    ignore (text 128 (`String nonce));
    private_stat Unix.S_DIR (Unix.lstat root);
    if Unix.realpath root <> root then fail ();
    let fd =
      open_private
        (Filename.concat root "notes-grants.json")
        [ Unix.O_RDONLY; Unix.O_CLOEXEC ]
    in
    let ch = Unix.in_channel_of_descr fd in
    let v =
      Fun.protect
        ~finally:(fun () -> close_in_noerr ch)
        (fun () ->
          let n = in_channel_length ch in
          if n > 65536 then fail ();
          Yojson.Safe.from_string (really_input_string ch n))
    in
    exact [ "version"; "sessions" ] v;
    if get "version" v <> `Int 1 then fail ();
    let grants = list (get "sessions" v) in
    if List.length grants > 256 then fail ();
    List.iter
      (fun grant ->
        exact [ "name"; "created"; "nonce"; "tools" ] grant;
        ignore (string "name" 256 grant);
        ignore (number (get "created" grant));
        ignore (string "nonce" 128 grant);
        let tools = list (get "tools" grant) in
        if List.length tools > 4 then fail ();
        List.iter
          (function
            | `String
                ("create_note" | "replace_note" | "mint_share" | "revoke_share")
              ->
                ()
            | _ -> fail ())
          tools)
      grants;
    List.exists
      (fun grant ->
        same id grant
        && get "nonce" grant = `String nonce
        && List.mem (`String tool) (list (get "tools" grant)))
      grants
  with _ -> false
