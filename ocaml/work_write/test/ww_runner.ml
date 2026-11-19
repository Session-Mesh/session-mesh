(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

module W = Mesh_worklog
module U = Yojson.Safe.Util

type repo = { home : string; wl_home : string }
type result = { code : int; out : string; err : string }

let counter = ref 0
let write_exe = lazy (Unix.realpath (Sys.getenv "WORK_WRITE_EXE"))
let read_exe = lazy (Unix.realpath (Sys.getenv "WORK_READ_EXE"))

let temp_dir prefix =
  incr counter;
  let dir =
    Filename.concat (Filename.get_temp_dir_name ())
      (Printf.sprintf "%s-%d-%d-%d" prefix (Unix.getpid ()) !counter (Random.bits ()))
  in
  W.Appendfile.mkdir_p dir;
  dir

let read_file path = In_channel.with_open_bin path In_channel.input_all
let write_file path text = Out_channel.with_open_bin path (fun oc -> output_string oc text)

let rec copy_tree src dst =
  if Sys.is_directory src then begin
    W.Appendfile.mkdir_p dst;
    Array.iter (fun n -> copy_tree (Filename.concat src n) (Filename.concat dst n)) (Sys.readdir src)
  end
  else write_file dst (read_file src)

let qid i = Printf.sprintf "N-0000a%03x" i

let question_line i =
  Printf.sprintf
    {|{"ts":"2026-11-08T09:00:00Z","task":"T-3c4d","type":"question","id":"%s","text":"Question %d?","agent":"claude","session":"asking"}|}
    (qid i) i

let fixture ?(questions = 2) ?(lines = []) () =
  let root = temp_dir "work-write" in
  let wl_home = Filename.concat root "data" and home = Filename.concat root "home" in
  copy_tree "../../worklog/test/fixture" wl_home;
  W.Appendfile.mkdir_p home;
  let all = List.init questions question_line @ lines in
  write_file (Filename.concat (Filename.concat wl_home "events") "2026-11.hostq.jsonl") (String.concat "\n" all ^ "\n");
  { home; wl_home }

let request question text =
  Yojson.Safe.to_string (`Assoc [ ("op", `String "answer"); ("args", `Assoc [ ("question", `String question); ("text", `String text) ]) ])

let environment ?(env = []) repo =
  let base =
    [
      ("PATH", try Sys.getenv "PATH" with Not_found -> "/usr/bin:/bin");
      ("HOME", repo.home);
      ("WL_HOME", repo.wl_home);
      ("WL_HOST", "ownerhost");
    ]
  in
  let base = List.filter (fun (k, _) -> not (List.mem_assoc k env)) base in
  Array.of_list (List.map (fun (k, v) -> k ^ "=" ^ v) (base @ env))

let start ?env ?(args = [ "--request" ]) ~exe repo input =
  let dir = temp_dir "work-write-io" in
  let path name = Filename.concat dir name in
  write_file (path "in") input;
  let open_out name = Unix.openfile (path name) [ Unix.O_WRONLY; Unix.O_CREAT ] 0o600 in
  let out_fd = open_out "out" and err_fd = open_out "err" in
  let in_fd = Unix.openfile (path "in") [ Unix.O_RDONLY ] 0 in
  let exe = Lazy.force exe in
  let pid = Unix.create_process_env exe (Array.of_list (exe :: args)) (environment ?env repo) in_fd out_fd err_fd in
  List.iter Unix.close [ out_fd; err_fd; in_fd ];
  fun () ->
    let _, status = Unix.waitpid [] pid in
    let code = match status with Unix.WEXITED c -> c | _ -> -1 in
    { code; out = read_file (path "out"); err = read_file (path "err") }

let run ?env ?args repo input = start ?env ?args ~exe:write_exe repo input ()
let spawn repo input = start ~exe:write_exe repo input

let json r =
  match String.split_on_char '\n' r.out with
  | [ line; "" ] -> Yojson.Safe.from_string line
  | _ -> Alcotest.failf "standard output is not exactly one line: %S" r.out

let questions repo =
  let r = start ~exe:read_exe repo {|{"op":"task","args":{"id":"T-3c4d"}}|} () in
  if r.code <> 0 then Alcotest.failf "work-read: exit %d: %s" r.code r.out;
  U.to_list (U.member "questions" (json r))

let answer_events repo =
  let dir = Filename.concat repo.wl_home "events" in
  Sys.readdir dir |> Array.to_list |> List.sort compare
  |> List.concat_map (fun f -> String.split_on_char '\n' (read_file (Filename.concat dir f)))
  |> List.filter_map (fun line ->
         match Yojson.Safe.from_string line with
         | `Assoc fields as j when List.assoc_opt "type" fields = Some (`String "answer") -> Some j
         | _ -> None
         | exception Yojson.Json_error _ -> None)

let tree_state dir =
  let rec walk path =
    match Unix.lstat path with
    | { Unix.st_kind = Unix.S_DIR; _ } ->
        (path, 0) :: List.concat_map (fun n -> walk (Filename.concat path n)) (Array.to_list (Sys.readdir path))
    | st -> [ (path, st.Unix.st_size) ]
    | exception Unix.Unix_error _ -> []
  in
  List.sort compare (walk dir)
