/******************************************************************************/
/*                                                                            */
/* SPDX-License-Identifier: AGPL-3.0-or-later                                 */
/* Copyright (c) 2026 Atacama <contact@atacama.tech>                          */
/*                                                                            */
/******************************************************************************/

/* statvfs(3): the bytes an unprivileged writer can still use on the file
   system of a path, which OCaml's Unix cannot tell. */
#define _GNU_SOURCE
#include <sys/statvfs.h>
#include <errno.h>
#include <fcntl.h>
#ifdef __linux__
#include <sys/syscall.h>
#include <unistd.h>
#endif
#ifdef __APPLE__
#include <stdio.h>
#endif

#include <caml/alloc.h>
#include <caml/memory.h>
#include <caml/mlvalues.h>
#include <caml/signals.h>
#include <caml/unixsupport.h>

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

/* Move an entry without replacing an existing destination. On unsupported
   systems (or filesystems), fail closed instead of falling back to rename. */
CAMLprim value mesh_accounts_carry_rename_noreplace(value from, value to)
{
  CAMLparam2(from, to);
  int result;
  if (!caml_string_is_c_safe(from) || !caml_string_is_c_safe(to)) {
    errno = EINVAL;
    uerror("rename_noreplace", Nothing);
  }
#ifdef __linux__
#ifdef SYS_renameat2
  result = syscall(SYS_renameat2, AT_FDCWD, String_val(from),
                   AT_FDCWD, String_val(to), 1 /* RENAME_NOREPLACE */);
#else
  errno = ENOTSUP;
  result = -1;
#endif
#elif defined(__APPLE__)
  result = renamex_np(String_val(from), String_val(to), RENAME_EXCL);
#else
  errno = ENOTSUP;
  result = -1;
#endif
  if (result != 0) uerror("rename_noreplace", Nothing);
  CAMLreturn(Val_unit);
}
