# MemoraX Code 研究与复用决定

源码与发行说明固定在 `v0.1.23`，提交 `e21227ab6ea0ef13e95ae866d8711b2cece8e16e`。Sol xhigh 独立审查了工作区身份、原生回合、写回、数据流和证据接口。研究使用公开源码。本机实验使用临时合成 Git 仓库。 [发行版](https://github.com/memorax-ai/memorax-code/releases/tag/v0.1.23) · [源码版本](https://github.com/memorax-ai/memorax-code/tree/e21227ab6ea0ef13e95ae866d8711b2cece8e16e)

| 机制 | 实际行为与复用决定 |
| --- | --- |
| Repo Memory | 本地统一仓库地图。读取者固定一次已发布版本，维护任务从本地已知的 `origin/HEAD` 选提交，验证候选后切换共享指针，旧版本仍可读。**首轮采用精确 Git 文件引用和只读核对。** 后续可增加可重建的仓库地图、变更回执和失败回退。仓库身份继续由 Lab 的项目配置授权，不用目录名称推导。 [Repo Memory 架构](https://github.com/memorax-ai/memorax-code/blob/e21227ab6ea0ef13e95ae866d8711b2cece8e16e/ARCHITECTURE.md#L858-L911) |
| 原生回合与写回 | Codex 按原生 rollout 的 session/turn 匹配。DSH 检查事件区间、连续序号及完成边界，排除注入和压缩内容。**适合做 Writer 候选准入**，下一轮先用中断、重复、错配和重启夹具验证。原生采集继续保留全部可得证据。 [Codex 回合](https://github.com/memorax-ai/memorax-code/blob/e21227ab6ea0ef13e95ae866d8711b2cece8e16e/packages/ts/memorax-code-backend/src/clients/codex/rollout-turn.ts#L98-L153) · [DSH 回合](https://github.com/memorax-ai/memorax-code/blob/e21227ab6ea0ef13e95ae866d8711b2cece8e16e/packages/ts/memorax-code-backend/src/clients/dsh/session-turn.ts#L151-L311) |
| 检索与上下文 | 客户端把 dense/sparse 参数传给服务。文档输出以块为单位控制长度并报告遗漏，可携带服务端文档和片段坐标。**保留现有分层装包**。评估本地来源过滤与可解释排序时沿用精确版本和完整证据组，控制整个输出的字节数。该客户端代码没有独立验证服务端检索质量。 [检索适配器](https://github.com/memorax-ai/memorax-code/blob/e21227ab6ea0ef13e95ae866d8711b2cece8e16e/packages/ts/memorax-code-backend/src/provider/memorax/adapter.ts#L227-L253) · [文档装包](https://github.com/memorax-ai/memorax-code/blob/e21227ab6ea0ef13e95ae866d8711b2cece8e16e/packages/ts/memorax-code-backend/src/provider/memorax/adapter.ts#L588-L656) |
| 项目作用域与云服务 | 本地校验 Git 元数据与工作区。远端 Coding Memory 身份使用基础用户 ID 与仓库名称，同名仓库可能共享。安装后的设置会启用自动写回。查询、所选回合和可选 Jev 有各自的数据流。**继续使用 Lab 的 `owner/project`**，云客户端与自动 Hooks 暂缓。 [作用域源码](https://github.com/memorax-ai/memorax-code/blob/e21227ab6ea0ef13e95ae866d8711b2cece8e16e/packages/ts/memorax-code-backend/src/repository/scope.ts#L18-L29) · [安全说明](https://github.com/memorax-ai/memorax-code/blob/e21227ab6ea0ef13e95ae866d8711b2cece8e16e/SECURITY.md#L183-L315) |
| 偏好、流程与删除 | 本地偏好支持更新与删除，流程单独存储。**借鉴范围、适用条件与变更意图**。Lab 中的撤销、纠正、检索隐藏和物理删除各有含义。物理删除需要明确各副本、派生产物和备份的规则。 [本地偏好操作](https://github.com/memorax-ai/memorax-code/blob/e21227ab6ea0ef13e95ae866d8711b2cece8e16e/packages/ts/memorax-code-backend/src/personal-memory/user-profile.ts#L278-L337) · [保留规则](https://github.com/memorax-ai/memorax-code/blob/e21227ab6ea0ef13e95ae866d8711b2cece8e16e/SECURITY.md#uninstall-and-retention) |

MemoraX Code 使用 MIT 许可。首轮实现调用本机 Git 命令并验证对象，没有引入上游运行时或复制实现。发行页报告了宿主兼容测试，效果仍应按 Lab 的真实检索场景独立评测。 [上游许可](https://github.com/memorax-ai/memorax-code/blob/e21227ab6ea0ef13e95ae866d8711b2cece8e16e/LICENSE)

## 本机 Git 证据入口

```sh
node bin/memory.cjs repo-evidence \
  --root "$repo" --commit "$full_commit_oid" --path spec/roadmap.md \
  --first-line 1 --last-line 8
```

输出包含提交、仓库相对路径、Git blob ID、首尾行、准确原文和片段 SHA-256。已有引用可用 `--expect-blob` 核验。该命令读取调用者显式选择的本地 Git 工作树。分支名、缩写提交、符号链接、二进制、子模块及超预算输入不作为文本证据返回。区间从 1 开始，包含首尾行，保留换行。每次最多 100 行和 8 KiB 片段，整文件上限 1 MiB。分支或工作区内容改变后，同一提交仍返回同一片段。

这是本地开发者入口，由用户或可信工作流选定工作树。命令依赖本地 Git 解析提交与文件路径，再独立复算返回的 blob 内容。可用对象也可能来自 Git 的 alternates。固定项目 MCP、Web 和定时任务保持现有访问范围。后续在 Wiki 或图谱持久化引用前，先建立项目与仓库绑定及提交可达性检查。独立保存 Git 证据是后续事项，源对象被清理后本命令会报告缺失。
