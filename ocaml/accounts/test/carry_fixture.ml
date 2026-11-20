(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(* Temporary account folders for the carry tests, and an [io] whose steps
   fail on demand. *)

module C = Mesh_accounts_carry

let uid = Unix.geteuid ()
let sid = "0f1e2d3c-4b5a-4968-8778-695a4b3c2d1e"

let rec remove path =
  match Unix.lstat path with
  | { Unix.st_kind = Unix.S_DIR; _ } ->
      Unix.chmod path 0o700;
      Array.iter
        (fun name -> remove (Filename.concat path name))
        (Sys.readdir path);
      Unix.rmdir path
  | _ -> Unix.unlink path
  | exception Unix.Unix_error (Unix.ENOENT, _, _) -> ()

let with_root f =
  let root = Filename.temp_dir "carry" "" in
  Fun.protect ~finally:(fun () -> remove root) (fun () -> f root)

let mkdirs path =
  let rec make path =
    if not (Sys.file_exists path) then begin
      make (Filename.dirname path);
      Unix.mkdir path 0o700
    end
  in
  make path

let write path text =
  mkdirs (Filename.dirname path);
  Out_channel.with_open_gen [ Open_wronly; Open_creat; Open_trunc; Open_binary ]
    0o600 path (fun channel -> Out_channel.output_string channel text)

let read path = In_channel.with_open_bin path In_channel.input_all
let exists path = match Unix.lstat path with _ -> true | exception _ -> false

let contains text part =
  let length = String.length part in
  let rec from index =
    index + length <= String.length text
    && (String.sub text index length = part || from (index + 1))
  in
  from 0

(* Every path under [folder], relative, sorted, but the lock file: what a
   carry left there. *)
let listing folder =
  let rec walk relative acc =
    let path =
      if relative = "" then folder else Filename.concat folder relative
    in
    match Unix.lstat path with
    | { Unix.st_kind = Unix.S_DIR; _ } ->
        Array.fold_left
          (fun acc name ->
            let child =
              if relative = "" then name else Filename.concat relative name
            in
            walk child (child :: acc))
          acc (Sys.readdir path)
    | _ -> acc
    | exception Unix.Unix_error (Unix.ENOENT, _, _) -> acc
  in
  List.sort String.compare (List.filter (( <> ) C.lock_name) (walk "" []))

let project = "projects/-home-me-work"
let transcript = project ^ "/" ^ sid ^ ".jsonl"
let own = project ^ "/" ^ sid

let rollout =
  "sessions/2026/11/20/rollout-2026-11-20T10-00-00-" ^ sid ^ ".jsonl"

(* A Claude account folder as Claude leaves it: login files at the top, the
   project's memory and other conversations next to this one. *)
let claude_account root name =
  let folder = Filename.concat root name in
  mkdirs folder;
  write (Filename.concat folder ".credentials.json") "{\"secret\":1}";
  write (Filename.concat folder ".claude.json") "{\"secret\":2}";
  write (Filename.concat folder "settings.json") "{}";
  folder

let with_conversation folder =
  write (Filename.concat folder transcript) "{\"line\":1}\n{\"line\":2}\n";
  write
    (Filename.concat folder (own ^ "/subagents/agent-1.jsonl"))
    "{\"sub\":1}\n";
  write (Filename.concat folder (own ^ "/tool-results/r1.txt")) "result";
  write (Filename.concat folder (project ^ "/other-conversation.jsonl")) "x";
  write (Filename.concat folder (project ^ "/memory/MEMORY.md")) "memory"

let carried = function
  | Ok outcome -> outcome
  | Error { C.code; message } -> Alcotest.failf "refused: %s %s" code message

let refused_with code = function
  | Ok _ -> Alcotest.failf "carried, expected %s" code
  | Error { C.code = found; message } ->
      Alcotest.(check string) ("code (" ^ message ^ ")") code found

let message_of = function
  | Ok _ -> Alcotest.fail "carried, expected a refusal"
  | Error { C.message; _ } -> message

(* Writes after [writes] fail with ENOSPC; reads after [reads] and removals
   of a file put in place after [unlinks] fail with EIO; renames of a new
   temporary file after [renames] fail with EIO, and so do the renames that
   put a replaced copy back unless [restores]; closes after [closes] fail with
   EIO (the file is closed first). The free space is [free], plenty by
   default: the tests do not depend on the test machine's disk. *)
let failing_io ?(writes = max_int) ?(reads = max_int) ?(unlinks = max_int)
    ?(renames = max_int) ?(closes = max_int) ?(restores = true)
    ?(free = Some max_int) () =
  let write_count = ref 0 and rename_count = ref 0 and close_count = ref 0 in
  let read_count = ref 0 and unlink_count = ref 0 in
  let fail_with error name = raise (Unix.Unix_error (error, name, "")) in
  let counted counter limit error name =
    incr counter;
    if !counter > limit then fail_with error name
  in
  {
    C.write =
      (fun descriptor buffer offset length ->
        incr write_count;
        if !write_count > writes then fail_with Unix.ENOSPC "write"
        else Unix.write descriptor buffer offset length);
    read =
      (fun descriptor buffer offset length ->
        counted read_count reads Unix.EIO "read";
        Unix.read descriptor buffer offset length);
    unlink =
      (fun path ->
        counted unlink_count unlinks Unix.EIO "unlink";
        Unix.unlink path);
    rename =
      (fun old_path new_path ->
        if contains old_path ".carry-new-" then begin
          incr rename_count;
          if !rename_count > renames then fail_with Unix.EIO "rename"
        end;
        if contains old_path ".carry-old-" && not restores then
          fail_with Unix.EIO "rename";
        Unix.rename old_path new_path);
    close =
      (fun descriptor ->
        incr close_count;
        Unix.close descriptor;
        if !close_count > closes then fail_with Unix.EIO "close");
    free_bytes = (fun _ -> free);
  }

let carry ?(io = failing_io ()) ?limits ?(conversation = sid) ~source ~target
    kind =
  C.carry ~io ?limits ~uid ~kind ~conversation ~source ~target ()

(* Wait at most 10 s for [descriptor] to be readable; false on a timeout. *)
let readable descriptor =
  match Unix.select [ descriptor ] [] [] 10.0 with
  | [], _, _ -> false
  | _ -> true

(* A child process carries the conversation from [source] to [target] and
   stops at its first write; [f] runs then, the child goes on, and its exit
   status is returned. The test fails, without hanging, when the child never
   reaches its first write. *)
let while_carrying ~source ~target f =
  let entered_read, entered_write = Unix.pipe ~cloexec:true () in
  let go_read, go_write = Unix.pipe ~cloexec:true () in
  match Unix.fork () with
  | 0 ->
      Unix.close entered_read;
      Unix.close go_write;
      let first = ref true in
      let write descriptor buffer offset length =
        if !first then begin
          first := false;
          ignore (Unix.write_substring entered_write "x" 0 1);
          ignore (readable go_read)
        end;
        Unix.write descriptor buffer offset length
      in
      let io = { (failing_io ()) with C.write } in
      Unix._exit
        (match carry ~io ~source ~target C.Claude with
        | Ok _ -> 0
        | Error _ -> 1)
  | child -> (
      Unix.close entered_write;
      Unix.close go_read;
      let byte = Bytes.create 1 in
      let entered =
        readable entered_read && Unix.read entered_read byte 0 1 = 1
      in
      let release () =
        Unix.close go_write;
        Unix.close entered_read;
        snd (Unix.waitpid [] child)
      in
      if not entered then begin
        ignore (release ());
        Alcotest.fail "the first carry never reached its first write"
      end;
      match f () with
      | () -> release ()
      | exception error ->
          ignore (release ());
          raise error)
