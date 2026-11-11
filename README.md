# Agent Memory Lab

个人跨 Harness／Agent 记忆系统的开放设计与合成实验。这里保存的是**提案、代码和合成示例**，不保存个人会话或真实运行数据。

- [记忆数据契约 v0.1](spec/contract-v0.1.md)：事件、来源、纠正、状态和验收边界。
- [JSON Schema](spec/event.schema.json)、[正例](examples/synthetic.json)、[反例](examples/invalid-cases.json)。
- [设计决定与开放问题](spec/design-decisions.md)。
- [总体目标与路线图](spec/roadmap.md)。
- [OntoSmith 复用评估](spec/research/ontosmith-reuse.md)，按固定官方提交核对类型、证据、图投影与同步边界。
- [可复用的离线同步技能](skills/couchdb-offline-sync/SKILL.md)。
- [CouchDB/PouchDB 同步实验](benchmark/couchdb-sync/README.md)。

用 Node.js 24.22.1 运行 `npm ci --ignore-scripts && npm test`，测试会先编译。离线同步实验需 Docker Compose，进入实验目录执行 `./run.sh`。Linux CI 使用合成资料验证存储和 CLI 协议。

## 中期可运行版本

用合成资料走一遍完整界面。

```sh
npm ci --ignore-scripts
npm run build
demo_dir=$(mktemp -d)
node bin/seed-demo.cjs "$demo_dir"
node bin/memory.cjs find --dir "$demo_dir" --project demo --keyword Release
node bin/memory.cjs serve --dir "$demo_dir" --project demo
```

打开命令打印的本机网址，搜索 `Release`，选择 `Release checklist`，查看决定、待办与精确证据。各端使用独立运行目录和同一项目范围。默认归档路径为 `~/.local/share/agent-memory-lab`，目录需为私有权限，归档拒绝位于 Git 工作树。真实原文和凭据留在私有运行环境。

[使用手册](spec/midpoint-usage.md) · [中期验收状态](spec/midpoint-status.md) · [工程边界与验收](spec/engineering-quality.md)

`npm run build` 将首批严格 TypeScript 模块编译至 `lib/generated/`。发行包包含编译产物。仓库开发用 `npm run quality` 检查代码、格式、严格类型、工作流和选定的 shell 脚本，需安装 actionlint 和 ShellCheck。旧 JavaScript 范围保存在显式清单中。新增代码范围需随变更复核。
