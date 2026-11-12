# 当前完成计划

更新于 2026-11-12。基础交付证据对应 `4bd2be5`。Graph + Wiki 首轮 Web 交付对应 [PR #34](https://github.com/yulongbai-nov/agent-memory-lab/pull/34)。当前先验收本机 Codex／DSH 的过去决定回溯和未完任务接续。长期完成条件见[路线图](spec/roadmap.md)，具体行为见[规格目录](spec/README.md)。 [基线合约与同步 CI](https://github.com/yulongbai-nov/agent-memory-lab/actions/runs/43200081640) · [基线公开协议 CI](https://github.com/yulongbai-nov/agent-memory-lab/actions/runs/43200081685)

## 六项目标

| 目标 | 当前状态与验收依据 | 下一步和责任角色 |
| --- | --- | --- |
| 原始数据资产 | **进行中**。本机 Codex／DSH 摄取、逐来源覆盖、原件哈希和增量 checkpoint 已有代码与合成回归。完整目标还包括可获得的工具轨迹和附件引用、缺口与恢复。 [归档契约](spec/contract-v0.1.md) · [索引与恢复](spec/adr-local-sqlite-index.md) | **归档与采集负责人**按冻结截止点核对配置来源、原件捕获与缺口。新增来源先核实身份，再验证增量和故障恢复。 |
| 分层记忆与知识 | **进行中**。当前决定、Wiki、版本化候选与图投影已有实现。v2 `decision`／`todo` 读审闭环已部署。公开合成验证覆盖候选状态、原件证据、审核幂等与回链。 [版本化读审 PR](https://github.com/yulongbai-nov/agent-memory-lab/pull/28) · [图投影](spec/ontology-projection-v0.1.md) | **知识与审核负责人**验证真实资料在工作上下文、主题记忆、知识、Wiki 和图谱间的重建与纠正。旧 Codex 包装兼容的交付进度见下方“纠正与 v2 读审”。 |
| 查找与接续 | **进行中**。有界查找、同版预览、时间过滤、时间线和分页待办可用。公开协议覆盖两端 CLI 的合成精确引用；真实任务状态及决定回溯仍按场景验收。 [时间查询 PR](https://github.com/yulongbai-nov/agent-memory-lab/pull/22) · [任务状态 PR](https://github.com/yulongbai-nov/agent-memory-lab/pull/23) | **检索负责人和独立验收者**从模糊时间或话题线索验证约五个候选、精确旧版和有证据的下一步。明确暂停、完成和冲突时的接续行为。 |
| 跨 Agent／代码库协作 | **进行中**。共享 CLI、stdio MCP 和 Skill 有公开合成回放。固定范围本机入口已配置为只读。共享文件可验证，已运行会话是否加载新版需另验。 [共享 Skill](skills/agent-memory/SKILL.md) · [双 CLI 协议](benchmark/harness-e2e/README.md) | **宿主集成负责人**核验 Codex、DSH 在真实授权范围的调用和交接。跨代码库上下文、团队角色与设备权限需单独设计及验收。 |
| 每日回顾与自进化 | **进行中**。有界采集、确定性派生、v3 草稿恢复和扫描预算分离已有合成回归。扫描修复已部署，修复后的自然运行仍待验。 [续接修复 PR](https://github.com/yulongbai-nov/agent-memory-lab/pull/27) · [恢复契约](spec/local-draft-recovery.md) | **运行负责人**核对下一次自然调度、积压和恢复。**知识与审核负责人**另定经验和候选 Skills 的审查、发布、回退与自动采纳边界。 |
| 小模型后训练 | **合成契约已验收，真实训练待启动**。公开合成清单包含精确版本、用途授权和隔离的训练／评测分区。真实资料的授权、导出和训练仍待验收。 [样本清单](spec/training-manifest-v1.md) [数据契约](spec/contract-v0.1.md) · [训练目标](spec/roadmap.md) | **数据治理与评测负责人**先明确来源授权、训练与评测隔离、冲突和负例处理，再进行独立评测与采用决策。 |

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
| Graph + Wiki 与框架选型 | **进行中**。同一 Web 内两个平级入口已接入本地 Cytoscape.js 和 vis-timeline；跨 Harness 合成浏览器路径通过，精确来源和原档不变得到验证。Graphiti 等框架仍为候选。 [设计与研究](spec/graph-wiki-design.md) · [现有图投影](spec/ontology-projection-v0.1.md) | **架构与评测负责人**继续核验范围、来源和状态边界并对照 Graphiti；审核链有界读取、真实资料和完整 Wiki／ontology 应用另行验收。 |
| 手机、ChatGPT 官方导出和远端 Host | **暂缓**。保留浏览器离线壳、归一化快照契约及远端配置说明。 [手机接入](spec/mobile-access.md) · [快照契约](spec/chatgpt-snapshot-v1.md) | **产品与宿主集成负责人**在恢复范围后分别验手机真机、官方导出转换和远端主机连通及权限。 |

工作顺序沿用 BFS 后 DFS。先核对来源与可用入口，再深入验证决定与任务两个场景。自动派生候选保留来源与状态，明确审核层支撑已审知识。受控发布依赖可追溯归档、检索、明确策略及相应复核，逐条人工批准不作为预设。训练依赖上述证据以及独立数据治理。更新本页时只追加或修正当前结论，保留[历史验收](spec/midpoint-status.md)中的原始失败和证据边界。

短迭代优先验证正常用户路径。每轮从 CLI、Harness 或网页选一个真实入口，跑到可观察的结果并核对精确来源。独立实现、文档和验收可由 Terra 并行处理，主代理负责依赖、合并与最终证据。优先复用现有测试，在来源版本、作用域和评分边界保留必要的拒绝案例。 [协作规范](AGENTS.md#协作提交与交付)

Graph + Wiki 当前迭代已用一个跨 Harness 合成案例验证项目和主题入口、决定变更、待办及精确来源。测试禁用 service worker，不证明新的离线能力；未调用模型。[查询契约提案](spec/graph-wiki-contract-v0.1.md) · [验收场景](benchmark/graph-wiki/README.md)

来源分页使用 SQLite 话题索引，每页返回 20 条精确版本引用。审核历史单独保留决定和任务状态。合成浏览器用例遍历多页，核对跨 Harness 引用及原档完整性。 [分页契约](spec/graph-wiki-contract-v0.1.md#分页来源与审核历史)

项目页支持直接核对待办和决定的精确证据。SQLite 待办查询仅将任务版本与关联目标返回给应用，兼容旧版待办的识别仍扫描作用域内的版本元数据。合成 Chrome 验收覆盖批注失败时证据保持可见。

每日整理按实际候选原件检查计费，同一次筛选复用已核验的片段，并为待推理批次重新核验预留检查额度。运行状态区分档案扫描和候选筛选续跑。合成回放验证了缺失或篡改原件之后的前进与精确重试。下一次自然运行仍需验收。 [恢复契约](spec/local-draft-recovery.md)

单条原件支持最多 16 MiB，校验按块计算 SHA-256。针对旧版大小限制留下的记录，可以按已配置来源、条目和版本补录当前观察。旧版本和采集 checkpoint 原样保留。合成测试覆盖大原件、精确补录和重试。 [原件使用说明](spec/midpoint-usage.md#私有原件与脱敏投影)

审核时间线按事件时间分页。页面按 20 条逐批读取，任务状态和纠正内容只为所选页构建。审核输入变化时重新加载当前决定和图，保留已打开的精确证据。服务端仍需读取作用域中的审核输入，完整的存储层有界读取待实现。 [分页契约](spec/graph-wiki-contract-v0.1.md#分页来源与审核历史)

SQLite 的话题审核查询通过话题索引和精确版本联结选择候选，再读取关联批注。无关话题批注可以在翻页期间加入。跨话题审核、任务状态、纠正和纳秒时间边界通过 JSON 与 SQLite 对照验收。排序仍处理该话题的全部审核候选。

公开合成训练清单支持独立导出训练与留出评测文件。每份保留精确证据和对应授权，输入与预期答案分开，并可追溯到同一完整清单。 [分区导出](spec/training-manifest-v1.md#分区导出)

公开合成留出数据支持生成只含模型输入的请求批次，并在本机回放评分。答案精确匹配、引用范围和缺失响应分别计数。合成回放验收流程，实际模型评测另行执行。 [离线评测回放](spec/training-manifest-v1.md#离线评测回放)
