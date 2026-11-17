// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// A minimal client of the PTY host's socket protocol for Node tests: one control request per
// connection, or an attachment that collects output frames and sends input frames.
// Frame: one kind byte, a 32-bit big-endian length, then the payload.
import assert from 'node:assert/strict';
import net from 'node:net';

export type Frame = {kind: string; payload: Buffer};

export function encode(kind: string, body: Buffer): Buffer {
  const head = Buffer.alloc(5);
  head.write(kind, 'latin1');
  head.writeUInt32BE(body.length, 1);
  return Buffer.concat([head, body]);
}

export async function waitFor(what: string, timeoutMs: number, done: () => boolean | Promise<boolean>): Promise<number> {
  const start = performance.now();
  while (!(await done())) {
    if (performance.now() - start > timeoutMs) throw new Error(`${what}: not within ${timeoutMs} ms`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  return performance.now() - start;
}

export function request(socketPath: string, payload: object): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let received = Buffer.alloc(0);
    socket.setTimeout(5000, () => socket.destroy(new Error('ptyhost did not answer')));
    socket.on('error', reject);
    socket.on('connect', () => socket.write(encode('C', Buffer.from(JSON.stringify(payload)))));
    socket.on('data', chunk => {
      received = Buffer.concat([received, chunk]);
      if (received.length < 5 || received.length < 5 + received.readUInt32BE(1)) return;
      socket.destroy();
      resolve(JSON.parse(received.subarray(5, 5 + received.readUInt32BE(1)).toString('utf8')));
    });
  });
}

export class Attachment {
  readonly frames: Frame[] = [];
  closed = false;
  private buffer = Buffer.alloc(0);
  readonly socket: net.Socket;

  constructor(socket: net.Socket) {
    this.socket = socket;
    socket.on('data', chunk => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      while (this.buffer.length >= 5 && this.buffer.length >= 5 + this.buffer.readUInt32BE(1)) {
        const length = this.buffer.readUInt32BE(1);
        this.frames.push({kind: this.buffer.subarray(0, 1).toString('latin1'), payload: this.buffer.subarray(5, 5 + length)});
        this.buffer = this.buffer.subarray(5 + length);
      }
    });
    socket.on('close', () => { this.closed = true; });
    socket.on('error', () => { this.closed = true; });
  }

  async next(kind: string): Promise<Frame> {
    await waitFor(`a ${kind} frame`, 10000, () => this.frames.some(frame => frame.kind === kind));
    const index = this.frames.findIndex(frame => frame.kind === kind);
    return this.frames.splice(index, 1)[0];
  }

  output(): string {
    return Buffer.concat(this.frames.filter(frame => frame.kind === 'D').map(frame => frame.payload)).toString('latin1');
  }

  send(kind: string, payload: Buffer | object): void {
    this.socket.write(encode(kind, Buffer.isBuffer(payload) ? payload : Buffer.from(JSON.stringify(payload))));
  }

  close(): void {
    this.socket.destroy();
  }
}

export async function attach(socketPath: string, name: string): Promise<Attachment> {
  const attachment = new Attachment(net.createConnection(socketPath));
  attachment.send('C', {op: 'attach', name, rows: 24, cols: 80});
  const reply = await attachment.next('C');
  assert.equal(JSON.parse(reply.payload.toString('utf8')).ok, true);
  return attachment;
}
