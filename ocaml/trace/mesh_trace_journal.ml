(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(* The journal contains metadata only. A session token is replaced with a
   digest, so the Mesh owner can correlate an event without storing authority. *)
let string_option = function Some value -> `String value | None -> `Null

(* A client chooses the method string. Retain known protocol names only so a
   malformed request cannot smuggle its contents into the metadata journal. *)
let safe_method = function
  | ( "initialize" | "ping" | "tools/list" | "tools/call" | "resources/list"
    | "resources/read" | "resources/templates/list" | "resources/subscribe"
    | "resources/unsubscribe" | "prompts/list" | "prompts/get"
    | "completion/complete" | "logging/setLevel" | "server/discover" ) as
    method_ ->
      method_
  | _ -> "other"

let outcome = function
  | Mcp_kit.Trace.Success -> `String "success"
  | Tool_error -> `String "tool_error"
  | Input_required -> `String "input_required"
  | Rpc_error code -> `Assoc [ ("rpc_error", `Int code) ]
  | Exception -> `String "exception"

let random_instance () =
  let channel = open_in_bin "/dev/urandom" in
  Fun.protect
    ~finally:(fun () -> close_in_noerr channel)
    (fun () ->
      let bytes = really_input_string channel 16 in
      String.concat ""
        (List.init (String.length bytes) (fun i ->
             Printf.sprintf "%02x" (Char.code bytes.[i]))))

let write_all fd text =
  let rec loop offset =
    if offset < String.length text then
      match
        Unix.write_substring fd text offset (String.length text - offset)
      with
      | 0 -> failwith "trace journal write made no progress"
      | written -> loop (offset + written)
      | exception Unix.Unix_error (Unix.EINTR, _, _) -> loop offset
  in
  loop 0

let lock_bounded fd =
  let rec acquire remaining =
    try Unix.lockf fd Unix.F_TLOCK 0 with
    | Unix.Unix_error ((Unix.EACCES | Unix.EAGAIN), _, _) when remaining > 0 ->
        ignore (Unix.select [] [] [] 0.005);
        acquire (remaining - 1)
  in
  acquire 20

let append path line =
  let fd =
    Unix.openfile path
      [ Unix.O_WRONLY; Unix.O_CREAT; Unix.O_APPEND; Unix.O_NONBLOCK ]
      0o600
  in
  Fun.protect
    ~finally:(fun () -> Unix.close fd)
    (fun () ->
      let opened = Unix.fstat fd and named = Unix.lstat path in
      if
        opened.st_kind <> Unix.S_REG
        || named.st_kind <> Unix.S_REG
        || opened.st_dev <> named.st_dev
        || opened.st_ino <> named.st_ino
        || opened.st_uid <> Unix.geteuid ()
        || opened.st_nlink <> 1
        || opened.st_perm land 0o077 <> 0
      then failwith "trace journal is not a private regular file";
      (* A stuck writer must not stall the MCP server indefinitely. *)
      lock_bounded fd;
      Fun.protect
        ~finally:(fun () -> Unix.lockf fd Unix.F_ULOCK 0)
        (fun () ->
          write_all fd line;
          Unix.fsync fd))

let make_observer ~server ~identity () =
  match Sys.getenv_opt "MESH_MCP_TRACE_JOURNAL" with
  | Some path when path <> "" && not (Filename.is_relative path) ->
      let instance = random_instance () in
      let mutex = Mutex.create () in
      let failed = ref false in
      fun event ->
        let call, phase, result =
          match event with
          | Mcp_kit.Trace.Started call -> (call, "started", `Null)
          | Finished (call, result) -> (call, "finished", outcome result)
        in
        let fields =
          [
            ("version", `Int 1);
            ("server", `String server);
            ("session", string_option identity);
            ("instance", `String instance);
            ("call", `Int call.id);
            ("time", `Float (Unix.gettimeofday ()));
            ("phase", `String phase);
            ("method", `String (safe_method call.method_));
            ("tool", string_option call.tool);
            ("action", string_option call.subcommand);
            ("outcome", result);
          ]
        in
        Mutex.lock mutex;
        Fun.protect
          ~finally:(fun () -> Mutex.unlock mutex)
          (fun () ->
            try append path (Yojson.Safe.to_string (`Assoc fields) ^ "\n")
            with _ ->
              if not !failed then (
                failed := true;
                prerr_endline "mesh-mcp-trace: cannot write the journal"))
  | _ -> ignore

let observer () =
  match Sys.getenv_opt "MESH_SESSION_TOKEN" with
  | Some token when token <> "" ->
      let identity = Digestif.SHA256.(to_hex (digest_string token)) in
      make_observer ~server:"mesh-board-mcp" ~identity:(Some identity) ()
  | _ -> ignore

(* The tracker must never derive its trace identity from a Mesh credential.
   Its calls have no session attribution rather than an invented identity. *)
let observer_anonymous () = make_observer ~server:"work-mcp" ~identity:None ()
