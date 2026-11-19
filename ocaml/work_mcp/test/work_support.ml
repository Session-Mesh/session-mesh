(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(* Helpers of the hardening tests: checks for absolute paths, a checkout used
   as the server's working directory, and a stand-in for git on the PATH. *)

open Work_client
module W = Mesh_worklog

(* A "/" that starts an absolute path: it follows anything but a word
   character (so "and/or", "1/2", "a.b/c" and a URL's own slashes are not
   paths), or a flag glued to it ("-C/srv/x"), and a name, digit or dot
   follows. A path may start with a digit. A byte of a multi-byte character
   before the slash (a guillemet, a typographic quote) counts as punctuation. *)
let has_abs_path s =
  let n = String.length s in
  let alnum c = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') in
  let name_start c = alnum c || c = '.' || c = '_' || Char.code c >= 0x80 in
  let word_char c = alnum c || String.contains "._-/" c in
  let glued_flag i = i >= 2 && alnum s.[i - 1] && s.[i - 2] = '-' in
  let starts i =
    s.[i] = '/' && name_start s.[i + 1] && (i = 0 || (not (word_char s.[i - 1])) || glued_flag i)
  in
  let rec at i = i + 1 < n && (starts i || at (i + 1)) in
  at 0

(* Every JSON string of a value that is, or contains, an absolute path. *)
let rec absolute_paths = function
  | `String s -> if has_abs_path s || (s <> "" && s.[0] = '/') then [ s ] else []
  | `List l -> List.concat_map absolute_paths l
  | `Assoc l -> List.concat_map (fun (_, v) -> absolute_paths v) l
  | _ -> []

let assert_no_path ~what json =
  match absolute_paths json with
  | [] -> ()
  | p :: _ -> Alcotest.failf "%s: an absolute path is returned: %s" what p

let assert_no_path_text ~what text =
  if has_abs_path text then Alcotest.failf "%s: an absolute path is returned: %s" what text

let run_ok command = if Sys.command command <> 0 then Alcotest.failf "command failed: %s" command

(* A checkout in a fresh directory (its real path), for a server whose
   working directory is a repository root. *)
let checkout () =
  let dir = Unix.realpath (temp_dir "work-mcp-checkout") in
  run_ok (Printf.sprintf "git init -q %s" (Filename.quote dir));
  dir

let real_git () =
  let ic = Unix.open_process_in "command -v git" in
  let path = String.trim (input_line ic) in
  ignore (Unix.close_process_in ic);
  path

(* An executable first on the server's PATH: it logs its environment, fails
   every commit with a message holding an absolute path, and runs the real
   program otherwise. Returns its directory and the log file. *)
let stand_in_with ~message ~dir =
  let bin = Filename.concat dir "fakebin" in
  W.Appendfile.mkdir_p bin;
  let log = Filename.concat dir "child-env.log" in
  let script = Filename.concat bin "git" in
  Out_channel.with_open_bin script (fun oc ->
      output_string oc
        (Printf.sprintf
           "#!/bin/sh\nenv >> %s\ncase \" $* \" in\n  *\" commit \"*) echo \"%s\"; exit 1;;\nesac\nexec %s \"$@\"\n"
           (Filename.quote log) message (Filename.quote (real_git ()))));
  Unix.chmod script 0o755;
  (bin, log)

let stand_in ~dir =
  stand_in_with ~message:"fatal: Unable to create '/secret/place/.git/index.lock': File exists." ~dir

let path_with bin = "PATH=" ^ bin ^ ":" ^ (try Sys.getenv "PATH" with Not_found -> "/usr/bin:/bin")

let library_ctx ?(host = "owner-ui") ?now wl_home = W.Ctx.make ~root:wl_home ~host ?now ~commit:false ()

(* A long link, valid for the library. *)
let long_link i = Printf.sprintf "https://example.invalid/%d/%s" i (String.make 450 'x')

let update_add c id field values =
  ignore
    (ok c "work_update"
       (`Assoc [ ("id", `String id); ("add", `Assoc [ (field, `List (List.map (fun v -> `String v) values)) ]) ]))

let new_task c ?(title = "T") ?(product = "gateway") () =
  str (ok c "work_add_task" (`Assoc [ ("title", `String title); ("product", `String product) ])) "id"

let count_events wl_home typ =
  List.length (List.filter (fun l -> contains l (Printf.sprintf "\"type\":%S" typ)) (event_lines wl_home))
