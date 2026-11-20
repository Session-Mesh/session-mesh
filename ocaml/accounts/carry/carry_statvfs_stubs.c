/******************************************************************************/
/*                                                                            */
/* SPDX-License-Identifier: AGPL-3.0-or-later                                 */
/* Copyright (c) 2026 Atacama <contact@atacama.tech>                          */
/*                                                                            */
/******************************************************************************/

/* statvfs(3): the bytes an unprivileged writer can still use on the file
   system of a path, which OCaml's Unix cannot tell. */
#include <sys/statvfs.h>

#include <caml/alloc.h>
#include <caml/memory.h>
#include <caml/mlvalues.h>
#include <caml/signals.h>

/* The available bytes (f_bavail * f_frsize, capped at max_int), or -1 when
   statvfs fails. */
CAMLprim value mesh_accounts_carry_free_bytes(value path)
{
  CAMLparam1(path);
  struct statvfs st;
  unsigned long long bytes;
  char *copy;
  int failed;

  if (!caml_string_is_c_safe(path))
    CAMLreturn(Val_long(-1));
  copy = caml_stat_strdup(String_val(path));
  caml_enter_blocking_section();
  failed = statvfs(copy, &st) != 0;
  caml_leave_blocking_section();
  caml_stat_free(copy);
  if (failed)
    CAMLreturn(Val_long(-1));
  bytes = (unsigned long long)st.f_bavail * (unsigned long long)st.f_frsize;
  if (bytes > (unsigned long long)Max_long)
    bytes = (unsigned long long)Max_long;
  CAMLreturn(Val_long((intnat)bytes));
}
