- Treat incoming stream quote replies to the connector's own messages as mentions,
  using the quoted message's sender rather than the silent mention's label.
  Message handlers are awaited to preserve delivery order, with quote lookups
  limited to the first two distinct targets and a shared three-second budget.
