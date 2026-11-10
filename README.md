# Agent Memory Lab

个人跨 Harness／Agent 记忆系统的开放设计与合成实验。这里保存的是**提案、代码和合成示例**，不保存个人会话或真实运行数据。

- [记忆数据契约 v0.1](spec/contract-v0.1.md)：事件、来源、纠正、状态和验收边界。
- [JSON Schema](spec/event.schema.json)、[正例](examples/synthetic.json)、[反例](examples/invalid-cases.json)。
- [设计决定与开放问题](spec/design-decisions.md)。
- [可复用的离线同步技能](skills/couchdb-offline-sync/SKILL.md)。
- [CouchDB/PouchDB 同步实验](benchmark/couchdb-sync/README.md)。

Node.js 24 下运行 `npm ci --ignore-scripts && npm test`；测试命令会先编译。实验需 Docker Compose 和 Node.js，进入实验目录执行 `./run.sh`。CI 在 Linux 真实运行二者并保存合成结果；结果不能代表手机或生产负载。

## 中期可运行版本

需要 Node.js 24。用合成资料走一遍完整界面。

```sh
npm ci --ignore-scripts
npm run build
demo_dir=$(mktemp -d)
node bin/seed-demo.cjs "$demo_dir"
node bin/memory.cjs find --dir "$demo_dir" --project demo --keyword Release
node bin/memory.cjs serve --dir "$demo_dir" --project demo
```

打开命令打印的本机网址，搜索 `Release`，选择 `Release checklist`，查看决定、待办与精确证据。各端使用独立运行目录和同一项目范围。默认归档路径为 `~/.local/share/agent-memory-lab`，目录需为私有权限，归档拒绝位于 Git 工作树。真实原文和凭据留在私有运行环境。

[使用手册](spec/midpoint-usage.md) · [中期验收状态](spec/midpoint-status.md)

Development checks: after `npm ci --ignore-scripts`, run `npm run build` to
compile the semantic modules into `lib/generated/`. Run `npm run quality` for
scoped lint, formatting, strict TypeScript, and workflow checks (requires
`actionlint` on PATH), and `npm test` for the test suite. The TypeScript scope is
`src/semantic-validation.cts` and `src/semantic-queue.cts`; their CommonJS
entry points and all other JavaScript remain legacy boundaries. The generated
files are build artifacts and are included in packed releases.
