- A stream the bot joins after startup is usable without a restart (#20).
  It was registered only by the startup enumeration, so `channels/open`
  answered `Unknown channel` for it even while its mentions were being
  delivered and `get_channel_history` worked. Now every stream message
  carries its descriptor (as a DM from a new conversation already did), and
  `listen` registers what it subscribes the bot to.
- The announcement of a channel is no longer lost when the host does not
  answer it. That is what made the reported streams unopenable:
  agent-framework answers `channels/register` before reconciling but
  `channels/changed` after, and this server serves one request at a time, so
  an announcement made inside a tool call cannot be answered until the call
  returns and it timed out. Descriptors are now recorded before the
  announcement goes out, the wait is 5s rather than 30s, and an unconfirmed
  channel stays usable and is re-announced on the next explicit
  registration (capped at 100 pending).
- `channels/changed` verdicts are read per descriptor: an itemized
  `accepted: false` unregisters and closes the channel and is remembered,
  while a descriptor the host's itemization does not mention is treated as
  unstated rather than refused. `refresh_channels` reports
  `pendingAnnouncement` and `refused` instead of claiming the host already
  knows every visible channel, and retries refused channels when the agent
  asks.
- A reconnect clears the announcement backlog, so a channel pending for one
  host is not announced to the next.
