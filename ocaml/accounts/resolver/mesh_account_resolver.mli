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
    changing. The source is the operator's [accounts.json] ({!Mesh_accounts}):
    an alias with a Claude folder is the account [(Claude, id)], one with a
    Codex home the account [(Codex, id)].

    Guarantees, whatever the source: ids match [[a-z0-9-]{1,32}] and are never
    [default]; labels pass {!Mesh_accounts.valid_label}; folders pass
    {!Mesh_accounts.valid_path}; ids are unique per backend and labels unique
    per backend ignoring ASCII case. A source that breaks one is refused whole
    ([accounts_refused]). The [default] account is never read from a source: it
    is synthesised, serves every backend, and has no folder of its own. No
    lookup falls back to it, and no file inside an account folder is read. *)

type backend = Claude | Codex

val backend_of_string : string -> backend option
(** ["claude"] or ["codex"]. *)

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
(** {!Mesh_accounts.load} of [file], then {!of_accounts}. Any refusal is
    [accounts_refused] with the reason as its message. *)

val list : t -> entry list
(** Every declared [(backend, id)], in the file's order, Claude before Codex
    within an alias. [default] is not listed. *)

val find : t -> account_ref -> (entry, error) result
(** The account [(backend, id)]: [default] (synthesised), or a declared one.
    [account_no_agent] when [id] is declared for another backend only,
    [account_unknown] otherwise. *)

val resolve_name : t -> backend -> string -> (entry, error) result
(** The account of [backend] whose id is exactly the name; otherwise the one
    whose label equals the name ignoring ASCII case. Never a prefix, never
    another backend's account. Several label matches are [account_ambiguous]
    (its message lists the candidates); none is {!find}'s error for the name as
    an id. *)

val label_matches : t -> backend -> string -> entry list
(** The accounts of [backend] ([default] included) whose label equals the name
    ignoring ASCII case: the candidates of an [account_ambiguous] refusal. *)

val serves : t -> id:string -> backend -> bool
(** [find] succeeds. *)

val ref_ : entry -> account_ref
val label : entry -> string

val launch_env : entry -> (string * string) list
(** The variable the agent runs with: [[]] for [default],
    [[("CLAUDE_CONFIG_DIR", folder)]] or [[("CODEX_HOME", folder)]]. *)

val prepare : uid:int -> entry -> (entry, error) result
(** {!Mesh_accounts.prepare_directory} of the account's folder (created 0700
    when missing, checked again); nothing for [default]. *)

val prepare_id : uid:int -> t -> string -> (Yojson.Safe.t, error) result
(** {!prepare} of every account of the alias [id], Claude first, stopping at the
    first refusal; then the alias as {!Mesh_accounts.to_json} prints it.
    [account_unknown] for [default] or an undeclared id. *)

val carry_folder :
  uid:int ->
  getenv:(string -> string option) ->
  create:bool ->
  entry ->
  (string, error) result
(** The folder whose conversations a carry reads or writes. For [default]:
    [CLAUDE_CONFIG_DIR] or [CODEX_HOME] when set and absolute, else
    [$HOME/.claude] or [$HOME/.codex]. The folder is checked
    ({!Mesh_accounts.check_directory}), or prepared when [create]. *)

val protected_roots : t -> string list
(** Every declared folder, in {!list}'s order: the login folders [/view] must
    refuse. *)

val describe_current : t -> backend -> string option -> Yojson.Safe.t
(** [{"id", "label", "declared"}] of the account a session of [backend] runs
    under ([None]: [default]). An id no longer declared for [backend] keeps the
    id as its label and is [declared: false]. *)

val to_host_json : t -> Yojson.Safe.t
(** [{"accounts": [...]}], each alias as {!Mesh_accounts.to_json} prints it: the
    output of [mesh-platform accounts list]. *)

val entry_json : entry -> Yojson.Safe.t
(** [{"backend", "id", "label"}]: no folder. *)
