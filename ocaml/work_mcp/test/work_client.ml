(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(* A real work-mcp process driven over stdio, against a temporary fictional
   data repository. *)

module W = Mesh_worklog

let exe = lazy (Unix.realpath (Sys.getenv "WORK_MCP_EXE"))
let secret = "SECRET-TOKEN-do-not-leak-0123456789"
let counter = ref 0

let temp_dir prefix =
  incr counter;
  let dir =
    Filename.concat (Filename.get_temp_dir_name ())
      (Printf.sprintf "%s-%d-%d-%d" prefix (Unix.getpid ()) !counter (Random.bits ()))
  in
  W.Appendfile.mkdir_p dir;
  dir

let read_file path = In_channel.with_open_bin path In_channel.input_all

let contains haystack needle =
  let n = String.length needle and m = String.length haystack in
  let rec at i = i + n <= m && (String.sub haystack i n = needle || at (i + 1)) in
  n = 0 || at 0

(* Everything every server printed or logged, checked for leaks at the end. *)
let transcript = Buffer.create 65536

type t = {
  pid : int;
  oc : out_channel;
  ic : in_channel;
  stderr_path : string;
  mutable next_id : int;
}

type reply = { is_error : bool; json : Yojson.Safe.t; text : string }

let base_env ?(extra = []) ?(unset = []) ~home ~wl_home ~session () =
  let keys = List.map (fun kv -> String.sub kv 0 (String.index kv '=')) extra @ unset in
  let key kv = String.sub kv 0 (String.index kv '=') in
  let base =
  [|
    "PATH=" ^ (try Sys.getenv "PATH" with Not_found -> "/usr/bin:/bin");
    "HOME=" ^ home;
    "WL_HOME=" ^ wl_home;
    "WL_HOST=testhost";
    "CLAUDECODE=1";
    "MESH_SESSION=" ^ session;
    "MESH_SESSION_TOKEN=" ^ secret;
    "GIT_CONFIG_GLOBAL=/dev/null";
    "GIT_AUTHOR_NAME=test";
    "GIT_AUTHOR_EMAIL=test@example.invalid";
    "GIT_COMMITTER_NAME=test";
    "GIT_COMMITTER_EMAIL=test@example.invalid";
  |]
  in
  Array.append
    (Array.of_list (List.filter (fun kv -> not (List.mem (key kv) keys)) (Array.to_list base)))
    (Array.of_list extra)

let live = ref []

let kill c =
  (try Unix.kill c.pid Sys.sigkill with Unix.Unix_error _ -> ());
  (try ignore (Unix.waitpid [] c.pid) with Unix.Unix_error _ -> ())

let () = at_exit (fun () -> List.iter kill !live)

let send c json =
  let line = Yojson.Safe.to_string json in
  output_string c.oc (line ^ "\n");
  flush c.oc

let recv c =
  let line = input_line c.ic in
  Buffer.add_string transcript line;
  Buffer.add_char transcript '\n';
  Yojson.Safe.from_string line

let request c meth params =
  c.next_id <- c.next_id + 1;
  `Assoc [ ("jsonrpc", `String "2.0"); ("id", `Int c.next_id); ("method", `String meth); ("params", params) ]

let rpc c meth params =
  send c (request c meth params);
  recv c

(* [wrap]: a command line the server runs under, the server's path appended (a shell that sets a limit first). *)
let start ?(session = "probe-session") ?extra ?unset ?cwd ?(wrap = []) ~wl_home ~home () =
  let in_r, in_w = Unix.pipe ~cloexec:true () in
  let out_r, out_w = Unix.pipe ~cloexec:true () in
  let stderr_path = Filename.concat home (Printf.sprintf "stderr-%s.log" session) in
  let err = Unix.openfile stderr_path [ Unix.O_WRONLY; Unix.O_CREAT; Unix.O_TRUNC ] 0o600 in
  let exe = Lazy.force exe in
  let previous = Sys.getcwd () in
  Option.iter Unix.chdir cwd;
  let pid =
    let argv = Array.of_list (wrap @ [ exe ]) in
    Unix.create_process_env argv.(0) argv (base_env ?extra ?unset ~home ~wl_home ~session ()) in_r out_w err
  in
  Unix.chdir previous;
  List.iter Unix.close [ in_r; out_w; err ];
  let c =
    { pid; oc = Unix.out_channel_of_descr in_w; ic = Unix.in_channel_of_descr out_r; stderr_path; next_id = 0 }
  in
  live := c :: !live;
  c

let initialize c =
  let reply =
    rpc c "initialize"
      (`Assoc
        [
          ("protocolVersion", `String "2025-06-18");
          ("capabilities", `Assoc []);
          ("clientInfo", `Assoc [ ("name", `String "test"); ("version", `String "1") ]);
        ])
  in
  send c (`Assoc [ ("jsonrpc", `String "2.0"); ("method", `String "notifications/initialized") ]);
  reply

let connect ?session ?extra ?unset ?cwd ?wrap ~wl_home ~home () =
  let c = start ?session ?extra ?unset ?cwd ?wrap ~wl_home ~home () in
  ignore (initialize c);
  c

let stop c =
  close_out_noerr c.oc;
  kill c;
  live := List.filter (fun x -> x != c) !live;
  Buffer.add_string transcript (read_file c.stderr_path)

let member k = function `Assoc l -> (try List.assoc k l with Not_found -> `Null) | _ -> `Null

let reply_of response =
  match member "error" response with
  | `Null ->
      let result = member "result" response in
      let text =
        match member "content" result with
        | `List (first :: _) -> ( match member "text" first with `String s -> s | _ -> "")
        | _ -> ""
      in
      { is_error = member "isError" result = `Bool true; json = member "structuredContent" result; text }
  | err ->
      { is_error = true; json = `Null; text = (match member "message" err with `String s -> s | _ -> "error") }

let call_request c name args =
  request c "tools/call" (`Assoc [ ("name", `String name); ("arguments", args) ])

let call c name args =
  send c (call_request c name args);
  reply_of (recv c)

let ok c name args =
  let r = call c name args in
  if r.is_error then Alcotest.failf "%s failed: %s" name r.text;
  r.json

let error_code r = match member "code" (member "error" r.json) with `String s -> s | _ -> ""

(* A fictional repository: two categories of products, one tree. *)
let seed root =
  Result.get_ok (W.Init.init ~root ~product:"general" ());
  let ctx = W.Ctx.make ~root ~host:"seed" ~commit:false () in
  List.iter
    (fun (id, parent) -> Result.get_ok (W.Taxonomy_edit.add_product ctx ~id ~category:"main" ?parent ()))
    [ ("gateway", None); ("relay", None); ("relay-core", Some "relay") ]

let fresh () =
  let home = temp_dir "work-mcp-home" in
  let wl_home = Filename.concat home "data" in
  seed wl_home;
  (home, wl_home)

let str j k = match member k j with `String s -> s | _ -> Alcotest.failf "missing string %s in %s" k (Yojson.Safe.to_string j)
let items j k = match member k j with `List l -> l | _ -> Alcotest.failf "missing list %s in %s" k (Yojson.Safe.to_string j)

let events_text wl_home =
  let dir = Filename.concat wl_home "events" in
  Sys.readdir dir |> Array.to_list |> List.sort compare
  |> List.map (fun f -> read_file (Filename.concat dir f))
  |> String.concat ""

let event_lines wl_home =
  String.split_on_char '\n' (events_text wl_home) |> List.filter (fun l -> l <> "")

let assert_no_leaks ~what ~forbidden =
  let all = Buffer.contents transcript in
  List.iter
    (fun needle ->
      if contains all needle then Alcotest.failf "%s: %S appears in the server's output" what needle)
    forbidden

let with_server f =
  let home, wl_home = fresh () in
  let c = connect ~wl_home ~home () in
  Fun.protect ~finally:(fun () -> stop c) (fun () -> f c wl_home)
