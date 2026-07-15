import test from 'node:test';
import assert from 'node:assert/strict';
import { SlackAdapter } from '../src/platforms/slack.ts';
import { ZulipAdapter } from '../src/platforms/zulip.ts';
import type { ChannelDescriptor } from '../src/mcpl/types.ts';

const publicZulip: ChannelDescriptor = {
  id: 'zulip:general',
  type: 'zulip',
  label: '#general',
  direction: 'bidirectional',
  metadata: { is_public: true },
};

test('Zulip lifecycle subscribes on open, leaves public streams on close, and retains private access', async () => {
  const added: unknown[] = [];
  const removed: unknown[] = [];
  const client = {
    users: { me: { subscriptions: {
      add: async (params: unknown) => { added.push(params); return {}; },
      remove: async (params: unknown) => { removed.push(params); return {}; },
    } } },
  } as any;
  const adapter = new ZulipAdapter(client, 7, 'session');

  await adapter.openChannel(publicZulip.id);
  await adapter.closeChannel(publicZulip.id, publicZulip);
  await adapter.closeChannel('zulip:private', {
    ...publicZulip,
    id: 'zulip:private',
    label: '#private',
    metadata: { is_public: false },
  });

  assert.deepEqual(added, [{ subscriptions: [{ name: 'general' }] }]);
  assert.deepEqual(removed, [{ subscriptions: JSON.stringify(['general']) }]);
});

test('Zulip backscroll honors the anchor and acknowledgment uses a reaction', async () => {
  const retrieves: any[] = [];
  const reactions: any[] = [];
  const client = {
    messages: {
      retrieve: async (params: unknown) => {
        retrieves.push(params);
        return { messages: [
          { id: 2, sender_id: 2, sender_full_name: 'Bob', sender_email: 'b@example.test', subject: 'topic', content: '<p>two</p>', timestamp: 2 },
          { id: 1, sender_id: 1, sender_full_name: 'Alice', sender_email: 'a@example.test', subject: 'topic', content: '<p>one</p>', timestamp: 1 },
          { id: 99, sender_id: 3, sender_full_name: 'Anchor', sender_email: 'x@example.test', subject: 'topic', content: '<p>anchor</p>', timestamp: 3 },
        ] };
      },
    },
    reactions: { add: async (params: unknown) => { reactions.push(params); return {}; } },
  } as any;
  const adapter = new ZulipAdapter(client, 7, 'session');

  const history = await adapter.fetchHistory(publicZulip.id, publicZulip, 20, '99');
  assert.deepEqual(history.map((message) => message.messageId), ['1', '2']);
  assert.equal(retrieves[0].anchor, 99);
  assert.equal(history[0].metadata?.backscroll, true);
  assert.deepEqual(
    await adapter.acknowledge(publicZulip.id, publicZulip, '2'),
    { acknowledged: true, representation: '👀' },
  );
  assert.deepEqual(reactions, [{
    message_id: 2,
    emoji_name: 'eyes',
    reaction_type: 'unicode_emoji',
  }]);
});

test('Slack returns anchored backscroll and posts acknowledgment reactions', async () => {
  const historyCalls: any[] = [];
  const reactionCalls: any[] = [];
  const web = {
    conversations: {
      history: async (params: unknown) => {
        historyCalls.push(params);
        return { messages: [
          { ts: '2.0', user: 'U2', text: 'two' },
          { ts: '1.0', user: 'U1', text: 'one' },
        ] };
      },
    },
    users: {
      info: async ({ user }: { user: string }) => ({ user: { name: user.toLowerCase() } }),
    },
    reactions: {
      add: async (params: unknown) => { reactionCalls.push(params); return {}; },
    },
  } as any;
  const socket = { on() {}, async start() {}, async disconnect() {} } as any;
  const descriptor: ChannelDescriptor = {
    id: 'slack:C1', type: 'slack', label: '#general', direction: 'bidirectional',
  };
  const adapter = new SlackAdapter(web, socket, 'UBOT', 'acme');

  const history = await adapter.fetchHistory(descriptor.id, descriptor, 20, '3.0');
  assert.deepEqual(history.map((message) => message.messageId), ['1.0', '2.0']);
  assert.deepEqual(historyCalls, [{ channel: 'C1', limit: 20, latest: '3.0', inclusive: false }]);
  assert.deepEqual(
    await adapter.acknowledge(descriptor.id, descriptor, '2.0', ':white_check_mark:'),
    { acknowledged: true, representation: ':white_check_mark:' },
  );
  assert.deepEqual(reactionCalls, [{ channel: 'C1', timestamp: '2.0', name: 'white_check_mark' }]);
});
