(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

let seconds_per_day = 86400

(* Days since 1970-01-01 of a proleptic Gregorian date (Hinnant's algorithm). *)
let days_from_civil y m d =
  let y = if m <= 2 then y - 1 else y in
  let era = (if y >= 0 then y else y - 399) / 400 in
  let yoe = y - (era * 400) in
  let mp = (m + 9) mod 12 in
  let doy = (((153 * mp) + 2) / 5) + d - 1 in
  let doe = (yoe * 365) + (yoe / 4) - (yoe / 100) + doy in
  (era * 146097) + doe - 719468

let civil_from_days z =
  let z = z + 719468 in
  let era = (if z >= 0 then z else z - 146096) / 146097 in
  let doe = z - (era * 146097) in
  let yoe = (doe - (doe / 1460) + (doe / 36524) - (doe / 146096)) / 365 in
  let doy = doe - ((365 * yoe) + (yoe / 4) - (yoe / 100)) in
  let mp = ((5 * doy) + 2) / 153 in
  let d = doy - (((153 * mp) + 2) / 5) + 1 in
  let m = if mp < 10 then mp + 3 else mp - 9 in
  let y = yoe + (era * 400) + if m <= 2 then 1 else 0 in
  (y, m, d)

let is_leap y = (y mod 4 = 0 && y mod 100 <> 0) || y mod 400 = 0

let days_in_month y m =
  match m with
  | 2 -> if is_leap y then 29 else 28
  | 4 | 6 | 9 | 11 -> 30
  | _ -> 31

let all_digits s pos len =
  let ok = ref (pos + len <= String.length s) in
  if !ok then
    for i = pos to pos + len - 1 do
      if s.[i] < '0' || s.[i] > '9' then ok := false
    done;
  !ok

let num s pos len = int_of_string (String.sub s pos len)

(* (y, m, d) of "YYYY-MM-DD" at [pos], validated. *)
let date_at s pos =
  if
    String.length s >= pos + 10
    && all_digits s pos 4
    && s.[pos + 4] = '-'
    && all_digits s (pos + 5) 2
    && s.[pos + 7] = '-'
    && all_digits s (pos + 8) 2
  then
    let y = num s pos 4 and m = num s (pos + 5) 2 and d = num s (pos + 8) 2 in
    if y >= 1 && m >= 1 && m <= 12 && d >= 1 && d <= days_in_month y m then
      Some (y, m, d)
    else None
  else None

let valid_date s = String.length s = 10 && date_at s 0 <> None

(* "THH:MM" at 10, then optional ":SS", then "Z" at the end. *)
let clock_at s =
  let n = String.length s in
  let hm_ok = n >= 17 && s.[10] = 'T' && all_digits s 11 2 && s.[13] = ':' && all_digits s 14 2 in
  if not hm_ok then None
  else
    let h = num s 11 2 and mi = num s 14 2 in
    let sec =
      if n = 17 && s.[16] = 'Z' then Some 0
      else if n = 20 && s.[16] = ':' && all_digits s 17 2 && s.[19] = 'Z' then
        Some (num s 17 2)
      else None
    in
    match sec with
    | Some sec when h < 24 && mi < 60 && sec < 60 -> Some ((h * 3600) + (mi * 60) + sec)
    | _ -> None

let parse s =
  match (date_at s 0, clock_at s) with
  | Some (y, m, d), Some secs ->
      Some ((days_from_civil y m d * seconds_per_day) + secs)
  | _ -> None

let split ts =
  let days = if ts >= 0 then ts / seconds_per_day else ((ts + 1) / seconds_per_day) - 1 in
  (civil_from_days days, ts - (days * seconds_per_day))

let format ts =
  let (y, m, d), secs = split ts in
  Printf.sprintf "%04d-%02d-%02dT%02d:%02d:%02dZ" y m d (secs / 3600)
    (secs mod 3600 / 60) (secs mod 60)

let month ts =
  let (y, m, _), _ = split ts in
  Printf.sprintf "%04d-%02d" y m

let date_of ts =
  let (y, m, d), _ = split ts in
  Printf.sprintf "%04d-%02d-%02d" y m d

let add_days date n =
  match date_at date 0 with
  | None -> date
  | Some (y, m, d) ->
      let y, m, d = civil_from_days (days_from_civil y m d + n) in
      Printf.sprintf "%04d-%02d-%02d" y m d
