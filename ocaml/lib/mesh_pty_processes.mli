(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(** The [processes] operation of the native PTY host: the process facts its
    local clients need where they cannot read [/proc] themselves (macOS).

    Requests:
    - [{"op": "processes"}]: every process the host can see;
    - [{"op": "processes", "pids": [N, ...]}]: at most {!max_selected} positive
      pids, each looked up alone, without details. An empty list asks for the
      host's own identity only.

    Reply: [{"version": 1, "host": H, "complete": B, "processes": [ROW, ...]}],
    plus ["errors": [{"pid": N, "kind": K}, ...]] for a [pids] request. [H] is
    [{"pid": N, "incarnation": "DIGITS"}] for the host itself, or [null] when
    its own entry cannot be read. [K] is [not_found], [denied], [unsupported] or
    [malformed]. A row has [pid], [ppid], [pgrp], [sid], [tpgid], [comm],
    [state] (one letter) and [incarnation] (decimal string, see
    {!Mesh_platform.process}), and for a whole table only, these details:
    - [argv] (list of strings) and [cwd], for a process with a controlling
      terminal ([tpgid > 0]) or named [claude], [codex], [pi], [node] or
      [nodejs];
    - [stdin], the path open on descriptor 0, for such a process that leads its
      session with a controlling terminal ([null] when descriptor 0 has no
      path);
    - [open_files] (list of paths), for such a process that is [codex] by name
      or by the basename of [argv.(0)].

    A detail that cannot be read is [null]; it never fails the operation. A
    table that cannot be read at all is empty with [complete = false]. Strings
    are the kernel's bytes, which need not be UTF-8.

    [complete] is [true] only when every process of the scan has its row with
    all its details. It is [false] when a process exists but was left out by the
    scan ([Denied] or [Malformed] entry, see {!Mesh_platform.scan}), or when the
    budget dropped a row or a detail.

    The reply fits one control frame. Rows are in pid order. Priority, highest
    first: a session leader with a terminal, a process in its terminal's
    foreground group, or a process named like an agent ([claude], [codex], [pi],
    [node], [nodejs]); then any other process with a terminal; then the rest.
    When the bare rows of every process fit the budget, all are sent and details
    are added in priority order while they fit. Otherwise bare rows are taken in
    priority order, each one kept if it fits the room left and skipped if not (a
    smaller row further down may still be kept), then details as before. *)

type platform = {
  scan : unit -> (Mesh_platform.process_scan, Mesh_platform.error) result;
  process : int -> (Mesh_platform.process, Mesh_platform.error) result;
  command_line : int -> (string list, Mesh_platform.error) result;
  working_directory : int -> (string, Mesh_platform.error) result;
  open_file_paths : int -> ((int * string) list, Mesh_platform.error) result;
  process_owner : int -> (int, Mesh_platform.error) result;
}
(** The facts the operation reads; tests pass their own. The [processes]
    reply does not use [process_owner]; the session listing does. *)

val live : platform
(** {!Mesh_platform} itself. *)

type request

val max_selected : int

val parse : (string * Yojson.Basic.t) list -> request
(** Validates a request's fields ([op] is checked by the caller). Raises
    [Invalid_argument] for any other key, a repeated key or an invalid [pids]
    list. *)

val default_budget : int
(** Bytes the [processes] list may take: a control frame minus room for the rest
    of the reply. *)

val reply : ?platform:platform -> ?budget:int -> request -> Yojson.Basic.t
(** Reads the process table. It can take tens of milliseconds and blocks the
    calling thread: the host runs it in a system thread. *)
