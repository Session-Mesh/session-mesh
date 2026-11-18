(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

module C = Mesh_update_check
module R = Mesh_update_report

type t = { mutable latest : Yojson.Basic.t }

let create () = { latest = `Null }
let latest t = t.latest
let tick = 600.
let request_limit = 30.

let answer ~home = function
  | R.Available _ as outcome -> Yojson.Safe.to_basic (R.to_json ~home outcome)
  | _ -> `Null

let describe = function
  | R.Disabled -> "turned off"
  | _ -> "not a release install"

let loop t ~getenv ~installation ~now ~sleep ~fetch ~log =
  let debug = getenv "MESH_UPDATE_DEBUG" = Some "1" in
  let note text = if debug then log ("update check: " ^ text) in
  let home = getenv "HOME" in
  let was_off = ref false in
  let attempted = ref None in
  let counting ~etag =
    attempted := Some (now ());
    fetch ~etag
  in
  let due current =
    match !attempted with
    | None -> true
    | Some last -> current < last || current -. last >= C.period
  in
  let announced = ref false in
  let step () =
    let current = now () in
    (* the settings file is read at every look, so a change applies without a
       restart of the host *)
    let settings, settings_problem = R.with_settings getenv in
    Option.iter note settings_problem;
    let outcome, problem =
      R.check ~getenv:settings ~installation:(installation ())
        ~request:(due current) ~force:false ~now:current ~fetch:counting
    in
    Option.iter note problem;
    t.latest <- answer ~home outcome;
    (match (outcome, !announced) with
    | R.Available _, false ->
        announced := true;
        Option.iter log (R.line ~home outcome)
    | _ -> ());
    outcome
  in
  let rec go () =
    match
      (try Ok (step ()) with
      | Eio.Cancel.Cancelled _ as cancelled -> raise cancelled
      | failure -> Error (Printexc.to_string failure))
    with
    | Ok (R.Unknown_version as outcome) -> note (describe outcome)
    | Ok R.Disabled ->
        (* off for now: nothing is requested and nothing is shown, but the file
           may turn it on again *)
        if not !was_off then note (describe R.Disabled);
        was_off := true;
        sleep tick;
        go ()
    | Ok _ ->
        was_off := false;
        sleep tick;
        go ()
    | Error text ->
        note ("failed: " ^ text);
        sleep tick;
        go ()
  in
  go ()

let run_curl ~mgr ~clock ~seconds arguments =
  Eio.Switch.run @@ fun sw ->
  let reader, writer = Eio_unix.pipe sw in
  (* Standard input and error are the null device itself, not flows the host
     copies: no fiber and no buffer in the host, and no descendant of the child
     can hold anything of the host's but the 64-byte output pipe. *)
  let null =
    Eio_unix.Fd.of_unix ~sw ~close_unix:true
      (Unix.openfile "/dev/null" [ Unix.O_RDWR; Unix.O_CLOEXEC ] 0)
  in
  let out = Eio_unix.Resource.fd_opt writer in
  let spawned =
    match out with
    | None -> Error (Failure "the output pipe has no descriptor")
    | Some out -> (
        try
          Ok
            (Eio_unix.Process.spawn_unix ~sw mgr
               ~fds:
                 [
                   (0, null, `Blocking); (1, out, `Blocking); (2, null, `Blocking);
                 ]
               arguments)
        with Eio.Io _ as failure -> Error failure)
  in
  Option.iter Eio_unix.Fd.close out;
  match spawned with
  | Error _ -> (Unix.WEXITED 127, "") (* curl is not there: a shell's status *)
  | Ok process -> (
      let finished () =
        match Eio.Buf_read.parse ~max_size:64 Eio.Buf_read.take_all reader with
        | Ok text -> Some (Eio.Process.await process, String.trim text)
        | Error _ -> None
      in
      let kill_and_reap () =
        Eio.Cancel.protect (fun () ->
            (try Eio.Process.signal process Sys.sigkill with _ -> ());
            ignore (Eio.Process.await process))
      in
      match
        Eio.Time.Timeout.run (Eio.Time.Timeout.seconds clock seconds)
          (fun () ->
            try Ok (finished ())
            with Eio.Cancel.Cancelled _ as cancelled ->
              kill_and_reap ();
              raise cancelled)
      with
      | Ok (Some (`Exited code, text)) -> (Unix.WEXITED code, text)
      | Ok (Some (`Signaled signal, text)) -> (Unix.WSIGNALED signal, text)
      | Ok None | Error `Timeout ->
          kill_and_reap ();
          (Unix.WSIGNALED Sys.sigkill, ""))

let start t ~sw ~mgr ~clock ~log =
  let getenv = Sys.getenv_opt in
  let own = R.installation_of_executable Sys.executable_name in
  let installation () = Option.map R.following_current own in
  let fetch ~etag =
    match R.cache_directory getenv with
    | Some directory ->
        R.fetch_with
          ~run:(run_curl ~mgr ~clock ~seconds:request_limit)
          ~directory ~etag
    | None -> C.Failed "no cache directory (MESH_CACHE_DIR or HOME)"
  in
  Eio.Fiber.fork_daemon ~sw (fun () ->
      Option.iter
        (fun directory -> R.clean_stale ~directory)
        (R.cache_directory getenv);
      loop t ~getenv ~installation ~now:Unix.gettimeofday
        ~sleep:(Eio.Time.Mono.sleep clock) ~fetch ~log;
      `Stop_daemon)
