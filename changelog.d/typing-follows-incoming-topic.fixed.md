- `channels/typing` without a `topic` in its metadata now shows in the topic of
  the channel's newest incoming message, the same topic a publish replies in.
  It used to fall back to the `mcpl` topic, where nobody was looking, because
  hosts send typing with the channel alone.
