# 当前完成计划

更新于 2026-11-12。代码证据基线为 `4bd2be5`，包含截至 PR #31 的交付。当前先验收本机 Codex／DSH 的过去决定回溯和未完任务接续。长期完成条件见[路线图](spec/roadmap.md)，具体行为见[规格目录](spec/README.md)。 [基线合约与同步 CI](https://github.com/yulongbai-nov/agent-memory-lab/actions/runs/43200081640) · [基线公开协议 CI](https://github.com/yulongbai-nov/agent-memory-lab/actions/runs/43200081685)

## 六项目标

| 目标 | 当前状态与验收依据 | 下一步和责任角色 |
| --- | --- | --- |
| 原始数据资产 | **进行中**。本机 Codex／DSH 摄取、逐来源覆盖、原件哈希和增量 checkpoint 已有代码与合成回归。完整目标还包括可获得的工具轨迹和附件引用、缺口与恢复。 [归档契约](spec/contract-v0.1.md) · [索引与恢复](spec/adr-local-sqlite-index.md) | **归档与采集负责人**按冻结截止点核对配置来源、原件捕获与缺口。新增来源先核实身份，再验证增量和故障恢复。 |
| 分层记忆与知识 | **进行中**。当前决定、Wiki、版本化候选与图投影已有实现。v2 `decision`／`todo` 读审闭环已部署。公开合成验证覆盖候选状态、原件证据、审核幂等与回链。 [版本化读审 PR](https://github.com/yulongbai-nov/agent-memory-lab/pull/28) · [图投影](spec/ontology-projection-v0.1.md) | **知识与审核负责人**验证真实资料在工作上下文、主题记忆、知识、Wiki 和图谱间的重建与纠正。旧 Codex 包装兼容的交付进度见下方“纠正与 v2 读审”。 |
| 查找与接续 | **进行中**。有界查找、同版预览、时间过滤、时间线和分页待办可用。公开协议覆盖两端 CLI 的合成精确引用；真实任务状态及决定回溯仍按场景验收。 [时间查询 PR](https://github.com/yulongbai-nov/agent-memory-lab/pull/22) · [任务状态 PR](https://github.com/yulongbai-nov/agent-memory-lab/pull/23) | **检索负责人和独立验收者**从模糊时间或话题线索验证约五个候选、精确旧版和有证据的下一步。明确暂停、完成和冲突时的接续行为。 |
| 跨 Agent／代码库协作 | **进行中**。共享 CLI、stdio MCP 和 Skill 有公开合成回放。固定范围本机入口已配置为只读。共享文件可验证，已运行会话是否加载新版需另验。 [共享 Skill](skills/agent-memory/SKILL.md) · [双 CLI 协议](benchmark/harness-e2e/README.md) | **宿主集成负责人**核验 Codex、DSH 在真实授权范围的调用和交接。跨代码库上下文、团队角色与设备权限需单独设计及验收。 |
| 每日回顾与自进化 | **进行中**。有界采集、确定性派生、v3 草稿恢复和扫描预算分离已有合成回归。扫描修复已部署，修复后的自然运行仍待验。 [续接修复 PR](https://github.com/yulongbai-nov/agent-memory-lab/pull/27) · [恢复契约](spec/local-draft-recovery.md) | **运行负责人**核对下一次自然调度、积压和恢复。**知识与审核负责人**另定经验和候选 Skills 的审查、发布、回退与自动采纳边界。 |
| 小模型后训练 | **待启动**，依赖尚未满足。当前公开夹具可用来验证数据与评测契约，训练资产的权限、版本和隔离尚未验收。 [数据契约](spec/contract-v0.1.md) · [训练目标](spec/roadmap.md) | **数据治理与评测负责人**先明确来源授权、训练与评测隔离、冲突和负例处理，再进行独立评测与采用决策。 |

## 当前交付检查

“已完成”仅适用于该行的交付边界。代码存在、合成测试、真实模型、真实环境验收和部署分别记录。公开协议回放使用真实 CLI 和模拟提供方。公开合成材料的真实模型结果只覆盖原实验。私有验收保留在本机，本页只记录其待验边界。

| 检查项 | 状态与证据 | 下一步和责任角色 |
| --- | --- | --- |
| 主线编排与验收 | **已完成**分工和三阶段检查单的成文。各项交付仍按自身证据验收。 [编排规范](AGENTS.md#协作提交与交付) | **主代理**保留目标、依赖和最终判断。**执行角色**按规范分工，**验收角色**独立核对证据。交接只带结果、证据、卡点和所需决策。 |
| 分页待办与固定范围入口 | **已完成**本机代码部署与只读入口边界。`task-list` 默认 20、最多 50，默认 MCP 仍是五个工具。 [任务契约](spec/task-state-observations.md) · [共享说明 PR](https://github.com/yulongbai-nov/agent-memory-lab/pull/25) | **宿主集成负责人**验真实接续及旧会话重新发现。 |
| 纠正与 v2 读审 | **已完成**合成闭环与本机部署。v2 显式审阅决定或待办；变更与纠正继续用 `annotate`。 [纠正一致性 PR](https://github.com/yulongbai-nov/agent-memory-lab/pull/24) · [读审 PR](https://github.com/yulongbai-nov/agent-memory-lab/pull/28) | 旧 Codex 包装兼容的代码与公开合成验证已完成：仅 v2 显式读审支持经用户转录佐证的输入，所选字段须为唯一原生 `input_text`；v1／v3 不变。 [读审规格](spec/local-draft-review-v2.md) · [合成测试](tests/versioned-review.test.cjs) **知识与审核负责人**另行验证宿主部署、真实资料与可移植审核记录。 |
| 真实资料端到端验收 | **进行中**。私有范围、精确来源与用户审核分别验证。 | **独立验收者**在已授权范围完成决定回溯、待办状态和自然运行复核。发布私有结果须有单独授权。 |
| 下一次自然每日整理 | **待验**。分离档案扫描和候选筛选预算的改动已过公开 CI。 [每日续接 PR](https://github.com/yulongbai-nov/agent-memory-lab/pull/27) | **运行负责人**用调度记录和状态文件核对实际触发与积压。手动检查另行记账。 |
| Writer 与读者语义质量 | **待验**。公开合成的真实模型结果已记录，离线复现另有证据。默认 Writer 仍为 v3。 [Luna Writer 结果](benchmark/writer-luna/results-20261112.md) · [读者评测](benchmark/memory-views/README.md) | **评测负责人**用独立留出和负例衡量全面语义质量。自动采纳规则仍未定。 |
| Graph + Wiki 与框架选型 | **进行中**。项目工作页和知识主题页平级，可视化是正式需求；关系图选定 Cytoscape.js、时间线选定 vis-timeline，尚未接入测试。Graphiti 等框架仍为候选。 [设计与研究](spec/graph-wiki-design.md) · [现有图投影](spec/ontology-projection-v0.1.md) | **架构与评测负责人**先定义查询、来源与时间契约及跨 Harness 合成案例，再评估组件、设计原型并对照 Graphiti；真实资料另行有界验收。 |
| 手机、ChatGPT 官方导出和远端 Host | **暂缓**。保留浏览器离线壳、归一化快照契约及远端配置说明。 [手机接入](spec/mobile-access.md) · [快照契约](spec/chatgpt-snapshot-v1.md) | **产品与宿主集成负责人**在恢复范围后分别验手机真机、官方导出转换和远端主机连通及权限。 |

工作顺序沿用 BFS 后 DFS。先核对来源与可用入口，再深入验证决定与任务两个场景。自动派生候选保留来源与状态，明确审核层支撑已审知识。受控发布依赖可追溯归档、检索、明确策略及相应复核，逐条人工批准不作为预设。训练依赖上述证据以及独立数据治理。更新本页时只追加或修正当前结论，保留[历史验收](spec/midpoint-status.md)中的原始失败和证据边界。
