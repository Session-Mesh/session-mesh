(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

let size_limit = 5 * 1024 * 1024
let max_redirects = 3
let budget_count = 60
let budget_window = 600.
let total_seconds = 20.
let header_limit = 65536
let response_limit = header_limit + size_limit + 1

(* The leading bytes of each accepted type (WebP: RIFF, then WEBP at 8). *)
let magics =
  [
    ("image/png", [ "\x89PNG\r\n\x1a\n" ]);
    ("image/jpeg", [ "\xff\xd8\xff" ]);
    ("image/gif", [ "GIF87a"; "GIF89a" ]);
    ("image/webp", [ "RIFF" ]);
  ]

module U = Mesh_update_image_url

let suffix_from text index = String.sub text index (String.length text - index)

(* ---- where the request goes *)

type target = { fetch_url : string; proto : string; pin : string option }

let stand_ins_of_string text =
  let port text =
    match int_of_string_opt text with
    | Some port
      when port > 0 && port < 65536
           && String.for_all (function '0' .. '9' -> true | _ -> false) text ->
        Some port
    | _ -> None
  in
  List.filter_map
    (fun item ->
      match String.index_opt item '=' with
      | None -> None
      | Some equal -> (
          let place = suffix_from item (equal + 1) in
          match String.rindex_opt place ':' with
          | None -> None
          | Some colon ->
              Option.map
                (fun port ->
                  (String.sub item 0 equal, (String.sub place 0 colon, port)))
                (port (suffix_from place (colon + 1)))))
    (String.split_on_char ',' text)

let literal text =
  let bare =
    if String.starts_with ~prefix:"[" text && String.ends_with ~suffix:"]" text
    then String.sub text 1 (String.length text - 2)
    else text
  in
  match Unix.inet_addr_of_string bare with
  | address -> Some address
  | exception Failure _ -> None

let bracketed address =
  let text = Unix.string_of_inet_addr address in
  if String.contains text ':' then "[" ^ text ^ "]" else text

(* The first address of [host], when every address it has is public. *)
let public_first ~resolve host =
  match resolve host with
  | first :: _ as all when List.for_all U.public_address all -> Some first
  | _ -> None

let loopback address =
  address = Unix.inet6_addr_loopback
  || String.starts_with ~prefix:"127." (Unix.string_of_inet_addr address)

let stand_in ~resolve (host, port) rest =
  let fetch_url = Printf.sprintf "http://%s:%d%s" host port rest in
  match literal host with
  | Some address when loopback address ->
      Some { fetch_url; proto = "=http"; pin = None }
  | Some _ -> None
  | None ->
      Option.map
        (fun address ->
          let pin = Printf.sprintf "%s:%d:%s" host port (bracketed address) in
          { fetch_url; proto = "=http"; pin = Some pin })
        (public_first ~resolve host)

let target ~resolve ~stand_ins (url : U.url) =
  match stand_ins with
  | Some table ->
      Option.bind (List.assoc_opt url.host table) (fun place ->
          stand_in ~resolve place url.rest)
  | None ->
      Option.map
        (fun address ->
          {
            fetch_url = "https://" ^ url.host ^ url.rest;
            proto = "=https";
            pin = Some (url.host ^ ":443:" ^ bracketed address);
          })
        (public_first ~resolve url.host)

let curl_arguments target ~max_time =
  [
    "curl";
    "-q";
    "-A";
    Mesh_update_report.user_agent;
    "--proto";
    target.proto;
    "--max-redirs";
    "0";
    "--noproxy";
    "*";
    "--globoff";
    "--silent";
    "--connect-timeout";
    Printf.sprintf "%.3f" (Float.min 10. max_time);
    "--max-time";
    Printf.sprintf "%.3f" max_time;
    "--max-filesize";
    string_of_int size_limit;
    "-H";
    "Accept: " ^ String.concat ", " (List.map fst magics);
    "-D";
    "-";
    "-o";
    "-";
  ]
  @ (match target.pin with Some pin -> [ "--resolve"; pin ] | None -> [])
  @ [ target.fetch_url ]

(* ---- the answer *)

type answer = { status : int; content_type : string; body : string }

type response = {
  code : int;
  headers : (string * string) list;
  payload : string;
}

let refused status = { status; content_type = ""; body = "" }

(* The end of the header block at or after [start]: the blank line and its
   length. *)
let header_end text start =
  let rec go index =
    if index >= String.length text || index - start > header_limit then None
    else if text.[index] = '\n' && index + 1 < String.length text then
      if text.[index + 1] = '\n' then Some (index + 1, 1)
      else if
        text.[index + 1] = '\r'
        && index + 2 < String.length text
        && text.[index + 2] = '\n'
      then Some (index + 1, 2)
      else go (index + 1)
    else go (index + 1)
  in
  go start

let header_line line =
  match String.index_opt line ':' with
  | Some colon ->
      Some
        ( String.lowercase_ascii (String.trim (String.sub line 0 colon)),
          String.trim (suffix_from line (colon + 1)) )
  | None -> None

(* "HTTP/1.1 302 Found" or "HTTP/2 200". *)
let status_code line =
  match String.split_on_char ' ' (String.trim line) with
  | version :: code :: _
    when String.starts_with ~prefix:"HTTP/" version && String.length code = 3 ->
      int_of_string_opt code
  | _ -> None

(* The final response of curl's [-D - -o -] output: a 1xx block is skipped. *)
let rec parse_response text start =
  match header_end text start with
  | None -> None
  | Some (blank, length) -> (
      let block = String.sub text start (blank - start) in
      match String.split_on_char '\n' block with
      | first :: lines -> (
          match status_code first with
          | Some code when code >= 100 && code < 200 ->
              parse_response text (blank + length)
          | Some code ->
              Some
                {
                  code;
                  headers = List.filter_map header_line lines;
                  payload = suffix_from text (blank + length);
                }
          | None -> None)
      | [] -> None)

let media_type response =
  match List.assoc_opt "content-type" response.headers with
  | Some value ->
      String.lowercase_ascii
        (String.trim (List.hd (String.split_on_char ';' value)))
  | None -> ""

let declared_length response =
  Option.bind
    (List.assoc_opt "content-length" response.headers)
    int_of_string_opt

let starts_as kind body =
  List.exists
    (fun magic -> String.starts_with ~prefix:magic body)
    (List.assoc kind magics)
  && (kind <> "image/webp"
     || (String.length body >= 12 && String.sub body 8 4 = "WEBP"))

(* curl's exit 63: --max-filesize exceeded. *)
let final exit_code response =
  let kind = media_type response in
  let oversize =
    String.length response.payload > size_limit
    || Option.fold ~none:false
         ~some:(fun n -> n > size_limit)
         (declared_length response)
  in
  if response.code <> 200 then refused 502
  else if not (List.mem_assoc kind magics) then refused 415
  else if oversize || exit_code = 63 then refused 413
  else if exit_code <> 0 || not (starts_as kind response.payload) then
    refused 502
  else { status = 200; content_type = kind; body = response.payload }

let redirect code = List.mem code [ 301; 302; 303; 307; 308 ]
let exit_code = function Unix.WEXITED code -> code | _ -> -1

let fetch ~resolve ~transport ~stand_ins ~clock (url : U.url) =
  let deadline = clock () +. total_seconds in
  let rec hop url redirects =
    let remaining = deadline -. clock () in
    match target ~resolve ~stand_ins url with
    | _ when remaining <= 0. -> refused 502
    | None -> refused 502
    | Some target -> (
        let status, output =
          transport (curl_arguments target ~max_time:remaining)
        in
        match parse_response output 0 with
        | None when exit_code status = 63 ->
            (* over --max-filesize: some curl versions stop on the declared
               length before writing any header *)
            refused 413
        | None -> refused 502
        | Some response when redirect response.code -> (
            let next =
              Option.bind (List.assoc_opt "location" response.headers)
                (fun location -> U.image_url (U.join ~base:url location))
            in
            match next with
            | Some next when redirects < max_redirects ->
                hop next (redirects + 1)
            | _ -> refused 502)
        | Some response -> final (exit_code status) response)
  in
  hop url 0

(* ---- the budget *)

let read_descriptor descriptor =
  let buffer = Buffer.create 2048 and chunk = Bytes.create 4096 in
  let rec go () =
    match Unix.read descriptor chunk 0 (Bytes.length chunk) with
    | 0 -> ()
    | count ->
        Buffer.add_subbytes buffer chunk 0 count;
        if Buffer.length buffer < 65536 then go ()
    | exception Unix.Unix_error (Unix.EINTR, _, _) -> go ()
  in
  go ();
  Buffer.contents buffer

let take_budget ~path ~now =
  (match Unix.lstat path with
  | { Unix.st_kind = Unix.S_REG; _ } -> ()
  | _ -> failwith "not a regular file"
  | exception Unix.Unix_error (Unix.ENOENT, _, _) -> ());
  let descriptor =
    Unix.openfile path [ Unix.O_RDWR; Unix.O_CREAT; Unix.O_CLOEXEC ] 0o600
  in
  Fun.protect
    ~finally:(fun () -> Unix.close descriptor)
    (fun () ->
      Unix.lockf descriptor Unix.F_LOCK 0;
      let recent =
        String.split_on_char '\n' (read_descriptor descriptor)
        |> List.filter_map float_of_string_opt
        |> List.filter (fun time ->
            time <= now +. 1. && now -. time <= budget_window)
      in
      List.length recent < budget_count
      &&
      let text =
        String.concat "" (List.map (Printf.sprintf "%.3f\n") (recent @ [ now ]))
      in
      Unix.ftruncate descriptor 0;
      ignore (Unix.lseek descriptor 0 Unix.SEEK_SET);
      ignore (Unix.write_substring descriptor text 0 (String.length text));
      true)

let answer ~getenv ~resolve ~transport ~clock ~url ~notes =
  match U.image_url url with
  | Some parsed when U.in_notes ~notes url -> (
      let stand_ins =
        match getenv "MESH_UPDATE_IMAGE_TEST_HOSTS" with
        | Some "" | None -> None
        | Some text -> Some (stand_ins_of_string text)
      in
      match Mesh_update_report.cache_directory getenv with
      | None -> refused 502
      | Some directory -> (
          let path = Filename.concat directory "update-image-fetches" in
          match
            Mesh_update_check.make_directory directory;
            take_budget ~path ~now:(clock ())
          with
          | true -> fetch ~resolve ~transport ~stand_ins ~clock parsed
          | false -> refused 429
          | exception (Unix.Unix_error _ | Sys_error _ | Failure _) ->
              refused 502))
  | _ -> refused 404

(* ---- the effects *)

let resolve host =
  match Unix.getaddrinfo host "" [ Unix.AI_SOCKTYPE Unix.SOCK_STREAM ] with
  | infos ->
      List.sort_uniq compare
        (List.filter_map
           (fun info ->
             match info.Unix.ai_addr with
             | Unix.ADDR_INET (address, _) -> Some address
             | Unix.ADDR_UNIX _ -> None)
           infos)
  | exception Unix.Unix_error _ -> []

let run_curl arguments =
  let null = Unix.openfile "/dev/null" [ Unix.O_RDWR; Unix.O_CLOEXEC ] 0 in
  let reader, writer = Unix.pipe ~cloexec:true () in
  let pid =
    Fun.protect
      ~finally:(fun () ->
        Unix.close writer;
        Unix.close null)
      (fun () ->
        Unix.create_process "curl" (Array.of_list arguments) null writer null)
  in
  let buffer = Buffer.create 65536 and chunk = Bytes.create 65536 in
  let rec read () =
    if Buffer.length buffer > response_limit then
      try Unix.kill pid Sys.sigkill with Unix.Unix_error _ -> ()
    else
      match Unix.read reader chunk 0 (Bytes.length chunk) with
      | 0 -> ()
      | count ->
          Buffer.add_subbytes buffer chunk 0 count;
          read ()
      | exception Unix.Unix_error (Unix.EINTR, _, _) -> read ()
  in
  Fun.protect ~finally:(fun () -> Unix.close reader) read;
  let rec wait () =
    match Unix.waitpid [] pid with
    | _, status -> status
    | exception Unix.Unix_error (Unix.EINTR, _, _) -> wait ()
  in
  let status = wait () in
  let output = Buffer.contents buffer in
  ( status,
    if String.length output > response_limit then
      String.sub output 0 response_limit
    else output )
