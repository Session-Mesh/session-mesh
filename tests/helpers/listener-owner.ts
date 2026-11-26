// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// Shared test-only listener ownership check.
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';

const PROC = process.env.MESH_TEST_OWNER !== 'lsof' && fs.existsSync('/proc/net/tcp');
const LSOF = !PROC && spawnSync('lsof', ['-v'], {stdio: 'ignore'}).error === undefined;
export const OWNER_CHECK = PROC || LSOF;
function listens(pid: number, port: number, loopbackOnly: boolean): boolean {
  if (!PROC) {
    if (!loopbackOnly) {
      const found = spawnSync('lsof', ['-nP', '-a', '-p', String(pid), `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], {encoding: 'utf8'});
      return found.status === 0 && found.stdout.split('\n').includes(String(pid));
    }
    // Restrict to IPv4: lsof prints both IPv4 and IPv6 wildcard sockets as '*'.
    // Only the exact loopback address or an IPv4 wildcard can serve our probe.
    const found = spawnSync('lsof', ['-nP', '-a', '-p', String(pid), `-i4TCP:${port}`, '-sTCP:LISTEN', '-Fn'], {encoding: 'utf8'});
    return found.status === 0 && found.stdout.split('\n').some(line =>
      line === `n127.0.0.1:${port}` || line === `n*:${port}` || line === `n0.0.0.0:${port}`);
  }
  const portHex = port.toString(16).toUpperCase().padStart(4, '0');
  const locals = new Set([`0100007F:${portHex}`, `00000000:${portHex}`]);
  const inodes = new Set<string>();
  for (const table of loopbackOnly ? ['/proc/net/tcp'] : ['/proc/net/tcp', '/proc/net/tcp6']) {
    let text = '';
    try { text = fs.readFileSync(table, 'utf8'); } catch { continue; }
    for (const row of text.split('\n').slice(1)) {
      const fields = row.trim().split(/\s+/);
      // local address, state 0A (LISTEN), inode
      if ((loopbackOnly ? locals.has(fields[1] ?? '') : fields[1]?.endsWith(`:${portHex}`))
          && fields[3] === '0A' && fields[9]) inodes.add(fields[9]);
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

export function listensFrom(pid: number, port: number): boolean { return listens(pid, port, false); }
export function listensLoopbackFrom(pid: number, port: number): boolean { return listens(pid, port, true); }

