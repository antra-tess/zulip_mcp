- Event-queue registration works on Zulip 12 again. #22 added
  `client_capabilities` with `bulk_message_deletion` only; Zulip 12 validates
  the object as a whole and refused the registration
  (`notification_settings_null field is missing`), so no event ever arrived
  while the log only said `returned no events array`. The capability is now
  sent at its documented default (`false`), and a refused registration is
  logged with Zulip's reason and retried instead of polling queue `undefined`.
