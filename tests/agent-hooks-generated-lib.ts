// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The hook configurations Mesh generates for each agent, produced by the real generators (resumeargs.py,
// agentmcp.py) and the shipped Copilot plugin, with the installation directory replaced by @BIN@. Shared by
// the golden test (tests/agent-hooks-golden.test.ts) and the table test (tests/agent-hooks-model.test.ts).
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const REPO = path.resolve(import.meta.dirname, '..');

export interface Generated {
  claude_inline: string;
  claude_merge: string;
  gemini: unknown;
  agy: string;
  vibe: string;
  copilot: string;
}

const created: string[] = [];

/** A new private temporary directory, removed by removeTemporary. */
export function temporary(prefix: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  created.push(directory);
  return directory;
}

/** Remove every directory temporary and stubBin made (a test file's after hook). */
export function removeTemporary(): void {
  for (const directory of created.splice(0)) fs.rmSync(directory, {recursive: true, force: true});
}

/** A private installation directory holding executable stubs named after ``programs``. */
export function stubBin(programs: string[]): {root: string; bin: string} {
  const root = temporary('agent-hooks-');
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  for (const name of programs) fs.writeFileSync(path.join(bin, name), '#!/bin/sh\nexit 0\n', {mode: 0o755});
  return {root, bin};
}

const SCRIPT = String.raw`
import json, os, sys
sys.path.insert(0, os.environ["REPO"])
import agentmcp, resumeargs
bin_dir = os.environ["MESH_BIN_DIR"]
def norm(value):
    return json.loads(json.dumps(value).replace(bin_dir, "@BIN@"))
def settings_of(args):
    return args[args.index("--settings") + 1].replace(bin_dir, "@BIN@")
user = {"model": "x", "hooks": {
    "Stop": [{"hooks": [{"type": "command", "command": "/home/u/own-stop", "timeout": 3}]}],
    "PreToolUse": [{"matcher": "Bash", "hooks": [{"type": "command", "command": "/old/install/bin/mesh-event claude"}]}],
    "SessionStart": [{"hooks": [{"type": "command", "command": "/home/u/own-start"}]}]}}
gemini_user = {"hooks": {"BeforeAgent": [{"hooks": [{"type": "command", "command": "/home/u/own"}]}]}}
vibe_dir = agentmcp.vibe_hooks_dir(os.environ["CONF"], "launch-12345678")
with open(os.path.join(vibe_dir, ".vibe", "hooks.toml")) as handle:
    vibe = handle.read()
with open(os.path.join(os.environ["REPO"], "copilot-mesh-plugin", "hooks", "hooks.json")) as handle:
    copilot = handle.read()
print(json.dumps({
    "claude_inline": settings_of(resumeargs.claude_args([])),
    "claude_merge": settings_of(resumeargs.claude_args(["--settings", json.dumps(user)])),
    "gemini": norm(agentmcp.gemini_settings(gemini_user)["hooks"]),
    "agy": agentmcp.agy_plugin_files(bridge="", event=os.path.join(bin_dir, "mesh-event"))["hooks.json"].replace(bin_dir, "@BIN@"),
    "vibe": vibe.replace(bin_dir, "@BIN@"),
    "copilot": copilot,
}))
`;

/** What the generators produce with ``bin`` as MESH_BIN_DIR and ``extra`` added to their environment. */
export function generated(bin: string, extra: Record<string, string> = {}): Generated {
  const conf = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hooks-conf-'));
  try {
    const output = execFileSync(process.env.MESH_PYTHON || 'python3', ['-I', '-c', SCRIPT], {
      encoding: 'utf8',
      env: {PATH: process.env.PATH, HOME: conf, TMPDIR: process.env.TMPDIR ?? '/tmp', REPO, CONF: conf,
        MESH_BIN_DIR: bin, MESH_CONF_DIR: conf, ...extra},
    });
    return JSON.parse(output) as Generated;
  } finally {
    fs.chmodSync(conf, 0o700);
    for (const entry of walk(conf)) fs.chmodSync(entry, 0o700);
    fs.rmSync(conf, {recursive: true, force: true});
  }
}

/** The settings value resumeargs.claude_args gives for ``argv``, with the installation directory as @BIN@. */
export function claudeSettings(bin: string, argv: string[], extra: Record<string, string> = {}): string {
  const script = String.raw`
import json, os, sys
sys.path.insert(0, os.environ["REPO"])
import resumeargs
args = resumeargs.claude_args(json.loads(sys.argv[1]))
print(args[args.index("--settings") + 1].replace(os.environ["MESH_BIN_DIR"], "@BIN@"))
`;
  return execFileSync(process.env.MESH_PYTHON || 'python3', ['-I', '-c', script, JSON.stringify(argv)], {
    encoding: 'utf8',
    env: {PATH: process.env.PATH, HOME: os.tmpdir(), TMPDIR: process.env.TMPDIR ?? '/tmp', REPO, MESH_BIN_DIR: bin, ...extra},
  }).trimEnd();
}

function walk(directory: string): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(directory, {withFileTypes: true})) {
    if (entry.isDirectory()) {
      const inner = path.join(directory, entry.name);
      found.push(inner, ...walk(inner));
    }
  }
  return found;
}
