(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(** The session identity registry: the conversation each session incarnation
    runs, recorded when it becomes known and never guessed.

    The file is [session-identities.json], next to the sessions snapshot,
    mode 0600, replaced atomically under an fcntl lock on
    [session-identities.json.lock]:

    {v
    {"version": 1, "generation": int, "entries": [entry]}
    entry = {"session": {"name", "created": float | null, "nonce": str | null},
             "agent", "id": str | null, "source": "chosen" | "hook" | "observed",
             "evidence": "<kind>:<detail>", "agent_started": float | null,
             "observed_at": float, "generation": int,
             "state": "active" | "contested", "holds_open": bool}
    v}

    The web server ([respawn.py]) implements the same rules; both run the
    vectors of [test/vectors]. Nothing here knows an agent: the id format of
    each one is the caller's [formats]. *)

type source =
  | Observed  (** Seen exactly by a listing (an open rollout, a pid file). *)
  | Hook  (** Reported by the agent's hook. *)
  | Chosen  (** Named by Mesh before the agent started. *)

type state = Active | Contested  (** A contested entry has no id. *)

type incarnation = {
  name : string;
  created : float option;  (** Known once the session is listed. *)
  nonce : string option;  (** Known when Mesh created the session. *)
}

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
(** [counter] is the file's ["generation"]: one more for every placed claim. *)

module Claim : sig
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
(** The agents and, for each, whether a string is one of its conversation ids.
    An id never starts with ['-']: it ends up in an argument vector. *)

(** Id checks a [formats] table is built from. *)
module Format : sig
  val uuid : string -> bool
  (** A canonical lower-case UUID. *)

  val prefixed : prefix:string -> min:int -> max:int -> string -> bool
  (** [prefix] then [min] to [max] ASCII letters or digits. *)

  val token : min:int -> max:int -> string -> bool
  (** An ASCII letter or digit, then letters, digits, ['_'] or ['-'];
      [min] to [max] characters in all. *)
end

val empty : registry
val max_entries : int
val max_bytes : int

val grace : float
(** Seconds an entry outlives an unlisted incarnation (it may be written just
    before its session is listed). *)

val same_incarnation : incarnation -> incarnation -> bool
(** Same name, [created] and [nonce] equal wherever both know them, and at
    least one of the two known on both sides. *)

val merge : formats:formats -> registry -> Claim.t -> now:float -> registry
(** The registry after one claim. In order: an invalid claim changes
    nothing; on the incarnation's own entry, another agent counts only from a
    process started after that entry, and another id from a process started
    before the entry's agent is a late report, ignored; the same id refreshes
    the entry (the stronger source, [holds_open] once seen, a start time);
    another id replaces it (the newest fact wins). Among incarnations one id
    has one holder: the stronger (chosen > hook > observed, then the one that
    holds the rollout open) keeps it and the other is [Contested]; when equal,
    the current holder keeps it. *)

val prune : registry -> keep:incarnation list -> now:float -> registry
(** Without the entries of incarnations not in [keep] and older than
    {!grace}; a kept entry takes the [created] or [nonce] it lacks. *)

type resolution = No_entry | Resolved of string | Contested_entry

val resolve : registry -> name:string -> created:float -> agent:string -> resolution

(** {1 JSON} *)

val claim_of_json : formats:formats -> Yojson.Safe.t -> Claim.t option
(** A claim object, checked as an entry; [holds_open] defaults to false. *)

val incarnation_of_json : Yojson.Safe.t -> incarnation option

val of_json : formats:formats -> Yojson.Safe.t -> registry * bool
(** The registry and whether this version may replace the file. A newer
    version reads as empty and not writable; other malformed content reads as
    empty; each entry is checked, the first {!max_entries} only, and a
    repeated incarnation is dropped. *)

val to_json : registry -> Yojson.Safe.t

(** {1 Store} *)

type read_result =
  | Missing
  | Read of registry * bool  (** The registry and whether it may be replaced. *)

val read : formats:formats -> string -> read_result
(** Never follows a link; a file that is not a private regular file, is too
    large or does not parse reads as an empty, replaceable registry. *)

val update :
  formats:formats -> string -> (registry -> registry) -> (registry, string) result
(** Under the file lock: read (empty when missing), apply, and replace the
    file when the result differs or there was none (temporary file, fsync,
    rename, fsync of the directory). [Error] when a newer version holds the
    file or the write failed. *)
