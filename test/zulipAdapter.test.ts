/**
 * ZulipAdapter against a fake zulip-js client — what the allowlists do to
 * history reads, what a history page reports about what it scanned, and
 * that opening a channel asks Zulip about the subscription every time.
 *
 * Run: node --import tsx --test test/zulipAdapter.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { ZulipAdapter, type FilterView } from '../src/platforms/zulip.ts';
import type { ZulipRawMessage } from '../src/history.ts';
import type { ChannelDescriptor } from '@animalabs/mcpl-core';

const SELF = 790;

function raw(id: number, over: Partial<ZulipRawMessage> = {}): ZulipRawMessage {
  return {
    id, sender_id: 7, sender_full_name: 'Ann', sender_email: 'ann@example.com',
    display_recipient: 'general', subject: 'deploys', content: `m${id}`, timestamp: 1_700_000_000 + id, type: 'stream', flags: [],
    ...over,
  };
}

function dm(id: number, senderId: number): ZulipRawMessage {
  const people = [
    { id: SELF, full_name: 'Bot', email: 'bot@example.com' },
    { id: 7, full_name: 'Ann', email: 'ann@example.com' },
    { id: 42, full_name: 'Bo', email: 'bo@example.com' },
  ];
  const sender = people.find((p) => p.id === senderId)!;
  return raw(id, { type: 'private', display_recipient: people, sender_id: senderId, sender_full_name: sender.full_name, sender_email: sender.email });
}

function fakeClient(rows: ZulipRawMessage[]) {
  const calls: { retrieve: Record<string, unknown>[]; subscribe: unknown[] } = { retrieve: [], subscribe: [] };
  const client = {
    messages: {
      async retrieve(params: Record<string, unknown>) {
        calls.retrieve.push(params);
        const after = typeof params.anchor === 'number' && params.num_after ? params.anchor : null;
        const matching = rows
          .filter((m) => after === null || m.id > after)
          .filter((m) => {
            const narrow = params.narrow as unknown[][];
            const stream = narrow.find((n) => n[0] === 'stream')?.[1];
            const dmIds = narrow.find((n) => n[0] === 'dm')?.[1] as number[] | undefined;
            if (stream) return m.type === 'stream' && m.display_recipient === stream;
            if (dmIds) return m.type === 'private';
            return true;
          });
        const limit = Number(params.num_after || params.num_before);
        const page = after !== null ? matching.slice(0, limit) : matching.slice(-limit);
        return { result: 'success', messages: page, found_newest: page[page.length - 1] === matching[matching.length - 1], found_oldest: false };
      },
    },
    users: { me: { subscriptions: { add: async (p: unknown) => { calls.subscribe.push(p); return { result: 'success', subscribed: {}, already_subscribed: { 'bot@example.com': ['general'] } }; } } } },
  };
  return { client, calls };
}

const onlyDev: FilterView = { streamAllowed: (s) => s === 'dev', dmAllowed: (u) => u.id === 42 };

test('fetchHistory withholds the bot\'s own messages and disallowed senders, and reports the newest id it scanned', async () => {
  const { client } = fakeClient([raw(1, { sender_id: SELF }), raw(2, { sender_id: SELF }), raw(3), dm(4, 7), dm(5, 42), dm(6, SELF)]);
  const adapter = new ZulipAdapter(client, SELF, 's', { filters: onlyDev });

  // A stream outside the allowlist: nothing, without a fetch.
  const none = await adapter.fetchHistory('zulip:general', { limit: 10 });
  assert.deepEqual(none, { messages: [], scannedThrough: null, reachedNewest: true });

  // A DM conversation: the bot's own and the excluded sender's messages are
  // withheld, but the page scanned through all of them.
  const page = await adapter.fetchHistory('zulip:dm:7+42', { limit: 10, afterMessageId: '3' });
  assert.deepEqual(page.messages.map((m) => m.messageId), ['5']);
  assert.equal(page.scannedThrough, 6, 'the cursor covers the withheld rows');
  assert.equal(page.reachedNewest, true);
  assert.equal((page.messages[0].metadata as { backscroll: boolean }).backscroll, true);

  // A page of nothing but the bot's own messages is not the end of history.
  const allowAll: FilterView = { streamAllowed: () => true, dmAllowed: () => true };
  const wide = new ZulipAdapter(client, SELF, 's', { filters: allowAll });
  const own = await wide.fetchHistory('zulip:general', { limit: 2, afterMessageId: '0' });
  assert.deepEqual(own.messages, []);
  assert.equal(own.scannedThrough, 2);
  assert.equal(own.reachedNewest, false);
});

test('fetchContext injects nothing for a stream outside the allowlist, and only allowed senders of a DM', async () => {
  const { client, calls } = fakeClient([raw(3), dm(4, 7), dm(5, 42), dm(6, SELF)]);
  const adapter = new ZulipAdapter(client, SELF, 's', { filters: onlyDev });
  assert.equal(await adapter.fetchContext('zulip:general', undefined, 5), null);
  assert.equal(calls.retrieve.length, 0, 'not even fetched');
  const injection = await adapter.fetchContext('zulip:dm:7+42', undefined, 5);
  assert.ok(injection);
  assert.match(injection!.content, /Bo: m5/);
  const timed = new ZulipAdapter(client, SELF, 's', { filters: onlyDev, formatTime: () => 'T' });
  const lines = (await timed.fetchContext('zulip:dm:7+42', undefined, 5))!.content.split('\n');
  assert.deepEqual(lines.slice(1), ['[T id=5] [DM] Bo: m5', '[T id=6] [DM] Bot: m6'], 'injected history uses the shared line shape, ids included');
  assert.match(injection!.content, /Bot: m6/, 'the bot\'s own turns stay in context');
  assert.doesNotMatch(injection!.content, /Ann: m4/);
});

test('ensureSubscribed asks Zulip every time — a subscription dropped by unlisten is not remembered as live', async () => {
  const { client, calls } = fakeClient([]);
  const adapter = new ZulipAdapter(client, SELF, 's');
  await adapter.ensureSubscribed('zulip:general');
  await adapter.ensureSubscribed('zulip:general');
  assert.equal(calls.subscribe.length, 2);
  await adapter.ensureSubscribed('zulip:dm:42');
  assert.equal(calls.subscribe.length, 2, 'DMs need nothing');
});

test('publish uploads image blocks and links them after the text; without an uploader they are dropped as before', async () => {
  const sends: Record<string, unknown>[] = [];
  const client = { messages: { async send(p: Record<string, unknown>) { sends.push(p); return { result: 'success', id: 77 }; } } };
  const uploaded: string[] = [];
  const uploader = {
    async upload(i: { name: string; data: Buffer }) {
      uploaded.push(i.name);
      return { name: i.name, path: `/user_uploads/1/${i.name}`, url: `https://z/user_uploads/1/${i.name}` };
    },
  };
  const blocks = [
    { type: 'text' as const, text: 'chart attached' },
    { type: 'image' as const, data: Buffer.from('png').toString('base64'), mimeType: 'image/png' },
  ];

  const uploadPolicy = { roots: new Map<string, string>(), maxBytes: 1024, maxTotalBytes: 4096, maxCount: 10 };
  const withUploads = new ZulipAdapter(client, SELF, 's', { uploader, uploadPolicy });
  const res = await withUploads.publish('zulip:general', undefined, blocks, { threadId: 'deploys' });
  assert.deepEqual(res, { delivered: true, messageId: '77', messageIds: ['77'] });
  assert.deepEqual(uploaded, ['image-2.png']);
  assert.deepEqual(sends[0], { type: 'stream', to: 'general', topic: 'deploys', content: 'chart attached\n\n[image-2.png](/user_uploads/1/image-2.png)' });

  // Only an image: the links are the body.
  await withUploads.publish('zulip:dm:42', undefined, [blocks[1]]);
  assert.deepEqual(sends[1], { type: 'private', to: [42], content: '[image-1.png](/user_uploads/1/image-1.png)' });

  // A failed upload fails the publish before anything is sent.
  const failing = new ZulipAdapter(client, SELF, 's', { uploader: { async upload() { throw new Error('quota'); } }, uploadPolicy });
  await assert.rejects(failing.publish('zulip:general', undefined, blocks), /quota/);
  assert.equal(sends.length, 2);

  const plain = new ZulipAdapter(client, SELF, 's');
  await plain.publish('zulip:general', undefined, blocks);
  assert.equal(sends[2].content, 'chart attached');
  assert.equal((await plain.publish('zulip:general', undefined, [blocks[1]])).delivered, false);
});

// ── Streams joined after startup (#20) ──

/** A client whose event queue delivers `events` once, then parks. `visible`
 *  is what stream discovery answers. */
function eventingClient(rows: ZulipRawMessage[], events: { message: Record<string, unknown>; flags?: string[] }[], visible: { name: string; stream_id: number }[] = []) {
  const { client } = fakeClient(rows);
  let served = false;
  return {
    ...client,
    streams: { retrieve: async () => ({ result: 'success', streams: visible }) },
    queues: { register: async () => ({ queue_id: 'q1', last_event_id: -1 }) },
    events: {
      retrieve: async () => {
        if (served) return new Promise(() => {}); // park: the test is done polling
        served = true;
        return { result: 'success', events: events.map((e, i) => ({ id: i + 1, type: 'message', message: e.message, flags: e.flags ?? [] })) };
      },
    },
  };
}

function streamEvent(id: number, stream: string, streamId: number | undefined, over: Record<string, unknown> = {}) {
  return {
    message: {
      id, sender_id: 7, sender_full_name: 'Ann', sender_email: 'ann@example.com',
      display_recipient: stream, subject: 'incidents', content: 'hello', timestamp: 1_700_000_000,
      type: 'stream', ...(streamId === undefined ? {} : { stream_id: streamId }), ...over,
    },
    flags: ['mentioned'],
  };
}

test('every stream message carries its stream descriptor, so a stream joined after startup can be registered (#20)', async () => {
  const client = eventingClient([], [streamEvent(900, 'ops', 12), streamEvent(901, 'ops', 12), streamEvent(902, 'general', 7)]);
  const adapter = new ZulipAdapter(client, SELF, 's');
  const seen: { channelId: string; descriptor?: string }[] = [];
  adapter.startEvents((m, descriptor) => seen.push({ channelId: m.channelId, descriptor: descriptor?.id }));
  await new Promise((r) => setTimeout(r, 50));
  adapter.stopEvents();

  assert.deepEqual(seen.map((s) => s.channelId), ['zulip:ops', 'zulip:ops', 'zulip:general']);
  // Every message, not just the first: what is already registered is the
  // server's decision, and its registry is cleared on every reconnect.
  assert.deepEqual(seen.map((s) => s.descriptor), ['zulip:ops', 'zulip:ops', 'zulip:general']);
});

test('the descriptor a message carries matches the one discovery builds for the same stream (#20)', async () => {
  const client = eventingClient([], [streamEvent(900, 'general', 7)], [{ name: 'general', stream_id: 7 }]);
  const adapter = new ZulipAdapter(client, SELF, 's');
  const discovered = (await adapter.discoverChannels()).find((c) => c.id === 'zulip:general')!;
  let fromEvent: ChannelDescriptor | undefined;
  adapter.startEvents((_m, descriptor) => { fromEvent = descriptor; });
  await new Promise((r) => setTimeout(r, 50));
  adapter.stopEvents();
  assert.ok(fromEvent);
  assert.equal(fromEvent!.id, discovered.id);
  assert.equal(fromEvent!.label, discovered.label);
  assert.deepEqual(fromEvent!.address, discovered.address);
  assert.deepEqual(fromEvent!.capabilities, discovered.capabilities);
});

test('a descriptor built from an event without a stream_id still addresses the stream (#20)', async () => {
  const client = eventingClient([], [streamEvent(900, 'ops', undefined)]);
  const adapter = new ZulipAdapter(client, SELF, 's');
  const seen: { id: string; address: unknown }[] = [];
  adapter.startEvents((_m, descriptor) => { if (descriptor) seen.push({ id: descriptor.id, address: descriptor.address }); });
  await new Promise((r) => setTimeout(r, 50));
  adapter.stopEvents();
  assert.deepEqual(seen, [{ id: 'zulip:ops', address: { stream_name: 'ops', stream_id: undefined } }]);
});
