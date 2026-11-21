// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// Shared by the Claude socket-wake tests: a fake Claude (a script named `claude`, running Node) that
// answers --version and listens on the --messaging-socket-path it was given, logging every line it
// receives and every line typed in its terminal, and the PTY host command to run.
// Nothing here writes outside the directories it creates under the OS temporary directory.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {nativePtyhost} from './helpers/native-ptyhost.ts';
export {fakeAgentShell} from './helpers/fake-agent.ts';

/** The native PTY host to start (fails with a clear message when MESH_PTYHOST_CMD is not set). */
export const hostArgv = nativePtyhost;
// An administrator's policy would change what Claude does with the line: not these tests' subject.
export const MANAGED = ['/etc/claude-code', '/Library/Application Support/ClaudeCode'].filter(dir => fs.existsSync(dir));
export const NOTICE = 'check agent_inbox';

// `--version` has no side effect. Otherwise: record the arguments and the session token in the
// working directory, listen on the socket the command line names, and log typed lines.
export function fakeClaude(): string {
  return [
    "const fs = require('node:fs'), net = require('node:net'), readline = require('node:readline');",
    'const args = process.argv.slice(2);',
    "if (args[0] === '--version') { process.stdout.write('2.1.325 (Claude Code)\\n'); process.exit(0); }",
    "fs.writeFileSync('./argv.json', JSON.stringify(args));",
    "const at = args.indexOf('--messaging-socket-path');",
    "if (at >= 0) net.createServer(c => readline.createInterface({input: c}).on('line', l => fs.appendFileSync('./socket.log', l + '\\n'))).listen(args[at + 1]);",
    "readline.createInterface({input: process.stdin}).on('line', l => fs.appendFileSync('./input.log', l + '\\n'));",
    "fs.writeFileSync('./token.tmp', process.env.MESH_SESSION_TOKEN ?? ''); fs.renameSync('./token.tmp', './token');",
    '',
  ].join('\n');
}

/** A directory holding an executable `claude` the PTY host recognises, and the PATH that finds it.
 *  MESH_BIN_DIR names a directory with a stub `mesh-board-mcp`: the server gives a session a socket
 *  only when the board bridge (the `agent_inbox` tool) is installed, and these tests must not depend on
 *  an OCaml build. The stub is never run: the fake Claude ignores `--mcp-config`. */
export function installFakeClaude(): {bin: string; PATH: string; MESH_BIN_DIR: string} {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'skw-bin-'));
  fs.writeFileSync(path.join(bin, 'mesh-board-mcp'), '#!/bin/sh\nexit 1\n', {mode: 0o755});
  // The PTY host recognises an agent by argv[0]: a Node process must be started under that name.
  // bash, not sh: `exec -a` is a bash builtin option that dash (Ubuntu's /bin/sh) refuses.
  fs.writeFileSync(path.join(bin, 'fake-claude.js'), fakeClaude());
  fs.writeFileSync(path.join(bin, 'claude'),
    `#!/bin/bash\nexec -a claude '${process.execPath}' '${path.join(bin, 'fake-claude.js')}' "$@"\n`, {mode: 0o755});
  return {bin, PATH: `${bin}:${process.env.PATH}`, MESH_BIN_DIR: bin};
}
