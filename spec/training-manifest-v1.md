# 训练与评测样本清单 v1

构建后运行公开合成清单命令。JSON 输出可用来核对监督样本、证据和用途授权。

```sh
node bin/memory.cjs training-manifest --synthetic
```

`fixtures` 记录随包公开合成夹具的路径及 SHA-256。命令从固定路径读取夹具，校验摘要后组装清单。命令要求 `--synthetic`，可加 `--split train` 或 `--split test`。

| 字段 | 含义 |
| --- | --- |
| `manifest.samples` | 问题、预期答案、用途和数据分区。标签区分决定、纠正、改变、任务、冲突和负例。`validTime` 和 `observedTime` 保留来源时间的精度与偏移。未记录的时间省略。 |
| `manifest.registry` | 已使用的证据版本。每项记录作用域、来源、条目、版本和源记录摘要。合成命令附上同版片段。 |
| `manifest.grants` | 样本实际使用的精确版本用途授权。合成命令的 `authorizationId` 指向相应夹具摘要及其内置用途规则。 |
| `manifest.contentHash` | 对版本、已使用证据、用途授权和样本计算的内容版本。输入记录顺序不改变结果，样本内部证据顺序保留。 |

构建器要求每条引用匹配精确版本，并有对应训练或评测用途的授权。相同 Harness、实例和会话的修订及作用域副本属于同一分区。可信来源标注了共同会话沿革时，跨 Harness 副本也按同一来源检查。跨分区共享来源会拒绝生成清单。

`buildTrainingManifest` 接收调用方已核实的授权清单。公开合成命令用固定夹具及用途规则建立该输入。真实资料的授权来源核验、派生样本独立评测及模型训练仍待验收。

## 分区导出

```sh
node bin/memory.cjs training-manifest --synthetic --split train > training-split-train.json
node bin/memory.cjs training-manifest --synthetic --split test > training-split-test.json
```

导出先验证完整清单及其内容版本。每份 `training-split-v1` 文件只包含所选分区的样本和这些样本使用的证据授权。`sourceManifestHash` 指向同一份清单，`contentHash` 校验本文件的分区内容。

样本的 `input` 包含问题和同版证据片段，`expected` 包含答案、标签及已知时间。`evidenceRegistry` 按精确引用记录来源摘要、用途、授权标识和已知的共同会话沿革。运行留出评测时，模型输入使用 `input`，答案判定使用 `expected`。

公开合成文件可分别交给训练和评测流程的后续验证。实际训练和模型评测需要独立验收。

## 离线评测回放

```sh
node bin/memory.cjs training-eval-requests --synthetic > evaluation-requests.json
node bin/memory.cjs training-eval-score --synthetic < predictions.json
```

两个入口各自重建固定公开留出分区。请求文件的 `requests[].input` 仅包含问题和同版证据。调用方保留请求 `id` 和整批 `contentHash`，提供给模型的是 `input`。输入生成和评分命令都在本机运行。

评分从标准输入读取至多 1 MiB UTF-8 JSON。顶层包含 `version`、`requestsHash` 和 `responses`。`version` 使用 `training-eval-predictions-v1`，`requestsHash` 取请求文件的 `contentHash`。每条响应包含样本 `id`、答案字符串 `answer` 和精确引用数组 `evidence`。摘要不符、未知或重复样本会拒绝评分。

评分分别统计与预期文本完全一致的答案、引用均属于该请求且引用非空的响应，以及缺失的样本。回执含样本标识和结果布尔值。语义等价和引用是否足以支持答案仍需独立评测。
