// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// A throwaway server.py and PTY host with fake Claude agents, for the mailbox tests: each agent
// is a shell script named `claude` that writes its session token to a file, so the test can speak
// as that agent. HOME, configuration, runtime directory and port are the test's own; the
// caller's MESH_SESSION* variables are not passed on.
import assert from 'node:assert/strict';
import {type ChildProcess, spawn} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {REPO, type Mesh, startMesh} from '../mesh-server-lib.ts';
import {request, waitFor} from '../ptyhost-wire-lib.ts';
import {nativePtyhost} from './native-ptyhost.ts';

export type Agent = {name: string; dir: string; token: string; created: number};
export type Identity = {id: string; created: number; agent: string};

export class AgentMesh {
  readonly agents: Record<string, Agent> = {};
  cookie = '';
  private readonly scratches: string[] = [];
  private readonly hosts: ChildProcess[] = [];
  readonly mesh: Mesh;
  private constructor(mesh: Mesh) { this.mesh = mesh; }

  static async start(prefix: string, names: string[]): Promise<AgentMesh> {
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'mbx-'));
    fs.writeFileSync(path.join(bin, 'claude'), [
      '#!/bin/sh',
      'printf "%s" "$MESH_SESSION_TOKEN" > ./token.tmp && mv ./token.tmp ./token',
      'while IFS= read -r line; do :; done',
      '',
    ].join('\n'), {mode: 0o755});
    const PATH = `${bin}:${process.env.PATH}`;
    const mesh = await startMesh(prefix, {PATH, MESH_SESSION_TOKEN: undefined, MESH_SESSION: undefined, MESH_BIN_DIR: undefined});
    const lab = new AgentMesh(mesh);
    lab.scratches.push(bin);
    const runtime = path.join(mesh.home, 'run');
    const nativeHost = nativePtyhost();
    lab.hosts.push(spawn(nativeHost[0], nativeHost.slice(1), {cwd: REPO, stdio: 'ignore',
      env: {PATH, HOME: mesh.home, XDG_RUNTIME_DIR: runtime, LANG: 'C', SHELL: '/bin/bash'}}));
    const socketPath = path.join(runtime, 'session-mesh', 'ptyhost.sock');
    await waitFor('ptyhost answering', 10000, () => request(socketPath, {op: 'list'}).then(() => true, () => false));
    const login = await fetch(`${mesh.base}/login`, {method: 'POST', redirect: 'manual',
      headers: {'Content-Type': 'application/x-www-form-urlencoded'}, body: new URLSearchParams({token: mesh.token()})});
    lab.cookie = login.headers.get('set-cookie')?.split(';')[0] ?? '';
    assert.ok(lab.cookie, 'the owner signs in');
    for (const name of names) lab.agents[name] = await lab.launch(name);
    await lab.learnIncarnations();
    return lab;
  }

  async stop(): Promise<void> {
    for (const host of this.hosts) host.kill('SIGKILL');
    await this.mesh.stop();
    for (const dir of this.scratches) fs.rmSync(dir, {recursive: true, force: true});
  }

  ownerJson(): Record<string, string> {
    return {Cookie: this.cookie, Origin: this.mesh.base, 'Content-Type': 'application/json'};
  }

  agentHeaders(agent: Agent): Record<string, string> {
    return {Authorization: `MeshSession ${agent.token}`, 'Content-Type': 'application/json'};
  }

  private async launch(name: string): Promise<Agent> {
    const dir = path.join(this.mesh.home, name);
    fs.mkdirSync(dir);
    const response = await fetch(`${this.mesh.base}/api/new`, {method: 'POST',
      headers: {Authorization: `Bearer ${this.mesh.token()}`, Origin: this.mesh.base, 'Content-Type': 'application/json'},
      body: JSON.stringify({preset: 'claude', cwd: dir, name})});
    assert.equal(response.status, 200, await response.clone().text());
    await waitFor(`fake claude ${name}`, 15000, () => fs.existsSync(path.join(dir, 'token')));
    return {name, dir, token: fs.readFileSync(path.join(dir, 'token'), 'utf8').trim(), created: 0};
  }

  // Each agent sees the others as peers; together they give every incarnation's creation date.
  private async learnIncarnations(): Promise<void> {
    for (const agent of Object.values(this.agents)) {
      const peers = await (await fetch(`${this.mesh.base}/api/agent-mail/@self/peers`, {headers: this.agentHeaders(agent)}))
        .json() as {peers: Identity[]};
      for (const peer of peers.peers) this.agents[peer.id]!.created = peer.created;
    }
  }

  async send(from: Agent, to: Agent, text: string, kind = 'message'): Promise<void> {
    const response = await fetch(`${this.mesh.base}/api/agent-mail/@self/send`, {method: 'POST', headers: this.agentHeaders(from),
      body: JSON.stringify({target: to.name, target_created: to.created, kind, text})});
    assert.equal(response.status, 200, await response.clone().text());
  }

  async inbox(agent: Agent): Promise<string[]> {
    const response = await fetch(`${this.mesh.base}/api/agent-mail/@self/inbox`, {headers: this.agentHeaders(agent)});
    return ((await response.json()) as {messages: {id: string}[]}).messages.map(message => message.id);
  }

  readAs(agent: Agent, id: string): Promise<Response> {
    return fetch(`${this.mesh.base}/api/agent-mail/@self/read`,
      {method: 'POST', headers: this.agentHeaders(agent), body: JSON.stringify({message_id: id})});
  }

  decide(requestId: string, decision: string): Promise<Response> {
    return fetch(`${this.mesh.base}/api/agent-mail/consent/${requestId}/decision`,
      {method: 'POST', headers: this.ownerJson(), body: JSON.stringify({decision})});
  }

  async consent(): Promise<{requests: {id: string; message_id: string}[]; always: {id: string}[]}> {
    return (await fetch(`${this.mesh.base}/api/agent-mail/consent`, {headers: {Cookie: this.cookie}})).json() as never;
  }
}
