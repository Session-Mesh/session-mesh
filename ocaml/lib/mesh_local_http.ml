(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(* One HTTP/1.1 exchange on a plain loopback socket, without an HTTP client
   library and without a scheduler. No [select]: it refuses a descriptor at or
   above FD_SETSIZE. The connection is polled, and each read or write is a
   blocking call bounded by a kernel timeout (SO_RCVTIMEO, SO_SNDTIMEO). The
   deadline is a budget of seconds that every wait and the time between waits
   draw from (see [waited]), so it holds even when bytes never stop arriving
   and whatever the wall clock does. Everything read is bounded: a line, the
   number of header lines, the body.

   The disk fallback of mesh-logout-all hangs on [No_answer], so the rule is
   strict: [No_answer] only while not one byte of an answer has been read, and
   only for what the peer did (refused, closed, reset, silent). From the first
   byte on, whatever goes wrong is [Unreadable]; a local error is [Failed]. *)

type authorization = string

let is_control c = Char.code c < 0x20 || Char.code c = 0x7f

let bearer token =
  if String.exists is_control token then
    Error "the token holds a control character"
  else Ok ("Bearer " ^ token)

type outcome =
  | Success of string
  | Refused of { status : int; reason : string }
  | Unreadable of string
  | No_answer of string
  | Failed of string

(* Something answered, but not with a readable HTTP response. The message
   never quotes what was received. *)
exception Malformed of string
exception Timed_out

(* The answer's body is a few dozen bytes; anything past this is not the mesh. *)
let max_body = 1 lsl 20

(* The limits of Python's http.client: a status, header, chunk-size or trailer
   line, and the header lines of one answer. *)
let max_line = 1 lsl 16
let max_header_lines = 100

(* [100 Continue] answers skipped before the final one. *)
let max_interim = 8
let ended_early = Malformed "the answer ended early"

type connection = {
  socket : Unix.file_descr;
  timeout : float;
  clock : unit -> float;  (** The wall clock. *)
  mutable budget : float;  (** Seconds left before the deadline. *)
  mutable checked : float;  (** The wall clock when [budget] was last drawn. *)
  chunk : Bytes.t;
  mutable pos : int;
  mutable len : int;
  mutable received : bool;  (** At least one byte of an answer was read. *)
}

(* The longest single wait. A wait ends on a kernel timeout, which no step of
   the wall clock moves; the clock only says how long a wait that ended early
   took, so one step of it shifts the deadline by at most this much. *)
let longest_wait = 0.5

(* How often a connection in progress is looked at. *)
let connect_poll = 0.005

(* A kernel timeout below a millisecond could round to zero: "for ever". The
   last wait may so pass the deadline by less than a millisecond. *)
let shortest_wait = 0.001

(* Draws the time since the last draw from the budget: nothing when the wall
   clock went back. Returns the clock. *)
let draw connection =
  let now = connection.clock () in
  connection.budget <-
    connection.budget -. Float.max 0. (now -. connection.checked);
  connection.checked <- now;
  now

type 'a wait = Done of 'a | Expired | Interrupted

(* [run allowed] waits at most [allowed] seconds: [longest] at most, and no
   more than the budget left. A wait that expired costs [allowed], whatever
   the clock says; any other costs what the clock says it took, kept between 0
   and [allowed]. *)
let waited ?(longest = longest_wait) connection run =
  let start = draw connection in
  if connection.budget <= 0. then raise Timed_out;
  let allowed = Float.max shortest_wait (Float.min longest connection.budget) in
  let result = run allowed in
  let now = connection.clock () in
  let cost =
    match result with
    | Expired -> allowed
    | Done _ | Interrupted -> Float.min allowed (Float.max 0. (now -. start))
  in
  connection.budget <- connection.budget -. cost;
  connection.checked <- now;
  result

(* One blocking call on the socket under the kernel timeout [option]. *)
let on_socket connection option call allowed =
  Unix.setsockopt_float connection.socket option allowed;
  match call () with
  | result -> Done result
  | exception Unix.Unix_error ((Unix.EAGAIN | Unix.EWOULDBLOCK), _, _) ->
      Expired
  | exception Unix.Unix_error (Unix.EINTR, _, _) -> Interrupted

let pause allowed =
  match Unix.sleepf allowed with
  | () -> Expired
  | exception Unix.Unix_error (Unix.EINTR, _, _) -> Interrupted

let peer_name_error ~pending error =
  match (pending, error) with
  | Some pending, _ -> Some (pending, "connect")
  | None, Unix.ENOTCONN -> None
  | None, error -> Some (error, "getpeername")

(* A connection in progress, looked at every [connect_poll] seconds: an error
   the socket holds ends it, a peer name means it is made. When [getpeername]
   fails, the socket's error is read again: a refusal or a reset that lands
   between the two calls is there (on XNU [getpeername] then fails with
   EINVAL, which does not clear it). *)
let rec until_connected connection =
  match Unix.getsockopt_error connection.socket with
  | Some error -> raise (Unix.Unix_error (error, "connect", ""))
  | None -> (
      match Unix.getpeername connection.socket with
      | _ -> ()
      | exception Unix.Unix_error (error, _, _) -> (
          let pending = Unix.getsockopt_error connection.socket in
          match peer_name_error ~pending error with
          | Some (error, call) -> raise (Unix.Unix_error (error, call, ""))
          | None ->
              ignore (waited ~longest:connect_poll connection pause);
              until_connected connection))

let connect connection port =
  let address = Unix.ADDR_INET (Unix.inet_addr_loopback, port) in
  Unix.set_nonblock connection.socket;
  (try Unix.connect connection.socket address
   with Unix.Unix_error ((Unix.EINPROGRESS | Unix.EINTR), _, _) ->
     until_connected connection);
  Unix.clear_nonblock connection.socket

let rec send connection text offset =
  if offset < String.length text then
    let write () =
      Unix.single_write_substring connection.socket text offset
        (String.length text - offset)
    in
    match waited connection (on_socket connection Unix.SO_SNDTIMEO write) with
    | Done written -> send connection text (offset + written)
    | Expired | Interrupted -> send connection text offset

(* Fills the chunk; false at the end of the stream. *)
let rec refill connection =
  let read () =
    Unix.read connection.socket connection.chunk 0
      (Bytes.length connection.chunk)
  in
  match waited connection (on_socket connection Unix.SO_RCVTIMEO read) with
  | Done 0 -> false
  | Done count ->
      connection.pos <- 0;
      connection.len <- count;
      connection.received <- true;
      true
  | Expired | Interrupted -> refill connection

let available connection = connection.pos < connection.len || refill connection

let without_cr text =
  let length = String.length text in
  if length > 0 && text.[length - 1] = '\r' then String.sub text 0 (length - 1)
  else text

(* The next line without its end, at most [max_line] bytes; a last line the
   stream cuts before its end counts as a line, as for http.client. [None] at
   the end of the stream. *)
let read_line connection =
  let buffer = Buffer.create 128 in
  let rec loop () =
    if not (available connection) then
      if Buffer.length buffer = 0 then None
      else Some (without_cr (Buffer.contents buffer))
    else
      let rec line_end i =
        if i >= connection.len || Bytes.get connection.chunk i = '\n' then i
        else line_end (i + 1)
      in
      let stop = line_end connection.pos in
      let count = stop - connection.pos in
      if Buffer.length buffer + count > max_line then
        raise (Malformed "a line of the answer is too long");
      Buffer.add_subbytes buffer connection.chunk connection.pos count;
      if stop < connection.len then (
        connection.pos <- stop + 1;
        Some (without_cr (Buffer.contents buffer)))
      else (
        connection.pos <- stop;
        loop ())
  in
  loop ()

let line connection =
  match read_line connection with
  | Some text -> text
  | None -> raise ended_early

(* Moves what the chunk holds, at most [limit] bytes, to [body]. *)
let take connection body limit =
  let count = min limit (connection.len - connection.pos) in
  Buffer.add_subbytes body connection.chunk connection.pos count;
  connection.pos <- connection.pos + count;
  count

let rec exactly connection body count =
  if count > 0 then
    if available connection then
      exactly connection body (count - take connection body count)
    else raise ended_early

(* The redirections urllib's handler would follow, refused as the former Python
   mesh-logout-all refused them. *)
let is_redirection = function 301 | 302 | 303 | 307 | 308 -> true | _ -> false

let refused status =
  let reason =
    if is_redirection status then "redirect refused"
    else Cohttp.Code.reason_phrase_of_code status
  in
  Refused { status; reason }

let request_text ~port ~route authorization =
  Printf.sprintf
    "POST %s HTTP/1.1\r\n\
     host: 127.0.0.1:%d\r\n\
     authorization: %s\r\n\
     content-length: 0\r\n\
     connection: close\r\n\
     \r\n"
    route port authorization

let is_digit c = c >= '0' && c <= '9'
let all_digits text = text <> "" && String.for_all is_digit text

(* [HTTP/1.0] or [HTTP/1.1], a space, three digits from 100, then an optional
   reason: the status lines Python's http.client accepts. *)
let status_of_line text =
  let malformed () = raise (Malformed "malformed status line") in
  match String.split_on_char ' ' text with
  | version :: code :: _ ->
      if version <> "HTTP/1.1" && version <> "HTTP/1.0" then malformed ();
      if String.length code <> 3 || not (all_digits code) then malformed ();
      let status = int_of_string code in
      if status < 100 then malformed ();
      status
  | _ -> malformed ()

let field text =
  match String.index_opt text ':' with
  | None -> None
  | Some colon ->
      let name = String.lowercase_ascii (String.sub text 0 colon) in
      let value =
        String.sub text (colon + 1) (String.length text - colon - 1)
      in
      Some (name, String.trim value)

(* The fields in the order received, names in lower case. Every line counts
   towards the limit; one without a colon is skipped and the end of the stream
   ends the headers, both as for http.client. *)
let headers connection =
  let rec loop count fields =
    match read_line connection with
    | None | Some "" -> List.rev fields
    | Some _ when count >= max_header_lines ->
        raise (Malformed "too many header lines")
    | Some text -> (
        match field text with
        | None -> loop (count + 1) fields
        | Some pair -> loop (count + 1) (pair :: fields))
  in
  loop 0 []

let checked_size size =
  if size > max_body then raise (Malformed "the answer is too large");
  size

let content_length value =
  if String.length value > 9 || not (all_digits value) then
    raise (Malformed "malformed Content-Length");
  checked_size (int_of_string value)

let is_hex c = is_digit c || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')

let chunk_size text =
  let size =
    match String.index_opt text ';' with
    | Some semicolon -> String.trim (String.sub text 0 semicolon)
    | None -> String.trim text
  in
  if size = "" || String.length size > 7 || not (String.for_all is_hex size)
  then raise (Malformed "malformed chunk size");
  int_of_string ("0x" ^ size)

(* After the last chunk: at most [max_header_lines] lines, up to an empty one
   or the end of the stream. *)
let rec skip_trailers connection count =
  match read_line connection with
  | None | Some "" -> ()
  | Some _ when count >= max_header_lines ->
      raise (Malformed "too many header lines")
  | Some _ -> skip_trailers connection (count + 1)

let rec chunked connection body =
  match chunk_size (line connection) with
  | 0 -> skip_trailers connection 0
  | size ->
      ignore (checked_size (Buffer.length body + size));
      exactly connection body size;
      ignore (line connection);
      chunked connection body

let rec until_end connection body =
  if available connection then (
    ignore (take connection body max_int);
    ignore (checked_size (Buffer.length body));
    until_end connection body)

let is_chunked value =
  List.exists
    (fun coding -> String.lowercase_ascii (String.trim coding) = "chunked")
    (String.split_on_char ',' value)

(* Chunked wins over Content-Length; of several Content-Length fields the
   first counts, as for http.client. *)
let body connection fields =
  let text = Buffer.create 256 in
  (match List.assoc_opt "transfer-encoding" fields with
  | Some value when is_chunked value -> chunked connection text
  | _ -> (
      match List.assoc_opt "content-length" fields with
      | Some value -> exactly connection text (content_length value)
      | None -> until_end connection text));
  Buffer.contents text

(* The status and fields of the final answer, [100 Continue] answers skipped
   as http.client skips them; [None] when the stream ends before a status
   line. *)
let rec final_answer connection interim =
  match read_line connection with
  | None -> None
  | Some text -> (
      let status = status_of_line text in
      let fields = headers connection in
      match status with
      | 100 when interim < max_interim -> final_answer connection (interim + 1)
      | 100 -> raise (Malformed "too many interim answers")
      | _ -> Some (status, fields))

let exchange connection ~port ~route authorization =
  connect connection port;
  send connection (request_text ~port ~route authorization) 0;
  match final_answer connection 0 with
  | None when connection.received -> raise ended_early
  | None -> No_answer "the connection closed before an answer"
  | Some (status, fields) ->
      if status >= 200 && status < 300 then Success (body connection fields)
      else refused status

(* What the peer, or the way to it, can do to a connection. Any other error
   is local (no descriptor, no memory) and says nothing about the mesh, with
   one exception: on XNU (macOS), once a refusal or a reset has torn the
   socket down, [setsockopt] and [getpeername] fail with EINVAL ("the socket
   has been shutdown"). Here both only act on a connecting or connected
   socket, and the timeval set is always valid (XNU gives EDOM for an invalid
   one), so their EINVAL is the peer. Linux does not give it there. *)
let is_peer_error ~call = function
  | Unix.ECONNREFUSED | Unix.ECONNRESET | Unix.ECONNABORTED | Unix.EPIPE
  | Unix.ETIMEDOUT | Unix.EHOSTUNREACH | Unix.ENETUNREACH | Unix.EHOSTDOWN
  | Unix.ENETDOWN ->
      true
  | Unix.EINVAL -> call = "setsockopt_float" || call = "getpeername"
  | _ -> false

let local_failure error call =
  Failed (Printf.sprintf "%s: %s" call (Unix.error_message error))

let socket_failure ~received ~call error =
  if not (is_peer_error ~call error) then local_failure error call
  else if received then Unreadable "the connection failed during the answer"
  else No_answer (Unix.error_message error)

(* Before the first byte of an answer, what the peer did or the deadline is a
   mesh that does not answer (the former Python command took an OSError the
   same way). After it, something answered: never [No_answer]. A local error
   is neither. *)
let failure connection = function
  | Malformed message -> Unreadable message
  | Timed_out when connection.received ->
      Unreadable
        (Printf.sprintf "the answer was not complete within %g s"
           connection.timeout)
  | Timed_out ->
      No_answer (Printf.sprintf "no answer within %g s" connection.timeout)
  | Unix.Unix_error (error, call, _) ->
      socket_failure ~received:connection.received ~call error
  | error -> raise error

let post ?(timeout = 10.) ?(clock = Unix.gettimeofday) ~port ~route
    authorization () =
  let port = Mesh_paths.port_number port in
  let checked = clock () in
  match Unix.socket ~cloexec:true Unix.PF_INET Unix.SOCK_STREAM 0 with
  | exception Unix.Unix_error (error, call, _) -> local_failure error call
  | socket ->
      let connection =
        {
          socket;
          timeout;
          clock;
          budget = timeout;
          checked;
          chunk = Bytes.create 4096;
          pos = 0;
          len = 0;
          received = false;
        }
      in
      Fun.protect
        ~finally:(fun () -> Unix.close socket)
        (fun () ->
          try exchange connection ~port ~route authorization
          with error -> failure connection error)
