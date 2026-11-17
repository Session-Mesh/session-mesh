// A stand-in for the board bridge (mesh-board-mcp), for the real-OpenCode tests: a stdio MCP server with one
// tool, agent_peers, whose answer has the peer in structuredContent only. Every request, and the Mesh variables
// of its environment, are appended to the file named by STUB_LOG, so a test sees which process started the
// bridge, with which token, and which tools were called.
import fs from 'node:fs';
import readline from 'node:readline';

const log = process.env.STUB_LOG;
const note = (entry) => { if (log) fs.appendFileSync(log, `${JSON.stringify(entry)}\n`); };
note({started: true, token: process.env.MESH_SESSION_TOKEN ?? null, port: process.env.MESH_PORT ?? null,
  session: process.env.MESH_SESSION ?? null, confDir: process.env.MESH_CONF_DIR ?? null});
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
readline.createInterface({input: process.stdin}).on('line', (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  note({method: message.method});
  if (message.method === 'initialize') {
    send({jsonrpc: '2.0', id: message.id, result: {protocolVersion: message.params?.protocolVersion ?? '2025-06-18',
      capabilities: {tools: {}}, serverInfo: {name: 'fake-board', version: '0'}}});
  } else if (message.method === 'tools/list') {
    send({jsonrpc: '2.0', id: message.id, result: {tools: [{name: 'agent_peers',
      description: 'List the peer agents of this session.', inputSchema: {type: 'object', properties: {}}}]}});
  } else if (message.method === 'tools/call') {
    send({jsonrpc: '2.0', id: message.id, result: {content: [{type: 'text', text: 'Peers listed: see structured result.'}],
      structuredContent: {peers: [{name: 'zebra-peer-42'}]}}});
  } else if (message.id !== undefined) {
    send({jsonrpc: '2.0', id: message.id, result: {}});
  }
});
