# 中期使用手册

## 宿主机与服务

Node.js 24 是运行要求。CouchDB 可以在容器里运行。已授权的 Codex、DSH 通道应优先留在宿主机；全新容器的 CLI 认证需单独配置。Codex 宿主机已验证通过 ChatGPT 登录并完成合成 MCP 查询；DSH headless 合成运行明确报告缺少提供方凭据。桌面有模型选择器及一份未发送草稿，草稿被保留，桌面新会话与 Remote Host 连通性仍待验证，当前桌面探测等待用户解锁 Mac。原有两端的持久化文件适配器不需要模型或在线登录。

运行 `node bin/memory.cjs --help` 查看命令。每条命令都用 `--project` 选定项目，`--owner` 默认 `local`。不同设备应使用不同的 `--dir` 和不同实例标识。目录和归档分别使用 0700 和 0600 权限。CLI 的 `evidence` 会返回所请求归档原文，避免将其重定向到公共 CI、日志和版本控制。

## 初次回填与增量

```sh
node bin/memory.cjs ingest-tree --project work --source dsh \
  --root "$HOME/.dsh/sessions" --instance local --max-sessions 3 --max-records 100
node bin/memory.cjs ingest-tree --project work --source codex \
  --root "$HOME/.codex/sessions" --instance local --max-sessions 3 --max-records 100
node bin/memory.cjs coverage --project work
```

每个根目录按字典顺序枚举，`nextOffset` 可传给 `--offset` 继续。重新扫描同页会读取原有 checkpoint、重叠补扫并尝试修复未解决的坏行。单个已知文件用 `ingest --file`，用稳定的实例和会话标识。目录模式和单文件模式只有在会话标识一致时才会共享 checkpoint。先用有限页确认覆盖和缺失再扩大导入。明确报告不支持的私有格式、截断和改写缺口。坏行修复会轮转；被截短而找不到的位置仍留在覆盖缺口中。DSH 序号只在补扫读到相应源记录时恢复，未找到的序号继续标为缺失。每日和前台轮询会按最近会话和持久目录游标分配预算，失败的会话保留重试，逐会话复用 checkpoint。手动历史定位仍可用 offset。使用 `watch --manifest <private-json> --interval 60` 可在前台连续补扫。两轮合成验证中，第二轮只摄取新增记录。生命周期 hook 与实时订阅尚未接通。

## 私有原件与脱敏投影

导入器在识别受支持的会话记录外壳后，先保留原行，再做解析投影与脱敏。新事件类型仍能保留原件。Codex 保存逐条 JSONL 字节，DSH 的压缩日志保存解压后的逐条无损字节，均保留行尾。每条最多 1 MiB，每份会话每轮最多写入 16 MiB 新原件，重复内容不占新字节预算。原件存放在归档目录的 `originals/<sha256>.jsonl`，文件权限 0600。只有敏感字段变化时，脱敏预览可能相同，原始哈希和可引用的归档版本仍分别保留。

证据默认展示脱敏预览和原件摘要引用。`archived` 表示本机有对应原件，`source-only` 表示当前只有来源引用，`missing-locally` 表示引用已知但本机没有可核验的原件。旧投影只有在补扫实际读到源记录时才有原件；已被源改写或丢失的旧内容无法补造。遇到坏行、格式缺口或字节预算限制时保留缺口。用 `verify-original --id <item> --revision <version> --project work` 校验原件，仅返回哈希、字节数和校验结果。原件不经 MCP、网页、同步或 CI 输出；macOS 受限 MCP 进程可检查其元数据，不能读取原件字节。预览使用规则脱敏，不能视为敏感信息完整分类。

## 查询、批注和入口

```sh
node bin/memory.cjs find --project work --keyword "决策" --limit 5
node bin/memory.cjs timeline --project work --topic '返回的话题标识'
node bin/memory.cjs current --project work --topic '返回的话题标识'
node bin/memory.cjs serve --project work --port 8787
```

网页或 CLI 可以明确复核决定、变更和待办，也可以批注纠正。证据使用来源、条目 ID 和归档版本组合。变更引用前一条审核的编号；纠正必须引用确切解释的审核编号，保存即生效，拒绝另填生效时间。将来的决定或变更可单独指定生效时间。审核内容独立追加，保留原文和时间线。还没复核的原文可以搜索和查证，决定状态和下一步需要明确复核。话题有多个矛盾的决定时会标为待核实。

在任一支持 stdio MCP 的宿主注册命令 `node <repo>/bin/memory.cjs mcp --project work --dir <private-dir>`。默认只提供查询，启用 `--allow-annotations` 后可追加批注。共用 Skill 位于 `skills/agent-memory/SKILL.md`，用于查询、引用和复核流程。Codex 已用临时 MCP 配置通过合成验证；DSH 实际调用仍待验证。真实项目只在已授权的宿主范围内使用。

网页绑定 IPv4 loopback。可明确选择缓存最近的已复核目录和下一步，草稿仅在用户点击保存后存于该浏览器。离线重载需要固定端口和原先的浏览器配置。离线原文不可用，重新连接后可以用同一重试 ID 提交草稿。手机需要另做部署与设备验收。

## 每日整理

`daily --project work --manifest <private-json>` 接受一个输入数组。每个对象可选择单文件的 `source,file,instance,session` 或目录的 `source,root,instance`，可加 `max-records`、`max-sessions` 和 `offset`。目录条目也可设置 `"recent":true`，优先扫描最近更新的会话。清单为空也可重建当前项目的轻量索引、已复核决定视图和待审队列。运行统计只输出计数，快照留在私有目录的 `derived/`。模型提取和 Skill 草案生成标为待审，当前运行不会发起模型调用。归档、批注和生效决定都未变化时跳过派生写入。已排期的决定过了生效点后，Wiki 在下一次整理刷新，即使没有新增写入。缺乏足够证据时技能候选列表为空。

macOS 可用 `node bin/daily-launchd.cjs --dir <private-dir> --manifest <private-json> --project work` 生成用户 LaunchAgent。默认 03:00，按宿主机本地时区解释。Oslo 宿主对应 03:00 Europe/Oslo。将输出保存到私有 plist、用 `plutil -lint` 检查并用 `launchctl bootstrap gui/$(id -u) <plist>` 安装。已为 `private-acceptance` 私有试点注册 03:00 Europe/Oslo，并经调度器手动触发验证退出码为 0。每轮每端至多处理三份会话，每份最多摄取 40 条记录。预算在最近会话、失败重试和历史回补之间分配，无需人工为后台任务指定 offset。试点清单与派生快照在默认私有根目录的 `acceptance-*/` 子目录。可用 `launchctl bootout gui/$(id -u)/local.agent-memory-lab.daily` 停止试点。

## 合成语义整理验收

运行 `node bin/semantic-demo.cjs`。需要宿主机已登录的 Codex CLI。入口只接受仓库内哈希已固定的公开夹具 `examples/synthetic.json`，没有路径、项目或自定义输入参数。发送五条合成消息及 `semantic-candidates-v1` 提取说明，夹具中的预期事件不进入提示。临时会话跳过用户配置、记忆、hooks 和宿主 Skill 发现，关闭 shell、网页搜索和 MCP。构建侧固定为 `gpt-6-luna`、`low`，与召回验收分别计量。

每次最多一批，提示上限 4 KiB、结构化回答上限 8 KiB、超时 75 秒。最多四个候选，每条须有一到三处能精确匹配来源、条目、版本和引文的引用。候选全部进入「待核实」结果，独立于归档、当前决定和 Wiki。结构和引用校验用于核对证据链接，语义仍需复核。成功缓存键包括模型、推理强度、固定夹具哈希、含来源版本的提示、提示版本和输出结构。读取缓存时再次校验用量与候选引用。失败不缓存，可以重试，能取得的失败用量单独报告。

私有运行目录可用 `node bin/memory.cjs semantic-status --project work` 查看待处理条数、脱敏预览字节总量和 `requires-user-consent` 状态。该命令只输出统计。03:00 任务更新本地队列和确定性派生，模型调用数为 0。真实会话的外部模型处理须另行获得数据范围和发送授权。

## 私有 CouchDB 同步

给每个 owner/project 使用专用私有数据库。先通过授权管理员完成单节点初始化、建库和账号角色分配，再使用 `provision-hub --project work --couch-url <database-url>` 安装权限规则。运行时用私有环境注入 `MEMORY_LAB_COUCH_AUTHORIZATION`，URL 不带凭据。管理员仅用于配置，普通设备使用最小角色。非 loopback URL 要求 HTTPS。避免在浏览器、公共日志、shell 历史或公共仓库保存任何账号密钥。

- `archive_reader` 用 `sync --sync-mode pull`。
- `archive_annotator` 用 `sync --sync-mode annotations`。
- 采集器独用 `archive_writer` 与 `sync --sync-mode all`。

`sync` 默认为 pull。各端本地 checkpoint 独立，归档版本和批注通过共享库交换。角色限制在实际 CouchDB 中验过。能以同一 OS 用户直接访问私有文件的进程仍具备该用户的文件权限。部署时应使用限制文件访问的宿主或独立服务账户，对普通 Agent 只暴露范围固定的查询和批注接口。不要向普通 Agent 分发采集器凭据。macOS 可将 MCP 命令改为 `bin/readonly-mcp-macos.sh --dir <private-dir> --project work`。该进程实际通过过查询和直接写入拒绝测试，提供只读工具并禁止该进程写文件及联网。它依赖宿主 `sandbox-exec`。批注通过网页或明确授权的写入 MCP 追加。配置未长期开放 hub；合成验证仅使用本机回环地址。
