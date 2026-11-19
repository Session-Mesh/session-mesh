/******************************************************************************/
/*                                                                            */
/* SPDX-License-Identifier: AGPL-3.0-or-later                                 */
/* Copyright (c) 2026 Atacama <contact@atacama.tech>                          */
/*                                                                            */
/******************************************************************************/

/* lstat(2) with the modification time in integer nanoseconds, which OCaml's
   Unix.stats (a float) cannot carry. */
#include <sys/stat.h>

#include <caml/alloc.h>
#include <caml/memory.h>
#include <caml/mlvalues.h>
#include <caml/signals.h>

/* Some (device, inode, size, mtime_ns, mtime) for a regular file; None for
   anything else, or when lstat fails. */
CAMLprim value mesh_agent_codex_lstat_regular(value path)
{
  CAMLparam1(path);
  CAMLlocal3(fields, seconds, result);
  struct stat st;
  long long sec, nsec;
  char *copy;
  int failed;

  if (!caml_string_is_c_safe(path))
    CAMLreturn(Val_none);
  copy = caml_stat_strdup(String_val(path));
  caml_enter_blocking_section();
  failed = lstat(copy, &st) != 0;
  caml_leave_blocking_section();
  caml_stat_free(copy);
  if (failed || !S_ISREG(st.st_mode))
    CAMLreturn(Val_none);
#ifdef __APPLE__
  sec = (long long)st.st_mtimespec.tv_sec;
  nsec = (long long)st.st_mtimespec.tv_nsec;
#else
  sec = (long long)st.st_mtim.tv_sec;
  nsec = (long long)st.st_mtim.tv_nsec;
#endif
  /* Python's os.stat float: sec + nsec * 1e-9. */
  seconds = caml_copy_double((double)sec + (double)nsec * 1e-9);
  fields = caml_alloc_tuple(5);
  Store_field(fields, 0, Val_long(st.st_dev));
  Store_field(fields, 1, Val_long(st.st_ino));
  Store_field(fields, 2, Val_long(st.st_size));
  Store_field(fields, 3, Val_long(sec * 1000000000LL + nsec));
  Store_field(fields, 4, seconds);
  result = caml_alloc_some(fields);
  CAMLreturn(result);
}
