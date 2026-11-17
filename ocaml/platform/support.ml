(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(* Small I/O-robustness helpers shared by backends; pure of platform facts. *)

open Types

let rec retry_on_eintr action =
  try action ()
  with Unix.Unix_error (Unix.EINTR, _, _) -> retry_on_eintr action

(* A close error leaves nothing to recover and must never escape a cleanup. *)
let close_quietly descriptor = try Unix.close descriptor with _ -> ()
let closedir_quietly handle = try Unix.closedir handle with _ -> ()

(* One process vanishing, belonging to someone else, or answering garbage is
   left out; any other error fails the whole scan. A process that vanished is
   simply gone; one that is [Denied] or [Malformed] still exists and is
   counted in [skipped], so a caller can tell that the table is incomplete. *)
let collect_scan names read_process =
  let visit acc name =
    match acc with
    | Error _ -> acc
    | Ok (found, skipped) -> (
        match int_of_string_opt name with
        | None -> acc
        | Some pid -> (
            match read_process pid with
            | Ok entry -> Ok (entry :: found, skipped)
            | Error Not_found -> acc
            | Error (Denied | Malformed _) -> Ok (found, skipped + 1)
            | Error _ as failure -> failure))
  in
  match List.fold_left visit (Ok ([], 0)) names with
  | Error _ as failure -> failure
  | Ok (found, skipped) ->
      Ok
        {
          processes = List.sort (fun a b -> compare a.pid b.pid) found;
          skipped;
        }

let collect_processes names read_process =
  Result.map (fun scan -> scan.processes) (collect_scan names read_process)
