- A mention the host accepts as a push, in a stream it has closed, now sets
  the topic the answer goes to (#31). Only `channels/incoming` messages set
  it before, so the answer went to the stream's last topic from before the
  close, or to `mcpl` in a stream that had never been open, or after a
  reconnect. A catch-up `<missed>` block the host accepts sets it too, from
  its newest mention (from a backscroll block, its newest message), and so
  does the newest message of the history `channels/open` returns, unless
  that history was fetched before a given message. A push the host refuses
  sets nothing. The newest message wins: one older than the message the
  topic came from, such as a push accepted after a newer one's or a held
  message offered again, leaves the topic where it is. Typing with no topic
  from the host follows the same topic.
