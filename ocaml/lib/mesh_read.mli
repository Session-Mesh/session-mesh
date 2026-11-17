(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(** A deliberately small, local-only transcript reader for agent MCP clients.

    It never contacts Session Mesh and does not accept paths. It reads only
    regular files below the caller's own [HOME]/[.claude/projects] and
    [HOME]/[.codex/sessions] roots. *)

module Config : sig
  type t

  val from_env : unit -> (t, string) result
  val make_for_test : home:string -> (t, string) result
end

type session = { agent : string; id : string }
type message = { role : string; content : string }

type transcript = {
  agent : string;
  id : string;
  untrusted : bool;
  messages : message list;
}

module Store : sig
  type t

  val create : Config.t -> t

  (* Discovery limits fail closed rather than returning a partial list. *)
  val list_sessions : t -> (session list, string) result

  val read_transcript :
    t -> agent:string -> id:string -> (transcript, string) result
end

val server : Config.t -> Mcp_kit.Server.t
(** A stdio MCP declaration containing only [list_sessions] and
    [read_transcript]. Returned transcript text is explicitly marked as
    untrusted data; neither tool performs a write or network call. *)
