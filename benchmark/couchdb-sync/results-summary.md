# Synthetic benchmark summary

A local Apple Silicon macOS run used CouchDB 3.5.3 and Node/PouchDB clients in a dedicated Docker-compatible VM. All data and credentials were synthetic. The VM was configured with 2 CPUs and 3 GiB RAM; its overall resource use was not measured.

The running clients wrote while disconnected, survived a restart while still isolated, converged with the server, replayed sync without additional events, and preserved contradictory decision events through an explicit application-level resolution. Three matching final record sets contained six events. A single A/B/A sync sequence took 389 ms including invocation overhead; this is not a performance claim.

Container `docker stats` idle snapshots for A, B, and CouchDB were 45, 30.34, and 64.21 MiB; one synchronization-time sample was 26.89, 32.12, and 62.99 MiB. These sparse samples are neither peaks nor whole-VM cost. Data directories measured after initial sync were 24, 24, and 168 KiB, and at the end 36, 36, and 252 KiB (`du -sk`). Linux CI uses a different host and is not directly comparable.

System databases existed after initialization and restart; a transient first-boot missing `_users` warning was retained in local evidence. The test does not establish production readiness, conflict-branch handling, actual device networks, IndexedDB or background mobile behavior. See README for UUID override caveat.
