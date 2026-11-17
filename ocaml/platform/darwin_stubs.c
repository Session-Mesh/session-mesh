/* macOS process inspection for the darwin backend (libproc and sysctl).

   Every stub returns an OCaml [('a, int) result]: [Ok value] or [Error kind],
   where kind is one of the KIND_* codes below, classified here so that the
   OCaml side never depends on errno numbers. The OCaml declarations are in
   darwin_stubs.ml.

   The file is compiled on every system so that backend_darwin.ml links (and is
   checked against the backend contract) everywhere. Without __APPLE__ every
   stub answers KIND_UNSUPPORTED and the temporary directory is None.

   The runtime lock is released around the system calls: they only touch C
   memory (stack or malloc), and OCaml values are read before and built after
   the blocking section. Each length the kernel returns is checked against the
   buffer it was given; strings are bounded with strnlen. */

#define CAML_NAME_SPACE
#include <caml/alloc.h>
#include <caml/memory.h>
#include <caml/mlvalues.h>
#include <caml/signals.h>
#include <errno.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#define KIND_NOT_FOUND 0
#define KIND_DENIED 1
#define KIND_SHORT 2
#define KIND_INVALID 3
#define KIND_FAILED 4
#define KIND_UNSUPPORTED 5

/* Internal code for "the kernel answered fewer bytes than the structure". */
#define MESH_SHORT_ANSWER (-1)

static value result_error(int kind)
{
  CAMLparam0();
  CAMLlocal1(result);
  result = caml_alloc_small(1, 1);
  Field(result, 0) = Val_int(kind);
  CAMLreturn(result);
}

#ifdef __APPLE__

#include <libproc.h>
#include <sys/param.h>
#include <sys/proc.h>
#include <sys/proc_info.h>
#include <sys/sysctl.h>
#include <unistd.h>

static value result_ok(value payload)
{
  CAMLparam1(payload);
  CAMLlocal1(result);
  result = caml_alloc_small(1, 0);
  Field(result, 0) = payload;
  CAMLreturn(result);
}

static int kind_of_code(int code)
{
  switch (code) {
  case ESRCH: return KIND_NOT_FOUND;
  case EPERM:
  case EACCES: return KIND_DENIED;
  case EINVAL: return KIND_INVALID;
  case MESH_SHORT_ANSWER: return KIND_SHORT;
  default: return KIND_FAILED;
  }
}

/* errno after a failed call, never 0. */
static int failure_code(void) { return errno != 0 ? errno : EIO; }

#define COMM_CAPACITY (2 * MAXCOMLEN + 1)

struct raw_process {
  int ppid, pgid, sid, tpgid, status, uid;
  int64_t incarnation;
  char comm[COMM_CAPACITY];
};

/* Copy a kernel name that may lack its NUL when it fills the field. */
static void copy_name(char *target, const char *source, size_t source_size)
{
  size_t length = strnlen(source, source_size);
  if (length >= COMM_CAPACITY) length = COMM_CAPACITY - 1;
  memcpy(target, source, length);
  target[length] = '\0';
}

static int64_t microseconds(int64_t seconds, int64_t micros)
{
  return seconds * 1000000 + micros;
}

/* proc_pidinfo(PROC_PIDTBSDINFO): refused (EPERM) for processes of other
   users, and ESRCH for zombies. */
static int read_bsdinfo(pid_t pid, struct raw_process *out)
{
  struct proc_bsdinfo info;
  errno = 0;
  int got = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, sizeof info);
  if (got <= 0) return failure_code();
  if ((size_t)got < sizeof info) return MESH_SHORT_ANSWER;
  out->ppid = (int)info.pbi_ppid;
  out->pgid = (int)info.pbi_pgid;
  out->tpgid = (int)info.e_tpgid;
  out->status = (int)info.pbi_status;
  out->uid = (int)info.pbi_uid;
  out->incarnation = microseconds((int64_t)info.pbi_start_tvsec,
                                  (int64_t)info.pbi_start_tvusec);
  /* pbi_name holds up to 2*MAXCOMLEN bytes, pbi_comm up to MAXCOMLEN. */
  if (strnlen(info.pbi_name, sizeof info.pbi_name) >
      strnlen(info.pbi_comm, sizeof info.pbi_comm))
    copy_name(out->comm, info.pbi_name, sizeof info.pbi_name);
  else
    copy_name(out->comm, info.pbi_comm, sizeof info.pbi_comm);
  return 0;
}

/* sysctl(KERN_PROC_PID): the table ps reads, readable for every process,
   zombies included. An empty answer means no such process. */
static int read_kinfo(pid_t pid, struct raw_process *out)
{
  int mib[4] = {CTL_KERN, KERN_PROC, KERN_PROC_PID, pid};
  struct kinfo_proc info;
  size_t size = sizeof info;
  errno = 0;
  if (sysctl(mib, 4, &info, &size, NULL, 0) != 0) return failure_code();
  if (size == 0) return ESRCH;
  if (size < sizeof info) return MESH_SHORT_ANSWER;
  out->ppid = (int)info.kp_eproc.e_ppid;
  out->pgid = (int)info.kp_eproc.e_pgid;
  out->tpgid = (int)info.kp_eproc.e_tpgid;
  out->status = (int)info.kp_proc.p_stat;
  out->uid = (int)info.kp_eproc.e_ucred.cr_uid;
  out->incarnation =
      microseconds((int64_t)info.kp_proc.p_starttime.tv_sec,
                   (int64_t)info.kp_proc.p_starttime.tv_usec);
  copy_name(out->comm, info.kp_proc.p_comm, sizeof info.kp_proc.p_comm);
  return 0;
}

/* macOS keeps SRUN for every live process, sleeping or not; ps derives S
   from the threads. PROC_PIDTASKINFO (readable for the caller's own
   processes) counts the running threads: none means asleep. When it cannot
   be read the status stays SRUN. */
static void refine_running(pid_t pid, struct raw_process *out)
{
  if (out->status != SRUN) return;
  struct proc_taskinfo info;
  int got = proc_pidinfo(pid, PROC_PIDTASKINFO, 0, &info, sizeof info);
  if (got > 0 && (size_t)got >= sizeof info && info.pti_numrunning == 0)
    out->status = SSLEEP;
}

static int lookup_process(pid_t pid, struct raw_process *out)
{
  int code = read_bsdinfo(pid, out);
  if (code == 0)
    refine_running(pid, out);
  else if (code == ESRCH || code == EPERM || code == EACCES)
    code = read_kinfo(pid, out);
  if (code != 0) return code;
  errno = 0;
  pid_t sid = getsid(pid);
  if (sid >= 0) {
    out->sid = (int)sid;
    return 0;
  }
  code = failure_code();
  /* A zombie has no session any more: report 0. */
  if (code == ESRCH && out->status == SZOMB) {
    out->sid = 0;
    return 0;
  }
  return code;
}

/* (ppid, pgid, sid, tpgid, comm, status, uid, incarnation) */
CAMLprim value mesh_darwin_process(value v_pid)
{
  CAMLparam1(v_pid);
  CAMLlocal3(tuple, text, start);
  pid_t pid = (pid_t)Long_val(v_pid);
  struct raw_process found;
  memset(&found, 0, sizeof found);
  caml_enter_blocking_section();
  int code = lookup_process(pid, &found);
  caml_leave_blocking_section();
  if (code != 0) CAMLreturn(result_error(kind_of_code(code)));
  text = caml_copy_string(found.comm);
  start = caml_copy_int64(found.incarnation);
  tuple = caml_alloc_tuple(8);
  Store_field(tuple, 0, Val_int(found.ppid));
  Store_field(tuple, 1, Val_int(found.pgid));
  Store_field(tuple, 2, Val_int(found.sid));
  Store_field(tuple, 3, Val_int(found.tpgid));
  Store_field(tuple, 4, text);
  Store_field(tuple, 5, Val_int(found.status));
  Store_field(tuple, 6, Val_int(found.uid));
  Store_field(tuple, 7, start);
  CAMLreturn(result_ok(tuple));
}

/* proc_listallpids answers a count of pids. The table can grow between the
   size probe and the read: retry while the answer fills the buffer. */
static int list_pids(pid_t **out, int *count)
{
  for (int attempt = 0; attempt < 8; attempt++) {
    errno = 0;
    int estimate = proc_listallpids(NULL, 0);
    if (estimate <= 0) return failure_code();
    int capacity = estimate + 64;
    pid_t *pids = malloc((size_t)capacity * sizeof *pids);
    if (pids == NULL) return ENOMEM;
    errno = 0;
    int got = proc_listallpids(pids, capacity * (int)sizeof *pids);
    if (got <= 0) {
      int code = failure_code();
      free(pids);
      return code;
    }
    if (got < capacity) {
      *out = pids;
      *count = got;
      return 0;
    }
    free(pids);
  }
  return EAGAIN;
}

CAMLprim value mesh_darwin_list_pids(value unit)
{
  CAMLparam1(unit);
  CAMLlocal1(array);
  pid_t *pids = NULL;
  int count = 0;
  caml_enter_blocking_section();
  int code = list_pids(&pids, &count);
  caml_leave_blocking_section();
  if (code != 0) CAMLreturn(result_error(kind_of_code(code)));
  array = caml_alloc(count, 0);
  for (int index = 0; index < count; index++)
    Store_field(array, index, Val_int(pids[index]));
  free(pids);
  CAMLreturn(result_ok(array));
}

/* KERN_PROCARGS2 into a buffer of KERN_ARGMAX bytes. The kernel answers
   EINVAL both for a missing process and for one it will not show; the OCaml
   side tells them apart. */
static int read_procargs(pid_t pid, char **out, size_t *length)
{
  int argmax_mib[2] = {CTL_KERN, KERN_ARGMAX};
  int argmax = 0;
  size_t argmax_size = sizeof argmax;
  errno = 0;
  if (sysctl(argmax_mib, 2, &argmax, &argmax_size, NULL, 0) != 0)
    return failure_code();
  if (argmax_size != sizeof argmax || argmax <= 0) return MESH_SHORT_ANSWER;
  char *buffer = malloc((size_t)argmax);
  if (buffer == NULL) return ENOMEM;
  int mib[3] = {CTL_KERN, KERN_PROCARGS2, pid};
  size_t size = (size_t)argmax;
  errno = 0;
  if (sysctl(mib, 3, buffer, &size, NULL, 0) != 0) {
    int code = failure_code();
    free(buffer);
    return code;
  }
  if (size > (size_t)argmax) {
    free(buffer);
    return MESH_SHORT_ANSWER;
  }
  *out = buffer;
  *length = size;
  return 0;
}

CAMLprim value mesh_darwin_procargs2(value v_pid)
{
  CAMLparam1(v_pid);
  CAMLlocal1(text);
  pid_t pid = (pid_t)Long_val(v_pid);
  char *buffer = NULL;
  size_t length = 0;
  caml_enter_blocking_section();
  int code = read_procargs(pid, &buffer, &length);
  caml_leave_blocking_section();
  if (code != 0) CAMLreturn(result_error(kind_of_code(code)));
  text = caml_alloc_initialized_string(length, buffer);
  free(buffer);
  CAMLreturn(result_ok(text));
}

static int read_cwd(pid_t pid, struct proc_vnodepathinfo *info)
{
  errno = 0;
  int got = proc_pidinfo(pid, PROC_PIDVNODEPATHINFO, 0, info, sizeof *info);
  if (got <= 0) return failure_code();
  if ((size_t)got < sizeof *info) return MESH_SHORT_ANSWER;
  return 0;
}

CAMLprim value mesh_darwin_cwd(value v_pid)
{
  CAMLparam1(v_pid);
  CAMLlocal1(text);
  pid_t pid = (pid_t)Long_val(v_pid);
  struct proc_vnodepathinfo *info = malloc(sizeof *info);
  if (info == NULL) CAMLreturn(result_error(KIND_FAILED));
  caml_enter_blocking_section();
  int code = read_cwd(pid, info);
  caml_leave_blocking_section();
  if (code != 0) {
    free(info);
    CAMLreturn(result_error(kind_of_code(code)));
  }
  const char *path = info->pvi_cdir.vip_path;
  text = caml_alloc_initialized_string(
      strnlen(path, sizeof info->pvi_cdir.vip_path), path);
  free(info);
  CAMLreturn(result_ok(text));
}

struct fd_path {
  int fd;
  char *path;
};

static void free_fd_paths(struct fd_path *paths, size_t count)
{
  for (size_t index = 0; index < count; index++) free(paths[index].path);
  free(paths);
}

/* PROC_PIDLISTFDS answers bytes; a NULL buffer gives an estimate. Retry while
   the answer fills the buffer. An answer of 0 bytes with no errno is a
   process without descriptors. */
static int list_fds(pid_t pid, struct proc_fdinfo **out, int *count)
{
  for (int attempt = 0; attempt < 8; attempt++) {
    errno = 0;
    int estimate = proc_pidinfo(pid, PROC_PIDLISTFDS, 0, NULL, 0);
    if (estimate < 0 || (estimate == 0 && errno != 0)) return failure_code();
    int capacity = estimate / (int)sizeof(struct proc_fdinfo) + 32;
    struct proc_fdinfo *fds = malloc((size_t)capacity * sizeof *fds);
    if (fds == NULL) return ENOMEM;
    errno = 0;
    int got = proc_pidinfo(pid, PROC_PIDLISTFDS, 0, fds,
                           capacity * (int)sizeof *fds);
    if (got < 0 || (got == 0 && errno != 0)) {
      int code = failure_code();
      free(fds);
      return code;
    }
    int entries = got / (int)sizeof *fds;
    if (entries < capacity) {
      *out = fds;
      *count = entries;
      return 0;
    }
    free(fds);
  }
  return EAGAIN;
}

/* The path of one vnode descriptor, or NULL when it vanished, has no path,
   or memory ran out. */
static char *vnode_path(pid_t pid, int fd)
{
  struct vnode_fdinfowithpath info;
  int got = proc_pidfdinfo(pid, fd, PROC_PIDFDVNODEPATHINFO, &info,
                           sizeof info);
  if (got <= 0 || (size_t)got < sizeof info) return NULL;
  size_t length = strnlen(info.pvip.vip_path, sizeof info.pvip.vip_path);
  if (length == 0) return NULL;
  char *copy = malloc(length + 1);
  if (copy == NULL) return NULL;
  memcpy(copy, info.pvip.vip_path, length);
  copy[length] = '\0';
  return copy;
}

static int collect_fd_paths(pid_t pid, struct fd_path **out, size_t *count)
{
  struct proc_fdinfo *fds = NULL;
  int entries = 0;
  int code = list_fds(pid, &fds, &entries);
  if (code != 0) return code;
  struct fd_path *paths = calloc((size_t)entries + 1, sizeof *paths);
  if (paths == NULL) {
    free(fds);
    return ENOMEM;
  }
  size_t found = 0;
  for (int index = 0; index < entries; index++) {
    if (fds[index].proc_fdtype != PROX_FDTYPE_VNODE) continue;
    char *path = vnode_path(pid, fds[index].proc_fd);
    if (path == NULL) continue;
    paths[found].fd = fds[index].proc_fd;
    paths[found].path = path;
    found++;
  }
  free(fds);
  *out = paths;
  *count = found;
  return 0;
}

/* (fd, path) array, in the kernel's descriptor order. */
CAMLprim value mesh_darwin_fd_paths(value v_pid)
{
  CAMLparam1(v_pid);
  CAMLlocal3(array, pair, text);
  pid_t pid = (pid_t)Long_val(v_pid);
  struct fd_path *paths = NULL;
  size_t count = 0;
  caml_enter_blocking_section();
  int code = collect_fd_paths(pid, &paths, &count);
  caml_leave_blocking_section();
  if (code != 0) CAMLreturn(result_error(kind_of_code(code)));
  array = caml_alloc(count, 0);
  for (size_t index = 0; index < count; index++) {
    text = caml_copy_string(paths[index].path);
    pair = caml_alloc_tuple(2);
    Store_field(pair, 0, Val_int(paths[index].fd));
    Store_field(pair, 1, text);
    Store_field(array, index, pair);
  }
  free_fd_paths(paths, count);
  CAMLreturn(result_ok(array));
}

#else /* not __APPLE__ */

CAMLprim value mesh_darwin_process(value v_pid)
{
  (void)v_pid;
  return result_error(KIND_UNSUPPORTED);
}

CAMLprim value mesh_darwin_list_pids(value unit)
{
  (void)unit;
  return result_error(KIND_UNSUPPORTED);
}

CAMLprim value mesh_darwin_procargs2(value v_pid)
{
  (void)v_pid;
  return result_error(KIND_UNSUPPORTED);
}

CAMLprim value mesh_darwin_cwd(value v_pid)
{
  (void)v_pid;
  return result_error(KIND_UNSUPPORTED);
}

CAMLprim value mesh_darwin_fd_paths(value v_pid)
{
  (void)v_pid;
  return result_error(KIND_UNSUPPORTED);
}

#endif
