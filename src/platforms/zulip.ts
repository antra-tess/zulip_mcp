/**
 * ZulipAdapter — Zulip implementation of PlatformAdapter.
 *
 * Channel ID format: zulip:{stream_name}
 * Threads map to Zulip topics: incoming messages carry the topic as threadId,
 * and outgoing publishes route to the topic of the most recent incoming
 * message on the channel (falling back to 'mcpl').
 */

import type {
  ChannelDescriptor,
  ChannelIncomingMessage,
  McplContentBlock,
  McplContextInjection,
  McplTextContent,
  ChannelsAcknowledgeResult,
} from '../mcpl/types.js';
import type { PlatformAdapter, PublishResult, RoutingHints, OnIncomingMessage, OnSystemEvent } from './adapter.js';
import { ZulipEventLoop } from './zulip-events.js';
import { cleanContent, extractZulipAttachments } from '../content.js';

export class ZulipAdapter implements PlatformAdapter {
  readonly type = 'zulip';

  private eventLoop: ZulipEventLoop | null = null;

  constructor(
    private zulipClient: any,
    private selfUserId: number | null,
    private sessionId: string,
  ) {}

  async discoverChannels(): Promise<ChannelDescriptor[]> {
    const channels: ChannelDescriptor[] = [];
    try {
      const result = await this.zulipClient.streams.retrieve({
        include_public: true,
        include_subscribed: true,
      });
      const streams = result.streams || [];
      for (const stream of streams) {
        channels.push({
          id: `zulip:${stream.name}`,
          type: 'zulip',
          label: `#${stream.name}`,
          direction: 'bidirectional',
          address: { stream_name: stream.name, stream_id: stream.stream_id },
          metadata: {
            subscriber_count: stream.subscriber_count,
            is_public: !stream.invite_only,
          },
        });
      }
    } catch (error) {
      console.error('Failed to discover Zulip streams:', error);
    }
    return channels;
  }

  async openChannel(channelId: string): Promise<void> {
    const name = channelId.slice('zulip:'.length);
    await this.zulipClient.users.me.subscriptions.add({
      subscriptions: [{ name }],
    });
  }

  async closeChannel(channelId: string, descriptor: ChannelDescriptor): Promise<void> {
    // all_public_streams keeps public-channel events flowing even after the bot
    // leaves, which lets a closed @mention reach the host's wake gate. Private
    // channels have no equivalent: retain membership but close the local MCPL
    // delivery gate so the agent remains addressable there.
    if (descriptor.metadata?.is_public !== true) return;
    const name = channelId.slice('zulip:'.length);
    await this.zulipClient.users.me.subscriptions.remove({
      subscriptions: JSON.stringify([name]),
    });
  }

  async fetchHistory(
    channelId: string,
    _descriptor: ChannelDescriptor,
    limit: number,
    beforeMessageId?: string,
  ): Promise<ChannelIncomingMessage[]> {
    const streamName = channelId.slice('zulip:'.length);
    const anchor = beforeMessageId && /^\d+$/.test(beforeMessageId)
      ? Number(beforeMessageId)
      : 'newest';
    const result = await this.zulipClient.messages.retrieve({
      anchor,
      num_before: limit,
      num_after: 0,
      narrow: [['stream', streamName]],
    });
    return (result.messages ?? [])
      .filter((message: any) => String(message.id) !== beforeMessageId)
      .slice(-limit)
      .sort((a: any, b: any) => a.timestamp - b.timestamp)
      .map((message: any) => this.toIncoming(streamName, message, [], true));
  }

  async acknowledge(
    _channelId: string,
    _descriptor: ChannelDescriptor,
    messageId: string,
    value?: string,
  ): Promise<ChannelsAcknowledgeResult> {
    const representation = value?.trim() || '👀';
    const emojiName = representation === '👀'
      ? 'eyes'
      : representation.replace(/^:|:$/g, '');
    try {
      await this.zulipClient.reactions.add({
        message_id: Number(messageId),
        emoji_name: emojiName,
        reaction_type: 'unicode_emoji',
      });
      return { acknowledged: true, representation };
    } catch (error) {
      return { acknowledged: false, reason: (error as Error).message };
    }
  }

  async publish(
    channelId: string,
    _descriptor: ChannelDescriptor | undefined,
    content: McplContentBlock[],
    hints?: RoutingHints,
  ): Promise<PublishResult> {
    const textContent = content
      .filter((c): c is McplTextContent => c.type === 'text')
      .map(c => c.text)
      .join('\n');
    if (!textContent) return { delivered: false };

    // channelId format: zulip:{stream_name}
    const streamName = channelId.slice('zulip:'.length);

    // Route to the topic of the most recent incoming message on this channel
    // (in-thread answers); fall back to the 'mcpl' topic when the agent
    // initiates the conversation.
    const topic =
      (typeof hints?.metadata?.topic === 'string' ? hints.metadata.topic : undefined) ??
      hints?.threadId ??
      'mcpl';

    const result = await this.zulipClient.messages.send({
      type: 'stream',
      to: streamName,
      topic,
      content: textContent,
    });

    return { delivered: true, messageId: String(result.id) };
  }

  /**
   * Best-effort typing indicator.
   *
   * Routing metadata travels with the notification; the host (via whatever
   * inference logic it uses — most commonly the most recent incoming message
   * on this channel) provides a `topic` key pointing at the active Zulip
   * thread. Falls back to 'mcpl' if the host didn't provide one.
   *
   * Zulip typing events auto-expire server-side (~15s), so there's no stop op;
   * the host refreshes every 7s while inference is active.
   *
   * Note: zulip-js's `typing.send` unconditionally dereferences `params.to.length`,
   * so we must pass `to: []` even for the stream form — otherwise the library
   * throws a TypeError before the HTTP request is made. The Zulip server ignores
   * `to` when `type:'stream'` is set.
   */
  async sendTyping(
    channelId: string,
    descriptor: ChannelDescriptor | undefined,
    metadata: Record<string, unknown> | undefined,
    op: 'start' | 'stop',
  ): Promise<void> {
    const streamId = descriptor?.address?.stream_id as number | undefined;
    if (!streamId) {
      console.error(`[zulip-mcp] sendTyping: no stream_id for ${channelId} (descriptor=${descriptor ? 'present' : 'missing'})`);
      return;
    }

    const topic = typeof metadata?.topic === 'string' ? metadata.topic : 'mcpl';

    try {
      const result = await (this.zulipClient.typing.send as (p: unknown) => Promise<{ result?: string; msg?: string }>)({
        type: 'stream',
        stream_id: streamId,
        topic,
        op,
        to: [],
      });
      if (result?.result && result.result !== 'success') {
        console.error(`[zulip-mcp] typing.send(${op}) non-success: ${result.result} ${result.msg ?? ''}`);
      }
    } catch (err) {
      // Best-effort — swallow errors so typing never breaks the agent.
      console.error(`[zulip-mcp] typing.send(${op}) failed:`, (err as Error).message);
    }
  }

  async fetchContext(
    channelId: string,
    _descriptor: ChannelDescriptor | undefined,
    historySize: number,
  ): Promise<McplContextInjection | null> {
    const streamName = channelId.slice('zulip:'.length);

    const result = await this.zulipClient.messages.retrieve({
      anchor: 'newest',
      num_before: historySize,
      num_after: 0,
      narrow: [['stream', streamName]],
    });

    const messages = result.messages || [];
    if (messages.length === 0) return null;

    const formatted = messages.map((msg: any) => {
      const time = new Date(msg.timestamp * 1000).toLocaleTimeString('en-US', {
        hour: '2-digit', minute: '2-digit',
      });
      const content = cleanContent(msg.content);
      return `[${time}] [${msg.subject}] ${msg.sender_full_name}: ${content}`;
    }).join('\n');

    return {
      namespace: `zulip:${streamName}`,
      position: 'beforeUser',
      content: `Recent messages from Zulip #${streamName}:\n${formatted}`,
    };
  }

  startEvents(onMessage: OnIncomingMessage, onSystemEvent?: OnSystemEvent): void {
    this.eventLoop = new ZulipEventLoop();
    this.eventLoop.start(this.zulipClient, (streamName, msg, flags) => {
      if (this.selfUserId !== null && msg.sender_id === this.selfUserId) return;
      onMessage(this.toIncoming(streamName, msg, flags, false));
    }, onSystemEvent).catch(error => {
      console.error('Zulip event loop failed:', error);
    });
  }

  stopEvents(): void {
    this.eventLoop?.stop();
    this.eventLoop = null;
  }

  private toIncoming(
    streamName: string,
    msg: any,
    flags: string[],
    backscroll: boolean,
  ): ChannelIncomingMessage {
    const cleaned = cleanContent(msg.content);
    const attachments = extractZulipAttachments(msg.content);
    const content: McplTextContent[] = [{ type: 'text', text: cleaned }];
    if (attachments.length > 0) {
      const lines = attachments.map(a =>
        `- ${a.name} (${a.mimeType})${a.isImage ? ' — image, fetchable via fetch_attachment' : ''}: ${a.path}`,
      );
      content.push({
        type: 'text',
        text: `[attachments: ${attachments.length}]\n${lines.join('\n')}`,
      });
    }
    return {
      channelId: `zulip:${streamName}`,
      messageId: String(msg.id),
      threadId: msg.subject || undefined,
      author: { id: String(msg.sender_id), name: msg.sender_full_name },
      timestamp: new Date(msg.timestamp * 1000).toISOString(),
      content,
      metadata: {
        senderEmail: msg.sender_email,
        topic: msg.subject,
        mentioned: flags.includes('mentioned'),
        botUserId: this.selfUserId !== null ? String(this.selfUserId) : this.sessionId,
        ...(backscroll ? { backscroll: true } : {}),
        ...(attachments.length > 0 ? { attachments } : {}),
      },
    };
  }
}
