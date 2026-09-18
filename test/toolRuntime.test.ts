/**
 * The tool runtime against a fake zulip-js client — DM conversations in
 * fetch_history, reaction suppression on the legacy raw format, and API
 * errors that surface as errors.
 *
 * Run: node --import tsx --test test/toolRuntime.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ZulipToolRuntime, stripSuppressedReactions } from '../src/tool-runtime.ts';
import type { ZulipSession } from '../src/zulip-client.ts';
import { LOCAL_FILES_SUPPORTED, type UploadPolicy } from '../src/uploads.ts';

function runtime(client: Record<string, unknown>): { tools: ZulipToolRuntime; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'zulip-tools-'));
  const session: ZulipSession = { client, selfUserId: 790, realm: 'https://z.example.com', authHeader: '', sessionId: 't' };
  const original = console.error;
  console.error = () => {};
  try {
    return { tools: new ZulipToolRuntime(session, dir), dir };
  } finally {
    console.error = original;
  }
}

test('fetch_history reads a DM conversation by its channel id, the form every catch-up note quotes', async () => {
  const calls: Record<string, unknown>[] = [];
  const client = {
    messages: {
      async retrieve(params: Record<string, unknown>) {
        calls.push(params);
        return { result: 'success', messages: [], found_newest: true, found_oldest: true };
      },
    },
  };
  const { tools, dir } = runtime(client);
  try {
    const dm = await tools.handleToolCall('fetch_history', { channel: 'zulip:dm:7+42', after: 100 });
    assert.deepEqual(calls[0].narrow, [{ operator: 'dm', operand: [7, 42] }]);
    assert.equal(dm.channelId, 'zulip:dm:7+42');
    const stream = await tools.handleToolCall('fetch_history', { channel: '#general', topic: 'deploys' });
    assert.deepEqual(calls[1].narrow, [['stream', 'general'], ['topic', 'deploys']]);
    assert.equal(stream.channelId, 'zulip:general');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('suppressed reactions are withheld from the raw format too', () => {
  const policy = { suppressed: (name: string, code?: string, type?: string) => name === 'biohazard' || (type === 'unicode_emoji' && code === '1f6d1') };
  const stripped = stripSuppressedReactions([
    { id: 1, reactions: [
      { emoji_name: 'biohazard', emoji_code: '2623', reaction_type: 'unicode_emoji', user_id: 1 },
      { emoji_name: 'octagonal_sign', emoji_code: '1f6d1', reaction_type: 'unicode_emoji', user_id: 1 },
      { emoji_name: 'eyes', emoji_code: '1f440', reaction_type: 'unicode_emoji', user_id: 2 },
    ] },
    { id: 2 },
  ], policy);
  assert.deepEqual(stripped[0].reactions, [{ emoji_name: 'eyes', emoji_code: '1f440', reaction_type: 'unicode_emoji', user_id: 2 }]);
  assert.deepEqual(stripped[1], { id: 2 });
});

test('get_channel_history hands the model a raw payload with suppressed reactions removed', async () => {
  const client = {
    messages: {
      async retrieve() {
        return { result: 'success', messages: [{ id: 5, subject: 'x', sender_full_name: 'Ann', content: 'hi', timestamp: 1_700_000_000, reactions: [
          { emoji_name: 'biohazard', emoji_code: '2623', reaction_type: 'unicode_emoji', user_id: 1 },
          { emoji_name: 'eyes', emoji_code: '1f440', reaction_type: 'unicode_emoji', user_id: 2 },
        ] }] };
      },
    },
  };
  const { tools, dir } = runtime(client);
  try {
    tools.setReactionPolicy({ suppressed: (name) => name === 'biohazard' });
    const out = await tools.handleToolCall('get_channel_history', { channel: 'general', format: 'raw', start_date: '2000-01-01', auto_monitor: false });
    assert.doesNotMatch(out.formatted_history, /biohazard/);
    assert.match(out.formatted_history, /eyes/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('find_user and list_emojis report a Zulip API error as an error, never as an empty result', async () => {
  const client = {
    users: { async retrieve() { return { result: 'error', msg: 'Invalid API key' }; } },
    emojis: { async retrieve() { return { result: 'error', msg: 'Invalid API key' }; } },
  };
  const { tools, dir } = runtime(client);
  try {
    await assert.rejects(tools.handleToolCall('find_user', { query: 'ann' }), /Zulip refused listing users: Invalid API key/);
    await assert.rejects(tools.handleToolCall('list_emojis', {}), /Zulip refused listing realm emoji: Invalid API key/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Outbound attachments ──

function fakeUploader() {
  const uploaded: { name: string; bytes: string; mimeType?: string }[] = [];
  const uploader = {
    async upload(i: { name: string; data: Buffer; mimeType?: string }) {
      uploaded.push({ name: i.name, bytes: i.data.toString(), mimeType: i.mimeType });
      return { name: i.name, path: `/user_uploads/1/ab/${i.name}`, url: `https://z.example.com/user_uploads/1/ab/${i.name}` };
    },
  };
  return { uploader, uploaded };
}

function runtimeWithUploads(client: Record<string, unknown>, uploader: { upload: (i: any) => Promise<any> }, roots = new Map<string, string>()) {
  const dir = mkdtempSync(join(tmpdir(), 'zulip-tools-'));
  const session: ZulipSession = { client, selfUserId: 790, realm: 'https://z.example.com', authHeader: 'Basic x', sessionId: 't' };
  const uploadPolicy: UploadPolicy = { roots, maxBytes: 1024, maxTotalBytes: 4096, maxCount: 10 };
  const original = console.error;
  console.error = () => {};
  try {
    return { tools: new ZulipToolRuntime(session, dir, { uploader, uploadPolicy }), dir };
  } finally {
    console.error = original;
  }
}

test('send_message uploads attachments first and links them after the text; content may be empty with files', async () => {
  const sends: Record<string, unknown>[] = [];
  const client = { messages: { async send(p: Record<string, unknown>) { sends.push(p); return { result: 'success', id: 500 + sends.length }; } } };
  const { uploader, uploaded } = fakeUploader();
  const { tools, dir } = runtimeWithUploads(client, uploader);
  const sent: unknown[] = [];
  tools.onSent = (s) => sent.push(s);
  try {
    const res = await tools.handleToolCall('send_message', {
      type: 'stream', to: 'general', topic: 'reports', content: 'weekly numbers',
      attachments: [{ data: Buffer.from('a,b\n1,2').toString('base64'), name: 'numbers.csv', mime_type: 'text/csv' }],
    });
    assert.deepEqual(uploaded, [{ name: 'numbers.csv', bytes: 'a,b\n1,2', mimeType: 'text/csv' }]);
    assert.equal(sends[0].content, 'weekly numbers\n\n[numbers.csv](/user_uploads/1/ab/numbers.csv)');
    assert.equal(res.id, 501);
    assert.deepEqual(res.attachments, [{ name: 'numbers.csv', path: '/user_uploads/1/ab/numbers.csv', url: 'https://z.example.com/user_uploads/1/ab/numbers.csv' }]);
    assert.equal((sent[0] as { content: string }).content, sends[0].content, 'rollback sees the body as sent');

    const onlyFile = await tools.handleToolCall('send_message', { type: 'stream', to: 'general', topic: 'reports', attachments: [{ data: 'aGk=', name: 'hi.txt' }] });
    assert.equal(sends[1].content, '[hi.txt](/user_uploads/1/ab/hi.txt)');
    assert.equal(onlyFile.id, 502);

    await assert.rejects(tools.handleToolCall('send_message', { type: 'stream', to: 'general', topic: 'x' }), /content is required \(or at least one attachment\)/);
    await assert.rejects(tools.handleToolCall('send_message', { type: 'stream', to: 'general', topic: 'x', content: 'x', attachments: [{ data: 'aGk=' }] }), /need a `name`/);
    assert.equal(sends.length, 2, 'a bad attachment sends nothing');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('send_dm resolves recipients, then uploads, then sends with the links; upload_file returns the markdown', async () => {
  const sends: Record<string, unknown>[] = [];
  const client = {
    messages: { async send(p: Record<string, unknown>) { sends.push(p); return { result: 'success', id: 9 }; } },
    users: { async retrieve() { return { result: 'success', members: [{ user_id: 42, full_name: 'Bo', email: 'bo@example.com', is_active: true, is_bot: false }] }; } },
  };
  const { uploader, uploaded } = fakeUploader();
  const { tools, dir } = runtimeWithUploads(client, uploader);
  try {
    const res = await tools.handleToolCall('send_dm', { to: ['42'], content: 'here', attachments: [{ data: 'aGk=', name: 'hi.txt' }] });
    assert.deepEqual(sends[0], { type: 'private', to: [42], content: 'here\n\n[hi.txt](/user_uploads/1/ab/hi.txt)' });
    assert.deepEqual(res.to_user_ids, [42]);
    assert.equal(res.attachments[0].path, '/user_uploads/1/ab/hi.txt');

    const up = await tools.handleToolCall('upload_file', { data: Buffer.from('%PDF').toString('base64'), name: 'doc.pdf', mime_type: 'application/pdf' });
    assert.deepEqual(up, { name: 'doc.pdf', path: '/user_uploads/1/ab/doc.pdf', url: 'https://z.example.com/user_uploads/1/ab/doc.pdf', size: 4, markdown: '[doc.pdf](/user_uploads/1/ab/doc.pdf)' });
    assert.equal(uploaded[1].mimeType, 'application/pdf');
    await assert.rejects(tools.handleToolCall('upload_file', { data: Buffer.alloc(2048).toString('base64'), name: 'big.bin' }), /over the 1KB upload ceiling/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('upload_file and the send tools read local files only through a configured root', { skip: LOCAL_FILES_SUPPORTED ? false : 'local-file attachments are Linux-only' }, async () => {
  const sends: Record<string, unknown>[] = [];
  const client = { messages: { async send(p: Record<string, unknown>) { sends.push(p); return { result: 'success', id: 3 }; } } };
  const { uploader, uploaded } = fakeUploader();
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'zulip-root-')));
  writeFileSync(join(root, 'chart.png'), 'PNG');
  const { tools, dir } = runtimeWithUploads(client, uploader, new Map([['out', root]]));
  try {
    const up = await tools.handleToolCall('upload_file', { file: 'out/chart.png' });
    assert.equal(up.markdown, '[chart.png](/user_uploads/1/ab/chart.png)');
    assert.deepEqual(uploaded[0], { name: 'chart.png', bytes: 'PNG', mimeType: 'image/png' });
    await assert.rejects(tools.handleToolCall('upload_file', { file: join(root, 'chart.png') }), /paths are root-relative/);
    await assert.rejects(tools.handleToolCall('upload_file', { file: 'out/../chart.png' }), /outside upload root/);
    await assert.rejects(tools.handleToolCall('send_message', { type: 'stream', to: 'g', topic: 't', attachments: [{ file: 'home/.zuliprc' }] }), /unknown upload root "home"/);
    assert.equal(sends.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('without a realm there is no uploader: attachments error clearly and plain sends still work', async () => {
  const sends: Record<string, unknown>[] = [];
  const client = { messages: { async send(p: Record<string, unknown>) { sends.push(p); return { result: 'success', id: 1 }; } } };
  const dir = mkdtempSync(join(tmpdir(), 'zulip-tools-'));
  const session: ZulipSession = { client, selfUserId: 790, realm: '', authHeader: '', sessionId: 't' };
  const original = console.error;
  console.error = () => {};
  const tools = new ZulipToolRuntime(session, dir);
  console.error = original;
  try {
    await assert.rejects(tools.handleToolCall('send_message', { type: 'stream', to: 'g', topic: 't', attachments: [{ data: 'aGk=', name: 'a' }] }), /need the realm URL and bot credentials/);
    await assert.rejects(tools.handleToolCall('send_message', { type: 'stream', to: 'g', topic: 't', attachments: [{ file: 'x/y' }] }), /need the realm URL/, 'the uploader is checked before any file is touched');
    await assert.rejects(tools.handleToolCall('upload_file', { file: 'x/y' }), /need the realm URL/);
    await tools.handleToolCall('send_message', { type: 'stream', to: 'g', topic: 't', content: 'ok' });
    await tools.handleToolCall('send_message', { type: 'stream', to: 'g', topic: 't', content: 'ok', attachments: [] });
    assert.equal(sends.length, 2, 'an empty attachments array needs no uploader');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('delete_message notes the id before the call and un-notes it when the call fails (#22)', async () => {
  const noted: string[] = [];
  const failed: string[] = [];
  const { tools } = runtime({
    messages: {
      deleteById: async ({ message_id }: { message_id: number }) =>
        message_id === 7 ? { result: 'error', msg: 'You don\'t have permission to delete this message' } : { result: 'success' },
    },
  });
  tools.onDeleted = (id) => noted.push(id);
  tools.onDeleteFailed = (id) => failed.push(id);
  await tools.handleToolCall('delete_message', { message_id: 5 });
  await assert.rejects(tools.handleToolCall('delete_message', { message_id: 7 }));
  assert.deepEqual(noted, ['5', '7'], 'noted before the call on both');
  assert.deepEqual(failed, ['7'], 'only the refused one is un-noted');
});
