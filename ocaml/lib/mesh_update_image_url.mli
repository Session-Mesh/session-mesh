(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(** Which image URLs of the release notes [mesh-platform update-image] may fetch
    (see {!Mesh_update_image}): the allowlist, the match against the notes,
    which addresses are public, and where a redirect points. Pure functions, no
    effect. *)

type url = private {
  text : string;  (** As given. *)
  host : string;  (** Lower case, a name of the allowlist. *)
  rest : string;  (** Path and query, starting with [/], without fragment. *)
}

val image_url : string -> url option
(** [Some] when the text may be fetched: at most 2048 bytes without blank,
    control character or backslash, [https://] in lower case, no userinfo, no
    port or [:443], and a host that is [github.com] or ends in
    [.githubusercontent.com] with labels of [a-z0-9-]. An address literal in any
    form (dotted, decimal, octal, hexadecimal, bracketed IPv6) is never such a
    name. *)

val html_unescape : string -> string
(** The character references [&amp;], [&lt;], [&gt;], [&quot;], [&apos;],
    [&#NN;] and [&#xHH;]; anything else is kept as written. *)

val in_notes : notes:string -> string -> bool
(** The URL is written in the notes, verbatim or once their character references
    are decoded (an HTML [src] attribute writes [&] as [&amp;]). *)

val public_address : Unix.inet_addr -> bool
(** A globally reachable address: IPv4 outside the private, shared, loopback,
    link-local, documentation, benchmarking, multicast and reserved ranges; IPv6
    in [2000::/3] outside [2001::/23], [2001:db8::/32], [2002::/16] and
    [3fff::/20]; an IPv4-mapped IPv6 address as its IPv4 address. *)

val join : base:url -> string -> string
(** The absolute URL a [Location] value names, relative to [base]. *)
