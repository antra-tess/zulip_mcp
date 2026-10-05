- `channels/typing` without a `topic` in its metadata now shows in the topic of
  the channel's newest incoming message, the same topic a publish replies in.
  It used to fall back to the `mcpl` topic, where nobody was looking, because
  agent-framework's built-in indicator sends `channels/typing` with the
  channel alone. When a newer message moves the indicator to another topic,
  the old topic is stopped, and the final stop goes where the indicator is.
