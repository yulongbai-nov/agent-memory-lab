# 设计决定与开放问题

这里记录仍生效的设计取舍。交付状态和后续验收见[完成计划](../plan.md)，长期完成条件见[路线图](roadmap.md)。

## 已采用

- Tier 0 原件、归档版本和已接受复核采用追加历史。索引、Wiki、图谱及当前视图从证据重建。纠正误记、实际改变决定和任务状态各自使用显式关系，冲突需显式处理。 [数据契约](contract-v0.1.md) · [任务观察](task-state-observations.md)
- 本机存储使用 SQLite，旧 JSON 有明确的兼容和回退边界。来源、版本、去重和 checkpoint 已有当前实现，跨团队治理仍开放。 [本机索引 ADR](adr-local-sqlite-index.md)
- 同步主选型为 CouchDB。Node PouchDB 是实验客户端，单节点实验的证据适用于当时的拓扑和角色。 [离线同步实验](../benchmark/couchdb-sync/README.md)
- `owner/project` 是当前作用域，普通 Agent 走固定范围只读入口。宿主与模型能否接收私有结果按实际用户授权核对。团队与跨设备授权另有边界。 [共享 Skill](../skills/agent-memory/SKILL.md)
- v1 是既有本机草稿视图。v2 提供显式发布和人工审阅决定或待办及可移植来源链，变更和纠正沿用 `annotate`。默认 Writer 仍为 v3，候选业务 `basis` 与人工批准分开。 [v2 读审](local-draft-review-v2.md)
- 每日启动器代码默认使用宿主机本地 03:00，实际调度由宿主配置。定时整理先做确定性派生，模型草稿需显式启用。 [本机手册](midpoint-usage.md)
- 使用可验收场景及 proposal/spec/design/tasks 风格。该做法可与 OpenSpec 工作方式兼容，仓库未引入 OpenSpec 作为运行依赖。

## 仍开放

- 决定何时形成可复用经验或候选 Skill，如何独立审核、批准、发布、撤销及回退。全面语义质量与自动采纳规则尚未确定。
- 在相同预算下对照文件、结构化和图谱。Graphiti、HY／Hy-Memory、OntoSmith 的采用取决于真实缺口和对照证据。
- 定义原始材料保留与删除政策、附件归档、来源 URL 验证、剩余层编号、团队角色、设备撤销和跨代码库上下文。
- 确定多端入口、手机缓存策略和训练数据治理。ChatGPT 官方导出转换、手机真机和远端常在线主机分别验收。
