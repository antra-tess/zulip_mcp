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
    res.writeHead(status, { 'Content-Type': typeof response === 'string' ? 'text/html' : 'application/json' });
    res.end(typeof response === 'string' ? response : JSON.stringify(response));
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
    await assert.rejects(f.tools.handleToolCall('edit_message', { message_id: 42, content: 'updated' }), /HTTP 400.*Message edit time limit exceeded/);
  } finally {
    await f.close();
  }
});

test('edit_message reports the status and a safe snippet for HTML HTTP errors', async () => {
  const auth = Buffer.from('test@example.com:test-key').toString('base64');
  const f = await fixture(`<html>Service unavailable: Basic ${auth} test-key ${'x'.repeat(500)}</html>`, 503);
  try {
    await assert.rejects(f.tools.handleToolCall('edit_message', { message_id: 42, content: 'updated' }), (error: Error) => {
      assert.match(error.message, /HTTP 503.*Service unavailable/);
      assert.ok(!error.message.includes(auth));
      assert.doesNotMatch(error.message, /test-key|test@example.com/);
      assert.ok(error.message.length < 250, 'the response snippet is bounded');
      return true;
    });
  } finally {
    await f.close();
  }
});

test('edit_message rejects missing or non-string content without making a request', async () => {
  const f = await fixture({ result: 'success', msg: '' });
  try {
    for (const args of [{ message_id: 42 }, ...[null, 123, false, {}].map(content => ({ message_id: 42, content }))]) {
      await assert.rejects(f.tools.handleToolCall('edit_message', args), /^Error: content is required$/);
      assert.deepEqual(f.calls, []);
    }
  } finally {
    await f.close();
  }
});

test('edit_message reports the HTTP status for an empty error body', async () => {
  const f = await fixture('', 502);
  try {
    await assert.rejects(f.tools.handleToolCall('edit_message', { message_id: 42, content: 'updated' }), /HTTP 502/);
  } finally {
    await f.close();
  }
});
