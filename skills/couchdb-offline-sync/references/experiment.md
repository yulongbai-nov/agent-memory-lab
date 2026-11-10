# Tested experiment and boundaries

This skill is maintained in the `agent-memory-lab` repository. Resolve the skill directory's symlinks and locate `../../benchmark/couchdb-sync` relative to the real skill directory. Inspect its README and scripts before use. If the repository has moved or is absent, locate an authorized checkout or ask; do not silently download code or change configuration. Run its `./run.sh` only against the intended Docker context; it creates unique named volumes, leaves them for review, and stops its own project containers. Adapt it rather than assuming every future task needs the same resources or data.

The demonstrated single-node setup uses `single_node=true` and `[cluster] n=1`; verify `_users`, `_replicator`, and `_global_changes` before and after restart. The first boot can emit a transient missing `_users` warning; preserve the initialization log and distinguish it from persistent warnings after the databases exist. Authentication in the example is a synthetic internal test account, never a production credential.

The tested PouchDB 9.0.0 package declares UUID 8.3.2; the experiment overrides to 11.1.1 to address a reported advisory. The CommonJS v4 call, generated ID, nondeterministic revision and this replication scenario were exercised. This major-version override is outside the declared exact dependency and does not establish broad compatibility; recheck the dependency and advisory before relying on it.

Results cover a small Node/Docker single-node synthetic test. They do not establish mobile background behavior, IndexedDB, real device networks, production performance, backup, security or multi-node resilience. `docker stats` is a sparse container snapshot, not a peak or whole-VM measurement.
