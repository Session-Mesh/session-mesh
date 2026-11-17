(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

module P = Mesh_resume_profile
module T = Mesh_runner_target

type file = { path : string; digest : string; stat : Unix.stats }
type cwd_custody = Runner_held of Eio.Fs.dir_ty Eio.Path.t | Agent_after_drop

type entry = {
  cwd_custody : cwd_custody;
  cwd : string;
  arguments : string list;
  environment : string array;
  files : file list;
}

type t = { entries : (string * entry) list; new_claude : entry option }

let require b = if not b then invalid_arg "closed startup resume preset"

let keys expected = function
  | `Assoc fields ->
      require
        (List.sort String.compare (List.map fst fields)
        = List.sort String.compare expected);
      fields
  | _ -> invalid_arg "closed startup resume preset"

let string fields key = Yojson.Basic.Util.to_string (List.assoc key fields)

let strings = function
  | `List xs -> List.map Yojson.Basic.Util.to_string xs
  | _ -> invalid_arg "closed startup resume preset"

let hex s =
  String.length s = 64
  && String.for_all (function '0' .. '9' | 'a' .. 'f' -> true | _ -> false) s

(* Current sealed standalone Claude/Codex releases exceed 256 MiB. Hash them
   with a streaming reader, but keep a strict per-file upper bound. *)
let maximum_launcher_bytes = 536870912

let identity a b =
  a.Unix.st_dev = b.Unix.st_dev
  && a.st_ino = b.st_ino && a.st_uid = b.st_uid && a.st_perm = b.st_perm
  && a.st_size = b.st_size

(* An unmapped host root appears as the overflow UID in subordinate-ID test
   namespaces. This is accepted only when the namespace root itself has that
   owner; the agent UID must never be the overflow UID. *)
let trusted_root_uid uid =
  uid = 0 || (uid = 65534 && (Unix.lstat "/").Unix.st_uid = 65534)

let rec ancestors path =
  let stat = Unix.lstat path in
  require
    (stat.st_kind = Unix.S_DIR
    && (trusted_root_uid stat.st_uid || stat.st_uid = Unix.geteuid ())
    && (stat.st_perm land 0o022 = 0
       || (trusted_root_uid stat.st_uid && stat.st_perm land 0o1000 <> 0)));
  if path <> "/" then ancestors (Filename.dirname path)

let read_file ~private_file ~maximum path expected =
  require
    ((not (Filename.is_relative path))
    && String.length path <= 4096
    && (not (String.contains path '\000'))
    && Unix.realpath path = path
    && hex expected);
  ancestors (Filename.dirname path);
  let before = Unix.lstat path in
  require
    (before.st_kind = Unix.S_REG
    && before.st_size >= 0 && before.st_size <= maximum
    &&
    if private_file then
      before.st_uid = Unix.geteuid () && before.st_perm land 0o077 = 0
    else
      (trusted_root_uid before.st_uid || before.st_uid = Unix.geteuid ())
      && before.st_perm land 0o022 = 0);
  let fd = Unix.openfile path [ Unix.O_RDONLY; Unix.O_CLOEXEC ] 0 in
  Fun.protect
    ~finally:(fun () -> Unix.close fd)
    (fun () ->
      require (identity before (Unix.fstat fd));
      let hash = ref (Digestif.SHA256.init ()) in
      let output = if private_file then Some (Buffer.create 4096) else None in
      let buffer = Bytes.create 65536 in
      let rec loop total =
        let count = Unix.read fd buffer 0 (Bytes.length buffer) in
        if count <> 0 then (
          require (count <= maximum - total);
          let data = Bytes.sub_string buffer 0 count in
          hash := Digestif.SHA256.feed_string !hash data;
          Option.iter (fun b -> Buffer.add_string b data) output;
          loop (total + count))
      in
      loop 0;
      require
        (identity before (Unix.fstat fd) && identity before (Unix.lstat path));
      require (Digestif.SHA256.(to_hex (get !hash)) = expected);
      ( Option.map Buffer.contents output,
        { path; digest = expected; stat = before } ))

let pinned_file json =
  let fields = keys [ "path"; "sha256" ] json in
  let path = string fields "path" and expected = string fields "sha256" in
  snd
    (read_file ~private_file:false ~maximum:maximum_launcher_bytes path expected)

let launcher kind json =
  let fields = keys [ "executable"; "entrypoint"; "environment" ] json in
  let executable = pinned_file (List.assoc "executable" fields) in
  require (executable.stat.st_perm land 0o111 <> 0);
  let prefix =
    match List.assoc "entrypoint" fields with
    | `List files -> List.map pinned_file files
    | _ -> invalid_arg "closed entrypoint"
  in
  let expected = match kind with P.Claude -> "claude" | P.Codex -> "codex" in
  let basename = Filename.basename executable.path in
  (match prefix with
  | [] -> require (basename = expected)
  | [ script ] ->
      require (basename = "node" || basename = "nodejs");
      let suffix =
        match kind with
        | P.Claude -> "/@anthropic-ai/claude-code/cli.js"
        | P.Codex -> "/@openai/codex/bin/codex.js"
      in
      require (String.ends_with ~suffix script.path)
  | _ -> invalid_arg "closed entrypoint");
  let environment = strings (List.assoc "environment" fields) in
  let names =
    List.map
      (fun item ->
        require
          (String.length item <= 16384 && not (String.contains item '\000'));
        match String.index_opt item '=' with
        | Some i ->
            let name = String.sub item 0 i in
            require
              (List.mem name
                 [
                   "HOME";
                   "USER";
                   "LOGNAME";
                   "PATH";
                   "SSH_AUTH_SOCK";
                   "TERM";
                   "LANG";
                   "LC_ALL";
                   "XDG_CONFIG_HOME";
                   "XDG_DATA_HOME";
                 ]);
            name
        | None -> invalid_arg "closed environment")
      environment
  in
  require
    (List.length environment <= 16
    && List.length (List.sort_uniq String.compare names) = List.length names);
  ( executable :: prefix,
    executable.path :: List.map (fun f -> f.path) prefix,
    Array.of_list environment )

let load ?(agent_after_drop = false) ~path ~expected_sha256 ~hold_directory () =
  let parent = Filename.dirname path in
  let parent_info = Unix.lstat parent in
  (* A root-owned protected catalogue directory is deliberately not a private
     native-owned CWD. The file remains native-owned 0600 and [read_file]
     verifies its entire ancestry, opened inode and pinned content digest.
     Keep the original held-directory guard for native-owned parents. *)
  if
    not
      (parent_info.st_kind = Unix.S_DIR
      && trusted_root_uid parent_info.st_uid
      && parent_info.st_perm land 0o022 = 0)
  then ignore (hold_directory parent);
  let bytes, _ =
    read_file ~private_file:true ~maximum:4194304 path expected_sha256
  in
  let json = Yojson.Basic.from_string (Option.get bytes) in
  let fields =
    match json with
    | `Assoc fields when List.assoc_opt "version" fields = Some (`Int 1) ->
        keys [ "version"; "launchers"; "presets" ] json
    | `Assoc fields when List.assoc_opt "version" fields = Some (`Int 2) ->
        keys [ "version"; "launchers"; "presets"; "new_claude" ] json
    | _ -> invalid_arg "closed startup resume preset"
  in
  let launchers =
    match List.assoc "launchers" fields with
    | `Assoc entries ->
        let names = List.map fst entries in
        require
          (List.for_all (fun n -> n = "claude" || n = "codex") names
          && List.length (List.sort_uniq String.compare names)
             = List.length names);
        List.map
          (fun (name, value) ->
            ( name,
              launcher (if name = "claude" then P.Claude else P.Codex) value ))
          entries
    | _ -> invalid_arg "closed launchers"
  in
  let presets =
    match List.assoc "presets" fields with
    | `List xs -> xs
    | _ -> invalid_arg "closed presets"
  in
  require (List.length presets <= 200);
  let entries =
    List.map
      (fun json ->
        let fields = keys [ "source"; "receipt"; "cwd"; "profile" ] json in
        let source = string fields "source"
        and receipt = string fields "receipt"
        and cwd = string fields "cwd" in
        require
          (String.length source <= 2048
          && String.length receipt = 81
          && receipt.[64] = ':');
        require (hex (String.sub receipt 0 64));
        require
          (String.for_all
             (function '0' .. '9' | 'a' .. 'f' -> true | _ -> false)
             (String.sub receipt 65 16)
          && String.sub receipt 65 16 <> String.make 16 '0');
        let target =
          match T.decode_metadata source with
          | Ok t -> t
          | Error _ -> invalid_arg "closed source"
        in
        require (T.encode_metadata target = source);
        let profile =
          match P.of_json (List.assoc "profile" fields) with
          | Ok p -> p
          | Error _ -> invalid_arg "closed profile"
        in
        let files, prefix, environment =
          match
            List.assoc_opt
              (match P.kind profile with
              | P.Claude -> "claude"
              | P.Codex -> "codex")
              launchers
          with
          | Some entry -> entry
          | None -> invalid_arg "unconfigured agent"
        in
        let cwd_custody =
          if agent_after_drop then (
            require
              ((not (Filename.is_relative cwd))
              && String.length cwd <= 4096
              && not (String.contains cwd '\000'));
            Agent_after_drop)
          else Runner_held (hold_directory cwd)
        in
        ( P.selector profile ~source ~receipt ~cwd,
          {
            cwd_custody;
            cwd;
            arguments = prefix @ P.arguments profile;
            environment;
            files;
          } ))
      presets
  in
  require
    (List.length (List.sort_uniq String.compare (List.map fst entries))
    = List.length entries);
  let new_claude =
    match List.assoc_opt "new_claude" fields with
    | None | Some `Null -> None
    | Some json ->
        let f = keys [ "cwd" ] json in
        let cwd = string f "cwd" in
        let files, prefix, environment =
          match List.assoc_opt "claude" launchers with
          | Some configured -> configured
          | None -> invalid_arg "unconfigured agent"
        in
        let cwd_custody =
          if agent_after_drop then (
            require
              ((not (Filename.is_relative cwd))
              && String.length cwd <= 4096
              && not (String.contains cwd '\000'));
            Agent_after_drop)
          else Runner_held (hold_directory cwd)
        in
        Some { cwd_custody; cwd; arguments = prefix; environment; files }
  in
  { entries; new_claude }

let canonical_uuid uuid =
  String.length uuid = 36
  && List.for_all (fun i -> uuid.[i] = '-') [ 8; 13; 18; 23 ]
  && String.exists
       (function '1' .. '9' | 'a' .. 'f' -> true | _ -> false)
       uuid
  && String.for_all
       (function '0' .. '9' | 'a' .. 'f' | '-' -> true | _ -> false)
       uuid
  && String.length (String.concat "" (String.split_on_char '-' uuid)) = 32

let find t selector =
  match List.assoc_opt selector t.entries with
  | Some entry -> Some entry
  | None when String.starts_with ~prefix:"start-claude-" selector ->
      let uuid = String.sub selector 13 (String.length selector - 13) in
      if not (canonical_uuid uuid) then None
      else
        Option.map
          (fun entry ->
            {
              entry with
              arguments = entry.arguments @ [ "--session-id"; uuid ];
            })
          t.new_claude
  | None -> None

let directory e =
  match e.cwd_custody with
  | Runner_held held -> Some held
  | Agent_after_drop -> None

let cwd e = e.cwd
let arguments e = e.arguments
let environment e = Array.copy e.environment
let launcher_files e = List.map (fun file -> file.path) e.files

let revalidate_existing e =
  (match e.cwd_custody with
  | Agent_after_drop -> ()
  | Runner_held held ->
      let original = Unix.lstat e.cwd in
      let stat = Eio.Path.stat ~follow:false held in
      require
        (original.Unix.st_kind = Unix.S_DIR
        && Unix.realpath e.cwd = e.cwd
        && stat.Eio.File.Stat.dev = Int64.of_int original.st_dev
        && stat.ino = Int64.of_int original.st_ino
        && stat.kind = `Directory
        && stat.uid = Int64.of_int (Unix.geteuid ())
        && stat.perm land 0o077 = 0));
  List.iter
    (fun file ->
      let _, current =
        read_file ~private_file:false ~maximum:maximum_launcher_bytes file.path
          file.digest
      in
      require (identity current.stat file.stat))
    e.files

let revalidate e =
  try revalidate_existing e
  with Eio.Io _ -> invalid_arg "closed startup resume custody"
