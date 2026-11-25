(* SPDX-License-Identifier: AGPL-3.0-or-later
   Copyright (c) 2026 Atacama <contact@atacama.tech> *)

(** Pure registry mutations. The caller supplies validated strings and finite
    timestamps, in the order returned by registry loading. *)

include module type of struct include Conversation_registry_model end

type observed_binding = Shell | Ambiguous | Known of conversation

type observation = {
  incarnation : incarnation;
  identity : observed_binding;
  label : string;
}

type action =
  | Observe of { listed : bool; now : timestamp; sessions : observation list }
  | Rename of {
      incarnation : incarnation;
      now : timestamp;
      old_label : string;
      new_label : string;
    }
  | Close of { incarnation : incarnation; now : timestamp }
  | Forget of conversation

type result = { entries : entry list; dirty : bool }

(** [apply entries action] preserves row order and appends new rows. [dirty]
    tells the caller whether to persist the result. Stable sorting, retention,
    and registry capacity are the caller's responsibility. *)
val apply : entry list -> action -> result
