(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

type source = Observed | Hook | Chosen
type state = Active | Contested
type incarnation = { name : string; created : float option; nonce : string option }

type entry = {
  session : incarnation;
  agent : string;
  id : string option;
  source : source;
  evidence : string;
  agent_started : float option;
  observed_at : float;
  generation : int;
  state : state;
  holds_open : bool;
}

type registry = { counter : int; entries : entry list }

module Claim = struct
  type t = {
    session : incarnation;
    agent : string;
    id : string;
    source : source;
    evidence : string;
    agent_started : float option;
    holds_open : bool;
  }
end

type formats = (string * (string -> bool)) list

let version = 1
let max_entries = 400
let max_bytes = 512 * 1024
let grace = 60.0

(* Two reads of one process's start time agree to within this, in seconds. *)
let slack = 2.0
let empty = { counter = 0; entries = [] }

(* ------------------------------------------------------------ formats *)

let is_digit c = c >= '0' && c <= '9'
let is_alnum c = is_digit c || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
let is_lower_hex c = is_digit c || (c >= 'a' && c <= 'f')

let length_in s ~min ~max =
  let n = String.length s in
  n >= min && n <= max

module Format = struct
  let uuid s =
    let at i c =
      if i = 8 || i = 13 || i = 18 || i = 23 then c = '-' else is_lower_hex c
    in
    let ok = ref (String.length s = 36) in
    String.iteri (fun i c -> if not (at i c) then ok := false) s;
    !ok

  let prefixed ~prefix ~min ~max s =
    let p = String.length prefix in
    String.starts_with ~prefix s
    &&
    let rest = String.sub s p (String.length s - p) in
    length_in rest ~min ~max && String.for_all is_alnum rest

  let token ~min ~max s =
    length_in s ~min ~max
    && String.length s > 0
    && is_alnum s.[0]
    && String.for_all (fun c -> is_alnum c || c = '_' || c = '-') s
end

let valid_name s =
  length_in s ~min:1 ~max:48
  && String.for_all (fun c -> is_alnum c || c = '_' || c = '-') s

let valid_nonce s = String.length s = 32 && String.for_all is_lower_hex s

let valid_evidence s =
  match String.index_opt s ':' with
  | None -> false
  | Some i ->
      let kind = String.sub s 0 i in
      let detail = String.sub s (i + 1) (String.length s - i - 1) in
      length_in kind ~min:1 ~max:16
      && String.for_all (fun c -> c >= 'a' && c <= 'z') kind
      && length_in detail ~min:1 ~max:48
      && String.for_all (fun c -> is_alnum c || c = '_' || c = '.' || c = '-') detail

let valid_id ~formats ~agent id =
  match List.assoc_opt agent formats with Some check -> check id | None -> false

let valid_incarnation i =
  valid_name i.name
  && (match i.created with Some f -> Float.is_finite f | None -> true)
  && (match i.nonce with Some n -> valid_nonce n | None -> true)
  && (i.created <> None || i.nonce <> None)

let valid_time = function None -> true | Some f -> Float.is_finite f && f > 0.

let valid_claim ~formats (c : Claim.t) =
  valid_incarnation c.session
  && valid_id ~formats ~agent:c.agent c.id
  && valid_evidence c.evidence && valid_time c.agent_started

(* ------------------------------------------------------------ rules *)

let rank = function Observed -> 1 | Hook -> 2 | Chosen -> 3
let strength (e : entry) = (rank e.source, e.holds_open)

let same_incarnation a b =
  let shared x y = match (x, y) with Some x, Some y -> Some (x = y) | _ -> None in
  a.name = b.name
  &&
  match (shared a.created b.created, shared a.nonce b.nonce) with
  | None, None -> false
  | c, n -> Option.value c ~default:true && Option.value n ~default:true

let bound known seen =
  let fill k s = match k with None -> s | k -> k in
  { known with created = fill known.created seen.created; nonce = fill known.nonce seen.nonce }

(* The claim's agent process started after the entry was made: the agent was
   quit and started again in the terminal. *)
let started_after (c : Claim.t) (e : entry) =
  match c.agent_started with
  | None -> false
  | Some s -> s > Option.value e.agent_started ~default:e.observed_at +. slack

(* The claim's agent process started before the entry's: a late report. *)
let started_before (c : Claim.t) (e : entry) =
  match (c.agent_started, e.agent_started) with
  | Some s, Some t -> s < t -. slack
  | _ -> false

(* An observation never replaces a hook or chosen id of the same process: a
   listing is sampled before it is recorded, so it may be older than the
   report. Only one of a later process does. *)
let refused (mine : entry) (c : Claim.t) =
  if mine.agent <> c.agent then not (started_after c mine)
  else if mine.id = Some c.id then false
  else if started_before c mine then true
  else
    c.source = Observed && mine.source <> Observed && mine.state = Active
    && not (started_after c mine)

(* The start time an entry keeps: the claim's when none is known, or when it
   is a later process. *)
let later known seen =
  match (known, seen) with
  | None, s -> s
  | Some k, Some s when s > k +. slack -> Some s
  | k, _ -> k

let refreshed registry (mine : entry) (c : Claim.t) =
  let stronger = rank c.source > rank mine.source in
  let updated =
    {
      mine with
      session = bound mine.session c.session;
      holds_open = mine.holds_open || c.holds_open;
      agent_started = later mine.agent_started c.agent_started;
      source = (if stronger then c.source else mine.source);
      evidence = (if stronger then c.evidence else mine.evidence);
    }
  in
  if updated = mine then registry
  else { registry with entries = List.map (fun e -> if e == mine then updated else e) registry.entries }

let same_fact (a : entry) (b : entry) =
  a.session = b.session && a.agent = b.agent && a.id = b.id && a.source = b.source
  && a.evidence = b.evidence && a.agent_started = b.agent_started && a.state = b.state
  && a.holds_open = b.holds_open

(* At most [max_entries]: the entries of incarnations not in [listed] (when
   known) are dropped first, then the oldest observed (file order when
   equal). *)
let bounded ?listed entries =
  let excess = List.length entries - max_entries in
  if excess <= 0 then entries
  else
    let live (e : entry) =
      match listed with Some l -> List.exists (same_incarnation e.session) l | None -> false
    in
    let order =
      List.mapi (fun i (e : entry) -> (live e, e.observed_at, i)) entries |> List.sort compare
    in
    let dropped = List.filteri (fun k _ -> k < excess) order |> List.map (fun (_, _, i) -> i) in
    List.filteri (fun i _ -> not (List.mem i dropped)) entries

let candidate_of (c : Claim.t) session ~generation ~now =
  {
    session;
    agent = c.agent;
    id = Some c.id;
    source = c.source;
    evidence = c.evidence;
    agent_started = c.agent_started;
    observed_at = now;
    generation;
    state = Active;
    holds_open = c.holds_open;
  }

let placed ?listed registry (mine : entry option) (c : Claim.t) ~now =
  let generation = registry.counter + 1 in
  let session = match mine with Some m -> bound m.session c.session | None -> c.session in
  let candidate = candidate_of c session ~generation ~now in
  (* An untimed report of the same agent keeps the start of its process. *)
  let candidate =
    match mine with
    | Some m when m.agent = c.agent && c.agent_started = None ->
        { candidate with agent_started = m.agent_started }
    | _ -> candidate
  in
  let is_mine e = match mine with Some m -> e == m | None -> false in
  let holder =
    List.find_opt
      (fun e -> (not (is_mine e)) && e.state = Active && e.agent = c.agent && e.id = Some c.id)
      registry.entries
  in
  (* A holder the PTY host does not list loses to a claim of a listed incarnation. *)
  let listed_has (s : incarnation) =
    match listed with Some l -> List.exists (same_incarnation s) l | None -> false
  in
  let outlisted (h : entry) =
    listed <> None && listed_has candidate.session && not (listed_has h.session)
  in
  let candidate, holder =
    match holder with
    | Some h when (not (outlisted h)) && compare (strength candidate) (strength h) <= 0 ->
        ({ candidate with state = Contested; id = None }, None)
    | h -> (candidate, h)
  in
  match mine with
  | Some m when holder = None && same_fact m candidate -> registry
  | _ ->
      let is_holder e = match holder with Some h -> e == h | None -> false in
      let kept =
        List.filter_map
          (fun e ->
            if is_mine e then None
            else if is_holder e then Some { e with state = Contested; id = None; generation }
            else Some e)
          registry.entries
      in
      { counter = generation; entries = bounded ?listed (kept @ [ candidate ]) }

(* The incarnation's entry; when several entries are that incarnation (one
   keyed by its birth date, one by its nonce), only the newest stays. *)
let joined registry session =
  match List.filter (fun e -> same_incarnation e.session session) registry.entries with
  | [] -> (registry, None)
  | [ m ] -> (registry, Some m)
  | first :: rest as matches ->
      let mine =
        List.fold_left (fun m e -> if e.generation > m.generation then e else m) first rest
      in
      let entries =
        List.filter (fun e -> e == mine || not (List.memq e matches)) registry.entries
      in
      ({ registry with entries }, Some mine)

(* A refused claim still says which incarnation the entry is: its missing
   [created] or [nonce] is filled in. *)
let rebound registry (m : entry) session =
  let session = bound m.session session in
  if session = m.session then registry
  else { registry with entries = List.map (fun e -> if e == m then { e with session } else e) registry.entries }

let merge ?listed ~formats registry (c : Claim.t) ~now =
  if not (valid_claim ~formats c) then registry
  else
    let registry, mine = joined registry c.session in
    match mine with
    | Some m when refused m c -> rebound registry m c.session
    | Some m when m.state = Active && m.id = Some c.id && m.agent = c.agent ->
        refreshed registry m c
    | _ -> placed ?listed registry mine c ~now

(* Of the entries that are one incarnation, the newest (by generation; the
   first when equal). *)
let newest_only entries =
  let superseded e =
    List.exists
      (fun o -> o != e && same_incarnation o.session e.session && o.generation > e.generation)
      entries
  in
  let kept = List.filter (fun e -> not (superseded e)) entries in
  let earlier i = List.filteri (fun j _ -> j < i) kept in
  List.filteri
    (fun i e -> not (List.exists (fun o -> same_incarnation o.session e.session) (earlier i)))
    kept

let prune registry ~keep ~now =
  let entries =
    List.filter_map
      (fun e ->
        match List.find_opt (same_incarnation e.session) keep with
        | Some seen -> Some { e with session = bound e.session seen }
        | None -> if now -. e.observed_at < grace then Some e else None)
      registry.entries
    |> newest_only
  in
  if entries = registry.entries then registry else { registry with entries }

type resolution = No_entry | Resolved of string | Contested_entry

let resolve registry ~name ~created ~agent =
  let query = { name; created = Some created; nonce = None } in
  match
    List.find_opt (fun e -> same_incarnation e.session query && e.agent = agent) registry.entries
  with
  | None -> No_entry
  | Some { state = Contested; _ } -> Contested_entry
  | Some { id = Some id; _ } -> Resolved id
  | Some { id = None; _ } -> Contested_entry

(* ------------------------------------------------------------ JSON *)

(* The last value of a repeated key, as Python's json module keeps. *)
let field (json : Yojson.Safe.t) key =
  match json with
  | `Assoc pairs -> List.fold_left (fun found (k, v) -> if k = key then Some v else found) None pairs
  | _ -> None

let finite f = if Float.is_finite f then Some f else None

let number : Yojson.Safe.t -> float option = function
  | `Int i -> Some (float_of_int i)
  | `Intlit s -> Option.bind (float_of_string_opt s) finite
  | `Float f -> finite f
  | _ -> None

(* [Some value] when valid (value [None]: absent or null), [None] when not. *)
let optional_number = function
  | None | Some `Null -> Some None
  | Some j -> Option.map Option.some (number j)

let optional_time j =
  match optional_number j with Some (Some f) when f <= 0. -> None | checked -> checked

let optional_string valid = function
  | None | Some `Null -> Some None
  | Some (`String s) when valid s -> Some (Some s)
  | Some _ -> None

let source_of_string = function
  | "observed" -> Some Observed
  | "hook" -> Some Hook
  | "chosen" -> Some Chosen
  | _ -> None

let string_of_source = function Observed -> "observed" | Hook -> "hook" | Chosen -> "chosen"

let string_field json key valid =
  match field json key with Some (`String s) when valid s -> Some s | _ -> None

let incarnation_of_json json =
  match
    ( string_field json "name" valid_name,
      optional_number (field json "created"),
      optional_string valid_nonce (field json "nonce") )
  with
  | Some name, Some created, Some nonce ->
      let i = { name; created; nonce } in
      if valid_incarnation i then Some i else None
  | _ -> None

let ( let* ) = Option.bind

let claim_of_json ~formats json : Claim.t option =
  let* session = Option.bind (field json "session") incarnation_of_json in
  let* agent = string_field json "agent" (fun a -> List.mem_assoc a formats) in
  let* id = string_field json "id" (valid_id ~formats ~agent) in
  let* source = Option.bind (string_field json "source" (fun _ -> true)) source_of_string in
  let* evidence = string_field json "evidence" valid_evidence in
  let* agent_started = optional_time (field json "agent_started") in
  let* holds_open =
    match field json "holds_open" with None -> Some false | Some (`Bool b) -> Some b | Some _ -> None
  in
  Some { Claim.session; agent; id; source; evidence; agent_started; holds_open }

let state_of_string = function "active" -> Some Active | "contested" -> Some Contested | _ -> None

let entry_id ~formats ~agent state json =
  match (state, field json "id") with
  | Contested, (None | Some `Null) -> Some None
  | Active, Some (`String s) when valid_id ~formats ~agent s -> Some (Some s)
  | _ -> None

let entry_of_json ~formats json =
  let* session = Option.bind (field json "session") incarnation_of_json in
  let* agent = string_field json "agent" (fun a -> List.mem_assoc a formats) in
  let* state = Option.bind (string_field json "state" (fun _ -> true)) state_of_string in
  let* id = entry_id ~formats ~agent state json in
  let* source = Option.bind (string_field json "source" (fun _ -> true)) source_of_string in
  let* evidence = string_field json "evidence" valid_evidence in
  let* agent_started = optional_time (field json "agent_started") in
  let* observed_at = Option.bind (field json "observed_at") number in
  let* generation = match field json "generation" with Some (`Int g) when g >= 0 -> Some g | _ -> None in
  let* holds_open = match field json "holds_open" with Some (`Bool b) -> Some b | _ -> None in
  Some { session; agent; id; source; evidence; agent_started; observed_at; generation; state; holds_open }

let deduplicated entries =
  List.fold_left
    (fun kept e -> if List.exists (fun k -> same_incarnation e.session k.session) kept then kept else kept @ [ e ])
    [] entries

(* The version is read before the shape: a newer version, whatever its
   shape, is never replaced. *)
let of_json ~formats json =
  match (field json "version", field json "entries") with
  | Some (`Int v), _ when v <> version -> (empty, v < version)
  | Some (`Intlit s), _ -> (empty, String.length s > 0 && s.[0] = '-')
  | Some (`Int _), Some (`List items) ->
      let entries = List.filteri (fun i _ -> i < max_entries) items |> List.filter_map (entry_of_json ~formats) in
      let entries = deduplicated entries in
      let counter =
        match field json "generation" with
        | Some (`Int g) when g >= 0 -> g
        | _ -> List.fold_left (fun m e -> max m e.generation) 0 entries
      in
      ({ counter; entries }, true)
  | _ -> (empty, true)

let optional f = function None -> `Null | Some v -> f v

let incarnation_to_json i =
  `Assoc
    [
      ("name", `String i.name);
      ("created", optional (fun f -> `Float f) i.created);
      ("nonce", optional (fun s -> `String s) i.nonce);
    ]

let entry_to_json e =
  `Assoc
    [
      ("session", incarnation_to_json e.session);
      ("agent", `String e.agent);
      ("id", optional (fun s -> `String s) e.id);
      ("source", `String (string_of_source e.source));
      ("evidence", `String e.evidence);
      ("agent_started", optional (fun f -> `Float f) e.agent_started);
      ("observed_at", `Float e.observed_at);
      ("generation", `Int e.generation);
      ("state", `String (match e.state with Active -> "active" | Contested -> "contested"));
      ("holds_open", `Bool e.holds_open);
    ]

let to_json r =
  `Assoc
    [
      ("version", `Int version);
      ("generation", `Int r.counter);
      ("entries", `List (List.map entry_to_json r.entries));
    ]

(* ------------------------------------------------------------ store *)

type read_result = Missing | Read of registry * bool

let parse ~formats text =
  match Yojson.Safe.from_string text with
  | json -> of_json ~formats json
  | exception (Yojson.Json_error _ | Stack_overflow | Out_of_memory) -> (empty, true)

let read ~formats path =
  let contents fd (stats : Unix.stats) =
    if stats.st_perm land 0o077 <> 0 || stats.st_size > max_bytes then None
    else Some (Mesh_safe_file.read_range fd ~offset:0 ~length:(max_bytes + 1))
  in
  match Mesh_safe_file.with_regular path contents with
  | Error Mesh_safe_file.Missing -> Missing
  | Ok (Some text) when String.length text <= max_bytes ->
      let registry, writable = parse ~formats text in
      Read (registry, writable)
  | Ok _ | Error _ -> Read (empty, true)

let write_all fd text =
  let bytes = Bytes.of_string text in
  let rec go off =
    if off < Bytes.length bytes then go (off + Unix.write fd bytes off (Bytes.length bytes - off))
  in
  go 0

let fsync_directory dir =
  let fd = Unix.openfile dir [ Unix.O_RDONLY; Unix.O_CLOEXEC ] 0 in
  Fun.protect ~finally:(fun () -> Unix.close fd) (fun () -> Unix.fsync fd)

let random = lazy (Random.State.make_self_init ())

let write_atomic path text =
  let dir = Filename.dirname path in
  let tmp =
    Filename.concat dir
      (Printf.sprintf ".%s.%d.%d" (Filename.basename path) (Unix.getpid ())
         (Random.State.bits (Lazy.force random)))
  in
  let fd = Unix.openfile tmp [ Unix.O_WRONLY; Unix.O_CREAT; Unix.O_EXCL; Unix.O_CLOEXEC ] 0o600 in
  (try
     Fun.protect ~finally:(fun () -> Unix.close fd) (fun () ->
         write_all fd text;
         Unix.fsync fd);
     Unix.rename tmp path
   with e ->
     (try Unix.unlink tmp with Unix.Unix_error _ -> ());
     raise e);
  fsync_directory dir

let with_lock path f =
  let fd = Unix.openfile (path ^ ".lock") [ Unix.O_RDWR; Unix.O_CREAT; Unix.O_CLOEXEC ] 0o600 in
  Fun.protect ~finally:(fun () -> Unix.close fd) (fun () ->
      Unix.lockf fd Unix.F_LOCK 0;
      f ())

let update ~formats path change =
  let apply () =
    let current, writable, missing =
      match read ~formats path with Missing -> (empty, true, true) | Read (r, w) -> (r, w, false)
    in
    if not writable then Error "identity registry of a newer version: not replaced"
    else
      let next = change current in
      if not (missing || next <> current) then Ok next
      else
        let text = Yojson.Safe.pretty_to_string (to_json next) in
        if String.length text > max_bytes then
          Error "identity registry over its size limit: not written"
        else (
          write_atomic path text;
          Ok next)
  in
  try with_lock path apply
  with Unix.Unix_error (err, call, _) -> Error (call ^ ": " ^ Unix.error_message err)
