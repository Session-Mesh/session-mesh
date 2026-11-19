/* Three bindings: a non-blocking exclusive BSD flock(2), as taken by `wl`, the monotonic clock and the descriptor limit. */
#include <errno.h>
#include <sys/file.h>
#include <sys/resource.h>
#include <time.h>

#include <caml/alloc.h>
#include <caml/mlvalues.h>
#include <caml/unixsupport.h>

/* true: the lock is held; false: another descriptor holds it (or EINTR). */
CAMLprim value mesh_worklog_flock_try(value fd)
{
  if (flock(Int_val(fd), LOCK_EX | LOCK_NB) == 0)
    return Val_true;
  if (errno == EWOULDBLOCK || errno == EAGAIN || errno == EINTR)
    return Val_false;
  uerror("flock", Nothing);
  return Val_false;
}

/* Seconds on the monotonic clock, for lock deadlines unaffected by clock steps. */
CAMLprim value mesh_worklog_monotonic(value unit)
{
  struct timespec now;
  (void)unit;
  clock_gettime(CLOCK_MONOTONIC, &now);
  return caml_copy_double((double)now.tv_sec + (double)now.tv_nsec / 1e9);
}

/* Raise the soft limit on open descriptors towards [want], never above the hard
   limit; returns the soft limit in force afterwards (-1 when unknown). Used by
   tests that must cross descriptor 1024. */
CAMLprim value mesh_worklog_raise_nofile(value want)
{
  struct rlimit lim;
  rlim_t target = (rlim_t)Long_val(want);
  if (getrlimit(RLIMIT_NOFILE, &lim) != 0)
    return Val_long(-1);
  if (lim.rlim_cur < target) {
    struct rlimit raised = lim;
    raised.rlim_cur = (lim.rlim_max != RLIM_INFINITY && lim.rlim_max < target) ? lim.rlim_max : target;
    if (setrlimit(RLIMIT_NOFILE, &raised) == 0)
      lim = raised;
  }
  return Val_long(lim.rlim_cur == RLIM_INFINITY ? 0x3fffffff : (long)lim.rlim_cur);
}
