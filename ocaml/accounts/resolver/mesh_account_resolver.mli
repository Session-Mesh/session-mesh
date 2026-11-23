(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(** Which agent accounts exist on the runner, and where the account
    [(backend, id)] lives.

    The one place that answers it for [mesh-platform accounts]: the web server
    only parses that program's JSON, so the source can change without the server
    changing. An existing sibling [backend-profiles.json] is authoritative;
    otherwise the source is the operator's [accounts.json] ({!Mesh_accounts}).
    Enabled profiles of all four backends become backend-qualified launch entries.

    Guarantees, whatever the source: ids match [[a-z0-9-]{1,32}] and are never
    [default]; labels pass {!Mesh_accounts.valid_label}; folders pass
    {!Mesh_accounts.valid_path}; ids are unique per backend and labels unique
    per backend ignoring ASCII case. A source that breaks one is refused whole
    ([accounts_refused]). The [default] account is never read from a source: it
    is synthesised, serves every backend, and has no folder of its own. No
    lookup falls back to it, and no file inside an account folder is read. *)

type backend = Claude | Codex | Opencode_v2 | Pi

val backend_of_string : string -> backend option
(** ["claude"], ["codex"], ["opencode-v2"] or ["pi"]. *)

val backend_to_string : backend -> string

type account_ref = { backend : backend; id : string }

type entry
(** A known account: [default] or one declared by the source. *)

type t
(** One validated reading of the source. *)

type error = { code : string; message : string }
(** [code] is one of [accounts_refused], [account_unknown], [account_ambiguous],
    [account_no_agent], [account_folder_refused]. [message] never repeats a name
    the caller gave that matched nothing. *)

val default_id : string
val default_label : string

val of_accounts : Mesh_accounts.account list -> (t, error) result
(** The accounts of an already parsed [accounts.json], checked against the
    guarantees above. *)

val load : uid:int -> file:string -> (t, error) result
(** Prefer [backend-profiles.json] beside the legacy [file], using
    {!Mesh_backend_profile.load}, its strict metadata/layout validation, and
    current root custody checks. Only absence of both the registry and its
    [backend-profiles.migrated] retirement marker permits {!Mesh_accounts.load}
    of [file] then {!of_accounts}; malformed, unsafe, symlinked or disappearing
    configured registries fail closed with [accounts_refused]. Native loading
    requires [uid] to be the effective user. Missing declared roots may be
    prepared if their parent is private or another directly enclosing declared
    root; no credentials are read. *)

val list : t -> entry list
(** Every enabled launchable [(backend, id)], in authored profile order (legacy:
    Claude before Codex within an alias). [default] is not listed. *)

val find : t -> account_ref -> (entry, error) result
(** The account [(backend, id)]: [default] (synthesised), or a declared one.
    [account_no_agent] when [id] is declared for another backend only,
    [account_unknown] otherwise. *)

val resolve_name : t -> backend -> string -> (entry, error) result
(** The account of [backend] whose id is exactly the name, or else whose label
    equals the name ignoring ASCII case. Never a prefix, never another
    backend's account. Several {!candidates} are [account_ambiguous] (its
    message lists their ids and labels), so an exact id whose name is also the
    label of another account is refused rather than chosen by the letter case.
    No candidate is {!find}'s error for the name as an id. *)

val candidates : t -> backend -> string -> entry list
(** The accounts [resolve_name] chooses from: the account of [backend] whose id
    is exactly the name, if any, then the other accounts of [backend]
    ([default] included) whose label equals the name ignoring ASCII case. *)

val label_matches : t -> backend -> string -> entry list
(** The accounts of [backend] ([default] included) whose label equals the name
    ignoring ASCII case. *)

val sanitize : string -> string
(** The message with every absolute path (a word starting with ["/"]) replaced
    by ["<path>"] and every control character by ["?"]. *)

val resolve :
  uid:int ->
  file:string ->
  backend ->
  string ->
  (entry, error * entry list) result
(** {!load} then {!resolve_name}: [mesh-platform accounts resolve]. Every error
    message is {!sanitize}d (no folder, of this account or another, and no
    control character); the list holds the {!candidates} of an
    [account_ambiguous] refusal, [[]] otherwise. *)

val serves : t -> id:string -> backend -> bool
(** [find] succeeds. *)

val ref_ : entry -> account_ref
val label : entry -> string

val context_revision : entry -> string option
(** The revision in this already loaded native entry, without preparing roots.
    [None] denotes a legacy or synthetic default entry. *)

val launch_env : entry -> (string * string) list
(** Compatibility single-folder selector: [[]] for [default]. Use
    {!launch_context} for a validated four-backend launch environment. *)

type launch_context = {
  backend : backend;
  id : string;
  label : string;
  registry_revision : string option;
  context_revision : string option;
  roots : (string * string) list;
  env : (string * string) list;
  unset : string list;
}
(** One validated profile snapshot. The runner supplies HOME; no profile controls it. *)

val launch_context :
  uid:int -> ?expected_context:string -> entry -> (launch_context, error) result
(** When [expected_context] is provided, refuse a different revision before
    creating any directory. Prepare and validate exactly the selected backend, without preparing the
    other profiles sharing an id. Legacy accounts preserve their single folder. *)

val launch_context_json : launch_context -> Yojson.Safe.t

val prepare : uid:int -> entry -> (entry, error) result
(** {!Mesh_accounts.prepare_directory} of the account's folder (created 0700
    when missing, checked again); nothing for [default]. Native profiles recheck
    their declared roots, prepare missing declared roots parent-first, and run
    {!Mesh_backend_profile.validate_roots} again against their registry
    snapshot. They never reread a legacy alias for a different root. *)

val prepare_id : uid:int -> t -> string -> (Yojson.Safe.t, error) result
(** {!prepare} of every account of the alias [id], Claude first, stopping at the
    first refusal (native: enabled entries in profile order); then the grouped
    alias, with [backend_labels] for native profiles. [account_unknown] for
    [default], a disabled-only alias or an undeclared id. *)

val carry_folder :
  uid:int ->
  getenv:(string -> string option) ->
  create:bool ->
  entry ->
  (string, error) result
(** The folder whose conversations a carry reads or writes. For [default]:
     [CLAUDE_CONFIG_DIR] or [CODEX_HOME] when set and absolute, else
     [$HOME/.claude] or [$HOME/.codex]. The folder is checked
    ({!Mesh_accounts.check_directory}), or prepared when [create]. Native entries
    recheck profile custody before and after, but create only the configuration
    folder, not conversation subdirectories: carry retains responsibility for
    transactional conversation writes and cleanup. Declared history/state roles
    do not relocate the native CLI's conventional conversation layout. *)

val protected_roots : t -> string list
(** The login folders [/view] must refuse. Legacy: every declared folder in
    {!list}'s order. Native: all profiles' credential roles, including disabled
    profiles and unqualified backends: [config] for every backend plus OpenCode
    [data] and [state]. Separate conversation roots and caches are not classified
    as credential roots; a conversation subtree under a credential root remains
    protected with its parent. *)

val describe_current : t -> backend -> string option -> Yojson.Safe.t
(** [{"id", "label", "declared"}] of the account a session of [backend] runs
    under ([None]: [default]). An id no longer declared for [backend] keeps the
    id as its label and is [declared: false]. *)

val to_host_json : t -> Yojson.Safe.t
(** Legacy output is byte-for-byte unchanged: [{"accounts": [...]}], each alias
    as {!Mesh_accounts.to_json} prints it. Native output groups enabled
    entries by id with compatibility Claude/Codex configuration fields and an
    extra [backend_labels] containing only the
    enabled backends. The compatibility [label] is the first profile's label;
    identity-sensitive consumers must select [backend_labels] by backend. A
    top-level [protected_roots] lists {!protected_roots}, including disabled and
    unqualified profiles. On a failed read the host must retain historic deny
    roots; a refusal cannot supply a new protection inventory. *)

val entry_json : entry -> Yojson.Safe.t
(** [{"backend", "id", "label"}]: no folder. *)
