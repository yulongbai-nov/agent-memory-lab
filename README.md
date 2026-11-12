# Agent Memory Lab

本机跨 Harness 记忆系统。先归档 Codex 和 DSH 会话及来源版本，再用这些证据回溯决定、接续未完任务。公共仓库保留代码、规格和公开合成评测。个人档案留在本机。

## 现在能用什么

- 归档可读取的 Codex、DSH 会话，按来源和 checkpoint 续接。用 `coverage` 查看已导入范围和缺口。
- 按时间或关键词查找候选，用 `timeline`、`current`、`task-list` 和 `evidence` 回查决定、任务和精确版本。CLI 可显式加 `--preview`。共享 Skill 支持已核实的本机只读入口。
- 在本机读取 v1 草稿或显式读取 v2 快照。操作员可经 `draft-publish` 和 `draft-review` 发布已有 v2 候选、审阅决定或待办并回查来源链。决定变更和纠正走既有 `annotate`。

## 如何开始

用 Node.js **24.22.1** 在独立临时目录打开合成演示。以下流程无需真实档案或模型调用。

```sh
npm ci --ignore-scripts
npm run build
demo_dir=$(mktemp -d)
node bin/seed-demo.cjs "$demo_dir"
node bin/memory.cjs find --dir "$demo_dir" --project demo --keyword Release --limit 5
node bin/memory.cjs task-list --dir "$demo_dir" --project demo --limit 20
node bin/memory.cjs serve --dir "$demo_dir" --project demo
```

打开最后一条命令打印的本机网址，搜索 `Release` 并选择 `Release checklist`。接入已有档案时，先按[本机使用手册](spec/midpoint-usage.md)核实目录、范围和权限，再查个人资料。

## 怎么读规格

- 想了解系统要解决什么，读[长期路线图](spec/roadmap.md)和[设计决定](spec/design-decisions.md)。
- 想核对数据格式、时间、任务、草稿或同步规则，从[规格目录](spec/README.md)进入相应契约。
- 想改代码或运行验收，读[仓库协作入口](AGENTS.md)和[工程规范](spec/engineering-quality.md)。

## 进度去哪看

[当前完成计划](plan.md)记录六项目标的状态、证据、缺口和下一步。[中期验收记录](spec/midpoint-status.md)保留当时的结果和失败。
