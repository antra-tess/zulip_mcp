/**
 * Channel Manager — Maps platform channels to MCPL channels.
 *
 * Platform-agnostic: routes every operation to a PlatformAdapter by the
 * channel ID prefix (the part before the first ':'). Channel ID formats are
 * owned by the adapters (e.g. zulip:{stream_name}, discord:{guildId}:{channelId},
 * slack:{channelId}).
 *
 * Handles registration, open/close lifecycle, incoming message batching,
 * publish routing (with last-incoming thread tracking for in-thread replies),
 * and channel listing.
 */

import type {
  ChannelDescriptor,
  ChannelIncomingMessage,
  ChannelsPublishParams,
  ChannelsOpenParams,
  ChannelsOpenResult,
  ChannelsCloseParams,
  ChannelsCloseResult,
  ChannelsAcknowledgeParams,
  ChannelsAcknowledgeResult,
  ChannelsListResult,
} from './types.js';
import type { McplClient } from './client.js';
import type { PlatformAdapter, PlatformSystemEvent, RoutingHints } from '../platforms/adapter.js';

const DEFAULT_BATCH_WINDOW_MS = 500;
const DEFAULT_MAX_HISTORY = 200;

export interface ChannelManagerOptions {
  /** Legacy file-backed monitoring state, used only as a Chronicle bootstrap. */
  initiallyOpen?: ReadonlySet<string>;
  /** Called only after the host acknowledges the initial channels/register. */
  onInitialRegistrationAcknowledged?: (registeredChannelIds: ReadonlySet<string>) => void;
}

export class ChannelManager {
  private allChannels = new Map<string, ChannelDescriptor>();
  private openChannels = new Set<string>();
  private batchBuffer = new Map<string, ChannelIncomingMessage[]>();
  private batchTimer: ReturnType<typeof setTimeout> | null = null;
  private batchWindowMs: number;
  /** Per-channel routing hints from the most recent incoming message,
   *  so publishes can land in the active thread/topic. */
  private lastIncoming = new Map<string, RoutingHints>();

  constructor(
    private mcplClient: McplClient,
    private adapters: Map<string, PlatformAdapter>,
    batchWindowMs?: number,
    private options: ChannelManagerOptions = {},
  ) {
    this.batchWindowMs = batchWindowMs ?? DEFAULT_BATCH_WINDOW_MS;
  }

  /**
   * Discover all available channels across adapters and register them with the host.
   */
  async registerChannels(): Promise<void> {
    const channels: ChannelDescriptor[] = [];

    for (const adapter of this.adapters.values()) {
      try {
        const discovered = await adapter.discoverChannels();
        for (const raw of discovered) {
          const descriptor: ChannelDescriptor = {
            ...raw,
            initiallyOpen: this.options.initiallyOpen?.has(raw.id) === true,
            capabilities: {
              ...(adapter.fetchHistory ? {
                history: { maxMessages: DEFAULT_MAX_HISTORY, supportsBeforeMessage: true },
              } : {}),
              ...(adapter.acknowledge ? {
                acknowledgment: { kind: 'reaction', supportsValue: true },
              } : {}),
            },
          };
          channels.push(descriptor);
          this.allChannels.set(descriptor.id, descriptor);
        }
      } catch (error) {
        console.error(`Failed to discover ${adapter.type} channels:`, error);
      }
    }

    if (channels.length > 0) {
      try {
        await this.mcplClient.registerChannels(channels);
        this.options.onInitialRegistrationAcknowledged?.(
          new Set(channels.map((channel) => channel.id)),
        );
        console.error(`Registered ${channels.length} channels with host`);
      } catch (error) {
        console.error('Failed to register channels:', error);
        throw error;
      }
    }
  }

  /**
   * Handle channels/open from the host.
   */
  async openChannel(params: ChannelsOpenParams): Promise<ChannelsOpenResult> {
    const exact = params.channelId ? this.allChannels.get(params.channelId) : undefined;
    const descriptor = exact ?? Array.from(this.allChannels.values()).find((candidate) => {
      if (candidate.type !== params.type) return false;
      return !params.address ||
        Object.entries(params.address).every(([k, v]) => candidate.address?.[k] === v);
    });
    if (!descriptor) throw new Error(`No channel found matching type=${params.type}`);

    const adapter = this.adapterFor(descriptor.id);
    if (!adapter) throw new Error(`No adapter for channel ${descriptor.id}`);
    const result: ChannelsOpenResult = { channel: descriptor };
    const requested = params.history?.limit ?? 0;
    if (requested > 0 && adapter.fetchHistory) {
      const limit = Math.min(DEFAULT_MAX_HISTORY, Math.max(0, Math.floor(requested)));
      result.history = await adapter.fetchHistory(
        descriptor.id,
        descriptor,
        limit,
        params.history?.beforeMessageId,
      );
      result.historyTruncated = requested > limit;
    }

    // History and platform subscription are atomic from the host's point of
    // view: do not mark open if either operation fails.
    await adapter.openChannel?.(descriptor.id, descriptor);
    this.openChannels.add(descriptor.id);
    return result;
  }

  /**
   * Handle channels/close from the host.
   */
  async closeChannel(params: ChannelsCloseParams): Promise<ChannelsCloseResult> {
    const descriptor = this.allChannels.get(params.channelId);
    if (!descriptor) return { closed: false };
    const adapter = this.adapterFor(params.channelId);
    await adapter?.closeChannel?.(params.channelId, descriptor);
    this.openChannels.delete(params.channelId);
    return { closed: true };
  }

  async acknowledge(params: ChannelsAcknowledgeParams): Promise<ChannelsAcknowledgeResult> {
    const descriptor = this.allChannels.get(params.channelId);
    if (!descriptor) return { acknowledged: false, reason: `Unknown channel ${params.channelId}` };
    const adapter = this.adapterFor(params.channelId);
    if (!adapter?.acknowledge) {
      return { acknowledged: false, reason: `Acknowledgment is not supported for ${descriptor.type}` };
    }
    return adapter.acknowledge(params.channelId, descriptor, params.messageId, params.value);
  }

  /**
   * Handle channels/list from the host.
   */
  listChannels(): ChannelsListResult {
    return { channels: Array.from(this.allChannels.values()) };
  }

  /**
   * Called when a new message arrives from a platform.
   * Buffers messages and flushes in batches.
   */
  onIncomingMessage(channelId: string, message: ChannelIncomingMessage): void {
    if (!this.openChannels.has(channelId)) {
      this.pushClosedAddressedMessage(channelId, message);
      return;
    }

    // Remember where the conversation is, so publishes reply in-thread.
    this.lastIncoming.set(channelId, {
      threadId: message.threadId,
      metadata: message.metadata,
    });

    this.enqueue(channelId, message);
  }

  /**
   * Broadcast a platform system event (delivery gap, degraded polling) to
   * every open channel of that platform as a synthetic incoming message, so
   * the host/agent learns about it instead of it dying in stderr.
   *
   * Deliberately does NOT update lastIncoming: a system marker must not
   * clobber the thread/topic routing hints of the real conversation.
   */
  broadcastSystemEvent(platformType: string, event: PlatformSystemEvent): void {
    const prefix = `${platformType}:`;
    const targets = Array.from(this.openChannels).filter(id => id.startsWith(prefix));

    if (targets.length === 0) {
      // No open channel to carry the marker — at least leave a trace.
      console.error(`[system:${platformType}] ${event.kind}: ${event.text} (no open channels to notify)`);
      return;
    }

    const timestamp = new Date().toISOString();
    for (const channelId of targets) {
      this.enqueue(channelId, {
        channelId,
        messageId: `system:${platformType}:${event.kind}:${Date.now()}`,
        author: { id: 'system', name: `${platformType} connection` },
        timestamp,
        content: [{ type: 'text', text: event.text }],
        // Spread adapter metadata FIRST so it can never clobber the
        // discriminators consumers filter on (system / kind).
        metadata: { ...event.metadata, system: true, kind: event.kind },
      });
    }
  }

  /**
   * Handle channels/publish from the host — route to the owning adapter.
   */
  async publish(params: ChannelsPublishParams): Promise<{ delivered: boolean; messageId?: string }> {
    const channelId = params.channelId;
    const adapter = this.adapterFor(channelId);
    if (!adapter) {
      throw new Error(`Unknown channel format: ${channelId}`);
    }

    return adapter.publish(
      channelId,
      this.allChannels.get(channelId),
      params.content,
      this.lastIncoming.get(channelId),
    );
  }

  /**
   * Handle channels/typing — best-effort typing indicator, routed to the
   * owning adapter when it supports one.
   */
  async sendTyping(
    channelId: string,
    metadata?: Record<string, unknown>,
    op: 'start' | 'stop' = 'start',
  ): Promise<void> {
    const adapter = this.adapterFor(channelId);
    if (!adapter?.sendTyping) return;
    await adapter.sendTyping(channelId, this.allChannels.get(channelId), metadata, op);
  }

  /**
   * Get the set of currently open channel IDs.
   */
  getOpenChannels(): Set<string> {
    return this.openChannels;
  }

  /**
   * Get a channel descriptor by ID.
   */
  getChannel(id: string): ChannelDescriptor | undefined {
    return this.allChannels.get(id);
  }

  /**
   * Resolve the adapter owning a channel ID by its prefix.
   */
  adapterFor(channelId: string): PlatformAdapter | undefined {
    const prefix = channelId.split(':', 1)[0];
    return this.adapters.get(prefix);
  }

  /**
   * Type of the first registered adapter — used as a fallback when an
   * operation can't be attributed to a single platform.
   */
  firstAdapterType(): string {
    const first = this.adapters.values().next().value as PlatformAdapter | undefined;
    return first?.type ?? 'unknown';
  }

  /**
   * Cleanup timers.
   */
  destroy(): void {
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }
  }

  // -- Private --

  private enqueue(channelId: string, message: ChannelIncomingMessage): void {
    let buffer = this.batchBuffer.get(channelId);
    if (!buffer) {
      buffer = [];
      this.batchBuffer.set(channelId, buffer);
    }
    buffer.push(message);

    this.scheduleBatchFlush();
  }

  private pushClosedAddressedMessage(channelId: string, message: ChannelIncomingMessage): void {
    const metadata = message.metadata ?? {};
    const isDM = metadata.isDM === true || metadata.channel_type === 'im';
    const isMention = metadata.mentioned === true;
    const isReplyToBot = metadata.isReplyToBot === true;
    if (!isDM && !isMention && !isReplyToBot) return;

    const tags = [
      'chat:addressed',
      ...(isMention ? ['chat:mention'] : []),
      ...(isReplyToBot ? ['chat:reply'] : []),
      ...(isDM ? ['chat:dm'] : []),
      'chat:from-human',
    ];
    void this.mcplClient.sendPushEvent({
      featureSet: `${this.adapterFor(channelId)?.type ?? 'unknown'}.messaging`,
      eventId: `${channelId}:${message.messageId}`,
      timestamp: message.timestamp,
      origin: {
        source: this.adapterFor(channelId)?.type ?? 'unknown',
        channelId,
        mcplChannelId: channelId,
        messageId: message.messageId,
        threadId: message.threadId,
        authorId: message.author.id,
        authorName: message.author.name,
        isMention: isMention || isReplyToBot,
        isExplicitMention: isMention,
        isReplyToBot,
        isBot: false,
        isDM,
      },
      tags,
      payload: { content: message.content },
    }).catch((error) => {
      console.error(`Failed to send closed-channel ping ${channelId}/${message.messageId}:`, error);
    });
  }

  private scheduleBatchFlush(): void {
    if (this.batchTimer) return; // already scheduled
    this.batchTimer = setTimeout(() => {
      this.batchTimer = null;
      this.flushBatch();
    }, this.batchWindowMs);
  }

  private async flushBatch(): Promise<void> {
    const allMessages: ChannelIncomingMessage[] = [];

    for (const [, messages] of this.batchBuffer) {
      allMessages.push(...messages);
    }
    this.batchBuffer.clear();

    if (allMessages.length === 0) return;

    try {
      await this.mcplClient.sendIncoming(allMessages);
    } catch (error) {
      console.error('Failed to send incoming messages to host:', error);
    }
  }
}
