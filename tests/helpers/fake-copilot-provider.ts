// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// A fake OpenAI-compatible chat-completions server for driving a real `copilot` without any
// GitHub account or network: COPILOT_PROVIDER_BASE_URL=http://127.0.0.1:<port>/v1, COPILOT_MODEL=fake,
// COPILOT_OFFLINE=true. It records every request (so a test can see which tools the model was offered)
// and answers from a script: text, a tool call, or a delay.
import http from 'node:http';

export interface ChatRequest {
  messages: {role: string; content?: unknown; tool_calls?: unknown}[];
  tools?: {function?: {name?: string}}[];
}

export type StaticReply =
  | {text: string; delayMs?: number}
  | {tool: string; args: unknown; delayMs?: number};
/** A reply may depend on the request (for instance on the result of the tool the model just called). */
export type Reply = StaticReply | ((request: ChatRequest) => StaticReply);

export class FakeProvider {
  readonly requests: ChatRequest[] = [];
  private readonly script: Reply[] = [];
  private server: http.Server | undefined;
  port = 0;

  /** Forget the recorded requests and the unused script (between two scenarios). */
  reset(): void { this.requests.length = 0; this.script.length = 0; }

  /** The next reply (FIFO); once the script is empty the model answers "fake-done". */
  enqueue(...replies: Reply[]): void { this.script.push(...replies); }

  /** Names of the tools offered in the latest request. */
  toolNames(): string[] {
    const last = this.requests.at(-1);
    return (last?.tools ?? []).map(tool => tool.function?.name ?? '').filter(Boolean);
  }

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', chunk => chunks.push(chunk as Buffer));
      req.on('end', () => this.handle(req, res, Buffer.concat(chunks).toString('utf8')));
    });
    await new Promise<void>(resolve => this.server!.listen(0, '127.0.0.1', resolve));
    this.port = (this.server.address() as {port: number}).port;
  }

  get baseUrl(): string { return `http://127.0.0.1:${this.port}/v1`; }

  async stop(): Promise<void> {
    this.server?.closeAllConnections();
    await new Promise<void>(resolve => this.server ? this.server.close(() => resolve()) : resolve());
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse, body: string): void {
    if (req.url?.endsWith('/models')) {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({object: 'list', data: [{id: 'fake', object: 'model'}]}));
      return;
    }
    if (!req.url?.endsWith('/chat/completions')) { res.statusCode = 404; res.end('{}'); return; }
    let parsed: ChatRequest = {messages: []};
    try { parsed = JSON.parse(body) as ChatRequest; } catch { /* keep the empty request */ }
    this.requests.push(parsed);
    const next: Reply = this.script.shift() ?? {text: 'fake-done'};
    const reply = typeof next === 'function' ? next(parsed) : next;
    setTimeout(() => this.send(res, reply), reply.delayMs ?? 0);
  }

  private send(res: http.ServerResponse, reply: StaticReply): void {
    res.writeHead(200, {'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache'});
    const chunk = (delta: unknown, finish: string | null) => res.write(`data: ${JSON.stringify({
      id: 'chatcmpl-fake', object: 'chat.completion.chunk', created: 1, model: 'fake',
      choices: [{index: 0, delta, finish_reason: finish}]})}\n\n`);
    if ('tool' in reply) {
      chunk({role: 'assistant', content: null, tool_calls: [{index: 0, id: 'call_fake_1', type: 'function',
        function: {name: reply.tool, arguments: JSON.stringify(reply.args)}}]}, null);
      chunk({}, 'tool_calls');
    } else {
      chunk({role: 'assistant', content: reply.text}, null);
      chunk({}, 'stop');
    }
    res.write('data: [DONE]\n\n');
    res.end();
  }
}
