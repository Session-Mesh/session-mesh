(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

let usage =
  "usage: mesh-logout-all\n\n\
   Log every browser out of session-mesh at once. It takes no argument.\n\n\
   Raises the cookie generation: each mesh_auth cookie ever issued stops \
   working, so a lost or\n\
   stolen phone loses its access. Log in again with the token (or its ?token= \
   link) where wanted.\n\
   The master token (mesh-rename, mesh-attach, mesh-open outside a session) \
   and the sessions' own\n\
   tokens (mesh-open inside a session, mesh-event) keep working, as do the \
   running terminals.\n\n\
   Asks the running mesh with the master token; when it does not answer, \
   raises the generation\n\
   directly in the config dir (MESH_CONF_DIR, else ~/.config/session-mesh). \
   Port: MESH_PORT."

type output = { out : string -> unit; err : string -> unit }

let ( let* ) = Result.bind

let read_whole path =
  let fd = Unix.openfile path [ Unix.O_RDONLY; Unix.O_CLOEXEC ] 0 in
  Fun.protect
    ~finally:(fun () -> Unix.close fd)
    (fun () ->
      let buffer = Buffer.create 64 and chunk = Bytes.create 4096 in
      let rec loop () =
        let count = Unix.read fd chunk 0 (Bytes.length chunk) in
        if count > 0 then (
          Buffer.add_subbytes buffer chunk 0 count;
          loop ())
      in
      loop ();
      Buffer.contents buffer)

(* The message names the file and the error, never what the file holds. *)
let read_token conf =
  let path = Filename.concat conf "token" in
  match read_whole path with
  | text -> Ok (Mesh_python_text.strip text)
  | exception Unix.Unix_error (error, _, _) ->
      Error
        (Printf.sprintf "mesh-logout-all: unreadable token (%s: %s)" path
           (Unix.error_message error))

let arguments = function [] -> Ok () | _ :: _ -> Error usage

let prepare ~getenv ~args =
  let* conf = Mesh_paths.conf_dir getenv in
  let* _cache = Mesh_paths.cache_dir getenv in
  let* () = arguments args in
  let* token = read_token conf in
  let* port = Mesh_paths.port getenv in
  let* authorization =
    Mesh_local_http.bearer token
    |> Result.map_error (fun message -> "mesh-logout-all: " ^ message)
  in
  Ok (conf, port, authorization)

let generation_of body =
  match Yojson.Safe.from_string body with
  | `Assoc fields -> (
      match List.assoc_opt "generation" fields with
      | Some (`Int generation) -> Ok generation
      | Some _ | None ->
          Error "mesh-logout-all: the mesh answered without a generation")
  | _ -> Error "mesh-logout-all: the mesh answered without a generation"
  | exception Yojson.Json_error _ ->
      Error "mesh-logout-all: the mesh answered with something other than JSON"

let on_disk output conf =
  let path = Filename.concat conf Mesh_generation.file_name in
  match Mesh_generation.bump ~warn:output.out path with
  | Ok generation ->
      output.out
        (Printf.sprintf
           "The mesh is not responding: generation raised on disk (%d). All \
            devices are signed out."
           (generation :> int));
      0
  | Error message ->
      output.err
        (Printf.sprintf
           "mesh-logout-all: the mesh is not responding and the generation \
            could not be raised on disk (%s)"
           message);
      1

let fail output message =
  output.err message;
  1

let through_mesh ?timeout output (conf, port, authorization) =
  match
    Mesh_local_http.post ?timeout ~port ~route:"/api/logout-all" authorization
      ()
  with
  | Success body -> (
      match generation_of body with
      | Ok generation ->
          output.out
            (Printf.sprintf "All devices are signed out (generation %d)."
               generation);
          0
      | Error message -> fail output message)
  | Refused { status; reason } ->
      fail output
        (Printf.sprintf "mesh-logout-all: the mesh refused (%d %s)" status
           reason)
  | Unreadable message ->
      fail output
        (Printf.sprintf
           "mesh-logout-all: the mesh gave an unreadable answer (%s)" message)
  | Failed message ->
      fail output
        (Printf.sprintf
           "mesh-logout-all: the request to the mesh could not be made (%s)"
           message)
  | No_answer _ -> on_disk output conf

let run ?timeout ~getenv ~args output =
  match prepare ~getenv ~args with
  | Error message -> fail output message
  | Ok prepared -> through_mesh ?timeout output prepared
