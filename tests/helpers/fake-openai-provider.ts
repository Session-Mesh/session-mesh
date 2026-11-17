// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// A tiny OpenAI-compatible chat server with scripted answers, standing in for a model provider in the
// OpenCode tests (no real model, no network beyond 127.0.0.1). The last user message drives it:
//   [[execute: <code>]]   the model calls OpenCode 2's `execute` tool with that code;
//   [[call: <tool> <json>]] the model calls that tool with that JSON input (OpenCode 1 direct tools);
//   [[question]]          the model calls the `question` tool (two options);
//   [[slow <ms>]]         the answer is delayed, so the turn stays open;
//   anything else         a short text answer.
// After a tool result the model answers `RESULT: <the tool output>`, so a test can tell what the model saw.
import http from 'node:http';

export interface FakeProvider {
  port: number;
  requests: unknown[];
  close(): Promise<void>;
}

type Message = {role?: string; content?: unknown; tool_call_id?: string};

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(part => (typeof part === 'object' && part !== null && 'text' in part ? String((part as {text: unknown}).text) : '')).join('');
}

type Reply = {text: string} | {tool: string; input: unknown};

function script(messages: Message[]): {reply: Reply; delay: number} {
  const last = messages[messages.length - 1] ?? {};
  if (last.role === 'tool') return {reply: {text: `RESULT: ${textOf(last.content)}`}, delay: 0};
  const prompt = textOf([...messages].reverse().find(message => message.role === 'user')?.content);
  const delay = Number(/\[\[slow (\d+)\]\]/.exec(prompt)?.[1] ?? 0);
  const execute = /\[\[execute: ([\s\S]*?)\]\]/.exec(prompt);
  if (execute) return {reply: {tool: 'execute', input: {code: execute[1]}}, delay};
  const call = /\[\[call: (\S+) ([\s\S]*?)\]\]/.exec(prompt);
  if (call) return {reply: {tool: call[1], input: JSON.parse(call[2])}, delay};
  if (prompt.includes('[[question]]')) {
    return {reply: {tool: 'question', input: {questions: [{header: 'Colour', question: 'Red or blue?', multiple: false,
      options: [{label: 'Red', description: 'red'}, {label: 'Blue', description: 'blue'}]}]}}, delay};
  }
  return {reply: {text: 'ok'}, delay};
}

function chunk(id: string, delta: object, finish: string | null): string {
  return `data: ${JSON.stringify({id, object: 'chat.completion.chunk', created: 0, model: 'fake',
    choices: [{index: 0, delta, finish_reason: finish}]})}\n\n`;
}

function respond(response: http.ServerResponse, reply: Reply, stream: boolean): void {
  const id = 'chatcmpl-fake';
  const toolCall = 'tool' in reply
    ? [{index: 0, id: 'call_fake', type: 'function', function: {name: reply.tool, arguments: JSON.stringify(reply.input)}}] : null;
  if (stream) {
    response.writeHead(200, {'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache'});
    response.write(chunk(id, {role: 'assistant', content: toolCall ? null : '' }, null));
    response.write(chunk(id, toolCall ? {tool_calls: toolCall} : {content: (reply as {text: string}).text}, null));
    response.write(chunk(id, {}, toolCall ? 'tool_calls' : 'stop'));
    response.write(`data: ${JSON.stringify({id, object: 'chat.completion.chunk', created: 0, model: 'fake', choices: [],
      usage: {prompt_tokens: 1, completion_tokens: 1, total_tokens: 2}})}\n\n`);
    response.end('data: [DONE]\n\n');
    return;
  }
  response.writeHead(200, {'Content-Type': 'application/json'});
  response.end(JSON.stringify({id, object: 'chat.completion', created: 0, model: 'fake',
    choices: [{index: 0, finish_reason: toolCall ? 'tool_calls' : 'stop', message: toolCall
      ? {role: 'assistant', content: null, tool_calls: toolCall} : {role: 'assistant', content: (reply as {text: string}).text}}],
    usage: {prompt_tokens: 1, completion_tokens: 1, total_tokens: 2}}));
}

export async function startFakeProvider(): Promise<FakeProvider> {
  const requests: unknown[] = [];
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', chunkData => { body += chunkData; });
    request.on('end', () => {
      if (!request.url?.endsWith('/chat/completions')) {
        response.writeHead(404).end('{}');
        return;
      }
      let parsed: {messages?: Message[]; stream?: boolean} = {};
      try { parsed = JSON.parse(body); } catch { /* answered as an empty conversation */ }
      requests.push(parsed);
      const {reply, delay} = script(parsed.messages ?? []);
      setTimeout(() => respond(response, reply, parsed.stream === true), delay);
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as {port: number}).port;
  return {port, requests, close: () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); })};
}

/** The OpenCode `provider` block (v1 and v2 accept it; v2 normalises it to `providers`) and the model id. */
export function providerConfig(port: number): {provider: object; model: string} {
  return {
    provider: {fake: {npm: '@ai-sdk/openai-compatible', name: 'Fake', options: {baseURL: `http://127.0.0.1:${port}/v1`, apiKey: 'x'},
      models: {scripted: {name: 'scripted', tool_call: true}}}},
    model: 'fake/scripted',
  };
}
