(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

type t = {
  root : string;
  host : string;
  now : unit -> int;
  rng : Random.State.t;
  commit : bool;
  lock_timeout : float;
  warn : string -> unit;
}

(* One character per code point: lowercase ASCII letters, digits and [-] are kept,
   everything else becomes [-] (continuation bytes of a code point are dropped). *)
let sanitize_host raw =
  let buf = Buffer.create (String.length raw) in
  String.iter
    (fun c ->
      if Char.code c land 0xC0 <> 0x80 then begin
        let c = Char.lowercase_ascii c in
        Buffer.add_char buf
          (if (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c = '-' then c else '-')
      end)
    raw;
  if Buffer.length buf = 0 then "host" else Buffer.contents buf

(* The system host name is cut at its first dot; [WL_HOST] is not. *)
let host_name raw =
  sanitize_host (match String.index_opt raw '.' with Some i -> String.sub raw 0 i | None -> raw)

let default_lock_timeout = 30.0

(* A non-finite timeout (nan, inf) would wait forever: use the default. *)
let sane_timeout seconds =
  if Float.is_finite seconds then Float.max 0.0 seconds else default_lock_timeout

let make ~root ?host ?(now = fun () -> int_of_float (Unix.time ())) ?rng ?(commit = true)
    ?(lock_timeout = default_lock_timeout) ?(warn = fun _ -> ()) () =
  let host = match host with Some h -> sanitize_host h | None -> host_name (Unix.gethostname ()) in
  let rng = match rng with Some r -> r | None -> Random.State.make_self_init () in
  { root; host; now; rng; commit; lock_timeout = sane_timeout lock_timeout; warn }

let events_dir t = Filename.concat t.root "events"
let tasks_dir t = Filename.concat t.root "tasks"
let taxonomy_path t = Filename.concat t.root "taxonomy.yaml"
let lock_path t = Filename.concat t.root ".wl.lock"

let non_empty getenv name =
  match getenv name with Some "" | None -> None | Some v -> Some v

(* [home] is only evaluated when needed: [WL_HOME] may be absolute. *)
let expand_home ~home raw =
  let n = String.length raw in
  if raw = "~" then home ()
  else if n >= 2 && String.sub raw 0 2 = "~/" then home () ^ String.sub raw 1 (n - 1)
  else if n >= 2 && raw.[0] = '~' then begin
    (* ~user or ~user/rest, as Python's expanduser *)
    let stop = match String.index_opt raw '/' with Some i -> i | None -> n in
    match Unix.getpwnam (String.sub raw 1 (stop - 1)) with
    | entry when entry.Unix.pw_dir <> "" -> entry.Unix.pw_dir ^ String.sub raw stop (n - stop)
    | _ | exception Not_found -> raw
  end
  else raw

(* The home directory: [HOME], else the account database; never empty. *)
let home_dir getenv =
  match non_empty getenv "HOME" with
  | Some h -> h
  | None -> (
      match (Unix.getpwuid (Unix.getuid ())).Unix.pw_dir with
      | "" -> Err.fail Err.Repo "cannot determine the home directory (HOME is empty); set WL_HOME"
      | dir -> dir
      | exception Not_found -> Err.fail Err.Repo "cannot determine the home directory (HOME is empty); set WL_HOME")

let is_root dir = Safefs.is_file_following (Filename.concat dir "taxonomy.yaml")

let resolve_root getenv =
  let home () = home_dir getenv in
  match non_empty getenv "WL_HOME" with
  | Some raw -> expand_home ~home raw
  | None -> (
      let home = home () in
      let data = Filename.concat home "worklog-data"
      and legacy = Filename.concat home "worklog" in
      match (is_root data, is_root legacy) with
      | true, true ->
          Err.fail Err.Repo
            (Printf.sprintf
               "ambiguous worklog repos: both %s and %s are worklog repos; set WL_HOME" data
               legacy)
      | true, false -> data
      | false, true -> legacy
      | false, false ->
          Err.fail Err.Repo
            (Printf.sprintf
               "no worklog data repo found (%s or %s with taxonomy.yaml); set WL_HOME" data
               legacy))

let clock_of getenv =
  match non_empty getenv "WL_NOW" with
  | None -> None
  | Some text -> (
      match Tstamp.parse text with
      | Some seconds -> Some (fun () -> seconds)
      | None -> Err.usage "WL_NOW must be YYYY-MM-DDTHH:MM:SSZ, got %S" text)

let timeout_of getenv =
  match Option.bind (non_empty getenv "WL_LOCK_TIMEOUT") float_of_string_opt with
  | Some seconds -> seconds
  | None -> default_lock_timeout

let of_env ?(getenv = Sys.getenv_opt) ?commit ?warn () =
  Err.protect (fun () ->
      let root = resolve_root getenv in
      if not (is_root root) then
        Err.fail Err.Repo
          (Printf.sprintf "not a worklog repo (no taxonomy.yaml): %s; set WL_HOME" root);
      make ~root ?host:(non_empty getenv "WL_HOST") ?now:(clock_of getenv) ?commit
        ~lock_timeout:(timeout_of getenv) ?warn ())
