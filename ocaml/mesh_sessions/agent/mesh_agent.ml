(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

type fields = (string * Yojson.Safe.t) list
type session = { name : string; created : float; pid : int }
type described = { session : session; process : Mesh_agent_round.process; fields : fields }

module type ADAPTER = sig
  type t

  val kind : string
  val create : Mesh_agent_roots.t -> t
  val prepare : t -> Mesh_agent_round.t -> unit
  val resize : t -> sessions:int -> unit
  val describe : t -> Mesh_agent_round.t -> session -> Mesh_agent_round.process -> fields
  val check : t -> Mesh_agent_round.t -> described list -> (string * fields) list
end

let no_check _ _ _ = []

type adapter = Adapter : (module ADAPTER with type t = 'state) * 'state -> adapter

let adapter (type state) (module A : ADAPTER with type t = state) roots =
  Adapter ((module A), A.create roots)

let kind (Adapter ((module A), _)) = A.kind
let prepare (Adapter ((module A), state)) round = A.prepare state round
let resize (Adapter ((module A), state)) ~sessions = A.resize state ~sessions
let describe (Adapter ((module A), state)) round session process = A.describe state round session process
let check (Adapter ((module A), state)) round described = A.check state round described

module Registry = struct
  type t = adapter list

  let create adapters =
    let kinds = List.map kind adapters in
    List.iteri
      (fun index name ->
        if not (List.mem name Mesh_agent_session.agent_types) then
          invalid_arg ("Mesh_agent.Registry: unknown agent type " ^ name);
        if List.mem name (List.filteri (fun other _ -> other < index) kinds) then
          invalid_arg ("Mesh_agent.Registry: two adapters for " ^ name))
      kinds;
    adapters

  let find registry name = List.find_opt (fun candidate -> kind candidate = name) registry
  let kinds registry = List.map kind registry
  let adapters registry = registry
end
