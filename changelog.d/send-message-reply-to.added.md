- `send_message` accepts `reply_to` to derive a stream/topic or DM conversation
  from a message ID, refusing conflicting destinations and unreadable IDs
  before uploading or sending anything. The tool schema requires `type`;
  direct runtime callers may still omit it with `reply_to` to infer the type.
  Explicit destinations accept numeric-string IDs and visible real
  emails even when message metadata uses synthetic emails. Calls without
  either `to` or `reply_to`, or without `type` when not replying, are refused
  locally. Email-directory fallback is restricted to synthetic recipient
  metadata and shares one in-flight lookup across recipients.
