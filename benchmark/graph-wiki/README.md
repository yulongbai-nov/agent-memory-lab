# Graph + Wiki 合成验收场景 v0.1

[scenario.json](scenario.json) 用虚构的 Moonbridge 灯笼路线验证一条端到端链路。评审先把 DSH 的 Tuesday 误记为公开活动，随后独立 DSH 消息澄清它是彩排。Codex 在 11:00 将彩排改为从 12:00 起的 Wednesday，后续的 Thursday 提议未获确认。清单任务初始开放。追加独立 Codex 完成观察后，从接续列表移除，决定保持 Wednesday。旧 DSH 版本、更新版本及其它项目同 ID 的 Codex 条目都在夹具内。[查询契约](../../spec/graph-wiki-contract-v0.1.md)

## 播种与回放

使用仓库外的临时归档目录，通过 `openArchive` 打开。按以下顺序使用现有 API，无需改变持久化字段。

1. 对每条 `fixture.originals`，将 `utf8` 编码为 UTF-8 原件并交给 `originalCapture(dir)`。用 `references[ref]` 找到对应归档条目，按其 `metadata.original.coordinate` 捕获。返回元数据须等于该条目已有的 `metadata.original`。其余版本仍按各自的原件可用性显示。
2. 按顺序把 `fixture.batches` 传给 `archive.importBatch(batch)`，把 `fixture.annotations` 传给 `archive.addAnnotation(note)`。这些行使用现有输入形状。`references` 只在夹具内为固定引用提供别名，每条含 `scope` 与精确 `{id, revision, source}`。调用 `evidence` 时绑定对应范围并传入引用的三项。
3. 基线用 `fixture.dependencies` 作为 `rebuildProjection` 的已批准依赖侧车。完成测试到达相应步骤后，再追加 `fixture.stages.completed.annotations`。`recordedAt` 仍由真实归档入口分配。`occurredAt` 是合成历史事件，测试不要求导入时钟等于历史时钟。
4. 只向被测入口提供当前范围、输入资料和 `queries`。`expected` 由验收端读取，不能进入检索、读者或图构建。请求沿用[既有检索对照](../memory-views/retrieval-spec.json)的 `id`／`text`／`request` 形状，预期沿用[对照答案](../memory-views/retrieval-oracle.json)的 `status`／`facts`／`support`／`relevant`。新增的 `assertions` 供浏览器或接口验收读取，`request.kind` 仅用于场景分派。

## 验收重点

浏览器第一轮在项目页用 `blue lantern` 找到五条候选，从候选和知识主题入口访问同一个决定。打开关系图或时间线，看到原评审、澄清和后续变更的区别。沿引用打开旧 DSH 原件已归档的版本和 Codex 仅归档文本的版本，核对各自的 Harness、会话、turn 和 `revision`。浏览器回归实际点击 Cytoscape 决定节点，核对请求和证据面板中的旧 DSH 精确引用。用文字入口重复证据导航。确认清单待办有下一步。追加完成观察后，已完成状态在主题历史保留，接续列表不再建议它。

`effective-boundary` 用 11:59 与 12:00 检查适用决定 ID 切换，同时保留旧纠正历史时间未知。`dependency-time` 在同一适用时点比较两个知晓截止，只验证侧车关系。它们可以由当前查询和投影核对，不要求首轮浏览器暴露两个历史视图。后续对照 Graphiti 时固定此资料、问题和预期，分别记录框架的时间、精确引用和来源可用性结果，以及构建和查询开销。

此夹具是验收输入。归档与现有查询可播种检查。浏览器交互、组件适配、私有资料和任何框架对照分别记录运行结果。
