// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// Gemini CLI's resume command, capability row and hook translation. Options are `gemini --help` of 0.68.0.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {describe, test} from 'node:test';

const REPO = path.resolve(import.meta.dirname, '..');
const SID = '3f1d2c4b-5a6e-4f70-8a9b-0c1d2e3f4a5b';

function python(code: string, env: NodeJS.ProcessEnv = {}): unknown {
  const output = execFileSync(process.env.MESH_PYTHON || 'python3', ['-I', '-c', `import sys; sys.path.insert(0, ${JSON.stringify(REPO)})\n${code}`],
    {cwd: REPO, env: {PATH: process.env.PATH, HOME: process.env.HOME, ...env}, encoding: 'utf8', timeout: 30_000});
  return JSON.parse(output);
}
const resume = (argv: string[]): unknown => python(`
import json, resumeargs
try:
    print(json.dumps(resumeargs.resume_argv("gemini", ${JSON.stringify(argv)}, ${JSON.stringify(SID)})))
except resumeargs.WeakerResume as exc:
    print(json.dumps({"refused": str(exc)}))
`);

describe('Gemini resume', () => {
  test('keeps the session and restriction options, drops pickers, prompt and worktree', () => {
    assert.deepEqual(resume(['gemini']), ['gemini', '--resume', SID]);
    assert.deepEqual(resume(['gemini', '-m', 'gemini-x', '--approval-mode', 'plan', '--sandbox', '--yolo', '-r', 'latest',
      '--session-id', 'abc', '-w', 'tree', '--include-directories', '/a', '/b', '-i', 'first prompt', 'query words']),
    ['gemini', '--resume', SID, '-m', 'gemini-x', '--approval-mode', 'plan', '--sandbox', '--yolo',
      '--include-directories', '/a', '/b']);
  });

  test('refuses rather than drop a restriction it cannot read; subcommands are not conversations', () => {
    assert.match((resume(['gemini', '--unknown', '--policy', '/p']) as {refused: string}).refused, /--policy/);
    assert.deepEqual(resume(['gemini', 'mcp', 'list']), ['gemini', '--resume', SID]);
  });

  test('node entry point and npx package are recognised', () => {
    assert.deepEqual(resume(['node', '/usr/lib/node_modules/@google/gemini-cli/bundle/gemini.js', '--yolo']),
      ['gemini', '--resume', SID, '--yolo']);
    assert.deepEqual(resume(['npx', '-y', '@google/gemini-cli@0.68.0', '--sandbox']), ['gemini', '--resume', SID, '--sandbox']);
  });

  test('capability row and launch vector', () => {
    assert.deepEqual(python(`
import json, agentcap, launchplan
print(json.dumps({"row": {f.value: s.value for f, s in agentcap.MATRIX["gemini"].items()}, "argv": launchplan.build("gemini").command()}))`),
    {row: {board_mcp: 'supported', history: 'supported', resume: 'supported', structured_output: 'unknown'}, argv: ['gemini']});
  });

  test('hook payloads become Mesh events; unrelated hooks and malformed values do not', () => {
    assert.deepEqual(python(`
import importlib.machinery, importlib.util, json
loader = importlib.machinery.SourceFileLoader("mesh_event", "bin/mesh-event")
spec = importlib.util.spec_from_loader("mesh_event", loader)
module = importlib.util.module_from_spec(spec); loader.exec_module(module)
payloads = [{"hook_event_name": "BeforeAgent", "session_id": "s1"}, {"hook_event_name": "AfterAgent", "session_id": "s1"},
  {"hook_event_name": "Notification", "notification_type": "ToolPermission", "session_id": "s1"},
  {"hook_event_name": "Notification", "notification_type": "Other"}, {"hook_event_name": "SessionStart"}, "text", None,
  {"hook_event_name": "BeforeTool", "session_id": "s1"}, {"hook_event_name": "AfterTool", "session_id": "s1"}]
print(json.dumps([(e["type"], e["detail"].get("session")) if e else None for e in (module.gemini_event(p, 1.0) for p in payloads)]))`),
    [['working', 's1'], ['done', 's1'], ['waiting_permission', 's1'], null, null, null, null,
      ['working', 's1'], ['working', 's1']]);   // a tool running is a turn running: never finished
  });

  test('the user\'s restrictions survive the merge, tools.exclude included; the hook command never fails', () => {
    assert.deepEqual(python(`
import json, agentmcp
user = {"tools": {"exclude": ["run_shell_command"]}, "mcp": {"excluded": ["x"], "allowed": ["y"]},
        "hooksConfig": {"enabled": False}, "security": {"folderTrust": {"enabled": True}}}
merged = agentmcp.gemini_settings(user)
commands = [group["hooks"][0]["command"] for groups in merged["hooks"].values() for group in groups]
print(json.dumps({"kept": {key: merged[key] for key in user}, "commands": commands}))`),
    {kept: {tools: {exclude: ['run_shell_command']}, mcp: {excluded: ['x'], allowed: ['y']},
      hooksConfig: {enabled: false}, security: {folderTrust: {enabled: true}}},
    commands: Array(5).fill(`${path.join(REPO, 'bin', 'mesh-event')} gemini >/dev/null 2>&1 || true`)});
  });

  test('a stale Mesh hook of another install is replaced whether its path was quoted or not; the user\'s hooks stay', () => {
    assert.deepEqual(python(`
import json, agentmcp
stale = ["'/old install/bin/mesh-event' gemini >/dev/null 2>&1 || true", "/old/bin/mesh-event gemini >/dev/null 2>&1 || true",
         "'/older install/bin/mesh-event' gemini", "/older/bin/mesh-event gemini"]
user = {"hooks": {"AfterAgent": [{"hooks": [{"type": "command", "command": "/opt/user-hook"}]}] +
                  [{"hooks": [{"type": "command", "command": command}]} for command in stale]}}
after = agentmcp.gemini_settings(user)["hooks"]["AfterAgent"]
print(json.dumps([hook["command"] for group in after for hook in group["hooks"]]))`),
    ['/opt/user-hook', `${path.join(REPO, 'bin', 'mesh-event')} gemini >/dev/null 2>&1 || true`]);
  });

  test('settings.json swapped for a FIFO after the check is refused without blocking', () => {
    // Path.stat() answers "regular file" for a FIFO, as a swap between a stat and the open would.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-fifo-'));
    try {
      const fifo = path.join(dir, 'settings.json');
      execFileSync('mkfifo', [fifo]);
      assert.deepEqual(python(`
import json, os, pathlib, agentmcp
class Liar(type(pathlib.Path())):
    def stat(self, **kwargs):
        return os.stat_result((0o100644, 0, 0, 1, 0, 0, 10, 0, 0, 0))
try:
    agentmcp._read_gemini_settings(Liar(${JSON.stringify(fifo)}))
    print(json.dumps("read"))
except ValueError as exc:
    print(json.dumps(str(exc)))`), 'settings.json is not a regular file');
    } finally {
      fs.rmSync(dir, {recursive: true, force: true});
    }
  });

  test('a Gemini restart from the home directory is refused before the agent is stopped', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-home-'));
    try {
      // The pid is already being resumed: without the home-directory check the answer would be 409, and nothing is stopped.
      assert.deepEqual(python(`
import asyncio, json, server
from aiohttp import web
server.RESUMING.add(999999)
agent = {"type": "gemini", "session_id": ${JSON.stringify(SID)}, "argv": ["gemini"], "pid": 999999}
try:
    asyncio.run(server.resume_target({"agent": agent, "cwd": ${JSON.stringify(home)}}))
    print(json.dumps(["resumed"]))
except web.HTTPException as exc:
    print(json.dumps([exc.status, exc.text]))`, {HOME: home, XDG_RUNTIME_DIR: home, TMPDIR: home}),
      [400, 'Gemini CLI is not started in the home directory: it would take the real ~/.gemini for a project folder '
        + '(settings loaded twice, hooks run twice, ~/.agents/skills not found). Choose a subfolder. The agent was not stopped.']);
    } finally {
      fs.rmSync(home, {recursive: true, force: true});
    }
  });
});
