# Agent Memory Lab

个人跨 Harness／Agent 记忆系统的开放设计与合成实验。这里保存的是**提案、代码和合成示例**，不保存个人会话或真实运行数据。

- [记忆数据契约 v0.1](spec/contract-v0.1.md)：事件、来源、纠正、状态和验收边界。
- [JSON Schema](spec/event.schema.json)、[正例](examples/synthetic.json)、[反例](examples/invalid-cases.json)。
- [设计决定与开放问题](spec/design-decisions.md)。
- [CouchDB/PouchDB 同步实验](benchmark/couchdb-sync/README.md)。

Node.js 22 下运行 `npm ci && npm test`。实验需 Docker Compose 和 Node.js，进入实验目录执行 `./run.sh`。CI 在 Linux 真实运行二者并保存合成结果；结果不能代表手机或生产负载。
