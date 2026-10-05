- A stream the bot joins after startup stays usable without a restart
  (#20). Every stream message now carries its descriptor, not only the
  first one from a stream discovery never saw: whether a channel is new is
  decided by the server's registry, which a reconnect clears, so a channel
  whose announcement failed or was never confirmed is offered again. And
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
- `channels/open`'s re-discovery of an unknown channel no longer loops
  against a host that reconciles before answering. Its announcement times
  out, but the descriptor it recorded lets the open succeed, and the host's
  queued reconcile-time open then finds the channel instead of starting
  another re-discovery.
- A reconnect clears the announcement backlog, so a channel pending for one
  host is not announced to the next. A host that opens or closes a channel
  has confirmed it and it leaves the backlog — against agent-framework that
  is the only confirmation an announcement made inside a tool call can get,
  and without it the backlog would be retried on every refresh forever.
- `listen` registers only the streams it joined (no realm enumeration) and
  reports how the host answered, instead of logging it to stderr.
- An edit, move or deletion from a stream the bot joined after startup
  registers that channel too, so a message edited into a mention does not
  name a channel the agent cannot open (#22 delivers those markers).
