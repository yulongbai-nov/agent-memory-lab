# 中期使用手册

## 宿主机与服务

宿主安装使用 Node.js 24.22.1 和 `npm ci --ignore-scripts && npm run build`。DSH 压缩记录包含连续 Zstandard 帧，导入器在读取前验证解码能力。CouchDB 可以在容器里运行。宿主机 Codex 已用既有登录完成合成 MCP 查询。Linux 隔离任务用独立代理验证 Codex 与 DSH 的模型和记忆查询。宿主 DSH 桌面 profile、Remote Host 和真实手机另行验收。两端的持久化文件导入可离线执行。

运行 `node bin/memory.cjs --help` 查看命令。本机 SQLite 迁移、旧档和回退出口见 [本机索引 ADR](adr-local-sqlite-index.md)。普通查询以只读方式打开已有档案。每条命令都用 `--project` 选定项目，`--owner` 默认 `local`。不同设备应使用不同的 `--dir` 和不同实例标识。目录和归档分别使用 0700 和 0600 权限。CLI 的 `evidence` 会返回所请求归档原文，避免将其重定向到公共 CI、日志和版本控制。

## 初次回填与增量

```sh
node bin/memory.cjs ingest-tree --project work --source dsh \
  --root "$HOME/.dsh/sessions" --instance local --max-sessions 3 --max-records 100
node bin/memory.cjs ingest-tree --project work --source codex \
  --root "$HOME/.codex/sessions" --instance local --max-sessions 3 --max-records 100
node bin/memory.cjs coverage --project work
```

每个根目录按字典顺序枚举，`nextOffset` 可传给 `--offset` 继续。重新扫描同页会读取原有 checkpoint、重叠补扫并尝试修复未解决的坏行。推进断点时同时检查位置和覆盖版本。单个已知文件用 `ingest --file`，用稳定的实例和会话标识。目录模式和单文件模式只有在会话标识一致时才会共享 checkpoint。先用有限页确认覆盖和缺失再扩大导入。明确报告不支持的私有格式、截断和改写缺口。坏行修复会轮转；被截短而找不到的位置仍留在覆盖缺口中。DSH 序号只在补扫读到相应源记录时恢复，未找到的序号继续标为缺失。每日和前台轮询会按最近会话和持久目录游标分配预算，失败的会话保留重试，逐会话复用 checkpoint。手动历史定位仍可用 offset。使用 `watch --manifest <private-json> --interval 60` 可在前台连续补扫。两轮合成验证中，第二轮只摄取新增记录。生命周期 hook 与实时订阅尚未接通。

Codex 的目录清单可同时指定 `root` 和 `archiveRoot`。活跃会话移动到归档目录时，导入器用常规 rollout 文件名和会话头核对身份，继续使用原 checkpoint 和条目键。两处字节完全一致的副本只读取一次。文件不同或两种旧身份都存在时，留待复核。旧身份和原件继续可读。

归档写入和目录摄取使用跨进程锁，竞争时有界等待。新进程异常退出后，系统锁会释放，后续运行可恢复已识别的新版锁标记。无法识别的旧锁标记会保留，需要先核查旧进程状态。并发每日整理对同一范围的派生写入串行执行。

## 私有原件与脱敏投影

导入器在识别受支持的会话记录外壳后，先保留原行，再做解析投影与脱敏。新事件类型仍能保留原件。Codex 保存逐条 JSONL 字节，DSH 的压缩日志保存解压后的逐条无损字节，均保留行尾。已验证的 DSH v4 会话头作为来源元数据归档，旧的头行缺口只有在实际补扫读取并核验后才清除。每条最多 1 MiB，每份会话每轮最多写入 16 MiB 新原件，重复内容不占新字节预算。原件存放在归档目录的 `originals/<sha256>.jsonl`，文件权限 0600。只有敏感字段变化时，脱敏预览可能相同，原始哈希和可引用的归档版本仍分别保留。

证据默认展示脱敏预览和原件摘要引用。`archived` 表示本机有对应原件，`source-only` 表示当前只有来源引用，`missing-locally` 表示引用已知但本机没有可核验的原件。旧投影只有在补扫实际读到源记录时才有原件；已被源改写或丢失的旧内容无法补造。遇到坏行、格式缺口或字节预算限制时保留缺口。用 `verify-original --id <item> --revision <version> --project work` 校验原件，仅返回哈希、字节数和校验结果。原件不经 MCP、网页、同步或 CI 输出；macOS 受限 MCP 进程可检查其元数据，不能读取原件字节。预览使用规则脱敏，不能视为敏感信息完整分类。

## 查询、批注和入口

```sh
node bin/memory.cjs find --project work --keyword "决策" --limit 5
node bin/memory.cjs timeline --project work --topic '返回的话题标识'
node bin/memory.cjs current --project work --topic '返回的话题标识'
node bin/memory.cjs serve --project work --port 8787
```

网页或 CLI 可以明确复核决定、变更和待办，也可以批注纠正。证据使用来源、条目 ID 和归档版本组合。变更引用前一条审核的编号；纠正必须引用确切解释的审核编号，保存即生效，拒绝另填生效时间。后来另有原始消息作为依据时，在 CLI 的 `annotate --kind correction` 同时传入旧 `--target`、`--revises` 审核编号和新 `--evidence` 精确引用。MCP 对应字段为 `target`、`revises` 和 `evidence`。查询保留旧 `citation`，有新证据时另返回 `effectiveCitation`。各同步端须先升级再传输含新字段的纠正。将来的决定或变更可单独指定生效时间。审核内容独立追加，保留原文和时间线。还没复核的原文可以搜索和查证，决定状态和下一步需要明确复核。话题有多个矛盾的决定时会标为待核实。

在支持 stdio MCP 的宿主可注册 `node <repo>/bin/memory.cjs mcp --project work --dir <private-dir>`。默认只提供查询，启用 `--allow-annotations` 后可追加批注。[共用 Skill](../skills/agent-memory/SKILL.md) 说明如何使用已核实的私有 MCP 绑定，或发现 `$HOME/.local/share/agent-memory-lab/memory-private.sh` 固定范围只读入口。Codex 中的 `agent-memory-synthetic-demo` 只提供合成档案查询。Codex 和 DSH 的临时隔离配置已验证运行时能发现链接的 Skill，该结论仅覆盖对应配置及当时的进程。两个宿主的符号链接、共用 Skill 文件和固定范围只读脚本是安装与路由条件。2026-11-11，用户新开的 DSH Default workspace 会话以界面所示 GPT-6-Luna / Low 完成一次限定提示，显示用时 5 秒。Called tools 中实际执行的 Skill agent-memory 展示了与共用文件一致的说明及 DSH Skill 基目录，验证了该日常桌面会话发现并加载说明。该次列出了 memory_find、memory_timeline 和 memory_current 三个只读入口。记忆查询、历史读取及私有 MCP 绑定另行验收，其他既有会话的自动发现仍待验证。使用本机 CLI 时，仍须核实工具输出是否获准发送给当前模型。

用户随后在同一 DSH Default workspace 桌面会话完成一次合成 CLI 检查，界面配置为 GPT-6-Luna / Low，一次请求显示 25 秒完成。实际轨迹包含 Skill agent-memory，以及固定 local/demo 合成范围内的 find、timeline、current 和两次 evidence。查找返回 5 个候选、总数 12；Release checklist 时间线为两条且无后页，决定和待办答案与证据文本及归档版本引用一致。两次证据均标为 source-only / capture-not-configured，因此核验范围是合成归档版本引用。原件字节回查、私有 MCP 调用、真实召回和其他会话仍需分别验收；模型型号以本次 UI 配置为证据。

2026-11-11 的只读检查显示，DSH Remote UI 已登录，但连接数为 0，且没有可用 Host。账号登录、Host 连接和手机 Remote 使用分别验收。

网页绑定 IPv4 loopback，可选同一 Mac 的私网 HTTPS 代理。用户可主动保存已复核摘要和下一步，草稿存于同一浏览器。离线重载需要保持原先的浏览器配置和来源。重新连接后可用同一重试 ID 提交草稿。[手机接入与验收](mobile-access.md)

## 每日整理

`daily --project work --manifest <private-json>` 接受一个输入数组。每个对象可选择单文件的 `source,file,instance,session` 或目录的 `source,root,instance`，可加 `max-records`、`max-sessions` 和 `offset`。目录条目也可设置 `"recent":true`，优先扫描最近更新的会话。清单为空也可重建当前项目的轻量索引、已复核决定视图和待审队列。运行统计只输出计数，快照留在私有目录的 `derived/`。确定性整理阶段不调用模型，外部语义待授权。归档、批注和生效决定都未变化时跳过派生写入。已排期的决定过了生效点后，Wiki 在下一次整理刷新，即使没有新增写入。缺乏足够证据时技能候选列表为空。

macOS 可用 `node bin/daily-launchd.cjs --dir <private-dir> --manifest <private-json> --project work` 生成用户 LaunchAgent。默认 03:00，按宿主机本地时区解释。Oslo 宿主对应 03:00 Europe/Oslo。将输出保存到私有 plist、用 `plutil -lint` 检查并用 `launchctl bootstrap gui/$(id -u) <plist>` 安装。私有试点的旧配置已有自然触发与快照记录，当前重载后的配置仍待观察首次自然触发。运行计数按当前加载实例计算。每轮每端至多处理三份会话，每份最多摄取 40 条记录。预算在最近会话、失败重试和历史回补之间分配，无需人工为后台任务指定 offset。试点清单与派生快照在默认私有根目录的 `acceptance-*/` 子目录。可用 `launchctl bootout gui/$(id -u)/local.agent-memory-lab.daily` 停止试点。

## 本机持续摄取

`bin/daily-launchd.cjs --interval-seconds 120` 可为只含 `"incremental":true` 目录条目的私有清单生成变更采集任务。私有试点已注册 `local.agent-memory-lab.collector`，每 120 秒唤起一次有界运行。每轮每端最多 2 份变化会话、每份最多 80 条，超大投影批次会标记阻断。以文件元数据跳过未变化来源，较早失败的来源轮转重试；长期回填活跃时本轮让行。每会话前按当前索引大小检查容量。任务只做本地追加与基础索引，模型调用为 0。退出码 0 表示进程正常退出，积压和阻塞仍需查看采集统计。03:00 的任务负责每日派生整理与有界回补。

用 `launchctl bootout gui/$(id -u)/local.agent-memory-lab.collector` 停用持续摄取。恢复时用 `launchctl bootstrap gui/$(id -u) "$HOME/Library/LaunchAgents/local.agent-memory-lab.collector.plist"`。两条命令只操作持续摄取。合成试点验证了定时新增、停用和重新启用。

## 合成语义整理验收

运行 `node bin/semantic-demo.cjs`。需要宿主机已登录的 Codex CLI。入口只接受仓库内哈希已固定的公开夹具 `examples/synthetic.json`，没有路径、项目或自定义输入参数。发送五条合成消息及 `semantic-candidates-v1` 提取说明，夹具中的预期事件不进入提示。临时会话跳过用户配置、记忆、hooks 和宿主 Skill 发现，关闭 shell、网页搜索和 MCP。构建侧请求配置固定为 `gpt-6-luna`、`low`，与召回验收分别计量。接口未提供可独立核验的已解析型号。

每次最多一批，提示上限 4 KiB、结构化回答上限 8 KiB、超时 75 秒。最多四个候选，每条须有一到三处能精确匹配来源、条目、版本和引文的引用。候选全部进入「待核实」结果，独立于归档、当前决定和 Wiki。结构和引用校验用于核对证据链接，语义仍需复核。成功缓存键包括模型、推理强度、固定夹具哈希、含来源版本的提示、提示版本和输出结构。真实 CLI 缓存和注入测试缓存采用不同命名空间，读回时核对来源元组、用量及候选引用。旧格式条目不迁移。失败不缓存，可以重试，能取得的失败用量单独报告。

私有运行目录可用 `node bin/memory.cjs semantic-status --project work` 查看待处理条数、脱敏预览字节总量和 `requires-user-consent` 状态。该命令只输出统计。03:00 任务更新本地队列和确定性派生，外部模型调用数为 0。启用 `--local-draft` 时，草稿阶段可能运行本地推理。真实会话的外部模型处理须另行获得数据范围和发送授权。

## 手动本地语义构建

在已迁移的私有 SQLite 档案上显式运行一批：

```sh
node bin/local-derive.cjs --dir <private-dir> --owner local --project <project>
```

`--synthetic` 用同一公开合成夹具验收，可指定单独的私有空目录。实际构建使用本机现有的 llama.cpp 和 Qwen3.5 4B Q4_K_M。它优先选择已有结束标记且有决定、变更或下一步线索的轮次，同一轮次最多选取五条用户或助手预览。能匹配原件的短消息保留全文，长消息可从至多 32 KiB 的预览中选取有界的原句片段。已知转派包装只取输入字段，并标明是转派片段。未知包装、转录增量、工具、配置、未完成条目、找不到本机原件的记录，以及仍需脱敏的片段均跳过。输入总长上限为 1,500 字节。短引用别名映射回实际来源、条目与版本，再对归档脱敏预览逐字校验。每个入选片段都要唯一匹配哈希核验后的原件字段，草稿记录全文、片段或转派投影。原件偏移从解码后的字段字符串起算，采用零基、半开区间，分别记录 UTF-16 代码单元和 UTF-8 字节；预览偏移使用 UTF-16。原件定位包含字段路径和哈希。完整原件哈希可通过独立的 `verify-original` 命令校验。

推理使用命令行，不监听网络。macOS 沙盒拒绝网络、写文件和用户数据目录读取，在这些目录中仅允许读取固定模型和本次私有临时输入。系统运行库仍可读。每次启动前验证禁网和合成文件读取拒绝，失败则停止。两条 CPU 线程，上下文 768 token，输出上限 384 token，最长 60 秒。内存压力与进程常驻内存受监控。提示和临时文件存放在经 Git 工作树校验的私有 `local-derive/` 子目录，目录 0700、文件 0600。若该子目录自身已初始化为 Git 仓库，入口也会拒绝运行。

命令仅打印统计。成功候选另存为档案目录下 `local-derive/latest-*.json`，其中的 `draftFile` 指向同目录的 `draft-*.txt`。草稿供本机文件管理器或本地编辑器人工审阅，状态固定为「待核实」，与已确认决定的 Wiki 分开。文本和标记字符会转义，引用以来源、条目、版本和原句显示。网页和普通 MCP 均无候选读取入口。缓存按作用域、输入版本、模型文件 SHA-256 和提示版本区分。校验失败保留待处理状态，无变化时复用成功缓存。

日常确定性整理仍先运行。可为 `daily` 或 `bin/daily-launchd.cjs` 显式添加 `--local-draft`，每次最多处理一个本地批次。代码默认关闭。当前私有试点已在 03:00 的 LaunchAgent 中显式启用，保留原 plist 的私有备份。去掉此参数并重新加载任务即可停用草稿阶段。私有 `derived/local-draft-*.json` 分别记录本地与外部模型调用数、校验状态和安全计数。外部私有语义处理继续标记为 `requires-user-consent`，召回基准保持 `gpt-6-luna` low。

## 私有 CouchDB 同步

给每个 owner/project 使用专用私有数据库。先通过授权管理员完成单节点初始化、建库和账号角色分配，再使用 `provision-hub --project work --couch-url <database-url>` 安装权限规则。运行时用私有环境注入 `MEMORY_LAB_COUCH_AUTHORIZATION`，URL 不带凭据。管理员仅用于配置，普通设备使用最小角色。非 loopback URL 要求 HTTPS。避免在浏览器、公共日志、shell 历史或公共仓库保存任何账号密钥。

- `archive_reader` 用 `sync --sync-mode pull`。
- `archive_annotator` 用 `sync --sync-mode annotations`。
- 采集器独用 `archive_writer` 与 `sync --sync-mode all`。

`sync` 默认为 pull。各端本地 checkpoint 独立，归档版本和批注通过共享库交换。角色限制在实际 CouchDB 中验过。能以同一 OS 用户直接访问私有文件的进程仍具备该用户的文件权限。部署时应使用限制文件访问的宿主或独立服务账户，对普通 Agent 只暴露范围固定的查询和批注接口。不要向普通 Agent 分发采集器凭据。macOS 可将 MCP 命令改为 `bin/readonly-mcp-macos.sh --dir <private-dir> --project work`。该进程实际通过过查询和直接写入拒绝测试，提供只读工具并禁止该进程写文件及联网。它依赖宿主 `sandbox-exec`。批注通过网页或明确授权的写入 MCP 追加。已在本机配置可复用的私有 CouchDB 实例、持久卷和独立角色，验证了只在回环地址监听与重启持久化。交付时实例停止，按本地交付记录中的脚本启动。档案未上传至该实例；需要 Mac 离线时仍可访问的常在线节点，须另行选择受信主机。
