// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The agent hook model (agent-hooks.json, agent-hooks.ts, docs/agent-hooks.md): the table is valid and
// covers every agent Mesh launches, the Python generators read the same rows as the TypeScript model,
// the shipped Copilot plugin is the table's rendering, and the state consumer written against the
// normalised event gives exactly the envelope bin/mesh-event sends today for each agent's native hooks.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {describe, test} from 'node:test';

import {copilotHooksFile, installed, loadModel, stateEnvelope, type NormalisedEvent} from '../agent-hooks.ts';

const REPO = path.resolve(import.meta.dirname, '..');
const TEXT = fs.readFileSync(path.join(REPO, 'agent-hooks.json'), 'utf8');
const MODEL = loadModel(TEXT);
const UUID = '11111111-2222-3333-4444-555555555555';

function python(code: string): unknown {
  const output = execFileSync(process.env.MESH_PYTHON || 'python3', ['-I', '-c', `
import importlib.machinery, importlib.util, json, os, sys
sys.path.insert(0, ${JSON.stringify(REPO)})
${code}`], {encoding: 'utf8', env: {PATH: process.env.PATH, HOME: process.env.TMPDIR ?? '/tmp', TMPDIR: process.env.TMPDIR ?? '/tmp',
    MESH_BIN_DIR: '/nonexistent/bin'}});
  return JSON.parse(output);
}

describe('the table', () => {
  test('is valid, and a table that breaks a rule is refused', () => {
    const broken = (change: (model: Record<string, any>) => void) => {
      const copy = JSON.parse(TEXT);
      change(copy);
      return () => loadModel(JSON.stringify(copy));
    };
    assert.throws(broken(m => { m.reactions.block = 'permitted'; }), /may not block/);
    assert.throws(broken(m => { m.sources[0].subscriptions.state.push('session_end'); }), /does not emit/);
    assert.throws(broken(m => { m.sources.find((s: any) => s.agent === 'claude').inject = {}; }), /context format/);
    assert.throws(broken(m => { Object.assign(m.sources.find((s: any) => s.agent === 'opencode'), {kind: 'none'}); }), /says why/);
    assert.throws(broken(m => { m.consumers[1].reaction = 'block'; }), /not permitted/);
  });

  test('has one source for every agent Mesh launches', () => {
    const agents = python('import agentcap; print(json.dumps(sorted(agentcap.MATRIX)))') as string[];
    assert.deepEqual(MODEL.sources.map(s => s.agent).sort(), agents);
  });

  test('is what the Python generators install, consumer by consumer', () => {
    const fromPython = python(`import agentmcp
print(json.dumps({row["agent"]: {name: list(agentmcp.hook_events(row["agent"], name)) for name in row["subscriptions"]}
                  for row in agentmcp.AGENT_HOOKS["sources"]}))`) as Record<string, Record<string, string[]>>;
    for (const row of MODEL.sources) {
      for (const consumer of Object.keys(row.subscriptions)) {
        assert.deepEqual(fromPython[row.agent]![consumer], installed(MODEL, row.agent, consumer).map(e => e.native), `${row.agent} ${consumer}`);
      }
    }
  });

  test('renders the shipped Copilot plugin byte for byte', () => {
    assert.equal(copilotHooksFile(MODEL), fs.readFileSync(path.join(REPO, 'copilot-mesh-plugin/hooks/hooks.json'), 'utf8'));
  });

  // The cap that runs is the OCaml constant Wr_context.cap_seconds (work-read does not read the table):
  // the table's cap_seconds documents it, and this keeps the two equal.
  test('states the cap work-read applies', () => {
    const consumer = MODEL.consumers.find(c => c.name === 'project_context')!;
    const source = fs.readFileSync(path.join(REPO, 'ocaml/work_read/lib/wr_context.ml'), 'utf8');
    const caps = [...source.matchAll(/^let cap_seconds = ([0-9.]+)$/gm)].map(match => Number(match[1]));
    assert.deepEqual(caps, [consumer.cap_seconds], 'Wr_context.cap_seconds equals the table');
  });

  test('injects context only where a source has a verified format', () => {
    const wired = MODEL.sources.filter(s => (s.subscriptions.project_context ?? []).length > 0).map(s => s.agent);
    assert.deepEqual(wired, ['claude', 'vibe', 'codex']);
  });
});

// One native hook occurrence per row: the agent, the hook name mesh-event receives on its command line
// (agy and Copilot), the payload, and the normalised event the agent's adapter emits for it (null: the
// adapter drops it, as mesh-event does).
type Case = {agent: string; hook: string; payload: Record<string, unknown>; normalised: Omit<NormalisedEvent, 'schema' | 'at' | 'agent' | 'native'> | null};
const CASES: Case[] = [
  {agent: 'claude', hook: 'UserPromptSubmit', payload: {prompt_id: 'p1', session_id: UUID, prompt: 'SECRET PROMPT'},
    normalised: {event: 'prompt_submit', occurrence: 'p1', conversation: UUID}},
  {agent: 'claude', hook: 'PreToolUse', payload: {tool_name: 'Bash', tool_use_id: 'tu1', session_id: UUID, tool_input: {command: 'rm'}},
    normalised: {event: 'tool_before', tool: 'Bash', tool_use: 'tu1', occurrence: 'tu1', conversation: UUID}},
  {agent: 'claude', hook: 'PermissionRequest', payload: {tool_name: 'Bash', prompt_id: 'p2', session_id: UUID},
    normalised: {event: 'permission_request', tool: 'Bash', occurrence: 'p2', conversation: UUID}},
  {agent: 'claude', hook: 'PermissionRequest', payload: {tool_name: 'AskUserQuestion', prompt_id: 'p3'},
    normalised: {event: 'notification', notice: 'question', tool: 'AskUserQuestion', occurrence: 'p3'}},
  {agent: 'claude', hook: 'PostToolUse', payload: {tool_name: 'Read', tool_use_id: 'tu2'},
    normalised: {event: 'tool_after', tool: 'Read', tool_use: 'tu2', occurrence: 'tu2'}},
  {agent: 'claude', hook: 'Stop', payload: {background_tasks: [], prompt_id: 'p4', session_id: UUID, last_assistant_message: 'REPLY'},
    normalised: {event: 'turn_end', occurrence: 'p4', conversation: UUID}},
  {agent: 'claude', hook: 'Stop', payload: {background_tasks: [{id: 'x'}], prompt_id: 'p5'}, normalised: null},
  {agent: 'claude', hook: 'StopFailure', payload: {error: 'model_not_found', prompt_id: 'p6'},
    normalised: {event: 'turn_end_failure', error: 'model_not_found', occurrence: 'p6'}},
  {agent: 'gemini', hook: 'BeforeAgent', payload: {session_id: 's-1'}, normalised: {event: 'prompt_submit', conversation: 's-1'}},
  {agent: 'gemini', hook: 'BeforeTool', payload: {tool_name: 'run_shell_command'}, normalised: {event: 'tool_before', tool: 'run_shell_command'}},
  {agent: 'gemini', hook: 'AfterTool', payload: {tool_name: 'read_file'}, normalised: {event: 'tool_after', tool: 'read_file'}},
  {agent: 'gemini', hook: 'Notification', payload: {notification_type: 'ToolPermission'}, normalised: {event: 'notification', notice: 'permission'}},
  {agent: 'gemini', hook: 'AfterAgent', payload: {session_id: 's-1'}, normalised: {event: 'turn_end', conversation: 's-1'}},
  {agent: 'agy', hook: 'PreInvocation', payload: {conversationId: 'conv-12345678'}, normalised: {event: 'prompt_submit', conversation: 'conv-12345678'}},
  {agent: 'agy', hook: 'Stop', payload: {fullyIdle: true}, normalised: {event: 'turn_end'}},
  {agent: 'agy', hook: 'Stop', payload: {terminationReason: 'error'}, normalised: {event: 'turn_end_failure'}},
  {agent: 'agy', hook: 'Stop', payload: {fullyIdle: false}, normalised: null},
  {agent: 'copilot', hook: 'userPromptSubmitted', payload: {sessionId: UUID, timestamp: 123}, normalised: {event: 'prompt_submit', conversation: UUID, occurrence: '123'}},
  {agent: 'copilot', hook: 'postToolUse', payload: {toolName: 'bash'}, normalised: {event: 'tool_after', tool: 'bash'}},
  {agent: 'copilot', hook: 'postToolUseFailure', payload: {toolName: 'bash'}, normalised: {event: 'tool_failure', tool: 'bash'}},
  {agent: 'copilot', hook: 'notification', payload: {notification_type: 'permission_prompt'}, normalised: {event: 'notification', notice: 'permission'}},
  {agent: 'copilot', hook: 'notification', payload: {notification_type: 'elicitation_dialog'}, normalised: {event: 'notification', notice: 'question'}},
  {agent: 'copilot', hook: 'agentStop', payload: {}, normalised: {event: 'turn_end'}},
  {agent: 'copilot', hook: 'errorOccurred', payload: {recoverable: false}, normalised: {event: 'turn_end_failure'}},
  {agent: 'copilot', hook: 'errorOccurred', payload: {recoverable: true}, normalised: null},
  {agent: 'vibe', hook: 'session_start', payload: {session_id: UUID}, normalised: {event: 'session_start', conversation: UUID}},
  {agent: 'vibe', hook: 'pre_agent', payload: {}, normalised: {event: 'prompt_submit'}},
  {agent: 'vibe', hook: 'pre_tool', payload: {tool_name: 'bash'}, normalised: {event: 'tool_before', tool: 'bash'}},
  {agent: 'vibe', hook: 'post_tool', payload: {tool_name: 'bash'}, normalised: {event: 'tool_after', tool: 'bash'}},
  {agent: 'vibe', hook: 'notification', payload: {notification_type: 'approval_requested'}, normalised: {event: 'notification', notice: 'permission'}},
  {agent: 'vibe', hook: 'notification', payload: {notification_type: 'question_asked'}, normalised: {event: 'notification', notice: 'question'}},
  {agent: 'vibe', hook: 'notification', payload: {notification_type: 'turn_completed'}, normalised: {event: 'notification', notice: 'turn_completed'}},
  {agent: 'vibe', hook: 'notification', payload: {notification_type: 'turn_failed'}, normalised: {event: 'notification', notice: 'turn_failed'}},
];

describe('the state consumer written against the normalised event', () => {
  // Each payload carries the hook name the way its agent does (in the payload, or only on mesh-event's command line).
  const relayed = python(`
loader = importlib.machinery.SourceFileLoader("mesh_event", os.path.join(${JSON.stringify(REPO)}, "bin", "mesh-event"))
spec = importlib.util.spec_from_loader(loader.name, loader)
me = importlib.util.module_from_spec(spec)
loader.exec_module(me)
out = []
for case in json.loads(${JSON.stringify(JSON.stringify(CASES))}):
    agent, hook, payload = case["agent"], case["hook"], dict(case["payload"])
    if agent in ("claude", "gemini", "vibe"):
        payload["hook_event_name"] = hook
        out.append(getattr(me, agent + "_event")(payload, 1))
    else:
        out.append(getattr(me, agent + "_event")(hook, payload, 1))
print(json.dumps(out))`) as (Record<string, unknown> | null)[];

  CASES.forEach((item, index) => {
    test(`${item.agent} ${item.hook} ${JSON.stringify(item.payload)} gives what bin/mesh-event sends`, () => {
      const native = MODEL.sources.find(s => s.agent === item.agent)!.events.map(e => e.native);
      assert.ok(native.includes(item.hook), `${item.hook} is a native hook of the ${item.agent} source`);
      const envelope = item.normalised === null ? null
        : stateEnvelope({schema: 1, at: 1, agent: item.agent, native: item.hook, ...item.normalised});
      assert.deepEqual(envelope, relayed[index]);
    });
  });
});
