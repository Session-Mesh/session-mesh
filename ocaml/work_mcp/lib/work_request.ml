(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

module W = Mesh_worklog

let max_length = 64
let event_type = "request"

let valid_char c =
  (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || String.contains "_.:-" c

let check request_id =
  if request_id = "" || String.length request_id > max_length || not (String.for_all valid_char request_id) then
    Error
      (Work_err.invalid "request_id must be 1 to %d characters among A-Z a-z 0-9 _ . : -" max_length)
  else Ok request_id

let of_args args =
  match Work_args.opt_string args "request_id" with
  | Error e -> Error e
  | Ok None -> Ok None
  | Ok (Some r) -> Result.map Option.some (check r)

let matches ~session ~tool ~request_id ~target (ev : W.Event.t) =
  ev.typ = event_type
  && W.Event.get_string ev "session" = Some session
  && W.Event.get_string ev "tool" = Some tool
  && W.Event.get_string ev "request_id" = Some request_id
  && W.Event.get_string ev "target" = Some target

let find events ~session ~tool ~request_id ~target =
  List.find_map
    (fun ev ->
      if matches ~session ~tool ~request_id ~target ev then
        match W.Event.get ev "result" with Some (`Assoc _ as r) -> Some r | _ -> None
      else None)
    events

let lookup ctx ~session ~tool ~request_id ~target =
  Result.map
    (fun (snap : W.Reader.snapshot) -> find snap.loaded.events ~session ~tool ~request_id ~target)
    (Work_err.lift (W.Reader.snapshot ctx))

let record ctx ?session ~tool ~request_id ~target ~task ~result () =
  match
    W.Txn.run ctx ?session (fun tx ->
        W.Txn.append tx
          [
            ( task,
              event_type,
              [
                ("tool", `String tool);
                ("request_id", `String request_id);
                ("target", `String target);
                ("result", result);
              ] );
          ];
        W.Txn.commit tx ~cmd:"request" ~subject:(Some task))
  with
  | Ok () -> ()
  | Error e ->
      Work_repo.warn
        ("the request_id could not be recorded, so a retry of this call would write again: "
       ^ (Work_err.of_worklog e).message)

let with_duplicate = function
  | `Assoc fields -> `Assoc (fields @ [ ("duplicate", `Bool true) ])
  | json -> json

let once ctx ~tool ~request_id ~(session : W.Session.t option) ~target ~task_of write =
  match (request_id, Option.bind session (fun (s : W.Session.t) -> s.session)) with
  | None, _ -> write ()
  | Some _, None ->
      Error (Work_err.invalid "request_id needs a session identity (MESH_SESSION): no session is known")
  | Some request_id, Some name -> (
      match lookup ctx ~session:name ~tool ~request_id ~target with
      | Error e -> Error e
      | Ok (Some original) -> Ok (with_duplicate original)
      | Ok None -> (
          match write () with
          | Error e -> Error e
          | Ok result ->
              record ctx ?session ~tool ~request_id ~target ~task:(task_of result) ~result ();
              Ok result))
