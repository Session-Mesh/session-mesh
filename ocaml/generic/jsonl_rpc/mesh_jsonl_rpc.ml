(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

module Envelope = Mesh_jsonl_rpc_envelope

type config = {
  max_request_bytes : int;
  max_response_bytes : int;
  max_depth : int;
  max_in_flight : int;
}

let config ?(max_request_bytes = 1024 * 1024) ?(max_response_bytes = 4 * 1024 * 1024)
    ?(max_depth = 64) ?(max_in_flight = 4) () =
  if max_request_bytes < 1 || max_response_bytes < 1 || max_depth < 1 || max_in_flight < 1 then
    invalid_arg "Mesh_jsonl_rpc.config";
  { max_request_bytes; max_response_bytes; max_depth; max_in_flight }

type emit = string -> Envelope.fields -> (unit, [ `Too_large | `Not_json ]) result

type handler =
  Envelope.request -> emit:emit -> (Envelope.fields, Envelope.error) result

module Reader = struct
  type t = {
    source : Eio.Flow.source_ty Eio.Resource.t;
    splitter : Mesh_jsonl_lines.t;
    ready : Mesh_jsonl_lines.line Queue.t;
    chunk : Cstruct.t;
    mutable finished : bool;
  }

  let create ~max_line_bytes source =
    {
      source = (source :> Eio.Flow.source_ty Eio.Resource.t);
      splitter = Mesh_jsonl_lines.create ~max_line_bytes ();
      ready = Queue.create ();
      chunk = Cstruct.create 65536;
      finished = false;
    }

  let push t line = Queue.push line t.ready

  (* At the end of the input, a last line without a newline still counts. *)
  let finish t =
    t.finished <- true;
    if Mesh_jsonl_lines.pending_bytes t.splitter > 0 then
      Mesh_jsonl_lines.feed_string t.splitter "\n" (push t)

  let fill t =
    match Eio.Flow.single_read t.source t.chunk with
    | count ->
        let bytes = Bytes.create count in
        Cstruct.blit_to_bytes t.chunk 0 bytes 0 count;
        Mesh_jsonl_lines.feed t.splitter bytes ~pos:0 ~len:count (push t)
    | exception End_of_file -> finish t

  let rec next t =
    match Queue.take_opt t.ready with
    | Some line -> Some line
    | None when t.finished -> None
    | None ->
        fill t;
        next t
end

module Writer = struct
  type t = {
    sink : Eio.Flow.sink_ty Eio.Resource.t;
    max_line_bytes : int;
    lock : Eio.Mutex.t;
  }

  let create ~max_line_bytes sink =
    {
      sink = (sink :> Eio.Flow.sink_ty Eio.Resource.t);
      max_line_bytes;
      lock = Eio.Mutex.create ();
    }

  let write t frame =
    match Mesh_jsonl_value.encode ~max_bytes:t.max_line_bytes frame with
    | Error Mesh_jsonl_value.Too_large -> Error `Too_large
    | Error (Mesh_jsonl_value.Too_deep | Invalid _) -> Error `Not_json
    | Ok text ->
        Eio.Mutex.use_rw ~protect:true t.lock (fun () ->
            Eio.Flow.copy_string (text ^ "\n") t.sink);
        Ok ()
end

let internal_error = { Envelope.code = Envelope.Internal; message = "internal error" }

let too_large_error =
  { Envelope.code = Envelope.Too_large; message = "the response exceeds the output bound" }

let not_json_error =
  { Envelope.code = Envelope.Internal; message = "the response has no strict JSON form" }

(* A final frame is always written: when the frame cannot be, an error frame
   with the [req], and when even that cannot be (a [req] too large, or one
   with no JSON form), an error frame without it, which always can. *)
let write_final writer req frame =
  match Writer.write writer frame with
  | Ok () -> ()
  | Error reason -> (
      let problem = match reason with `Too_large -> too_large_error | `Not_json -> not_json_error in
      match Writer.write writer (Envelope.error req problem) with
      | Ok () -> ()
      | Error _ -> ignore (Writer.write writer (Envelope.error None problem)))

let answer handler writer (request : Envelope.request) =
  let emit name fields = Writer.write writer (Envelope.event request.req name fields) in
  let result =
    match handler request ~emit with
    | result -> result
    | exception (Eio.Cancel.Cancelled _ as cancelled) -> raise cancelled
    | exception _ -> Error internal_error
  in
  let frame =
    match result with
    | Ok fields -> Envelope.ok request.req fields
    | Error problem -> Envelope.error request.req problem
  in
  write_final writer request.req frame

let line_too_long =
  { Envelope.code = Envelope.Bad_request; message = "request line too long" }

let serve config handler source sink =
  let reader = Reader.create ~max_line_bytes:config.max_request_bytes source in
  let writer = Writer.create ~max_line_bytes:config.max_response_bytes sink in
  let limits =
    {
      Mesh_jsonl_value.max_bytes = config.max_request_bytes;
      max_depth = config.max_depth;
      invalid_utf8 = Reject;
    }
  in
  let slots = Eio.Semaphore.make config.max_in_flight in
  Eio.Switch.run @@ fun switch ->
  let start request =
    Eio.Semaphore.acquire slots;
    Eio.Fiber.fork ~sw:switch (fun () ->
        Fun.protect
          ~finally:(fun () -> Eio.Semaphore.release slots)
          (fun () -> answer handler writer request))
  in
  let rec loop () =
    match Reader.next reader with
    | None -> ()
    | Some Mesh_jsonl_lines.Too_long ->
        write_final writer None (Envelope.error None line_too_long);
        loop ()
    | Some (Mesh_jsonl_lines.Line text) when String.trim text = "" -> loop ()
    | Some (Mesh_jsonl_lines.Line text) ->
        (match Envelope.decode_request limits text with
        | Ok request -> start request
        | Error (req, problem) -> write_final writer req (Envelope.error req problem));
        loop ()
  in
  loop ()
