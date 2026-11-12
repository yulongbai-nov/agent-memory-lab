# DSH / Codex 记忆接入设计 v0.1（提案）

两端共用查询与复核 Skill，实际数据访问通过限定项目范围的 stdio MCP 完成。隔离 Linux 中的真实 Codex 和 DSH CLI 已通过合成协议回放，各自查找话题、读取当前决定和时间线并核对两条不同版本证据。宿主桌面自动发现、原生深链和手机端另行验收。独立适配器读取源，定时任务有界摄取，CouchDB 用于按项目同步。真实会话、工具轨迹、附件与索引留在私有运行环境。[运行与验证矩阵](engineering-quality.md)

macOS 上安装的 Codex CLI 0.165.0 已用 App Server 检查单个已注册合成绑定，得到五个只读工具。一个当前 Codex 会话使用该入口完成查找、时间线、当前决定和两条精确引用回查。两个归档版本均有可核查的来源和轮次，原件状态为 `source-only`。 [Codex App Server](https://learn.chatgpt.com/docs/app-server)

macOS 上安装的 DSH CLI 0.2.2-rc.1 已在临时配置和本机模拟提供方下完成有界合成回放，核对查找、时间线和证据调用。可重复的公开验收仍使用固定版本容器。DSH 桌面会话加载、其他 Codex 会话的注册刷新，以及真实授权范围内的模型调用分别验收。 [双端回放](../benchmark/harness-e2e/README.md)

## 数据和来源

| 粒度 | 含义 |
|---|---|
| Source | 一个可定位的源会话或分支，键含 Harness、源实例与原生会话 ID。记录父分支、可核查的分叉边界、已读范围及缺口。 |
| Turn | 源内工作单元，保留原生 ID 或适配器键、顺序及完成状态。一轮可有多条用户消息或工具事件，用于展示和批处理；精确采集不要求逐 turn 单独提交，可在多个 turn 后批量入库。 |
| Item | Tier0 的最小归档和引用单位，包括源消息、可获得的工具调用与结果、附件引用。保存源时间、采集时间、版本和定位。派生事件引用准确的 item 版本及原生链接或私有归档位置，无法定位时显式标为 unavailable。 |

原生 ID 经验证稳定时，以源身份和原生 item ID 标识逻辑项目。缺少原生 ID 时，以稳定的源记录坐标生成带算法版本的适配器键。没有稳定坐标时，只保证同一快照的重放去重，跨快照匹配标为待核实。item 版本用规范化源内容及适配器版本标识，排除采集时刻与重试元数据。同键同内容可重放，同键异内容保留冲突并复核。不同源中的相同文本各自保留。父子分支确有共同来源时可共享归档内容，分别保留来源关系。

## 摄取和变更

1. **首次导入。** 枚举获授权的会话和分支，逐页读取可获得的 item 及源事件。先归档，再抽样核对项目顺序、数量和来源定位。记录起止范围以及截断、权限不足或源数据缺失。回填期间记录后续增量起点，完成后重叠补扫。
2. **持续导入。** 完成通知或 hook 可唤醒适配器，有界轮询和周期补扫补足断线、迟到与变更。半条进入临时区，失败和中断保留状态。按源与扫描参数记录 checkpoint，包括已提交边界、源版本及覆盖范围。分页 cursor 仅作扫描提示，失效时回到已提交边界重扫。等待批内每笔 CouchDB 写入成功后，以 checkpoint 文档的 _rev 条件更新推进。崩溃后从旧边界幂等重放，部分失败不推进。语义抽取可在完成 turn / 会话节点或每日批次进行；触发时机待定。
3. **分叉、回滚、编辑和压缩。** 分叉新建 source，确认继承关系与分叉位置后再关联旧 item。回滚和编辑保留已采集旧版本，记录当前可见范围与替换关系，再重算受影响投影。只有源事件或可核验的范围变化才更新可见状态，单次扫描缺项保留为待核实。压缩摘要单独归档，压缩前原文从已留存的版本引用，未取得则标缺口。源状态变化与用户决策变化分别建模。保留与删除政策另定。
4. **验收与契约修订。** 用合成会话验证回填与增量衔接、部分写入后重试、重复通知、分叉继承、回滚、编辑、压缩以及旧版本来源复核。建议在导入层新增 source、turn、item 与 checkpoint 记录，并修订现有 `source_refs`，区分原生 ID 与适配器键、绑定 item 修订及区分分支归属。现有事件契约和 Schema 保持为当前提案，本稿未修改。

## 初期接口调研

下表记录隔离 CLI 验收前对宿主接口的只读观察。当前可运行结果见 [中期验收记录](midpoint-status.md)。

| 能力 | DSH | Codex |
|---|---|---|
| Skill / CLI / MCP | 本机有 `~/.dsh/skills` 和内置 launcher；桌面 profile 安装 `ds-harness-remote`，其 README 描述会话列表及可能截断的分页读取，依赖已连接 Host / workspace。实际调用、Skill 自动触发和历史覆盖未测。 | 当前会话已发现 Skill；桌面有聊天列表与分页读取工具。官方将 Skill 定义为工作流，MCP 提供实际数据 / 工具；本机 CLI 0.165.0 有 app-server。 |
| 历史与来源 ID | 本机少量日志元数据抽样观察到 `session.v4.jsonl.zstd`、`seq`、用户消息 ID、turn 边界和工具 `callId`；重写后的稳定性与全量覆盖未知。私有格式不是公开稳定接口。 | 本机 0.165.0 生成的 schema 包含 `thread/read`、`thread/turns/list`（`itemsView=full`）和 `thread/items/list`（可按 turn 过滤，依赖 store）；实际权限、完整性及版本差异未测。 |
| 分叉 / 回滚 / 编辑 / 压缩 | 安装的 OPS 文档提到 `contentGeneration` 在替换 / 投影时变化；来源 ID、分支继承和压缩前原文是否保留待测。 | 本机 schema 含 `thread/fork`、`forkedFromId`、`contextCompaction`，未列出 `thread/rollback`；最新官方文档说明 `turn/steer` 可向活动 turn 追加输入。各 store 的历史保留和编辑行为待测。 |
| 完成态 / 增量 / hooks | 抽样观察到 `turn/end`；中断和流式半条的持久化尚不明确。已安装文档描述工具执行前后 hook / checkpoint flush，但并不证明当前 profile 启用生命周期 hook 或提供导入 checkpoint。 | 本机 schema 含 `item/completed`；官方将其完整 item 视为权威状态。官方支持 `SessionStart`、`Stop`、`SessionEnd` 等 hook；本机启用情况与可靠送达未测，`SessionEnd` 不覆盖子代理。游标不是导入 checkpoint。 |

资料：[Codex App Server](https://learn.chatgpt.com/docs/app-server)、[Hooks](https://learn.chatgpt.com/docs/hooks)、[Skills](https://developers.openai.com/plugins/concepts/skills)；本机 CLI 0.165.0 生成 schema、两端各三个会话的字段名 / 类型抽样，以及已安装 `ds-harness-remote` README、`dsh-ops` 的 `context-read-dedup` 和工具注入说明。未输出会话正文或凭据；样本不能证明全量覆盖、稳定性或当前接口可用。
