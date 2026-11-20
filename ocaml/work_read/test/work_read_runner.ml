(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

module W = Mesh_worklog

type repo = { home : string; wl_home : string }
type result = { code : int; out : string; err : string }

let counter = ref 0
let exe = lazy (Unix.realpath (Sys.getenv "WORK_READ_EXE"))

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

let copy_fixture () =
  let root = temp_dir "work-read" in
  let wl_home = Filename.concat root "data" and home = Filename.concat root "home" in
  copy_tree "../../worklog/test/fixture" wl_home;
  W.Appendfile.mkdir_p home;
  { home; wl_home }

let append_events repo lines =
  Out_channel.with_open_gen [ Open_wronly; Open_creat; Open_append; Open_binary ] 0o644
    (Filename.concat (Filename.concat repo.wl_home "events") "2026-11.hostc.jsonl")
    (fun oc -> output_string oc (String.concat "\n" lines ^ "\n"))

(* fork and exec by hand, with [blocked] signals blocked in the child: the
   signal mask is inherited across exec, as from a launcher that blocks them. *)
let spawn_blocked ~blocked argv env stdin_fd out_fd err_fd =
  match Unix.fork () with
  | 0 -> (
      try
        ignore (Unix.sigprocmask Unix.SIG_BLOCK blocked);
        Unix.dup2 stdin_fd Unix.stdin;
        Unix.dup2 out_fd Unix.stdout;
        Unix.dup2 err_fd Unix.stderr;
        Unix.execve argv.(0) argv env
      with _ -> Unix._exit 127)
  | pid -> pid

let run ?(env = []) ?input ?(blocked = []) repo args =
  let base =
    [
      "PATH=" ^ (try Sys.getenv "PATH" with Not_found -> "/usr/bin:/bin");
      "HOME=" ^ repo.home;
      "WL_HOME=" ^ repo.wl_home;
      "WL_HOST=testhost";
      "WL_NOW=2026-11-10T00:00:00Z";
    ]
  in
  let extra_keys = List.map fst env in
  let base = List.filter (fun kv -> not (List.mem (String.sub kv 0 (String.index kv '=')) extra_keys)) base in
  let env = Array.of_list (base @ List.map (fun (k, v) -> k ^ "=" ^ v) env) in
  let out_path = Filename.concat (temp_dir "work-read-out") "out" and err_path = Filename.concat (temp_dir "work-read-err") "err" in
  let out_fd = Unix.openfile out_path [ Unix.O_WRONLY; Unix.O_CREAT ] 0o600 in
  let err_fd = Unix.openfile err_path [ Unix.O_WRONLY; Unix.O_CREAT ] 0o600 in
  let null =
    match input with
    | None -> Unix.openfile "/dev/null" [ Unix.O_RDONLY ] 0
    | Some text ->
        let in_path = Filename.concat (temp_dir "work-read-in") "in" in
        write_file in_path text;
        Unix.openfile in_path [ Unix.O_RDONLY ] 0
  in
  let argv = Array.of_list (Lazy.force exe :: args) in
  let pid =
    if blocked = [] then Unix.create_process_env (Lazy.force exe) argv env null out_fd err_fd
    else spawn_blocked ~blocked argv env null out_fd err_fd
  in
  List.iter Unix.close [ out_fd; err_fd; null ];
  let _, status = Unix.waitpid [] pid in
  let code = match status with Unix.WEXITED c -> c | _ -> -1 in
  { code; out = read_file out_path; err = read_file err_path }

let json r =
  match String.split_on_char '\n' r.out with
  | [ line; "" ] -> Yojson.Safe.from_string line
  | _ -> Alcotest.failf "standard output is not exactly one line: %S" r.out

let rec tree_state dir =
  Sys.readdir dir |> Array.to_list |> List.sort compare
  |> List.concat_map (fun n ->
         let p = Filename.concat dir n in
         let st = Unix.lstat p in
         let here = (p, st.Unix.st_mtime, st.Unix.st_size) in
         if st.Unix.st_kind = Unix.S_DIR then here :: tree_state p else [ here ])
