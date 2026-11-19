(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(** Running [git] for the data repository and for session context. Nothing
    here ever pushes or contacts a remote. *)

val run : ?timeout:float -> dir:string -> string list -> int * string
(** Run [git] with the arguments in [dir]; the exit code and the combined
    output. Environment variables that redirect git to another repository
    ([GIT_DIR], [GIT_WORK_TREE], [GIT_INDEX_FILE], [GIT_PREFIX] and the like) or
    inject configuration ([GIT_CONFIG_COUNT], [GIT_CONFIG_PARAMETERS] and any
    other [GIT_CONFIG_*]) are removed, prompts are disabled and pathspecs are
    literal. A missing [git] is exit code 127. A git still running after
    [timeout] seconds (default 60, on the monotonic clock, counted from the start
    and also after the output has ended) is killed: exit code 124. A git that
    has exited is a result even when a grandchild still holds the output pipe:
    its exit status decides first. Only the direct child is killed, not its
    process group. Output beyond {!max_output_bytes} kills the child: exit code
    125 and a message. Any other failure (an exception from a signal handler
    included) is exit code 125 with the child killed and reaped. Interrupted
    system calls are retried. Never raises, except [Sys.Break] and
    [Out_of_memory], which propagate after the child is reaped. *)

val max_output_bytes : int
(** The cap on the output of one git call: 16 MiB. *)

val context : string -> string option * string option
(** [(top level, branch)] of the repository containing a directory: both
    [None] outside a git repository, the branch [None] on a detached head. *)

val commit_paths : root:string -> paths:string list -> message:string -> (bool, string) result
(** Commit exactly [paths] (absolute, under [root]) with [message]: [Ok true]
    when a commit was made, [Ok false] when there was nothing to commit,
    [Error why] when it was skipped or failed (not a git repository,
    merge/rebase/cherry-pick in progress, git failure). Unrelated staged or
    dirty files never enter the commit; hooks and signing are off. *)
