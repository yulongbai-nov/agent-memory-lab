# 中期使用手册

## 宿主机与服务

Node.js 24 是运行要求。CouchDB 可以在容器里运行。已授权的 Codex、DSH 通道应优先留在宿主机；全新容器的 CLI 认证需单独配置。Codex 宿主机已验证通过 ChatGPT 登录并完成合成 MCP 查询；DSH headless 合成运行明确报告缺少提供方凭据。桌面有模型选择器及一份未发送草稿，草稿被保留，桌面新会话与 Remote Host 连通性仍待验证。原有两端的持久化文件适配器不需要模型或在线登录。

运行 `node bin/memory.cjs --help` 查看命令。每条命令都用 `--project` 选定项目，`--owner` 默认 `local`。不同设备应使用不同的 `--dir` 和不同实例标识。目录和归档分别使用 0700 和 0600 权限。CLI 的 `evidence` 会返回所请求归档原文，避免将其重定向到公共 CI、日志和版本控制。

## 初次回填与增量

```sh
node bin/memory.cjs ingest-tree --project work --source dsh \
  --root "$HOME/.dsh/sessions" --instance local --max-sessions 3 --max-records 100
node bin/memory.cjs ingest-tree --project work --source codex \
  --root "$HOME/.codex/sessions" --instance local --max-sessions 3 --max-records 100
node bin/memory.cjs coverage --project work
```

每个根目录按字典顺序枚举，`nextOffset` 可传给 `--offset` 继续。重新扫描同页会读取原有 checkpoint、重叠补扫并尝试修复未解决的坏行。单个已知文件用 `ingest --file`，用稳定的实例和会话标识。目录模式和单文件模式只有在会话标识一致时才会共享 checkpoint。先用有限页确认覆盖和缺失再扩大导入。明确报告不支持的私有格式、截断和改写缺口。定期补扫可通过每日清单重跑。使用 `watch --manifest <private-json> --interval 60` 可在前台连续补扫。两轮合成验证中，第二轮只摄取新增记录。生命周期 hook 与实时订阅尚未接通。

## 查询、批注和入口

```sh
node bin/memory.cjs find --project work --keyword "决策" --limit 5
node bin/memory.cjs timeline --project work --topic '返回的话题标识'
node bin/memory.cjs current --project work --topic '返回的话题标识'
node bin/memory.cjs serve --project work --port 8787
```

网页或 CLI 可以明确复核决定、变更和待办，也可以批注纠正。证据使用来源、条目 ID 和归档版本组合。变更引用前一条审核的编号；纠正可引用某条解释的审核编号。审核内容独立追加，保留原文和时间线。还没复核的原文可以搜索和查证，决定状态和下一步需要明确复核。话题有多个矛盾的决定时会标为待核实。

在任一支持 stdio MCP 的宿主注册命令 `node <repo>/bin/memory.cjs mcp --project work --dir <private-dir>`。默认只提供查询，启用 `--allow-annotations` 后可追加批注。共用 Skill 位于 `skills/agent-memory/SKILL.md`，用于查询、引用和复核流程。Codex 已用临时 MCP 配置通过合成验证；DSH 实际调用仍待验证。真实项目只在已授权的宿主范围内使用。

网页绑定 IPv4 loopback。可明确选择缓存最近的已复核目录和下一步，草稿仅在用户点击保存后存于该浏览器。离线重载需要固定端口和原先的浏览器配置。离线原文不可用，重新连接后可以用同一重试 ID 提交草稿。手机需要另做部署与设备验收。

## 每日整理

`daily --project work --manifest <private-json>` 接受一个输入数组。每个对象可选择单文件的 `source,file,instance,session` 或目录的 `source,root,instance`，可加 `max-records`、`max-sessions` 和 `offset`。目录条目也可设置 `"recent":true`，优先扫描最近更新的会话。清单为空也可重建当前项目的轻量索引、已复核决定视图和待审队列。运行统计只输出计数，快照留在私有目录的 `derived/`。模型提取和 Skill 草案生成标为待审，当前运行不会发起模型调用。无新增归档版本和批注时跳过派生写入。缺乏足够证据时技能候选列表为空。

macOS 可用 `node bin/daily-launchd.cjs --dir <private-dir> --manifest <private-json> --project work` 生成用户 LaunchAgent。默认 03:00，按宿主机本地时区解释。Oslo 宿主对应 03:00 Europe/Oslo。将输出保存到私有 plist、用 `plutil -lint` 检查并用 `launchctl bootstrap gui/$(id -u) <plist>` 安装。已为 `private-acceptance` 私有试点注册 03:00 Europe/Oslo，并经调度器手动触发验证退出码为 0。任务只处理两端各最多三份最近会话、每次每份最多 40 条记录。试点清单与派生快照在默认私有根目录的 `acceptance-*/` 子目录。可用 `launchctl bootout gui/$(id -u)/local.agent-memory-lab.daily` 停止试点。

## 私有 CouchDB 同步

给每个 owner/project 使用专用私有数据库。先通过授权管理员完成单节点初始化、建库和账号角色分配，再使用 `provision-hub --project work --couch-url <database-url>` 安装权限规则。运行时用私有环境注入 `MEMORY_LAB_COUCH_AUTHORIZATION`，URL 不带凭据。管理员仅用于配置，普通设备使用最小角色。非 loopback URL 要求 HTTPS。避免在浏览器、公共日志、shell 历史或公共仓库保存任何账号密钥。

- `archive_reader` 用 `sync --sync-mode pull`。
- `archive_annotator` 用 `sync --sync-mode annotations`。
- 采集器独用 `archive_writer` 与 `sync --sync-mode all`。

`sync` 默认为 pull。各端本地 checkpoint 独立，归档版本和批注通过共享库交换。角色限制在实际 CouchDB 中验过。能以同一 OS 用户直接访问私有文件的进程仍具备该用户的文件权限。部署时应使用限制文件访问的宿主或独立服务账户，对普通 Agent 只暴露范围固定的查询和批注接口。不要向普通 Agent 分发采集器凭据。macOS 可将 MCP 命令改为 `bin/readonly-mcp-macos.sh --dir <private-dir> --project work`。该进程实际通过过查询和直接写入拒绝测试，提供只读工具并禁止该进程写文件及联网。它依赖宿主 `sandbox-exec`。批注通过网页或明确授权的写入 MCP 追加。配置未长期开放 hub；合成验证仅使用本机回环地址。
