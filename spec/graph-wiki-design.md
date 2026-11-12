# Graph + Wiki 设计与研究

本文区分已确认需求、建议与待决事项；不声明新的运行能力。长期目标见[路线图](roadmap.md)，现有图投影的精确边界见[投影规格](ontology-projection-v0.1.md)。

## 用户已确认

- 项目工作页与知识主题页是平级入口；可视化是正式需求。关系图选用 Cytoscape.js，时间线选用 vis-timeline；优先复用或适配现成组件。选型不代表已安装、接入、测试或达到性能目标。
- 原始会话不可变，纠正追加；Wiki、图及索引是可重建视图。引用须定位 harness、session、turn 和 revision，并保留作用域及来源可用性。
- 决定状态区分**已确定、待决定、待核实、已替代、已取消**；与任务执行状态分开。时间或话题线索应提供约五个候选，供用户进一步查证。

## 现有实现与边界

仓库已有 Wiki、查询、时间线和小型确定性图投影；后者只使用已审核批注与精确归档版本，不推断事实或同步图数据库。其合成场景和历史歧义边界见[投影规格](ontology-projection-v0.1.md)。这些不证明下述 Graph + Wiki 界面、完整时间模型或真实资料验收已经完成。

## 建议的共同基础与交互

页面链接图表达页面之间的导航；语义事实图表达实体和有依据的关系，两者不能混同。建议两个入口共享实体 ID、作用域、来源版本和可追溯事实：区分用户表达与系统推断；记录表达时间、适用时间和系统记录时间，未知则保留未知。最新写入不能自动解决冲突。Ontology 定义概念、关系和语义；Schema 负责验证，存储引擎负责持久化，图和 Wiki 是视图，各层职责分开。

建议从项目或主题页进入局部关系图或决定时间线，按需过滤和展开，显示状态文字与颜色，并打开精确来源面板。保留文本／列表入口、键盘友好的来源导航。纠正应通过经验证的命令追加，不能直接改写原件；前端图不作为事实或本体的权威来源。具体布局与操作仍待设计。

## 组件研究与边界

| 组件 | 定位与状态 |
| --- | --- |
| [Cytoscape.js](https://js.cytoscape.org/) | 已选关系图，MIT；适配、无障碍和规模表现待测。 |
| [vis-timeline](https://github.com/visjs/vis-timeline) | 已选时间线，Apache-2.0 OR MIT；时间含义由本项目契约提供，接入待测。 |
| [Sigma.js](https://www.sigmajs.org/) | MIT，大图浏览备选，非当前首选。 |
| [React Flow](https://reactflow.dev/) | MIT 核心，未来本体／Schema 编辑器候选，首批不要求。 |
| [llmwiki](https://github.com/lucasastorian/llmwiki) | Apache-2.0，页面、来源脚注和图查看器的复用研究候选；支持删除，部分注释元数据仅存 index.db，不能整体套用其来源语义。 |
| [LLM Wiki 设计笔记](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) | Wiki 组织思路参考，非实现或验收证据。 |

[Graphiti OSS](https://github.com/getzep/graphiti/tree/ebef986a0b2360211b65751c111cacb4a7d790eb) 是研究候选，尚未采用；不能将 Zep Cloud 能力当作 OSS 能力。其 `valid_at`、`invalid_at`、`created_at`、`expired_at` 和 episode 引用本身不自动满足本项目完整的精确来源及历史语义，所核[代码](https://github.com/getzep/graphiti/blob/ebef986a0b2360211b65751c111cacb4a7d790eb/graphiti_core/edges.py)中，`valid_at` 对未来计划可能使用 episode reference time，不等于决定未来的实际适用时间；重建图的 `created_at` 也不能冒充权威系统首次获知时间。须逐字段映射，并以相同案例验证缺口及重建。首批不安装全部候选库。

## 待决定及推进顺序

待决定：Wiki 纠正和自动整理规则、最小 ontology 概念与关系集合、UI 布局；是否同时提供“以当前知识重建过去”和“当时系统所知”两种历史视图；以及使用一个物理引擎，还是一个权威来源加可重建图索引。这些均非已批准的实现方案。

1. 先定义最小查询、来源和时间契约，包括缺失、冲突与五种决定状态。
2. 用同一合成案例覆盖 DSH 决定、Codex 后续变更、时间边界和两端精确来源；验证纠正不改原件及任务状态独立。
3. 评估现有组件并制作低保真设计，再定义接口和原型；验证项目／主题页到图或时间线再到证据的路径，以及文本和键盘访问。
4. 以同一资料、问题和预算对照现有投影／Wiki 与 Graphiti，再进行后续有界真实资料验收。十一月文件、Markdown journal、ledger 和文本检索方案是 benchmark baseline；召回使用 `gpt-6-luna`、`low`，构建和语义理解成本单独计量。

新增适配器遵守严格 TypeScript 和现有 lint／质量门禁。合成结果、真实资料验收和实际部署分别报告。
