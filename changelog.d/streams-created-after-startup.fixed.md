- Streams created (or made visible) after startup can be opened. A live
  message from a stream discovery never described now carries its
  descriptor, so the server announces it to the host (`channels/changed`)
  before routing — the same path new DM conversations already took. And
  `channels/open` on an unknown exact `channelId` re-discovers once before
  failing, covering a new stream nobody has posted in yet. Previously both
  failed with `Unknown channel` until a restart, including when the agent
  tried to accept the channel invitation a mention there produced. The
  `Unknown channel` error now also names `refresh_channels`.
