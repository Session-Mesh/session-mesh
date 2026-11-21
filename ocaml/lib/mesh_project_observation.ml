(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

module C = Mesh_project_codec
module S = Mesh_project_store
let operations = ["project_observation_start"; "project_observation_status"; "project_observation_page"; "project_observation_cancel"]
let is_operation op = List.mem op operations
let s v = `String v
let obj v = `Assoc v
let now_default () = Mtime.Span.to_float_ns (Mtime_clock.elapsed ()) /. 1e9
let page_bytes = 131072
let result_bytes = 2097152
let worker_charge = 6815744
let control_charge = 524288
let fixed_charge = 128 * 2048 + 4 * result_bytes
let budget = 24 * 1024 * 1024

type stage = Capture | Control | Borrow | Settled | Child_started of int | Child_exited of int | Pipes_drained | Charge of string * int
type record = {
  id : string; token : string; request : string; machine : string; project : string;
  revision : string; admitted : float; mutable state : string; mutable code : string option;
  mutable terminal : float option; mutable published : float option;
  mutable descriptor : Yojson.Basic.t option; mutable payload : string option;
  mutable borrowers : int; mutable retired : bool; mutable cancelled : string option;
}
type t = {
  boot : string; store : S.t; lock : Mutex.t; hook : stage -> unit; now : unit -> float;
  runtime : (string * string) option; records : (string, record) Hashtbl.t;
  runtime_initial_ready : bool;
  mutable active : int; mutable controls : int; mutable charged : int;
}
let guard t f = Mutex.lock t.lock; Fun.protect ~finally:(fun () -> Mutex.unlock t.lock) f
let emit t stage = t.hook stage
let charge t name delta =
  if t.charged + delta > budget || t.charged + delta < 0 then raise (C.Invalid "byte-capacity");
  t.charged <- t.charged + delta; emit t (Charge (name, t.charged))
let base t op status fields = obj (["kind", s "mesh-project-reply"; "version", `Int 1; "op", s op; "boot", s t.boot; "status", s status] @ fields)
let error t op status code = base t op status ["code", s code]
let random () =
  let fd = Unix.openfile "/dev/urandom" [Unix.O_RDONLY; Unix.O_CLOEXEC] 0 in
  Fun.protect ~finally:(fun () -> Unix.close fd) (fun () ->
      let b = Bytes.create 32 in
      let rec read n = if n < 32 then let k = Unix.read fd b n (32-n) in if k = 0 then failwith "random" else read (n+k) in
      read 0;
      String.concat "" (List.init 32 (fun i -> Printf.sprintf "%02x" (Char.code (Bytes.get b i)))))
let hex v =
  match v with
  | `String x when String.length x = 64 && String.for_all (function '0'..'9'|'a'..'f' -> true | _ -> false) x -> x
  | _ -> raise (C.Invalid "invalid-request")
let revision v = match v with
  | `String x when String.length x = 69 && String.starts_with ~prefix:"cfg1_" x -> ignore (hex (s (String.sub x 5 64))); x
  | _ -> raise (C.Invalid "invalid-request")
let utc () =
  let tm = Unix.gmtime (Unix.gettimeofday ()) in
  Printf.sprintf "%04d-%02d-%02dT%02d:%02d:%02dZ" (tm.Unix.tm_year+1900) (tm.Unix.tm_mon+1) tm.Unix.tm_mday tm.Unix.tm_hour tm.Unix.tm_min tm.Unix.tm_sec
let remaining t time = `Int (max 0 (min 120000 (int_of_float ((time +. 120. -. t.now ()) *. 1000.))))
let scope r = obj ["machine_id", s r.machine; "project_id", s r.project; "revision", s r.revision]
let collector_scope r = obj ["machine_id", s r.machine; "project_id", s r.project; "captured_revision", s r.revision]
let retire r code =
  r.retired <- true;
  if r.borrowers = 0 then r.payload <- None;
  r.state <- "expired"; r.code <- Some code
let prune t =
  let now = t.now () in
  Hashtbl.filter_map_inplace (fun _ r ->
      (match r.published with Some time when now >= time +. 120. && r.state = "complete" -> retire r "expired" | _ -> ());
      match r.terminal with Some time when now >= time +. 120. && r.borrowers = 0 -> None | _ -> Some r) t.records
let known t op r extra =
  base t op "ok"
    (["observation_id", s r.id; "request_id", s r.request; "requested_scope", scope r;
      "observation_state", s r.state; "identity_retention_ms", (match r.terminal with None -> `Null | Some time -> remaining t time)]
     @ (match r.code with None -> [] | Some code -> ["code", s code])
     @ (match r.descriptor with None -> [] | Some d -> ["descriptor", d])
     @ (match r.published with None -> [] | Some time -> ["remaining_ms", remaining t time]) @ extra)
let settle t r state code =
  guard t (fun () ->
      r.state <- state; r.code <- code; r.terminal <- Some (t.now ());
      t.active <- t.active - 1; charge t "worker-release" (-worker_charge));
  emit t Settled
let cleanup_pending t r code = guard t (fun () -> r.state <- "cleanup-pending"; r.code <- Some code)
let cancellation t r = guard t (fun () ->
    if r.cancelled = None && t.now () >= r.admitted +. 30. then r.cancelled <- Some "deadline";
    r.cancelled)
let request_cancel t r reason =
  if r.terminal = None then (
    let unverified = r.code=Some "worker-exited-unverified" in
    r.cancelled <- Some reason;
    r.state <- (if unverified || reason="stale" || r.state="capturing" || r.state="cleanup-pending" then "cleanup-pending" else "cancelling");
    if not unverified then r.code <- Some reason)
let readable path executable =
  try let st = Unix.stat path in
    st.Unix.st_kind = Unix.S_REG && (Unix.access path (if executable then [Unix.X_OK] else [Unix.R_OK]); true)
  with Unix.Unix_error _ -> false
let runtime_ready t = match t.runtime with Some (exe,entry) -> readable exe true && readable entry false | None -> false
let make ?(hook = fun _ -> ()) ?(now = now_default) ~boot ~store () =
  let runtime = match Sys.getenv_opt "MESH_PROJECT_OBSERVATION_RUNTIME", Sys.getenv_opt "MESH_PROJECT_OBSERVATION_ENTRY" with
    | Some exe, Some entry when not (Filename.is_relative exe || Filename.is_relative entry) -> Some (exe,entry)
    | _ -> None in
  let runtime_initial_ready = match runtime with Some (exe,entry) -> readable exe true && readable entry false | None -> false in
  let t = {boot;store;lock=Mutex.create ();hook;now;runtime;runtime_initial_ready;records=Hashtbl.create 128;active=0;controls=0;charged=fixed_charge} in
  emit t (Charge ("fixed-record-result-reservations", fixed_charge));
  S.observe_revision store (fun current -> guard t (fun () ->
      Hashtbl.iter (fun _ r ->
          if current <> r.revision then
            if r.state = "complete" then (r.state <- "stale"; r.code <- Some "stale"; r.retired <- true; if r.borrowers=0 then r.payload <- None)
            else if r.terminal = None then request_cancel t r "stale") t.records));
  t
let capability t = obj ["feature", s "project-observation/1"; "protocol_version", `Int 1;
  "implemented", `Bool true; "runtime_configured", `Bool t.runtime_initial_ready;
  "operations", `List (List.map s operations);
  "limits", obj ["request_bytes", `Int C.request_bytes; "reply_bytes", `Int C.reply_bytes;
    "control_frame_bytes", `Int 262144; "catalog_bytes", `Int result_bytes; "raw_page_bytes", `Int page_bytes;
    "max_pages", `Int 16; "active_workers", `Int 2; "control_workers", `Int 4; "completed_payloads", `Int 4;
    "identity_records", `Int 128; "identity_record_bytes", `Int 2048; "payload_ttl_ms", `Int 120000;
    "terminal_ttl_ms", `Int 120000; "deadline_ms", `Int 30000; "manager_bytes", `Int budget;
    "collector_bytes", `Int (16*1024*1024); "aggregate_bytes", `Int (56*1024*1024)]]

let encoded_size value =
  let string_size text =
    2 + String.fold_left (fun n c -> n + match c with
      | '"' | '\\' | '\b' | '\t' | '\n' | '\012' | '\r' -> 2
      | c when Char.code c < 32 -> 6 | _ -> 1) 0 text in
  let rec size = function
    | `String text -> string_size text
    | `Assoc fields -> 2 + max 0 (List.length fields-1) + List.fold_left (fun n (k,v) -> n+string_size k+1+size v) 0 fields
    | `List values -> 2 + max 0 (List.length values-1) + List.fold_left (fun n v -> n+size v) 0 values
    | `Float f when not (Float.is_finite f) -> raise (C.Invalid "collector-invalid")
    | scalar -> String.length (C.encode scalar)
  in size value

let validate_output t r wire =
  let output = C.parse_document ~max_bytes:(result_bytes+8192) (Option.get !wire) in
  (* Drop the raw envelope before serializing the validated catalog. Parsing
     and serialization each have a bounded private staging copy; their full
     copies must not overlap with a retained raw envelope. *)
  wire := None;
  C.strict output;
  let a = C.obj output in
  C.keys a ["kind"; "version"; "observation_id"; "boot"; "scope"; "result"; "settlement"];
  if C.get a "kind" <> s "mesh-project-observation-output" || C.get a "version" <> `Int 1
     || C.get a "observation_id" <> s r.id || C.get a "boot" <> s t.boot
     || C.canonical (C.get a "scope") <> C.canonical (collector_scope r) then raise (C.Invalid "collector-invalid");
  let witness = C.obj (C.get a "settlement") in
  C.keys witness ["providers_closed"; "provider_pipes_closed"];
  if C.get witness "providers_closed" <> `Bool true || C.get witness "provider_pipes_closed" <> `Bool true then raise (C.Invalid "worker-exited-unverified");
  let result = C.obj (C.get a "result") in
  match C.get result "state" with
  | `String "complete" ->
      C.keys result ["state"; "catalog"];
      let catalog = C.get result "catalog" in
      let a = C.obj catalog in
      C.keys a ["kind"; "schema_version"; "features"; "machine_id"; "revision"; "generated_at"; "projects"];
      if C.get a "kind" <> s "mesh-project-catalog" || C.get a "schema_version" <> `Int 2
        || C.get a "machine_id" <> s r.machine then raise (C.Invalid "collector-invalid");
      (match C.get a "features" with
      | `List fs when List.sort compare fs = List.sort compare [s "project-metadata/1";s "roster-followup/1"] -> ()
      | _ -> raise (C.Invalid "collector-invalid"));
      ignore (hex (C.get a "revision")); ignore (C.text 80 (C.get a "generated_at"));
      (match C.get a "projects" with
      | `List [project] when C.get (C.obj project) "id" = s r.project -> ()
      | _ -> raise (C.Invalid "collector-invalid"));
      let size = encoded_size catalog in
      if size < 1 || size > result_bytes then raise (C.Invalid "collector-oversize");
      if encoded_size output-size > 8192 then raise (C.Invalid "collector-invalid");
      let bytes = C.encode catalog in
      if String.length bytes < 1 || String.length bytes > result_bytes then raise (C.Invalid "collector-oversize");
      ("complete", None, Some bytes)
  | `String "failed" ->
      C.keys result ["state"; "code"];
      let code = match C.get result "code" with
        | `String ("collector-failed"|"collector-invalid"|"collector-oversize") as v -> (match v with `String x -> x | _ -> assert false)
        | _ -> raise (C.Invalid "collector-invalid") in
      ("failed", Some code, None)
  | `String "cancelled" ->
      C.keys result ["state"; "code"];
      let code = match C.get result "code" with `String ("cancelled"|"deadline"|"stale") as v -> (match v with `String x -> x | _ -> assert false) | _ -> raise (C.Invalid "collector-invalid") in
      ((if code="stale" then "stale" else "cancelled"), Some code, None)
  | _ -> raise (C.Invalid "collector-invalid")

let publish t r captured_at bytes =
  guard t (fun () ->
      prune t;
      let retained = Hashtbl.fold (fun _ r xs -> if r.payload <> None then r::xs else xs) t.records [] in
      let rec free retained =
        if List.length retained < 4 then true
        else match List.sort (fun a b -> compare a.published b.published) (List.filter (fun r -> r.borrowers=0) retained) with
          | [] -> false
          | oldest::_ -> retire oldest "evicted"; free (List.filter (fun r -> r != oldest) retained) in
      if r.cancelled<>None || not (free retained) then false
      else (
        let n = String.length bytes in
        let descriptor = obj ["observation_id", s r.id; "boot", s t.boot; "machine_id", s r.machine;
          "project_id", s r.project; "captured_revision", s r.revision; "byte_length", `Int n;
          "page_count", `Int ((n+page_bytes-1)/page_bytes); "raw_page_bytes", `Int page_bytes;
          "sha256", s (C.digest bytes); "captured_at", s captured_at; "published_at", s (utc ())] in
        r.payload <- Some bytes; r.descriptor <- Some descriptor; r.published <- Some (t.now ());
        r.state <- "complete"; r.code <- None; r.terminal <- Some (t.now ());
        t.active <- t.active-1; charge t "worker-release-after-result-transfer" (-worker_charge);
        emit t (Charge ("catalog-transfer-to-result-reservation", t.charged)); true))

let close fd = try Unix.close fd with Unix.Unix_error _ -> ()
exception Spawn_failed
let collect ?(arguments=[]) ?(output_cap=result_bytes+8192) ?(prefix="") ?(finish_input_on_cancel=false) t r input runtime entry =
  let input_read,input_write = Unix.pipe ~cloexec:true ()
  and output_read,output_write = Unix.pipe ~cloexec:true ()
  and error_read,error_write = Unix.pipe ~cloexec:true () in
  let all = [input_read;input_write;output_read;output_write;error_read;error_write] in
  let pid = try Unix.create_process runtime (Array.of_list (runtime::entry::arguments)) input_read output_write error_write
    with Unix.Unix_error _ -> List.iter close all; raise Spawn_failed in
  List.iter close [input_read;output_write;error_write];
  let input_open = ref true and out_open = ref true and err_open = ref true in
  let close_owned fd opened = if !opened then (opened := false; close fd) in
  Fun.protect ~finally:(fun () ->
      close_owned input_write input_open;
      close_owned output_read out_open;
      close_owned error_read err_open) (fun () ->
  emit t (Child_started pid);
  List.iter Unix.set_nonblock [input_write;output_read;error_read];
  (* Transfer input references to the pump. Prefix and body are separate
     borrowed strings, so validation never duplicates its two-MiB candidate. *)
  let pending = ref ((if prefix="" then [] else [prefix]) @ (match !input with None -> [] | Some bytes -> [bytes])) in
  input := None;
  let offset = ref 0 in
  let output = Bytes.create output_cap and output_len = ref 0 and overflow = ref false in
  let scratch = Bytes.create 8192 in
  let exited = ref None and signalled = ref None in
  let signal signal =
    (* Only this thread reaps. A child observed exited is never signalled. An
       exited but unreaped child remains our owned zombie, so its PID cannot
       be reused between the wait and this direct-child signal. *)
    if !exited = None then try Unix.kill pid signal with Unix.Unix_error (Unix.ESRCH,_,_) -> () in
  let read fd opened stdout =
    try let n = Unix.read fd scratch 0 8192 in
      if n=0 then close_owned fd opened
      else if stdout then
        if !output_len+n > Bytes.length output then overflow := true
        else (Bytes.blit scratch 0 output !output_len n; output_len := !output_len+n)
    with Unix.Unix_error ((Unix.EAGAIN|Unix.EWOULDBLOCK|Unix.EINTR),_,_) -> () in
      while !exited=None || !out_open || !err_open do
        if !exited=None then (try match Unix.waitpid [Unix.WNOHANG] pid with 0,_ -> () | _,status -> exited := Some status; emit t (Child_exited pid)
          with Unix.Unix_error (Unix.EINTR,_,_) -> ());
        let cancelled = cancellation t r in
        if (!overflow || cancelled<>None) && !signalled=None && !exited=None then (
          guard t (fun () -> r.state <- (if cancelled=Some "stale" then "cleanup-pending" else "cancelling")); signal Sys.sigterm; signalled := Some (t.now ()));
        (match !signalled with Some time when t.now () >= time +. 2. && !exited=None -> signal Sys.sigkill; signalled := Some infinity | _ -> ());
        if !input_open && ((cancelled<>None && not finish_input_on_cancel) || !exited<>None) then (close_owned input_write input_open; pending:=[]);
        if !exited<>None && (!out_open || !err_open) then cleanup_pending t r "worker-exited-unverified";
        let reads = (if !out_open then [output_read] else []) @ (if !err_open then [error_read] else []) in
        let writes = if !input_open then [input_write] else [] in
        let readable,writable,_ = try Unix.select reads writes [] 0.02 with Unix.Unix_error (Unix.EINTR,_,_) -> [],[],[] in
        List.iter (fun fd -> if fd=output_read then read fd out_open true else read fd err_open false) readable;
        if writable<>[] then (
          match !pending with
          | [] -> close_owned input_write input_open
          | bytes::rest ->
              (try let n = Unix.write_substring input_write bytes !offset (String.length bytes - !offset) in
                offset := !offset+n;
                if !offset=String.length bytes then (pending:=rest;offset:=0;if rest=[] then (close_owned input_write input_open))
              with Unix.Unix_error ((Unix.EAGAIN|Unix.EWOULDBLOCK|Unix.EINTR),_,_) -> ()
                 | Unix.Unix_error (Unix.EPIPE,_,_) -> pending:=[]; close_owned input_write input_open))
      done;
      emit t Pipes_drained;
      if !overflow then raise (C.Invalid "worker-exited-unverified");
      let bytes = Bytes.sub_string output 0 !output_len in
      (Option.get !exited, ref (Some bytes)))

let validate_catalog t r bytes runtime entry =
  (match cancellation t r with
  | Some reason -> raise(S.Outcome((if reason="stale" then "stale" else "cancelled"),reason))
  | None -> ());
  let sha256 = C.digest bytes in
  let header = C.encode (obj ["kind",s "mesh-project-catalog-validation-input";"version",`Int 1;
      "observation_id",s r.id;"boot",s t.boot;"scope",collector_scope r;"sha256",s sha256]) ^ "\n" in
  if String.length header>8192 then raise (C.Invalid "collector-invalid");
  let cancelled = guard t (fun () -> match r.cancelled with
      | None -> r.state<-"running";r.code<-None;None
      | Some reason -> Some reason) in
  (match cancelled with Some reason -> raise(S.Outcome((if reason="stale" then "stale" else "cancelled"),reason)) | None -> ());
  emit t (Charge ("validator-borrow-candidate-within-worker-reservation", t.charged));
  let status,wire = collect ~arguments:["--validate-catalog"] ~output_cap:8192 ~prefix:header ~finish_input_on_cancel:true
      t r (ref (Some bytes)) runtime entry in
  let ack = C.parse_document ~max_bytes:8192 (Option.get !wire) in
  wire:=None;
  let a=C.obj ack in
  C.keys a ["kind";"version";"observation_id";"boot";"scope";"sha256";"valid";"settlement"];
  if C.get a "kind"<>s "mesh-project-catalog-validation-reply" || C.get a "version"<>`Int 1
    || C.get a "observation_id"<>s r.id || C.get a "boot"<>s t.boot
    || C.get a "sha256"<>s sha256 || C.canonical(C.get a "scope")<>C.canonical(collector_scope r)
    then raise (C.Invalid "collector-invalid");
  let witness=C.obj(C.get a "settlement") in
  C.keys witness ["providers_closed";"provider_pipes_closed"];
  if C.get witness "providers_closed"<>`Bool true || C.get witness "provider_pipes_closed"<>`Bool true
    then raise (C.Invalid "worker-exited-unverified");
  let valid=match C.get a "valid" with `Bool value -> value | _ -> raise(C.Invalid "collector-invalid") in
  (* Cancelled: the host stopped the validator (SIGTERM, then SIGKILL 2 s later), and a validator still exiting
     then is killed after its settled reply. That exit status is the host's doing, not a failure of the
     validator: the validation is cancelled. *)
  (match cancellation t r with
  | Some reason -> raise(S.Outcome((if reason="stale" then "stale" else "cancelled"),reason))
  | None -> ());
  if status<>Unix.WEXITED 0 then raise(S.Outcome("failed","collector-failed"));
  valid

let captured_input t r =
  let config,plan = S.capture t.store ~machine_id:r.machine ~project_id:r.project ~expected_revision:r.revision in
  let input = C.encode (obj ["kind", s "mesh-project-observation-input";"version",`Int 1;
      "observation_id",s r.id;"boot",s t.boot;"scope",collector_scope r;"plan",plan;"config",config;"profile",s "metadata-followup/1"]) in
  if String.length input > result_bytes+8192 then raise (C.Invalid "byte-capacity");
  (ref (Some input), utc ())

let worker t r =
  let entered = ref false in
  try
    emit t Capture;
    let input,captured_at = captured_input t r in
    match cancellation t r with
    | Some reason -> settle t r (if reason="stale" then "stale" else "cancelled") (Some reason)
    | None ->
        let runtime,entry = Option.get t.runtime in
        if not (runtime_ready t) then settle t r "failed" (Some "runtime-unavailable")
        else (
          (* Cancellation is checked after capture and immediately before child
             entry. The spawn runs in this owned long worker, never control. *)
          match cancellation t r with
          | Some reason -> settle t r (if reason="stale" then "stale" else "cancelled") (Some reason)
          | None ->
              guard t (fun () -> r.state <- "running");
              entered := true;
              let status,output = try collect t r input runtime entry with
                | Spawn_failed -> raise (S.Outcome ("failed","runtime-unavailable")) in
              let state,code,payload = validate_output t r output in
              let cancelled = cancellation t r in
              (match cancelled with
              | Some reason -> settle t r (if reason="stale" then "stale" else "cancelled") (Some reason)
              | None when status<>Unix.WEXITED 0 -> settle t r "failed" (Some "collector-failed")
              | None -> (match payload with
                | Some bytes ->
                    let valid = try validate_catalog t r bytes runtime entry with Spawn_failed -> raise (S.Outcome ("failed","runtime-unavailable")) in
                    (match cancellation t r with
                    | Some reason -> settle t r (if reason="stale" then "stale" else "cancelled") (Some reason)
                    | None when not valid -> settle t r "failed" (Some "collector-invalid")
                    | None -> if publish t r captured_at bytes then emit t Settled else
                    (match cancellation t r with Some reason -> settle t r (if reason="stale" then "stale" else "cancelled") (Some reason)
                    | None -> settle t r "failed" (Some "result-capacity")))
                | None -> settle t r state code)))
  with
  | S.Outcome (state,code) -> settle t r state (Some code)
  | C.Invalid code -> if !entered then cleanup_pending t r "worker-exited-unverified" else settle t r "failed" (Some (if code="byte-capacity" then code else "collector-invalid"))
  | Unix.Unix_error _ | Sys_error _ | Failure _ | Yojson.Json_error _ | Invalid_argument _ ->
      if !entered then cleanup_pending t r "worker-exited-unverified" else settle t r "failed" (Some "runtime-unavailable")

let validate_request t fields =
  C.strict (obj fields);
  (* The native raw-frame gate marks oversized project input. Closed scalar
     validation below needs no duplicate serialization of a borrowed frame. *)
  if List.mem_assoc "__project_request_oversize" fields then raise (C.Invalid "invalid-request");
  let op = match C.get fields "op" with `String op when is_operation op -> op | _ -> raise (C.Invalid "invalid-request") in
  let start = op="project_observation_start" in
  let allowed = ["op";"version";"boot";"machine_id";"project_id";"request_id"] @
    (if start then ["expected_revision"] else ["requested_revision";"observation_id"])
    @ (if op="project_observation_page" then ["page_index"] else [])
    @ (if op="project_observation_cancel" then ["cancel_token"] else []) in
  C.keys fields allowed;
  if C.get fields "version" <> `Int 1 then raise (S.Outcome ("unsupported","wrong-version"));
  let boot = hex (C.get fields "boot") in
  let machine = C.id (C.get fields "machine_id") and project = C.id (C.get fields "project_id")
  and request = C.uuid (C.get fields "request_id")
  and rev = revision (C.get fields (if start then "expected_revision" else "requested_revision")) in
  if boot <> t.boot then raise (S.Outcome ("conflict","stale-host"));
  if not start then ignore (hex (C.get fields "observation_id"));
  if op="project_observation_page" then (match C.get fields "page_index" with `Int n when n>=0 && n<=15 -> () | _ -> raise (C.Invalid "page-range"));
  if op="project_observation_cancel" then ignore (hex (C.get fields "cancel_token"));
  (op,machine,project,request,rev)

let admit t op machine project request revision =
  let result = guard t (fun () ->
      prune t;
      match Hashtbl.fold (fun _ r found -> if r.request=request then Some r else found) t.records None with
      | Some r ->
          if r.machine<>machine || r.project<>project || r.revision<>revision then raise (S.Outcome ("conflict","immutable-identity"));
          `Replay r
      | None ->
          if t.runtime=None then raise (S.Outcome ("unavailable","runtime-not-configured"));
          if not t.runtime_initial_ready then raise (S.Outcome ("unavailable","runtime-unavailable"));
          if t.active>=2 then raise (S.Outcome ("busy","worker-capacity"));
          if Hashtbl.length t.records>=128 then raise (S.Outcome ("busy","record-capacity"));
          let id=random () and token=random () in
          charge t "worker-reserve-before-capture" worker_charge;
          let r = {id;token;request;machine;project;revision;admitted=t.now ();state="capturing";code=None;
            terminal=None;published=None;descriptor=None;payload=None;borrowers=0;retired=false;cancelled=None} in
          t.active<-t.active+1; Hashtbl.add t.records r.id r;
          `New (r, known t op r ["cancel_token",s r.token;"replayed",`Bool false])) in
  match result with
  | `Replay r -> guard t (fun () -> known t op r ["cancel_token",s r.token;"replayed",`Bool true])
  | `New (r,reply) ->
      (try ignore (Thread.create (worker t) r) with _ -> settle t r "failed" (Some "runtime-unavailable")); reply

let control t fields op machine project request revision =
  let id = hex (C.get fields "observation_id") in
  let admitted = guard t (fun () ->
      prune t;
      if t.controls>=4 then false
      else (charge t "control-reserve" control_charge; t.controls<-t.controls+1; true)) in
  if not admitted then raise (S.Outcome ("busy","control-capacity"));
  Fun.protect ~finally:(fun () -> guard t (fun () -> t.controls<-t.controls-1;charge t "control-transfer-to-transport" (-control_charge))) (fun () ->
      emit t Control;
      let result = guard t (fun () ->
          match Hashtbl.find_opt t.records id with
          | None -> `Reply (base t op "ok" ["code",s "unknown";"observation_id",s id;"request_id",s request;
                "requested_scope",obj ["machine_id",s machine;"project_id",s project;"revision",s revision]])
          | Some r ->
              if r.request<>request || r.machine<>machine || r.project<>project || r.revision<>revision then raise (S.Outcome ("conflict","lifetime-mismatch"));
              if r.terminal=None && t.now ()>=r.admitted+.30. then request_cancel t r "deadline";
              if op="project_observation_cancel" then (
                if C.get fields "cancel_token" <> s r.token then raise (S.Outcome ("refused","cancellation-denied"));
                request_cancel t r "cancelled");
              if op="project_observation_page" && r.state="complete" then (
                let index = match C.get fields "page_index" with `Int n -> n | _ -> assert false in
                match r.payload with
                | Some bytes when index*page_bytes < String.length bytes ->
                    r.borrowers<-r.borrowers+1; `Page (r,bytes,index,known t op r [])
                | Some _ -> raise (S.Outcome ("refused","page-range"))
                | None -> `Reply (known t op r []))
              else `Reply (known t op r [])) in
      match result with
      | `Reply reply -> reply
      | `Page (r,bytes,index,metadata) ->
          Fun.protect ~finally:(fun () -> guard t (fun () -> r.borrowers<-r.borrowers-1; if r.borrowers=0 && r.retired then r.payload<-None)) (fun () ->
              emit t Borrow;
              let offset = index*page_bytes in
              let raw = String.sub bytes offset (min page_bytes (String.length bytes-offset)) in
              let encoded = Base64.encode_string ~pad:true raw in
              (* Borrow pins the immutable result until the complete encoded
                 DTO is built. After return its bounded DTO is explicitly
                 transferred to the existing socket transport. *)
              obj (C.obj metadata @ ["page_index",`Int index;"data_base64",s encoded])))

let tick t ~stopping = guard t (fun () ->
    prune t;
    Hashtbl.iter (fun _ r -> if r.terminal=None then
        if stopping then request_cancel t r "cancelled"
        else if t.now () >= r.admitted+.30. then request_cancel t r "deadline") t.records)

let run t ~isolated ~stopping fields =
  let op = match List.assoc_opt "op" fields with Some (`String op) when is_operation op -> op | _ -> "project_observation_start" in
  try
    if isolated then raise (S.Outcome ("unsupported","unsupported-feature"));
    let op,machine,project,request,revision = validate_request t fields in
    if stopping && op="project_observation_start" then raise (S.Outcome ("unavailable","stopping"));
    if op="project_observation_start" then admit t op machine project request revision
    else control t fields op machine project request revision
  with
  | S.Outcome (status,code) -> error t op status code
  | C.Invalid code -> error t op "refused" code
  | Unix.Unix_error _ | Sys_error _ | Failure _ | Yojson.Json_error _ -> error t op "unavailable" "runtime-unavailable"
