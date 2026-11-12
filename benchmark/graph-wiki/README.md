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

## 时序对照

归档、Kuzu 和 FalkorDBLite 对照读取同一个 `scenario.json`。归档侧通过实际查询返回决定，再沿查询结果回查作用域、会话、轮次、版本和原件可用性。Graphiti 侧通过库写入显式评审过的关系，在临时数据库执行 Graphiti 生成的时间筛选，并按 UUID 取回 episode。预期答案用于验收断言。

```sh
npm ci --ignore-scripts
npm run build
node benchmark/graph-wiki/run-temporal-baseline.cjs

graphiti_venv=$(mktemp -d)
uv venv --python 3.12.15 "$graphiti_venv"
uv pip install --python "$graphiti_venv/bin/python" -r benchmark/graph-wiki/graphiti-temporal-requirements.txt
"$graphiti_venv/bin/python" -B benchmark/graph-wiki/run-graphiti-temporal.py
```

Node 回放随项目 CI 运行。Graphiti 回放是可选实验，在 macOS arm64、Python 3.12.15、Graphiti 0.31.2 固定提交和 Kuzu 0.11.3 上验收。安装依赖需要网络。运行时禁用 Graphiti 遥测，使用进程内数据库，不调用模型。该 Graphiti 版本已标记 Kuzu 后端弃用。 [固定版本配置](https://github.com/getzep/graphiti/blob/ebef986a0b2360211b65751c111cacb4a7d790eb/pyproject.toml) · [Kuzu 驱动](https://github.com/getzep/graphiti/blob/ebef986a0b2360211b65751c111cacb4a7d790eb/graphiti_core/driver/kuzu_driver.py)

| 观察 | 现有归档 | Graphiti 回放 |
| --- | --- | --- |
| 决定何时生效 | 11:59 为 `route-decision`，12:00 为 `route-change`。 | 显式写入适用区间后相同。若把 11:00 的 episode 时间写入适用字段，11:59 已错误返回新决定。 |
| 何时知道任务依赖 | 固定 12:30 的适用时点。知晓截止从 12:30 移到 13:00 时，依赖从无变有。 | 显式将 12:45 写入 `created_at` 可复现筛选。实际业务知晓时间需要单独保存，重建时生成的创建时间可能改变查询结果。 |
| 来源与纠正 | DSH 可回查原件，Codex 可回查精确版本，纠正的历史时间为未知。 | episode 能返回应用显式保存的来源引用。回放未验证原件字节，也未应用纠正或抽取事实。 |

适用区间使用 `valid_at <= asOf`，结束时间为空或严格晚于 `asOf`。Graphiti 在其模型契约中区分未来计划的表达时间和未来发生时间。表中提前切换使用显式替代输入模拟该映射，未运行模型抽取。此对照不评定性能或框架胜负。 [时间筛选源码](https://github.com/getzep/graphiti/blob/ebef986a0b2360211b65751c111cacb4a7d790eb/graphiti_core/search/search_filters.py) · [边模型](https://github.com/getzep/graphiti/blob/ebef986a0b2360211b65751c111cacb4a7d790eb/graphiti_core/edges.py)

### FalkorDBLite 索引对照

```sh
falkor_venv=$(mktemp -d)
uv venv --python 3.12.15 "$falkor_venv"
uv pip install --python "$falkor_venv/bin/python" -r benchmark/graph-wiki/graphiti-falkor-requirements.txt
"$falkor_venv/bin/python" -B benchmark/graph-wiki/run-falkor-temporal.py
```

macOS arm64 上的固定版本 Graphiti／FalkorDBLite 0.11.0 实测，11:59 的默认筛选同时返回旧决定和新决定，12:00 只返回新决定。在同一临时图上，仅移除 `valid_at` 索引后，11:59 只返回旧决定；重建该索引后重新返回两条。关系、参数和其他索引保持不变。脚本保留各阶段的实际返回。 [Graphiti 索引定义](https://github.com/getzep/graphiti/blob/ebef986a0b2360211b65751c111cacb4a7d790eb/graphiti_core/graph_queries.py) · [FalkorDB 索引文档](https://docs.falkordb.com/cypher/indexing)

对照另行读取整个合成分区的两条关系，验证作用域、关系身份与 UTC 区间，再独立判断生效。两时点均命中预期决定，并取回对应的精确 episode 引用。脚本额外用一条上限检验溢出会拒绝结果。该验证仅适用于完整读到的合成分区，尚未验证大图、性能、生产查询或引擎内部原因。

实验使用临时本机 Unix socket，禁用遥测和模型调用。为清理固定版本的嵌入进程，脚本调用了客户端的私有关闭方法，并核对进程退出。此实验不在默认 CI 中安装数据库。
