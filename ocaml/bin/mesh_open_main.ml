(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

let usage = "usage: mesh-open [-h] [--reload] [--watch] FILE"

let help =
  {|Run from a mesh session, the document opens next to that session's pane (the session
token in $MESH_SESSION_TOKEN is the credential, nothing else is needed); in a session
without that token it refuses (a session is recognised by $MESH_SESSION or, when the PTY
host answers, by a session shell among this process's ancestors). Outside any session it
opens in every page, with the mesh's own token.

Running it again on the same file reloads it; --reload says so explicitly.
--watch also reloads the document whenever the file changes on disk (the page must
stay open). Web pages (http:// or https://) are not shown in a panel: open them in a
browser. Meant for agents too: "write the report to ~/notes/x.html, then
run mesh-open on it".

positional arguments:
  FILE

options:
  -h, --help  show this help message and exit
  --reload    reload the document if it is already open
  --watch     reload it whenever the file changes|}

let die message =
  prerr_endline message;
  exit 1

let fail message = die ("mesh-open: " ^ message)
let value = function Ok data -> data | Error message -> die message

let usage_error message =
  prerr_endline usage;
  prerr_endline ("mesh-open: error: " ^ message);
  exit 2

let parse args =
  let rec loop options reload watch target = function
    | [] -> (
        match target with
        | Some file -> (file, reload, watch)
        | None -> usage_error "the following arguments are required: FILE")
    | "--" :: rest when options -> loop false reload watch target rest
    | argument :: rest when options && String.starts_with ~prefix:"--" argument
      -> (
        let flag, takes_value =
          match String.index_opt argument '=' with
          | None -> (argument, false)
          | Some i -> (String.sub argument 0 i, true)
        in
        let matches name =
          String.length flag > 2 && String.starts_with ~prefix:flag name
        in
        let name = List.find_opt matches [ "--help"; "--reload"; "--watch" ] in
        match name with
        | Some name when takes_value ->
            usage_error
              ("argument " ^ name ^ ": ignored explicit argument "
              ^ Mesh_python_text.repr
                  (String.sub argument
                     (String.length flag + 1)
                     (String.length argument - String.length flag - 1)))
        | Some "--help" ->
            Printf.printf "%s\n\n%s\n" usage help;
            exit 0
        | Some "--reload" -> loop options true watch target rest
        | Some "--watch" -> loop options reload true target rest
        | Some _ | None -> usage_error ("unrecognized arguments: " ^ argument))
    | "-h" :: _ when options ->
        Printf.printf "%s\n\n%s\n" usage help;
        exit 0
    | argument :: rest ->
        let negative_number =
          String.length argument > 1
          && argument.[0] = '-'
          && Float.of_string_opt argument <> None
        in
        if
          options
          && String.starts_with ~prefix:"-" argument
          && argument <> "-" && not negative_number
        then usage_error ("unrecognized arguments: " ^ argument)
        else if Option.is_some target then
          usage_error
            ("unrecognized arguments: " ^ String.concat " " (argument :: rest))
        else loop options reload watch (Some argument) rest
  in
  loop true false false None args

let getenv = Sys.getenv_opt

let expand_home file =
  match String.split_on_char '/' file with
  | user :: rest when String.starts_with ~prefix:"~" user ->
      let home =
        if user = "~" then value (Mesh_paths.home getenv)
        else
          let name = String.sub user 1 (String.length user - 1) in
          match Unix.getpwnam name with
          | { Unix.pw_dir; _ } -> pw_dir
          | exception Not_found -> fail "Could not determine home directory."
      in
      List.fold_left Filename.concat home rest
  | _ -> file

let resolve_path file =
  let file = expand_home file in
  let file =
    if Filename.is_relative file then Filename.concat (Sys.getcwd ()) file
    else file
  in
  (* Like pathlib's non-strict resolve, follow links even when the final file
     or a link target is missing. Resolve ".." after expanding any link. *)
  let rec resolve resolving dir = function
    | [] -> dir
    | ("" | ".") :: rest -> resolve resolving dir rest
    | ".." :: rest -> resolve resolving (Filename.dirname dir) rest
    | part :: rest -> (
        let candidate = Filename.concat dir part in
        match Unix.readlink candidate with
        | target ->
            if List.mem candidate resolving then
              fail ("symbolic link loop at " ^ candidate);
            let base = if Filename.is_relative target then dir else "/" in
            let resolved =
              resolve (candidate :: resolving) base
                (String.split_on_char '/' target)
            in
            resolve resolving resolved rest
        | exception
            Unix.Unix_error
              ( ( Unix.ENOENT | Unix.ENOTDIR | Unix.EINVAL | Unix.EACCES
                | Unix.EPERM ),
                _,
                _ ) ->
            resolve resolving candidate rest)
  in
  resolve [] "/" (String.split_on_char '/' file)

let session_by_ancestry () =
  (* The host may have exited. Query it under a deadline and look for a
     matching live process in the caller's ancestry. *)
  let home () =
    match Unix.getpwuid (Unix.geteuid ()) with
    | { Unix.pw_dir; _ } -> Some pw_dir
    | exception Not_found -> Result.to_option (Mesh_paths.home getenv)
  in
  let shells = Hashtbl.create 16 in
  let ( let* ) = Option.bind in
  let* socket = Mesh_platform.client_socket_path ~home () in
  let reply =
    try
      (* An environment variable that selects the Eio backend must not change
         the availability of this credential check. *)
      Eio_posix.run @@ fun env ->
      Eio.Time.Timeout.run_exn
        (Eio.Time.Timeout.seconds (Eio.Stdenv.mono_clock env) 5.)
      @@ fun () ->
      Eio.Switch.run @@ fun sw ->
      let stream = Eio.Net.connect ~sw (Eio.Stdenv.net env) (`Unix socket) in
      Eio.Flow.copy_string
        (Mesh_wire.encode { kind = 'C'; payload = {|{"op":"list"}|} })
        stream;
      let frame = Mesh_pty_support.Mesh_pty_protocol.read_frame stream in
      Yojson.Safe.from_string frame.payload
    with
    | Eio.Io _ | Eio.Time.Timeout | Unix.Unix_error _ | End_of_file
    | Yojson.Json_error _ | Invalid_argument _ | Stack_overflow
    ->
      `Null
  in
  let add_session = function
    | `Assoc fields -> (
        match (List.assoc_opt "pid" fields, List.assoc_opt "name" fields) with
        | Some (`Int pid), Some (`String name) when name <> "" ->
            Hashtbl.replace shells pid name
        | _ -> ())
    | _ -> ()
  in
  match reply with
  | `List rows ->
      List.iter add_session rows;
      let rec find pid =
        if pid <= 1 then None
        else
          match Hashtbl.find_opt shells pid with
          | Some _ as name -> name
          | None -> (
              match Mesh_platform.process pid with
              | Ok process when process.ppid <> pid -> find process.ppid
              | Ok _ | Error _ -> None)
      in
      find (Unix.getpid ())
  | _ -> None

let env_token name =
  getenv name |> Option.value ~default:"" |> Mesh_python_text.strip

let credential conf =
  let session_only = "in a mesh session only the session token is used" in
  let token = env_token "MESH_SESSION_TOKEN" in
  let make kind token =
    match kind token with Ok auth -> auth | Error reason -> fail reason
  in
  if token <> "" then (true, make Mesh_local_http.session token)
  else (
    if env_token "MESH_SESSION" <> "" then
      fail ("MESH_SESSION is set but MESH_SESSION_TOKEN is not; " ^ session_only);
    (match session_by_ancestry () with
    | Some name ->
        fail
          (Printf.sprintf
             "this runs in mesh session %s but MESH_SESSION_TOKEN is not set; \
              %s"
             name session_only)
    | None -> ());
    let token_file = Filename.concat conf "token" in
    let token =
      try In_channel.with_open_text token_file In_channel.input_all
      with Sys_error reason ->
        fail ("session-mesh token not found (" ^ reason ^ ")")
    in
    (false, make Mesh_local_http.bearer (Mesh_python_text.strip token)))

let open_document ~port ~by_session auth ~target ~reload ~watch =
  let json_body =
    Yojson.Safe.to_string
      (`Assoc
         [
           ("target", `String target);
           ("reload", `Bool reload);
           ("watch", `Bool watch);
         ])
  in
  match
    Mesh_local_http.post ~timeout:5. ~json_body ~port ~route:"/api/open" auth ()
  with
  | Success body -> (
      let target =
        match Yojson.Safe.from_string body with
        | `Assoc fields -> List.assoc_opt "target" fields
        | _ | (exception Yojson.Json_error _) -> None
      in
      match target with
      | Some (`String target) ->
          Printf.printf "opened in session-mesh: %s\n" target
      | _ -> fail "session-mesh is not responding (invalid open reply)")
  | Refused { status = 401; _ } when by_session ->
      fail
        "session token refused (the session is closed or MESH_SESSION_TOKEN is \
         out of date)"
  | Refused { reason; body; _ } ->
      die ("mesh-open : " ^ if body = "" then reason else body)
  | Unreadable reason | No_answer reason | Failed reason ->
      fail ("session-mesh is not responding (" ^ reason ^ ")")

let () =
  let conf = value (Mesh_paths.conf_dir getenv) in
  ignore (value (Mesh_paths.cache_dir getenv));
  let file, reload, watch = parse (List.tl (Array.to_list Sys.argv)) in
  let lower_file = String.lowercase_ascii file in
  if
    String.starts_with ~prefix:"http://" lower_file
    || String.starts_with ~prefix:"https://" lower_file
  then usage_error "a web page does not open in a panel; open it in a browser";
  let target =
    try resolve_path file with
    | Unix.Unix_error (code, _, path) ->
        fail (path ^ ": " ^ Unix.error_message code)
    | Sys_error reason -> fail reason
  in
  let by_session, auth = credential conf in
  let port = value (Mesh_paths.port getenv) in
  open_document ~port ~by_session auth ~target ~reload ~watch
