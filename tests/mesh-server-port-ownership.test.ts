import assert from 'node:assert/strict';
import net from 'node:net';
import test from 'node:test';
import {OWNER_CHECK} from './helpers/listener-owner.ts';
import {removeScratch, runServer, scratchHome, stopServer} from './mesh-server-lib.ts';

test('the spawned server is recognized when it owns the port', {skip: !OWNER_CHECK}, async () => {
  const where = await scratchHome('port-owner-');
  try {
    const result = await runServer(where);
    try { assert.equal(result.result.listened, true, result.result.output); }
    finally { await stopServer(result.child); }
  } finally { removeScratch(where.scratch); }
});

test('an unrelated listener is not mistaken for the spawned server', {skip: !OWNER_CHECK}, async () => {
  const where = await scratchHome('port-owner-');
  const listener = net.createServer(socket => socket.end());
  await new Promise<void>(resolve => listener.listen(where.port, '127.0.0.1', resolve));
  try {
    const result = await runServer(where);
    try {
      assert.equal(result.result.listened, false, result.result.output);
      assert.match(result.result.output, /address already in use|address.*in use/i);
    }
    finally { await stopServer(result.child); }
  } finally {
    await new Promise<void>(resolve => listener.close(() => resolve()));
    removeScratch(where.scratch);
  }
});
