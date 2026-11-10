# ChatGPT snapshot adapter v1

This is an offline, **normalized** interchange format for one conversation. It does not fetch data, use credentials, or accept a raw ChatGPT export or connector response. A separate, reviewed conversion is required; no converter for either source is claimed here. This contract has only been exercised with synthetic fixtures. Do not use a real snapshot until its mapping and privacy implications have been reviewed.

The input is a UTF-8 JSON object with exactly these fields:

```json
{
  "schema": "agent-memory-chatgpt-snapshot",
  "version": 1,
  "representation": "connector-projection",
  "conversation": {
    "id": "synthetic-thread",
    "created_at": "2026-01-01T00:00:00Z",
    "branches_complete": false,
    "attachments_complete": false
  },
  "messages": [
    {"id":"synthetic-message", "role":"user", "text":"Example", "created_at":"2026-01-01T00:00:01Z", "truncated":false}
  ]
}
```

`representation` is `connector-projection` or `official-export-normalized`. The latter records a normalization of an export. Message roles are `user`, `assistant`, `system`, or `tool`. Timestamps are UTC ISO strings. IDs must be stable and unique within the thread. All listed fields are required and unknown fields are rejected. A truncated message retains its identity, timestamp and coverage flag. Its partial text stays in the input snapshot and is omitted from searchable archive text. Thread previews are outside this format. Branch and attachment completeness are producer claims. Connector projections always carry a coverage gap, even when the producer supplies both completeness flags.

The adapter accepts at most 16 MiB per file, 100,000 messages and 1 MiB of text per message. The `--session` must equal the conversation ID. Import is read-only with respect to the snapshot, but writes normalized text to the selected private archive. Treat snapshots and archives as sensitive. Checkpoints bind to the exact input file bytes; resuming after any change is rejected. Import a changed snapshot under a separate source identity until a reviewed incremental update protocol exists.

Run `npm run build`, then `node bin/memory.cjs ingest --source chatgpt --file SNAPSHOT --instance INSTANCE --session CONVERSATION_ID --project PROJECT --dir PRIVATE_DIRECTORY`. Use `--max-records` and `--batch-size` to bound each run. Repeat the same command against the immutable normalized file to resume.
