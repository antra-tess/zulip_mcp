import test from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingChannelMessage } from '@animalabs/mcpl-core';
import { ZulipAdapter } from '../src/platforms/zulip.ts';
import type { ZulipRawMessage } from '../src/history.ts';

const SELF = 100;
const QUOTED = 200;

function raw(id: number, content: string, over: Partial<ZulipRawMessage> = {}): ZulipRawMessage {
  return {
    id, content, sender_id: 101, sender_full_name: 'User', sender_email: 'user@example.invalid',
    display_recipient: 'general', subject: 'topic', timestamp: 1_700_000_000,
    type: 'stream', flags: [], ...over,
  };
}

function quote(id = QUOTED, namedUser = SELF): string {
  return `@_**User|${namedUser}** [said](/#narrow/channel/1-general/near/${id}):\n\n\`\`\`quote\noriginal\n\`\`\`\nreply`;
}

/** Exercise the real queue -> adapter -> incoming-message path. */
async function receive(
  rows: ZulipRawMessage[],
  getById: (params: Record<string, unknown>) => Promise<unknown>,
  selfUserId: number | null = SELF,
): Promise<IncomingChannelMessage[]> {
  const received: IncomingChannelMessage[] = [];
  const sentinel = 999;
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => { finish = resolve; });
  let served = false;
  const client = {
    messages: { getById },
    queues: { register: async () => ({ queue_id: 'q', last_event_id: -1 }) },
    events: { retrieve: async () => {
      if (served) return new Promise(() => {});
      served = true;
      return { result: 'success', events: [...rows, raw(sentinel, 'done')].map((message, i) => ({
        id: i + 1, type: 'message', message, flags: message.flags ?? [],
      })) };
    } },
  };
  const adapter = new ZulipAdapter(client, selfUserId, 'session');
  adapter.startEvents((message) => {
    if (message.messageId === String(sentinel)) finish();
    else received.push(message);
  });
  try {
    await finished;
    return received;
  } finally {
    adapter.stopEvents();
  }
}

test('own-message quote sets the mention verdict in a stream', { timeout: 2000 }, async () => {
  const calls: Record<string, unknown>[] = [];
  // The silent mention's id is deliberately not SELF: the quoted sender decides.
  const messages = await receive([raw(300, quote(QUOTED, 102))], async (params) => {
    calls.push(params);
    return { result: 'success', message: raw(QUOTED, 'original', { sender_id: SELF }) };
  });
  assert.equal(messages[0].metadata?.mentioned, true);
  assert.ok(messages[0].tags?.includes('chat:mention'));
  assert.deepEqual(calls, [{ message_id: QUOTED, apply_markdown: false }]);
});

test('group DMs stay addressed without any quote lookup', { timeout: 2000 }, async () => {
  let gets = 0;
  const rows = [quote(), `@_**User|${SELF}** hello`, quote(201), 'plain message'].map((content, i) => raw(300 + i, content, {
    type: 'private', display_recipient: [SELF, 101, 102].map((id) => ({ id, full_name: 'User', email: `${id}@example.invalid` })),
  }));
  const messages = await receive(rows, async () => { gets++; throw new Error('unexpected GET'); });
  assert.equal(messages.length, rows.length);
  for (const message of messages) {
    assert.equal(message.metadata?.isDM, true);
    assert.equal(message.metadata?.mentioned, false);
    assert.ok(message.tags?.includes('chat:dm'));
  }
  assert.equal(gets, 0);
});

test('quote authors already seen locally need no GET; self messages remain ignored', { timeout: 2000 }, async () => {
  let gets = 0;
  const messages = await receive([
    raw(QUOTED, quote(), { sender_id: SELF }),
    raw(300, quote()),
  ], async () => { gets++; throw new Error('unexpected GET'); });
  assert.deepEqual(messages.map((m) => m.messageId), ['300']);
  assert.equal(messages[0].metadata?.mentioned, true);
  assert.equal(gets, 0);
});

for (const [label, content] of [
  ['silent mention only', `@_**User|${SELF}** hello`],
  ['unrelated near link', `[message](/#narrow/channel/1-general/near/${QUOTED})`],
  ['said link without quote', quote().replace('```quote', '```text')],
  ['intervening text', quote().replace(':\n\n', ':\nnot a quote header\n')],
  ['quote syntax inside a code example', `\`\`\`\`text\n${quote()}\n\`\`\`\``],
  ['near link elsewhere before a different quote', `[message](/#narrow/near/${QUOTED})\n${quote(201)}`],
] as const) {
  test(`${label} does not address the connector`, { timeout: 2000 }, async () => {
    const calls: Record<string, unknown>[] = [];
    const messages = await receive([raw(300, content)], async (params) => {
      calls.push(params);
      return { result: 'success', message: raw(Number(params.message_id), 'original') };
    });
    assert.equal(messages[0].metadata?.mentioned, false);
    assert.ok(messages[0].tags?.includes('chat:ambient'));
    assert.deepEqual(calls, label === 'near link elsewhere before a different quote'
      ? [{ message_id: 201, apply_markdown: false }] : []);
  });
}

test('a quote of another sender is not addressed even when the silent mention names self', { timeout: 2000 }, async () => {
  const messages = await receive([raw(300, quote())], async () => ({ result: 'success', message: raw(QUOTED, 'original') }));
  assert.equal(messages[0].metadata?.mentioned, false);
  assert.ok(messages[0].tags?.includes('chat:ambient'));
});

for (const failure of ['throw', 'deleted', 'missing'] as const) {
  test(`quote lookup fails closed on ${failure}, without retrying or losing later events`, { timeout: 2000 }, async () => {
    let gets = 0;
    const messages = await receive([raw(300, quote()), raw(301, 'later')], async () => {
      gets++;
      if (failure === 'throw') throw new Error('unavailable');
      return failure === 'deleted' ? { result: 'error', msg: 'not found' } : { result: 'success' };
    });
    assert.deepEqual(messages.map((m) => m.messageId), ['300', '301']);
    assert.equal(messages[0].metadata?.mentioned, false);
    assert.equal(gets, 1);
  });
}

test('unknown self identity makes no quote lookup', { timeout: 2000 }, async () => {
  let gets = 0;
  const messages = await receive([raw(300, quote())], async () => { gets++; return {}; }, null);
  assert.equal(messages[0].metadata?.mentioned, false);
  assert.equal(gets, 0);
});

test('multiple quotes resolve only their own headers, once per id, in delivery order', { timeout: 2000 }, async () => {
  const calls: number[] = [];
  const messages = await receive([
    raw(300, `${quote(201)}\n${quote(201)}\n${quote()}`), raw(301, 'later'),
  ], async (params) => {
    const id = Number(params.message_id);
    calls.push(id);
    await new Promise((resolve) => setTimeout(resolve, 5));
    if (id === 201) throw new Error('unavailable');
    return { result: 'success', message: raw(QUOTED, 'original', { sender_id: SELF }) };
  });
  assert.deepEqual(calls, [201, QUOTED]);
  assert.deepEqual(messages.map((m) => m.messageId), ['300', '301']);
  assert.equal(messages[0].metadata?.mentioned, true);
});

test('absolute quote links, CRLF and longer quote fences are recognized', { timeout: 2000 }, async () => {
  const content = quote().replace('](/', '](https://example.invalid/').replaceAll('```', '````').replaceAll('\n', '\r\n');
  const messages = await receive([raw(300, content)], async () => ({
    result: 'success', message: raw(QUOTED, 'original', { sender_id: SELF }),
  }));
  assert.equal(messages[0].metadata?.mentioned, true);
});

test('an existing mention needs no quote lookup and retains its addressing', { timeout: 2000 }, async () => {
  let gets = 0;
  const messages = await receive([raw(300, quote(), { flags: ['mentioned'] })], async () => { gets++; return {}; });
  assert.equal(messages[0].metadata?.mentioned, true);
  assert.ok(messages[0].tags?.includes('chat:mention'));
  assert.equal(gets, 0);
});
