- An answer in a stream the host has closed now goes to the topic of the
  newest mention the host accepted there. A mention in a closed stream is
  pushed rather than delivered as `channels/incoming`, and the topic
  `channels/publish` uses came only from `channels/incoming` messages, so the
  answer went to the stream's last topic from before the close, or to `mcpl`
  in a stream that had never been open, or after a reconnect. The topic now
  also comes from a mention or DM the host accepts as a push, alone or in a
  catch-up `<missed>` block (from a backscroll block, its newest message);
  one the host refuses moves nothing. The newest message wins: one older than
  the message the topic came from, such as a push accepted after a newer
  one's or a held message offered again, leaves the topic where it is. Typing
  with no topic from the host follows the same topic.
