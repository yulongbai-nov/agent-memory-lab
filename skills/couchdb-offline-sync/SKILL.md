---
name: couchdb-offline-sync
description: Design, run, or review a local CouchDB and PouchDB offline replication experiment with persistent clients and evidence of convergence; not a production deployment or mobile acceptance workflow.
---

# CouchDB offline sync experiments

Use synthetic records and task-scoped identities and resources unless the user explicitly authorizes real data. Keep each client's durable store independent. Isolate a **running** client from the replication network, write offline, restart while isolated and verify the full saved content before reconnecting. Bound replication waits; compare complete records across clients and server, then replay sync to verify idempotency.

Keep source and correction events and distinguish application-level contradictory meanings from database revision conflicts. If testing a shared-document revision conflict, inspect every conflict branch rather than only the default winner. A semantic projection and explicit resolution are application behavior, not built-in CouchDB understanding.

Initialize and verify single-node system databases and replica configuration; record early startup warnings and check post-initialization logs. Report sample size, elapsed sync, data-directory size and available container CPU/memory snapshots; do not equate sparse samples with peaks or include VM overhead in container figures. Stop only resources created for the experiment and preserve evidence. Follow the user's authorization for any external or host changes.

For the tested setup, reference implementation, dependency override caveats and limitations, read [references/experiment.md](references/experiment.md). Resolve symlinks before locating the repository reference implementation; never assume the current directory is the repository.
