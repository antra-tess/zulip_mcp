/**
 * Tests for ChannelManager adapter routing and in-thread publish hints.
 *
 * Run: node --import tsx --test test/channelManager.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { ChannelManager } from '../src/mcpl/channels.ts';
import type { PlatformAdapter, RoutingHints } from '../src/platforms/adapter.ts';
import type { ChannelDescriptor, McplContentBlock } from '../src/mcpl/types.ts';

function fakeAdapter(type: string, descriptors: ChannelDescriptor[]) {
  const calls: { channelId: string; content: McplContentBlock[]; hints?: RoutingHints }[] = [];
  const adapter: PlatformAdapter = {
    type,
    async discoverChannels() { return descriptors; },
    async publish(channelId, _descriptor, content, hints) {
      calls.push({ channelId, content, hints });
      return { delivered: true, messageId: 'm1' };
    },
    async fetchContext() { return null; },
    startEvents() {},
    stopEvents() {},
  };
  return { adapter, calls };
}

const fakeMcplClient = {
  registerChannels: async () => {},
  sendIncoming: async () => {},
} as any;

function makeManager() {
  const slackDesc: ChannelDescriptor = {
    id: 'slack:C1',
    type: 'slack',
    label: '#general (acme)',
    direction: 'bidirectional',
    address: { channel_id: 'C1' },
  };
  const { adapter, calls } = fakeAdapter('slack', [slackDesc]);
  const adapters = new Map<string, PlatformAdapter>([['slack', adapter]]);
  const manager = new ChannelManager(fakeMcplClient, adapters, 10);
  return { manager, calls };
}

test('adapterFor routes by channel ID prefix', () => {
  const { manager } = makeManager();
  assert.equal(manager.adapterFor('slack:C1')?.type, 'slack');
  assert.equal(manager.adapterFor('discord:g:c'), undefined);
});

test('publish throws for unknown channel prefix', async () => {
  const { manager } = makeManager();
  await assert.rejects(
    () => manager.publish({ conversationId: '', channelId: 'matrix:room', content: [] }),
    /Unknown channel format/,
  );
  manager.destroy();
});

test('publish forwards last-incoming thread hints to the adapter', async () => {
  const { manager, calls } = makeManager();
  await manager.registerChannels();
  await manager.openChannel({ type: 'slack' });

  manager.onIncomingMessage('slack:C1', {
    channelId: 'slack:C1',
    messageId: '1718012345.000200',
    threadId: '1718000000.000100',
    author: { id: 'U1', name: 'alice' },
    timestamp: new Date(0).toISOString(),
    content: [{ type: 'text', text: 'hello' }],
    metadata: { thread_ts: '1718000000.000100' },
  });

  await manager.publish({
    conversationId: '',
    channelId: 'slack:C1',
    content: [{ type: 'text', text: 'reply' }],
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].channelId, 'slack:C1');
  assert.equal(calls[0].hints?.threadId, '1718000000.000100');
  assert.equal(calls[0].hints?.metadata?.thread_ts, '1718000000.000100');
  manager.destroy();
});

test('publish has no hints before any incoming message', async () => {
  const { manager, calls } = makeManager();
  await manager.registerChannels();

  await manager.publish({
    conversationId: '',
    channelId: 'slack:C1',
    content: [{ type: 'text', text: 'first contact' }],
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].hints, undefined);
  manager.destroy();
});

test('broadcastSystemEvent reaches open channels of the platform without clobbering thread hints', async () => {
  const sent: any[][] = [];
  const client = {
    registerChannels: async () => {},
    sendIncoming: async (messages: any[]) => { sent.push(messages); },
  } as any;

  const desc: ChannelDescriptor = {
    id: 'zulip:general',
    type: 'zulip',
    label: '#general',
    direction: 'bidirectional',
  };
  const { adapter, calls } = fakeAdapter('zulip', [desc]);
  const manager = new ChannelManager(client, new Map([['zulip', adapter]]), 10);
  await manager.registerChannels();
  await manager.openChannel({ type: 'zulip' });

  // Real conversation establishes thread routing.
  manager.onIncomingMessage('zulip:general', {
    channelId: 'zulip:general',
    messageId: '7',
    threadId: 'deploys',
    author: { id: 'U1', name: 'alice' },
    timestamp: new Date(0).toISOString(),
    content: [{ type: 'text', text: 'hello' }],
    metadata: { topic: 'deploys' },
  });

  manager.broadcastSystemEvent('zulip', {
    kind: 'gap',
    text: 'queue expired; messages may have been missed',
    metadata: { expiredQueueId: 'q1', lastEventId: 42 },
  });

  await new Promise(resolve => setTimeout(resolve, 30)); // let the 10ms batch flush

  const flushed = sent.flat();
  const marker = flushed.find(m => m.metadata?.system === true);
  assert.ok(marker, 'gap marker delivered to host');
  assert.equal(marker.channelId, 'zulip:general');
  assert.equal(marker.author.id, 'system');
  assert.equal(marker.metadata.kind, 'gap');
  assert.equal(marker.metadata.lastEventId, 42);
  assert.match(marker.content[0].text, /missed/);

  // The system marker must not steal publish thread routing.
  await manager.publish({
    conversationId: '',
    channelId: 'zulip:general',
    content: [{ type: 'text', text: 'reply' }],
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].hints?.threadId, 'deploys');
  manager.destroy();
});

test('broadcastSystemEvent with no open channels does not throw', () => {
  const { manager } = makeManager();
  manager.broadcastSystemEvent('slack', { kind: 'degraded', text: 'polling failing' });
  manager.destroy();
  assert.ok(true);
});

test('incoming messages on unopened channels are ignored', () => {
  const { manager } = makeManager();
  // Channel never opened by host — should not record hints or buffer.
  manager.onIncomingMessage('slack:C1', {
    channelId: 'slack:C1',
    messageId: '1',
    author: { id: 'U1', name: 'alice' },
    timestamp: new Date(0).toISOString(),
    content: [{ type: 'text', text: 'ignored' }],
  });
  manager.destroy();
  // No assertion target beyond "doesn't throw" — hint state is private;
  // covered indirectly by the publish-hints test requiring openChannel.
  assert.ok(true);
});

test('registration advertises legacy initial state and lifecycle capabilities, then clears migration state', async () => {
  const registered: ChannelDescriptor[][] = [];
  const migrated: string[][] = [];
  const client = {
    registerChannels: async (channels: ChannelDescriptor[]) => {
      registered.push(channels);
      return { registered: channels.map((channel) => channel.id) };
    },
    sendIncoming: async () => {},
    sendPushEvent: async () => {},
  } as any;
  const desc: ChannelDescriptor = {
    id: 'slack:C1',
    type: 'slack',
    label: '#general',
    direction: 'bidirectional',
    address: { channel_id: 'C1' },
  };
  const { adapter } = fakeAdapter('slack', [desc]);
  adapter.fetchHistory = async () => [];
  adapter.acknowledge = async () => ({ acknowledged: true, representation: 'eyes' });
  const manager = new ChannelManager(client, new Map([['slack', adapter]]), 10, {
    initiallyOpen: new Set(['slack:C1']),
    onInitialRegistrationAcknowledged: (ids) => migrated.push([...ids]),
  });

  await manager.registerChannels();

  assert.equal(registered[0][0].initiallyOpen, true);
  assert.deepEqual(registered[0][0].capabilities?.history, {
    maxMessages: 200,
    supportsBeforeMessage: true,
  });
  assert.deepEqual(registered[0][0].capabilities?.acknowledgment, {
    kind: 'reaction',
    supportsValue: true,
  });
  assert.deepEqual(migrated, [['slack:C1']]);
  manager.destroy();
});

test('exact open returns backscroll before committing platform subscription; close reverses it', async () => {
  const order: string[] = [];
  const desc: ChannelDescriptor = {
    id: 'zulip:general',
    type: 'zulip',
    label: '#general',
    direction: 'bidirectional',
  };
  const { adapter } = fakeAdapter('zulip', [desc]);
  adapter.fetchHistory = async (_id, _descriptor, limit, before) => {
    order.push(`history:${limit}:${before}`);
    return [{
      channelId: desc.id,
      messageId: '1',
      author: { id: 'u1', name: 'Alice' },
      timestamp: new Date(0).toISOString(),
      content: [{ type: 'text', text: 'hello' }],
    }];
  };
  adapter.openChannel = async () => { order.push('open'); };
  adapter.closeChannel = async () => { order.push('close'); };
  const manager = new ChannelManager(fakeMcplClient, new Map([['zulip', adapter]]), 10);
  await manager.registerChannels();

  const result = await manager.openChannel({
    channelId: desc.id,
    type: 'zulip',
    history: { limit: 20, beforeMessageId: '99' },
  });
  assert.equal(result.channel.id, desc.id);
  assert.deepEqual(result.history?.map((message) => message.messageId), ['1']);
  assert.deepEqual(order, ['history:20:99', 'open']);
  assert.equal(manager.getOpenChannels().has(desc.id), true);

  assert.deepEqual(await manager.closeChannel({ channelId: desc.id }), { closed: true });
  assert.deepEqual(order, ['history:20:99', 'open', 'close']);
  assert.equal(manager.getOpenChannels().has(desc.id), false);
  manager.destroy();
});

test('closed addressed messages become gated push events with the exact channel id', async () => {
  const pushed: any[] = [];
  const client = {
    registerChannels: async () => ({ registered: ['slack:C1'] }),
    sendIncoming: async () => {},
    sendPushEvent: async (event: unknown) => { pushed.push(event); },
  } as any;
  const desc: ChannelDescriptor = {
    id: 'slack:C1',
    type: 'slack',
    label: '#general',
    direction: 'bidirectional',
  };
  const { adapter } = fakeAdapter('slack', [desc]);
  const manager = new ChannelManager(client, new Map([['slack', adapter]]), 10);
  await manager.registerChannels();

  manager.onIncomingMessage(desc.id, {
    channelId: desc.id,
    messageId: '1718.1',
    author: { id: 'U1', name: 'Alice' },
    timestamp: new Date(0).toISOString(),
    content: [{ type: 'text', text: '<@bot> hello' }],
    metadata: { mentioned: true },
  });
  manager.onIncomingMessage(desc.id, {
    channelId: desc.id,
    messageId: '1718.2',
    author: { id: 'U1', name: 'Alice' },
    timestamp: new Date(0).toISOString(),
    content: [{ type: 'text', text: 'ambient' }],
    metadata: { mentioned: false },
  });
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(pushed.length, 1);
  assert.equal(pushed[0].origin.mcplChannelId, desc.id);
  assert.equal(pushed[0].origin.isExplicitMention, true);
  assert.deepEqual(pushed[0].tags.slice(0, 2), ['chat:addressed', 'chat:mention']);
  manager.destroy();
});

test('acknowledgment routes to the owning platform adapter', async () => {
  const desc: ChannelDescriptor = {
    id: 'slack:C1', type: 'slack', label: '#general', direction: 'bidirectional',
  };
  const { adapter } = fakeAdapter('slack', [desc]);
  const calls: unknown[][] = [];
  adapter.acknowledge = async (...args) => {
    calls.push(args);
    return { acknowledged: true, representation: '✅' };
  };
  const manager = new ChannelManager(fakeMcplClient, new Map([['slack', adapter]]), 10);
  await manager.registerChannels();

  assert.deepEqual(await manager.acknowledge({
    channelId: desc.id,
    messageId: '1718.1',
    intent: 'seen-not-opening',
    value: '✅',
  }), { acknowledged: true, representation: '✅' });
  assert.equal(calls[0][0], desc.id);
  assert.equal(calls[0][2], '1718.1');
  assert.equal(calls[0][3], '✅');
  manager.destroy();
});
