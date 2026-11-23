(* SPDX-License-Identifier: AGPL-3.0-or-later *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech> *)
module A = Mesh_session_artifacts
module R = Work_read

let str s = `String s

let context value =
  A.exact [ "instance_id"; "project_id"; "product_id"; "project_created" ] value;
  List.iter
    (fun k -> ignore (A.string k 128 value))
    [ "instance_id"; "project_id"; "product_id"; "project_created" ];
  `Assoc
    (List.map
       (fun k -> (k, A.get k value))
       [ "instance_id"; "project_id"; "product_id"; "project_created" ])

let fresh expected =
  let expected = context expected in
  match R.Wr_load.load () with
  | Error _ -> A.fail ()
  | Ok loaded -> (
      match
        R.Wr_attachment.run loaded
          (A.string "project_id" 128 expected)
          (A.string "product_id" 128 expected)
      with
      | Error _ -> A.fail ()
      | Ok reply ->
          let actual =
            `Assoc
              (List.map
                 (fun k -> (k, A.get k reply))
                 [
                   "instance_id"; "project_id"; "product_id"; "project_created";
                 ])
          in
          if actual <> expected then A.fail ())

let canonical value = Yojson.Safe.to_string value
let digest value = Digestif.SHA256.(to_hex (digest_string (canonical value)))

let empty () =
  let fd = Unix.openfile "/dev/urandom" [ Unix.O_RDONLY; Unix.O_CLOEXEC ] 0 in
  let bytes = Bytes.create 32 in
  Fun.protect
    ~finally:(fun () -> Unix.close fd)
    (fun () ->
      let rec fill at =
        if at < 32 then
          let n = Unix.read fd bytes at (32 - at) in
          if n = 0 then A.fail () else fill (at + n)
      in
      fill 0);
  let machine =
    String.concat ""
      (List.init 32 (fun i ->
           Printf.sprintf "%02x" (Char.code (Bytes.get bytes i))))
  in
  `Assoc
    [
      ("version", `Int 1);
      ("machine_id", str machine);
      ("revision", `Int 0);
      ("bindings", `List []);
      ("receipts", `List []);
    ]

let rows key doc = match A.get key doc with `List l -> l | _ -> A.fail ()

let revision doc =
  match A.get "revision" doc with `Int n when n >= 0 -> n | _ -> A.fail ()

let session value =
  A.exact [ "name"; "created"; "machine_id" ] value;
  ignore
    (A.identity
       (`Assoc
          [ ("name", A.get "name" value); ("created", A.get "created" value) ]));
  ignore (A.string "machine_id" 128 value);
  `Assoc
    (List.map (fun k -> (k, A.get k value)) [ "name"; "created"; "machine_id" ])

let validate value =
  A.exact [ "version"; "machine_id"; "revision"; "bindings"; "receipts" ] value;
  ignore (A.string "machine_id" 64 value);
  if A.get "version" value <> `Int 1 then A.fail ();
  ignore (revision value);
  let bindings = rows "bindings" value and receipts = rows "receipts" value in
  if List.length bindings > 2000 || List.length receipts > 128 then A.fail ();
  List.iter
    (fun row ->
      A.exact [ "context"; "session" ] row;
      ignore (context (A.get "context" row));
      ignore (session (A.get "session" row)))
    bindings;
  List.iter
    (fun row ->
      A.exact
        [ "request_id"; "digest"; "revision"; "context"; "action"; "session" ]
        row;
      ignore (context (A.get "context" row));
      ignore (session (A.get "session" row));
      if not (List.mem (A.get "action" row) [ str "attach"; str "detach" ]) then
        A.fail ();
      ignore (A.string "request_id" 80 row);
      ignore (A.string "digest" 64 row);
      ignore (revision row))
    receipts;
  value

let with_document root f =
  A.private_stat Unix.S_DIR (Unix.lstat root);
  if Unix.realpath root <> root then A.fail ();
  let path = Filename.concat root "work-session-tools.json" in
  let lock =
    A.open_private (path ^ ".lock")
      [ Unix.O_CREAT; Unix.O_RDWR; Unix.O_CLOEXEC ]
  in
  Fun.protect
    ~finally:(fun () -> Unix.close lock)
    (fun () ->
      let until = Unix.gettimeofday () +. 2. in
      let rec acquire () =
        try Unix.lockf lock Unix.F_TLOCK 0
        with Unix.Unix_error ((Unix.EACCES | Unix.EAGAIN), _, _) ->
          if Unix.gettimeofday () >= until then A.fail ();
          Unix.sleepf 0.01;
          acquire ()
      in
      acquire ();
      let initialized = ref true in
      let old =
        try
          let fd = A.open_private path [ Unix.O_RDONLY; Unix.O_CLOEXEC ] in
          let ch = Unix.in_channel_of_descr fd in
          Fun.protect
            ~finally:(fun () -> close_in_noerr ch)
            (fun () ->
              let n = in_channel_length ch in
              if n > 2 * 1024 * 1024 then A.fail ();
              validate (Yojson.Safe.from_string (really_input_string ch n)))
        with Unix.Unix_error (Unix.ENOENT, _, _) ->
          initialized := false;
          empty ()
      in
      let reply, next = f old in
      let next = if next = None && not !initialized then Some old else next in
      (match next with
      | None -> ()
      | Some value ->
          let wire = canonical (validate value) in
          if String.length wire > 2 * 1024 * 1024 then A.fail ();
          let temp, ch =
            Filename.open_temp_file ~temp_dir:root ~perms:0o600 ".work-tools-"
              ".tmp"
          in
          Fun.protect
            ~finally:(fun () ->
              close_out_noerr ch;
              if Sys.file_exists temp then Sys.remove temp)
            (fun () ->
              output_string ch wire;
              flush ch;
              Unix.fsync (Unix.descr_of_out_channel ch);
              close_out ch;
              Unix.rename temp path;
              let fd = Unix.openfile root [ Unix.O_RDONLY; Unix.O_CLOEXEC ] 0 in
              Fun.protect
                ~finally:(fun () -> Unix.close fd)
                (fun () -> Unix.fsync fd)));
      reply)

let run root request =
  A.exact
    [ "op"; "action"; "context"; "session"; "request_id"; "revision" ]
    request;
  let scope = context (A.get "context" request) in
  fresh scope;
  let action = A.string "action" 16 request in
  if not (List.mem action [ "read"; "attach"; "detach"; "status" ]) then
    A.fail ();
  with_document root (fun doc ->
      fresh scope;
      let receipt =
        List.find_opt
          (fun r -> A.get "request_id" r = A.get "request_id" request)
          (rows "receipts" doc)
      in
      (match receipt with
      | Some r when A.get "context" r <> scope -> A.fail ()
      | _ -> ());
      let result rev bindings extra =
        `Assoc
          ([
             ("status", str "confirmed");
             ("context", scope);
             ("machine_id", A.get "machine_id" doc);
             ("revision", `Int rev);
             ( "sessions",
               `List
                 (List.filter_map
                    (fun r ->
                      if A.get "context" r = scope then Some (A.get "session" r)
                      else None)
                    bindings) );
           ]
          @ extra)
      in
      let bindings = rows "bindings" doc and rev = revision doc in
      if action = "status" then
        match receipt with
        | None ->
            (`Assoc [ ("status", str "unknown"); ("context", scope) ], None)
        | Some r ->
            ( result rev bindings
                [ ("request_id", A.get "request_id" r); ("receipt", r) ],
              None )
      else if action = "read" then (
        fresh scope;
        (result rev bindings [], None))
      else
        let id = session (A.get "session" request) in
        if action = "attach" && A.get "machine_id" id <> A.get "machine_id" doc
        then A.fail ();
        let request_id = A.string "request_id" 80 request in
        let fingerprint = digest request in
        match receipt with
        | Some r ->
            if A.get "digest" r <> str fingerprint then A.fail ();
            ( result rev bindings
                [ ("request_id", str request_id); ("receipt", r) ],
              None )
        | None ->
            if A.get "revision" request <> `Int rev || rev = max_int then
              A.fail ();
            let retained =
              List.filter
                (fun r ->
                  not (A.get "context" r = scope && A.get "session" r = id))
                bindings
            in
            let next_bindings =
              if action = "attach" then
                `Assoc [ ("context", scope); ("session", id) ] :: retained
              else retained
            in
            let receipt =
              `Assoc
                [
                  ("request_id", str request_id);
                  ("digest", str fingerprint);
                  ("revision", `Int (rev + 1));
                  ("context", scope);
                  ("action", str action);
                  ("session", id);
                ]
            in
            let rec take n = function
              | _ when n = 0 -> []
              | [] -> []
              | x :: xs -> x :: take (n - 1) xs
            in
            fresh scope;
            let next =
              `Assoc
                [
                  ("version", `Int 1);
                  ("machine_id", A.get "machine_id" doc);
                  ("revision", `Int (rev + 1));
                  ("bindings", `List next_bindings);
                  ("receipts", `List (take 128 (receipt :: rows "receipts" doc)));
                ]
            in
            ( result (rev + 1) next_bindings
                [ ("request_id", str request_id); ("receipt", receipt) ],
              Some next ))
