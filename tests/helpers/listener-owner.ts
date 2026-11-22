// Shared test-only listener ownership check.
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';

const PROC = process.env.MESH_TEST_OWNER !== 'lsof' && fs.existsSync('/proc/net/tcp');
const LSOF = !PROC && spawnSync('lsof', ['-v'], {stdio: 'ignore'}).error === undefined;
export const OWNER_CHECK = PROC || LSOF;
export function listensFrom(pid: number, port: number): boolean {
  if (!PROC) {
    // -a: the conditions together; -t: the PIDs only. Exit status 1 when nothing matches.
    const found = spawnSync('lsof', ['-nP', '-a', '-p', String(pid), `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], {encoding: 'utf8'});
    return found.status === 0 && found.stdout.split('\n').includes(String(pid));
  }
  const local = `:${port.toString(16).toUpperCase().padStart(4, '0')}`;
  const inodes = new Set<string>();
  for (const table of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let text = '';
    try { text = fs.readFileSync(table, 'utf8'); } catch { continue; }
    for (const row of text.split('\n').slice(1)) {
      const fields = row.trim().split(/\s+/);
      // local address, state 0A (LISTEN), inode
      if (fields[1]?.endsWith(local) && fields[3] === '0A' && fields[9]) inodes.add(fields[9]);
    }
  }
  if (inodes.size === 0) return false;
  let descriptors: string[] = [];
  try { descriptors = fs.readdirSync(`/proc/${pid}/fd`); } catch { return false; }
  return descriptors.some(fd => {
    try {
      const socket = /^socket:\[(\d+)\]$/.exec(fs.readlinkSync(`/proc/${pid}/fd/${fd}`));
      return socket?.[1] !== undefined && inodes.has(socket[1]);
    } catch {
      return false;
    }
  });
}

