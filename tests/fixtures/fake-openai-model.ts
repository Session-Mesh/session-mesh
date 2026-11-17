// A scripted OpenAI-compatible chat endpoint standing in for a model, for tests that run a real agent CLI.
// Usage: node --experimental-strip-types fake-openai-model.ts <port> <request log>
// The last user text decides the reply: "CALL <tool> [json arguments]" calls that tool (an agent_* function of the
// mesh-board MCP server goes through Vibe's run_typescript sandbox, the only way Vibe 3.1 offers MCP tools), a Mesh wake notice calls agent_inbox, anything else is acknowledged.
// After a tool result it answers "RESULT: <start of the result>". Every request is appended to the log.
import fs from 'node:fs';
import http from 'node:http';

const port = Number(process.argv[2]);
const logFile = process.argv[3];
let counter = 0;

type Content = string | {text?: string}[] | null | undefined;
const textOf = (content: Content): string =>
  typeof content === 'string' ? content : Array.isArray(content) ? content.map(part => part.text ?? '').join('') : '';

http.createServer((request, response) => {
  const chunks: Buffer[] = [];
  request.on('data', chunk => chunks.push(chunk));
  request.on('end', () => {
    if ((request.url ?? '').endsWith('/models')) {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({object: 'list', data: [{id: 'fake-model', object: 'model'}]}));
      return;
    }
    let body: {stream?: boolean; messages?: {role?: string; content?: Content}[]; tools?: {function?: {name?: string}}[]} = {};
    try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch { /* an empty probe */ }
    const messages = body.messages ?? [];
    const names = (body.tools ?? []).map(tool => tool.function?.name ?? '');
    const last = messages[messages.length - 1] ?? {};
    fs.appendFileSync(logFile, `${JSON.stringify({tools: names, role: last.role, text: textOf(last.content).slice(0, 400)})}\n`);
    let reply: string | null = null;
    let call: {name: string; args: string} | null = null;
    if (last.role === 'tool') reply = `RESULT: ${textOf(last.content).slice(0, 600)}`;
    else {
      const user = textOf(last.content);
      const wanted = /CALL (\S+)(?: (\{.*\}))?/s.exec(user)?.[1] ?? (user.includes('# Mesh: new message') ? 'agent_inbox' : null);
      if (wanted === null) reply = `ACK ${user.slice(0, 120)}`;
      else {
        const name = names.find(candidate => candidate === wanted);
        const args = /CALL \S+ (\{.*\})/s.exec(user)?.[1] ?? '{}';
        if (name) call = {name, args};
        else if (wanted.startsWith('agent_') && names.includes('run_typescript')) {
          // Vibe reaches MCP servers through its sandbox: tools.<mcp_server>.<function>(arguments).
          const code = `async function main() { return await tools.mcp_mesh_board.${wanted}(${args}); }`;
          call = {name: 'run_typescript', args: JSON.stringify({code})};
        } else reply = `NOTOOL ${wanted} among ${names.join(',')}`;
      }
    }
    const id = `chatcmpl-${++counter}`;
    const usage = {prompt_tokens: 10, completion_tokens: 5, total_tokens: 15};
    const toolCalls = call ? [{id: `call_${counter}`, type: 'function', function: {name: call.name, arguments: call.args}}] : null;
    if (!body.stream) {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({id, object: 'chat.completion', created: 0, model: 'fake-model', usage,
        choices: [{index: 0, finish_reason: call ? 'tool_calls' : 'stop',
          message: call ? {role: 'assistant', content: null, tool_calls: toolCalls} : {role: 'assistant', content: reply}}]}));
      return;
    }
    response.writeHead(200, {'content-type': 'text/event-stream'});
    const send = (value: object) => response.write(`data: ${JSON.stringify({id, object: 'chat.completion.chunk', created: 0, model: 'fake-model', ...value})}\n\n`);
    if (call) {
      send({choices: [{index: 0, finish_reason: null, delta: {role: 'assistant', tool_calls: [{index: 0, ...toolCalls![0]}]}}]});
      send({choices: [{index: 0, delta: {}, finish_reason: 'tool_calls'}], usage});
    } else {
      send({choices: [{index: 0, finish_reason: null, delta: {role: 'assistant', content: reply}}]});
      send({choices: [{index: 0, delta: {}, finish_reason: 'stop'}], usage});
    }
    response.end('data: [DONE]\n\n');
  });
}).listen(port, '127.0.0.1');
