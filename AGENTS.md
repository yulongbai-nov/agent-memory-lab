# 仓库协作入口

本文件适用于整个仓库。需求以用户当前目标和生效规格为准；实现与验收状态以当前代码、运行证据和对应提交的 CI 为准。历史报告或测试数量不能代替需求完成证明。

## 开始一项工作

1. 检查工作区、分支、远端和未提交改动，保留其他任务的现场。实现和实验使用独立分支或 worktree，不直接在 `main` 上试改。
2. 先看[当前完成计划](plan.md)、[路线图](spec/roadmap.md)和[工程边界](spec/engineering-quality.md)，再按下表读取相关规格与入口。先确认范围、依赖和验收，再深入实现；不要求每次扫描所有文档。
3. 查找现有实现与可复用组件。数据校验和业务规则尽量共用，避免 CLI、MCP、网页及同步各复制一套规则。
4. 行为或格式发生变化时同步更新规格、使用说明和对应验证。未实现的设想明确标为提案，不写成已有能力。

## 去哪里找

| 要处理的事情 | 主要代码 | 规格或说明 |
| --- | --- | --- |
| 产品目标、边界与设计取舍 | 按下列模块定位 | [完成计划](plan.md)、[规格目录](spec/README.md)、[路线图](spec/roadmap.md)、[数据契约](spec/contract-v0.1.md)、[设计决定](spec/design-decisions.md) |
| CLI、MCP、网页与作用域 | [CLI](bin/memory.cjs)、[共用操作](lib/operations.cjs)、[MCP](lib/mcp.cjs)、[网页](lib/web/server.cjs) | [使用手册](spec/midpoint-usage.md)、[跨 Harness 接入](spec/DSH-Codex-integration-v0.1.md) |
| 原生会话导入、发现与增量采集 | [适配器](lib/adapters/)、[摄取](lib/intake.cjs)、[收集器](src/collector.cts)、[检查点](lib/checkpoint.cjs)、[Codex 发现](lib/codex-discovery.cjs) | [接入设计](spec/DSH-Codex-integration-v0.1.md)、[ChatGPT 快照](spec/chatgpt-snapshot-v1.md) |
| 原件、归档、事务与同步 | [归档 API](lib/archive.cjs)、[原件](lib/originals.cjs)、[JSON 存储](lib/storage.cjs)、[SQLite](lib/storage-sqlite.cjs)、[锁](lib/lock.cjs)、[CouchDB](lib/storage-couch.cjs) | [数据契约](spec/contract-v0.1.md)、[本机索引 ADR](spec/adr-local-sqlite-index.md)、[同步实验](benchmark/couchdb-sync/README.md) |
| 查找、时间、决定与任务状态 | [查询](lib/query.cjs)、[时间比较](src/query-time.cts)、[预览](src/find-preview.cts)、[任务状态](lib/task-state.cjs) | [时间语义](spec/query-time.md)、[任务观察](spec/task-state-observations.md)、[预览](spec/find-preview-v0.1.md) |
| 每日整理、本地 Writer、缓存与恢复 | [每日入口](lib/daily.cjs)、[草稿生成](lib/local-derive.cjs)、[草稿索引](lib/local-draft-index.cjs)、[队列](src/local-draft-state.cts)、[资源准入](src/local-admission.cts) | [恢复契约](spec/local-draft-recovery.md)、[资源准入](spec/local-admission-wait.md) |
| 候选格式、草稿读取与审阅来源链 | [模型输出契约](src/candidate-contract-v2.cts)、[审核契约](src/candidate-review-contract.cts)、[v1 读取](src/local-draft-read.cts)、[v2 读审](src/versioned-review.cts) | [候选契约](spec/candidate-contract-v2.md)、[v1 读取](spec/local-draft-read.md)、[v2 读审](spec/local-draft-review-v2.md) |
| 本体、图谱与检索对照 | [图投影](src/ontology-projection.cts)、[检索对照](benchmark/memory-views/) | [本体规格](spec/ontology-projection-v0.1.md)、[评测说明](benchmark/memory-views/README.md)、[OntoSmith 研究](spec/research/ontosmith-reuse.md) |
| Agent 使用流程与独立验证 | [共享记忆 Skill](skills/agent-memory/SKILL.md)、[测试](tests/)、[发行包验收](scripts/smoke-package.cjs) | [双 CLI 验收](benchmark/harness-e2e/README.md)、[Luna Writer 对照](benchmark/writer-luna/README.md) |

## 代码质量要求

- 新核心逻辑、持久化格式和外部接口优先放入 `src/*.cts`，使用严格 TypeScript。既有 CommonJS 入口可以保留薄适配层。逐模块迁移旧 JavaScript，保持行为与公开接口；不把整仓改名当作迁移完成。
- 保持 [tsconfig](tsconfig.json) 的 `strict`、`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes` 和 `noEmitOnError`。用判别联合表达互斥状态，例如决定必须有 `basis`，待办不得带该字段。
- 对磁盘、网络、模型及 CLI 输入先作运行时校验，再收窄类型。类型声明不能认证外部数据。不要用无约束 `any`、`@ts-ignore`、关闭规则或缩小检查范围来掩盖错误；遗留边界的类型转换应限制范围并说明依据。
- 修改源码而非 `lib/generated/`。编译产物由 `npm run build` 生成，随发行包交付，不手改或提交生成目录。兼容层要在安装后的生产包中仍可解析依赖。
- 新增、移动或删除源码时核对 [范围门禁](scripts/check-ts-scope.cjs)、[ESLint](eslint.config.mjs)、[package 脚本](package.json) 和 TypeScript 文件清单。保留 JS 的测试或薄入口也应进入相应 lint/格式检查；不得把新逻辑塞入[遗留豁免清单](scripts/legacy-js-scope.json)来绕过质量门禁。
- 修改类型契约时保留正常与拒绝案例，必要时加编译期负例，参考[候选类型测试](tests/candidate-contract-v2.types.cts)和[审核类型测试](tests/candidate-review-contract.types.cts)。
- 改动保持聚焦，清理本次引入的重复逻辑、死代码和临时调试输出。失败要可观察，不能吞掉错误后返回成功，也不能用空结果冒称全量覆盖。

## 数据与操作不变量

- Tier 0 原件、历史版本和已接受复核事件保持追加历史；纠正、决定改变和任务状态使用显式关系。Wiki、索引、图和当前视图是派生层。新的抓取时间或“最后写入”不能自动覆盖语义冲突。
- 所有读写绑定 `owner/project`，引用保留 Harness、实例、会话、条目及精确版本。区分当前与旧源版本、原件核验与仅预览可用、生成时间与系统获知时间。来源缺失就明确保留缺口，不补造证据。
- 普通 Agent 的固定入口保持只读；明确写入按当前用户授权和作用域进行。候选 `basis`、生产者自报信息与已接受审核分别表达，不能把模型候选自动冒称为用户批准。
- 持久化改动考虑原子写入、幂等重试、并发冲突、重启恢复和旧数据兼容。新增字段要核对 JSON、SQLite、同步、查询及投影之间的一致性。
- 公共 Git 和 CI 仅放代码、合成材料及其结果。真实会话、私有引用映射、个人路径、真实验收回执和凭据保存在私有运行目录，发布另需明确授权；`.gitignore` 只是防线，不能替代发布内容审查。归档不得放进 Git 工作树。
- 保留已有会话、脏 worktree 和原始失败记录。不要覆盖 `HOME`、`CODEX_HOME`，不要修改全局 Git 身份；使用已核实的用户署名。实验只清理自己创建的资源。

## 验证入口

当前 CI 固定 Node.js **24.22.1**；以 [package.json](package.json) 和工作流中的实际命令为准。

```sh
npm ci --ignore-scripts
npm run build
npm run quality
npm test
```

`quality` 包含范围检查、ESLint、Prettier、严格类型、actionlint 和 ShellCheck；后两者需在环境中可用。它覆盖明确登记的迁移范围，并不表示旧 JS 已全部迁为 TS 或全部采用相同 lint 规则。

| 改动范围 | 有意义的验证 |
| --- | --- |
| 纯文档或导航 | 核对链接、路径、命令和当前行为，运行 `git diff --check`；不为凑数量增加镜像测试 |
| 业务、状态或数据格式 | 相关规格导出的正反例及真实 CLI 回归；合入前按影响范围完成 `npm run quality`、`npm test` |
| 编译、入口、打包或依赖 | 加跑 `npm run smoke:package`，验证仅生产依赖的实际发行包 |
| 检索、引用或时间语义 | 加跑 `npm run check:memory-retrieval`，并检查精确引用、作用域、旧版本和边界条件 |
| 双 Harness 或模型协议 | 按双 CLI 验收说明运行 `benchmark/harness-e2e/run-public.sh`，需要 Docker；公开回放不调用模型 |
| 同步、离线或恢复行为 | 按影响选择 `node tests/archive-hub.cjs` 或同步实验中的真实服务验证；文件支持的模拟传输不能称为真实 CouchDB 实测 |

默认 CI 的 [verify](.github/workflows/ci.yml) 和 [public-protocol](.github/workflows/harness-e2e.yml) 都要检查最终提交。`trusted-model-e2e` 仅在主分支手动触发并使用受保护环境。真实模型测试遵守当前数据、模型、预算和授权范围，召回基准使用 `gpt-6-luna`、`low`；不要因为零模型测试失败就自动增加付费请求。

固定评测材料、预期和计量口径。保留失败、跳过项及局限，不能改金标准来迎合输出。合成测试、协议回放、真实模型结果、私有资料验收和实际部署分别报告；小样本通过不证明泛化质量。

## 协作、提交与交付

按任务复杂度分工。主代理保留全局目标、依赖、优先级和最终验收判断。简单机械核对交轻量模型，例如链接检查、清单整理和状态读取。中等实现、文档整理与 GitHub 操作由 Terra 负责。具体审查可由主代理或轻量模型完成，依风险与所需专业判断选择。条件允许时使用不同模型或供应商独立复核。执行者遇到具体难点，可按需请 GPT-6 Astra 提供建议，任务归属和验收责任仍由原角色承担。

| 阶段 | 检查项 |
| --- | --- |
| 开始 | 给出范围明确的任务说明，包含目标、范围、依赖、基线提交、文件归属、交付物和验收条件。并行任务各用独立分支或 worktree，核对已有授权。 |
| 交接 | 回传结果、精确提交和证据链接、卡点及所需决策。注明未完成项和需要接管的运行句柄。日志留在相应任务和证据中，主线程保留可行动摘要。 |
| 验收 | 主代理按规格复核交付、跨模块一致性、隐私权限和实际验证边界。独立测试从规格出发。标注自测、独立审查、公开 CI 与部署的各自证据。 |

集成冲突时保留双方有效行为及检查清单，针对真实冲突复验。新改动、失败或未解决问题才需要追加验证。使用正常 PR 与分支保护流程，禁止强推或绕过门禁，保留他人现场。合并沿用已有授权。交付说明问题、结果、验证、待验边界及下一步，并绑定具体提交与 CI。
