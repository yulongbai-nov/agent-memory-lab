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

`representation` is `connector-projection` or `official-export-normalized`. The latter means a normalized representation derived from an export, not the original export bytes. Message roles are `user`, `assistant`, `system`, or `tool`. Timestamps are UTC ISO strings. IDs must be stable and unique within the thread. All listed fields are required and unknown fields are rejected. Truncation is per message; branch and attachment completeness are claims made by the producer for the thread. The adapter does not independently verify those claims or capture attachment content or original bytes. Connector projections always carry a coverage gap, even if both completeness flags are true.

The adapter accepts at most 16 MiB per file, 100,000 messages and 1 MiB of text per message. The `--session` must equal the conversation ID. Import is read-only with respect to the snapshot, but writes normalized text to the selected private archive. Treat snapshots and archives as sensitive. Checkpoints bind to the exact input file bytes; resuming after any change is rejected. Import a changed snapshot under a separate source identity until a reviewed incremental update protocol exists.

After the adapter is included in the TypeScript build, run `npm run build`, then `node bin/memory.cjs ingest --source chatgpt --file SNAPSHOT --instance INSTANCE --session CONVERSATION_ID --project PROJECT --dir PRIVATE_DIRECTORY`. `--max-records` and `--batch-size` bound each run; repeat the same command to resume. Do not point this at a raw export or connector dump.
