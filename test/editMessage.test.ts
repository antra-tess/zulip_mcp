import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import zulipInit from 'zulip-js';
import { ZulipToolRuntime } from '../src/tool-runtime.ts';

/** Exercise the real client and runtime against a local HTTP stand-in. */
async function fixture(response: unknown, status = 200) {
  const calls: { method?: string; path?: string; body: string; auth?: string; contentType?: string }[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    calls.push({
      method: req.method, path: req.url, body: Buffer.concat(chunks).toString(),
      auth: req.headers.authorization, contentType: req.headers['content-type'],
    });
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(response));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const realm = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const client = await zulipInit({ realm, username: 'test@example.com', apiKey: 'test-key' });
  const authHeader = `Basic ${Buffer.from('test@example.com:test-key').toString('base64')}`;
  const dir = mkdtempSync(join(tmpdir(), 'zulip-edit-'));
  const tools = new ZulipToolRuntime({ client, realm, authHeader, selfUserId: 1, sessionId: 'test' }, dir);
  return {
    tools, calls, authHeader,
    async close() {
      server.close();
      server.closeAllConnections();
      await once(server, 'close');
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('edit_message PATCHes the id in the path and only content in the form body', async () => {
  const response = { result: 'success', msg: '', ignored_parameters_unsupported: [] };
  const f = await fixture(response);
  try {
    const content = 'Updated **text** & + = \n✓';
    assert.deepEqual(await f.tools.handleToolCall('edit_message', { message_id: 42, content, extra: 'not sent' }), response);
    assert.deepEqual(f.calls, [{
      method: 'PATCH', path: '/api/v1/messages/42',
      body: new URLSearchParams({ content }).toString(), auth: f.authHeader,
      contentType: 'application/x-www-form-urlencoded;charset=UTF-8',
    }]);
  } finally {
    await f.close();
  }
});

test('edit_message rejects success responses with any unsupported parameters', async () => {
  for (const parameter of ['message_id', 'content', 'future_field']) {
    const f = await fixture({ result: 'success', msg: '', ignored_parameters_unsupported: [parameter] });
    try {
      await assert.rejects(
        f.tools.handleToolCall('edit_message', { message_id: 42, content: 'updated' }),
        new RegExp(`editing message 42.*ignored_parameters_unsupported.*${parameter}`),
      );
    } finally {
      await f.close();
    }
  }
});

test('edit_message preserves Zulip API errors', async () => {
  const f = await fixture({ result: 'error', msg: 'Message edit time limit exceeded' }, 400);
  try {
    await assert.rejects(f.tools.handleToolCall('edit_message', { message_id: 42, content: 'updated' }), /Message edit time limit exceeded/);
  } finally {
    await f.close();
  }
});

test('edit_message rejects HTTP errors even without a Zulip error result', async () => {
  const f = await fixture({}, 503);
  try {
    await assert.rejects(f.tools.handleToolCall('edit_message', { message_id: 42, content: 'updated' }), /HTTP 503/);
  } finally {
    await f.close();
  }
});
