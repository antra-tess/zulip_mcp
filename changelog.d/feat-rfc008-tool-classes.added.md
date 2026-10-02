- Every tool in `tools/list` declares its MCPL RFC-008 class in
  `_meta["mcpl/class"]`: `send_message`, `send_dm` and `upload_file` are
  `comms` and `files` (attachments may be local paths); the tools that
  edit, delete, react to or read messages, or list users, streams, topics
  and emoji, are `comms`; monitoring, filters, muting, reaction
  visibility, `channel_missed`, `refresh_channels` and `get_user_profile`
  are `control`. Hosts use the class to decide what tool-lifecycle
  observers may see, and never share `comms` arguments. Other `_meta` keys
  are kept, and tool names, descriptions and schemas are unchanged.
