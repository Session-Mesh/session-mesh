(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

type t = {
  ctx : Ctx.t;
  session : Session.t option;
  now : int;
  loaded : Store.loaded;
  mutable paths : string list;
}

type items = (string * string * (string * Yojson.Safe.t) list) list

let run (ctx : Ctx.t) ?session f =
  Err.protect (fun () ->
      Lock.with_lock ~path:(Ctx.lock_path ctx) ~timeout:ctx.lock_timeout (fun () ->
          f { ctx; session; now = ctx.now (); loaded = Store.load ctx; paths = [] }))

let touch tx path = if not (List.mem path tx.paths) then tx.paths <- tx.paths @ [ path ]
let has_written tx = tx.paths <> []

(* The newest timestamp this host has written: the last valid line of its
   newest event file. *)
let own_last_ts (ctx : Ctx.t) =
  let dir = Ctx.events_dir ctx in
  let own =
    List.filter
      (fun f ->
        match Store.parse_event_file_name f with
        | Some (_, h) -> h = ctx.host && Safefs.is_regular_file (Filename.concat dir f)
        | None -> false)
      (Safefs.list_dir dir)
  in
  match List.rev (List.sort String.compare own) with
  | [] -> None
  | newest :: _ ->
      let chunk = Appendfile.tail (Filename.concat dir newest) 65536 in
      List.find_map
        (fun raw -> match Event.classify raw with Ok (_, ts) -> Some ts | Error _ -> None)
        (List.rev (String.split_on_char '\n' chunk))

let with_identity tx fields =
  match tx.session with
  | None -> fields
  | Some s ->
      let add key value fields =
        if List.mem_assoc key fields then fields else fields @ [ (key, `String value) ]
      in
      let fields = add "agent" s.agent fields in
      (match s.session with Some id -> add "session" id fields | None -> fields)

let max_blob_bytes = 60_000

let prepare tx (items : items) =
  let ts = match own_last_ts tx.ctx with Some last when last > tx.now -> last | _ -> tx.now in
  let blob =
    String.concat ""
      (List.map
         (fun (task, typ, fields) -> Event.encode ~ts ~task ~typ (with_identity tx fields) ^ "\n")
         items)
  in
  (* One [write(2)]: [Unix.single_write] sends at most 64 KiB, and a torn blob is
     what the append protocol avoids. Refused here, before anything is written. *)
  if String.length blob > max_blob_bytes then
    Err.usage "the events of this change are %d bytes, over the %d byte limit of one append"
      (String.length blob) max_blob_bytes;
  let path =
    Filename.concat (Ctx.events_dir tx.ctx) (Printf.sprintf "%s.%s.jsonl" (Tstamp.month ts) tx.ctx.host)
  in
  fun () ->
    Appendfile.append ~root:tx.ctx.root path blob;
    touch tx path

let append tx items = prepare tx items ()

let commit tx ~cmd ~subject =
  if tx.ctx.commit && tx.paths <> [] then
    let message = match subject with Some s -> Printf.sprintf "wl: %s %s" cmd s | None -> "wl: " ^ cmd in
    (* The events are already durable: nothing here may turn the write into an Error. *)
    try
      match Gitrun.commit_paths ~root:tx.ctx.root ~paths:tx.paths ~message with
      | Ok _ -> ()
      | Error why -> tx.ctx.warn why
    with e -> (
      Err.reraise_fatal e;
      try tx.ctx.warn ("auto-commit failed: " ^ Printexc.to_string e) with e -> Err.reraise_fatal e)
