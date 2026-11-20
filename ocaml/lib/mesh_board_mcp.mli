(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(** A local, session-scoped MCP bridge for the Mesh whiteboard.

    The bridge only uses the session token inherited from the agent process. It
    never accepts a board name, URL, path, cookie, or master token. *)

module Config : sig
  type t

  val from_env : unit -> (t, string) result
  (** Read [MESH_SESSION_TOKEN] and the optional [MESH_PORT]. *)

  val make_for_test :
    ?timeout:float -> token:string -> port:int -> unit -> (t, string) result
  (** [timeout] bounds each request to the Mesh server, in seconds (default 30).
  *)
end

module Client : sig
  type t
  type agent_read = Opened of Yojson.Safe.t | Pending of Yojson.Safe.t

  val create : Config.t -> t
  val get : t -> (Yojson.Safe.t, string) result
  val replace : t -> Yojson.Safe.t -> (Yojson.Safe.t, string) result
  val demo_get : t -> (Yojson.Safe.t, string) result
  val demo_revisions : t -> (Yojson.Safe.t, string) result
  val demo_replace : t -> Yojson.Safe.t -> (Yojson.Safe.t, string) result
  val demo_list : t -> (Yojson.Safe.t, string) result
  val demo_create_named : t -> Yojson.Safe.t -> (Yojson.Safe.t, string) result
  val demo_get_named : t -> string -> (Yojson.Safe.t, string) result

  val demo_update_named :
    t -> string -> Yojson.Safe.t -> (Yojson.Safe.t, string) result

  val demo_open_named : t -> string -> (Yojson.Safe.t, string) result

  val demo_open : t -> (Yojson.Safe.t, string) result
  (** Fixed loopback, inherited-session-only operations for the non-executable
      [mesh-scene-v0] demo format. *)

  val open_ : t -> (Yojson.Safe.t, string) result
  (** Send an empty, session-scoped board-open request to the fixed loopback
      endpoint. *)

  val revisions : t -> (Yojson.Safe.t, string) result
  val revision : t -> int -> (Yojson.Safe.t, string) result
  val diff : t -> int -> int -> (Yojson.Safe.t, string) result

  val latest_change : t -> (Yojson.Safe.t, string) result
  (** Read only the newest safe structural transition for the inherited session;
      no board selector or document content is accepted. *)

  val refresh : t -> (Yojson.Safe.t, string) result
  val restore : t -> int -> int -> (Yojson.Safe.t, string) result
  val agent_peers : t -> (Yojson.Safe.t, string) result
  val agent_inbox : t -> (Yojson.Safe.t, string) result
  val agent_read : t -> string -> (agent_read, string) result

  val agent_send :
    t ->
    string ->
    Yojson.Safe.t ->
    string ->
    string ->
    (Yojson.Safe.t, string) result

  val agent_reply :
    t -> string -> string -> string -> (Yojson.Safe.t, string) result

  val agent_ack : t -> string list -> (Yojson.Safe.t, string) result
  (** The current agent's explicit private inbox. Listing reveals only metadata;
      message text is returned only by [agent_read]. *)
end

val valid_document : Yojson.Safe.t -> (unit, string) result
(** Check the deliberately narrow v0 Excalidraw wire shape before a write. *)

val server : Config.t -> Mcp_kit.Server.t

val notes_server : Config.t -> Mcp_kit.Server.t
(** Construct the stdio MCP server with board, explicit agent-mailbox and
    static-demo-scene tools scoped to the inherited session. A negotiated
    [2025-06-18] client receives the standard 2025-06 response wire profile;
    other legacy clients retain the mcp-kit modern profile. *)
