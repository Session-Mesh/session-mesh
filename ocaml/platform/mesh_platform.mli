(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(** Operating-system facts Session Mesh needs, behind one interface.

    Everything here that differs between Linux and macOS goes through this
    module. The OCaml programs inspect other processes and resolve the runtime
    directory only through it (the PTY host still reads [/proc/self/uid_map] for
    its Linux-only isolated agent launcher). The Python server is not a caller:
    on Linux it keeps its own [/proc] code, and on macOS it asks the PTY host,
    which answers from this module. The backend is chosen at build time from
    [%{system}]: [linux] reads procfs, [macosx] uses [libproc]/[sysctl], and any
    other system builds a backend that reports every inspection as
    [Unsupported].

    macOS specifics: a process of another user is read through
    [sysctl(KERN_PROC_PID)], so it appears in {!snapshot} and {!process}, but
    its {!command_line}, {!working_directory} and {!open_file_paths} are
    [Denied]. A zombie is reported with state [Z], [sid] 0 (the kernel no longer
    knows its session) and an empty {!command_line}. The kernel marks most live
    processes runnable: [state] is [S] for one of the caller's own processes
    with no running thread, and [R] for every live process of another user,
    asleep or not.

    Inspection results are snapshots of a process table that keeps changing. A
    pid can be reused between two calls; compare {!process.incarnation} before
    trusting that two observations describe the same process. *)

(** {1 Platform and capabilities} *)

type platform = Linux | Macos | Other of string

val platform : platform
(** The system this binary was built for. *)

val platform_name : platform -> string
(** ["linux"], ["macos"], or the [Other] name. *)

type capabilities = {
  process_table : bool;  (** {!snapshot} and {!process} work. *)
  foreground_agent : bool;
      (** {!foreground_process_group} plus {!command_line} identify the agent in
          a terminal's foreground. *)
  open_file_paths : bool;  (** {!open_file_paths} works. *)
  isolated_agent : bool;
      (** The UID-split agent launcher ([setpriv], Linux only) is available. *)
  demo_sandbox : bool;
      (** The demo compiler's sandbox ([bwrap], Linux only) is available. *)
}
(** What this build can do. {!require} turns [isolated_agent] and [demo_sandbox]
    into a clear refusal for a feature that needs them; no program calls it yet
    (see {!require}). *)

val capabilities : unit -> capabilities
(** Probed once per call; [isolated_agent] and [demo_sandbox] also check that
    the executable they need is present. *)

(** {1 Errors} *)

type error =
  | Unsupported of string  (** This platform has no such facility. *)
  | Not_found  (** No such process, or it exited during the read. *)
  | Denied  (** The process exists but belongs to someone else. *)
  | Malformed of string  (** The kernel answer did not parse. *)

val error_to_string : error -> string

(** {1 Runtime directory} *)

type runtime_source =
  | Xdg_runtime_dir  (** [$XDG_RUNTIME_DIR], set by the login manager. *)
  | Mesh_runtime_dir  (** [$MESH_RUNTIME_DIR], set explicitly by the owner. *)
  | Run_user_guess
      (** Linux only: [/run/user/<euid>], the directory logind creates, used
          when both variables are unset. Accepted only if it passes every check
          below and its mode is exactly 0700. *)
  | Macos_default
      (** macOS only: [<home>/Library/Application Support/session-mesh/run],
          used when both variables are unset. Created when missing. *)

type runtime_dir = { path : string; source : runtime_source }

val runtime_dir :
  ?getenv:(string -> string option) ->
  ?home:(unit -> string option) ->
  ?run_user_root:string ->
  unit ->
  (runtime_dir, string) result
(** The directory that holds [session-mesh/ptyhost.sock].

    Resolution order: [MESH_RUNTIME_DIR], then [XDG_RUNTIME_DIR], then a default
    that depends on the platform:
    - Linux: the guess [/run/user/<euid>] ({!Run_user_guess});
    - macOS: [<home>/Library/Application Support/session-mesh/run]
      ({!Macos_default}), where [<home>] is the home directory of the effective
      user in the user database (not [$HOME], so that every program of the
      account, whatever its environment, finds the same socket; the Python
      client [ptyhost.py] and the installer use the same entry). This is Apple's
      per-user location for application files, which the system does not purge
      (the per-user temporary directory, [confstr(_CS_DARWIN_USER_TEMP_DIR)], is
      purged of old files by a daily job and could lose the host lock and the
      socket). [Library/Application Support] must already exist; the components
      [session-mesh] and [run] are created with mode 0700 when missing, each
      checked with [lstat] after creation (a symlink is refused, never
      followed). If the socket path would exceed [sun_path], nothing is created
      and the error asks for a shorter [MESH_RUNTIME_DIR];
    - every other system: no default, an error asking for [MESH_RUNTIME_DIR].

    [MESH_RUNTIME_DIR] remains an override everywhere. An invalid variable never
    falls through to a later step, and a default that fails validation is an
    error naming the variables to set. The chosen directory must be a normalised
    absolute path (no trailing slash, no empty segment, no ["."] or [".."]
    segment) that equals its own [Unix.realpath], a real directory (the last
    component is not a symlink), owned by the effective user and not writable by
    group or others. The resulting socket path must fit the platform's
    [sun_path] (108 bytes on Linux, 104 on macOS, the terminating NUL included).

    Limitation: only the last component is checked for ownership and mode. An
    ancestor directory writable by another user lets that user rename the
    directory and swap another in after validation. Callers that create the
    socket must therefore [lstat] and verify the directory again (type, owner,
    mode) at [bind] time. Ancestors are not walked.

    [getenv] defaults to [Sys.getenv_opt], [home] to the user database entry of
    the effective user and [run_user_root] to ["/run/user"]; tests pass their
    own. *)

val socket_path : runtime_dir -> string
(** [path/session-mesh/ptyhost.sock]. *)

val max_socket_path : int
(** Usable [sun_path] length on this platform, terminating NUL excluded. *)

(** {1 Processes} *)

type process = {
  pid : int;
  ppid : int;
  pgrp : int;
  sid : int;
  tpgid : int;
      (** Foreground process group of its terminal, or [-1]/[0] when it has none
          (raw kernel value). *)
  comm : string;  (** Short executable name, as the kernel truncates it. *)
  state : char;
      (** [R], [S], [Z]... (Linux letters; macOS mapped onto them). *)
  incarnation : int64;
      (** Opaque start-time marker. Two observations of one pid describe the
          same process only if their incarnations are equal. Linux: start time
          in clock ticks since boot. macOS: start time in microseconds since the
          epoch. Never compare across platforms. *)
}

val process : int -> (process, error) result

type process_scan = {
  processes : process list;  (** Sorted by pid. *)
  skipped : int;
      (** Processes that exist but were left out: their entry was refused
          ([Denied]) or did not parse ([Malformed]). *)
}

val scan : unit -> (process_scan, error) result
(** Every process visible to the caller. Linux: every [/proc] entry, other
    users' processes included (unless [/proc] is mounted with [hidepid], which
    hides them from the listing itself). macOS: every pid [proc_listallpids]
    lists, other users' processes included (read through [sysctl]). A process
    that exits during the walk is left out and not counted; one whose entry is
    [Denied] or [Malformed] is left out and counted in [skipped]. Any other
    error fails the whole scan. Interrupted reads are retried. *)

val snapshot : unit -> (process list, error) result
(** [scan] without the count: the same processes, and a skipped process is not
    reported as an error. Callers that must know whether the table is whole use
    {!scan}. *)

val command_line : int -> (string list, error) result
(** The argument vector, [argv.(0)] first. *)

val working_directory : int -> (string, error) result
(** The current directory. A ["(deleted)"] suffix, which Linux appends when the
    directory was removed, is returned as-is. *)

val open_file_paths : int -> ((int * string) list, error) result
(** [(fd, target)] for each open descriptor whose target has a path. A
    ["(deleted)"] suffix on a target is returned as-is. *)

val process_owner : int -> (int, error) result
(** The user id that owns the process. Linux: the owner of [/proc/<pid>],
    which is the process's real user id (also when its other entries are
    [Denied], for example a non-dumpable process of the same user). macOS and
    other systems: [Unsupported] for now. *)

val foreground_process_group : int -> (int, error) result
(** [foreground_process_group pid]: the foreground process group of the
    controlling terminal of session leader [pid]. The result is always a
    positive group id: when the process has no controlling terminal (kernel
    [tpgid] <= 0) the answer is [Error Not_found], so a caller's [kill(-pgid)]
    can never hit its own group or pid 1. *)

val unix_socket_bound : string -> (bool, error) result
(** [unix_socket_bound path]: whether a live Unix socket of this network
    namespace is bound to [path]. A socket file left behind by a dead process is
    not bound. A path that was never bound is not bound.

    Linux reads [/proc/net/unix]; when that table cannot be read the answer is
    an [Error], not [Ok false], so a caller that deletes files on "not bound"
    must treat an error as bound. macOS has no such table: it answers
    [Error (Unsupported _)], as every other system does. *)

(** {1 Pure parsers}

    Exposed so that both backends' parsing can be tested on recorded fixtures on
    any build machine. *)

module Parse : sig
  val linux_stat : string -> (process, error) result
  (** One [/proc/<pid>/stat] line. *)

  val linux_cmdline : string -> string list
  (** [/proc/<pid>/cmdline] contents. *)

  val darwin_procargs2 : string -> (string list, error) result
  (** A [KERN_PROCARGS2] buffer, little-endian [argc] first. Limitation: the
      kernel pads after the exec path with NUL bytes, which are skipped, so
      padding cannot be told from an empty [argv.(0)]: a leading empty argument
      is dropped. *)

  val darwin_state : int -> char option
  (** A macOS process status ([p_stat]/[pbi_status]) as a Linux letter: SIDL (1)
      and SRUN (2) are [R], SSLEEP (3) [S], SSTOP (4) [T], SZOMB (5) [Z]; [None]
      for any other value. *)

  val linux_unix_socket_bound : string -> string -> bool
  (** [linux_unix_socket_bound table path]: whether a socket line of a
      [/proc/net/unix] table has exactly [path] as its path field (the rest of
      the line after the seventh field and one space). *)

  val foreground_group : int -> (int, error) result
  (** [Ok tpgid] when [tpgid > 0], [Error Not_found] otherwise (no controlling
      terminal). *)
end

(** {1 Robustness helpers}

    Exposed so the error-handling decisions can be tested without provoking
    [EINTR] or close failures. *)

module Support : sig
  val retry_on_eintr : (unit -> 'a) -> 'a
  (** Re-run the action while it raises [Unix_error (EINTR, _, _)]. *)

  val close_quietly : Unix.file_descr -> unit
  (** [Unix.close], ignoring any error. *)

  val closedir_quietly : Unix.dir_handle -> unit
  (** [Unix.closedir], ignoring any error. *)

  val collect_scan :
    string list ->
    (int -> (process, error) result) ->
    (process_scan, error) result
  (** Reads each numeric name with the function and sorts by pid. [Not_found]
      for one process leaves it out; [Denied] and [Malformed] leave it out and
      count it in [skipped]; any other error fails the whole collection.
      Non-numeric names are ignored. *)

  val collect_processes :
    string list ->
    (int -> (process, error) result) ->
    (process list, error) result
  (** {!collect_scan} without the count. *)
end

(** {1 Refusing Linux-only features}

    The isolated agent launcher and the demo compiler sandbox exist on Linux
    only. {!require} (and the [mesh-platform require] command) is available to a
    caller that needs one: it asks first and stops on [Error], with no weaker
    fallback. No program calls it yet: the PTY host checks its isolated agent
    launcher ([setpriv]) itself, and the demo compiler does not consult it. *)

type feature =
  | Isolated_agent  (** The UID-split agent launcher ([setpriv]). *)
  | Demo_sandbox  (** The demo compiler's [bwrap] sandbox. *)

val feature_name : feature -> string
(** ["isolated-agent"] or ["demo-sandbox"]. *)

val feature_of_string : string -> feature option
(** Inverse of {!feature_name}; [None] for any other text. *)

val require : ?capabilities:capabilities -> feature -> (unit, string) result
(** [Ok ()] when the feature's capability is true. Otherwise [Error] with one
    sentence, without a trailing newline, naming the feature in words, the
    platform ({!platform_name}) and the reason: on Linux the executable that is
    missing, not a regular file, or not executable ([/usr/bin/setpriv] from
    util-linux, [/usr/bin/bwrap] from bubblewrap), elsewhere that the feature is
    Linux-only on this release. [capabilities] defaults to {!capabilities}[ ()];
    tests pass their own to force a capability off.

    [Ok ()] means the executable is present and executable (the check uses
    [stat], so it follows symlinks). That is necessary but not sufficient: a
    caller keeps its own launch-time trust checks (for example the PTY host's
    [lstat] and ownership checks on [setpriv]) and must not replace them with
    [require]. *)

(** Test hooks; not part of the supported API. *)
module For_testing : sig
  val require_on :
    platform:platform ->
    capabilities:capabilities ->
    feature ->
    (unit, string) result
  (** {!require} with the given [capabilities]. Only the message wording follows
      [platform]; the capabilities are not derived from it. Lets the message of
      every platform be tested on any build machine. *)

  val unsupported_unix_socket_bound : string -> (bool, error) result
  (** {!unix_socket_bound} as the backend of an unsupported system answers it,
      whatever this build is. *)

  val runtime_dir_on :
    ?home:string ->
    platform:platform ->
    getenv:(string -> string option) ->
    unit ->
    (runtime_dir, string) result
  (** {!runtime_dir} as [platform] resolves it, with the [/run/user] guess
      pointed at a directory that does not exist and [home] (default: a
      directory that does not exist) as the home directory. Lets the macOS
      default be tested on any build machine. *)
end
