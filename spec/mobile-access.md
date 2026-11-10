# 手机私网入口

浏览器入口在 Mac 上读取同一私有归档，手机通过受信私网 HTTPS 访问。DSH 与 Codex 的 Skill/MCP 则供宿主 Agent 查询，使用独立的工具入口。网页只监听 Mac 的 IPv4 loopback，浏览器也不需要 CouchDB 凭据。

## 私网入口的范围

启动 `serve` 时同时提供 `--serve-origin https://HOST:PORT` 和 `--serve-tailnet-user LOGIN`。使用独立的本机端口，由 Tailscale Serve 转发。应用校验精确 HTTPS Host、Origin、单一登录身份，写入还校验 CSRF。默认本机模式可单独运行。不要为此切换公开 Funnel 或转发 CouchDB。

Tailscale Serve 会移除传入的身份头并注入已验证身份。应用依赖这个信任边界，Mac 上能直接访问 loopback 的进程也必须可信。应用按 Tailscale 用户授权，同账号其他允许的设备也可能访问。仅限指定手机时，还需核对 tailnet 的设备访问策略。首次申请 HTTPS 证书前确认域名是否可进入公开证书透明度记录。[Tailscale Serve 身份头](https://tailscale.com/docs/features/tailscale-serve#identity-headers) · [HTTPS 证书](https://tailscale.com/docs/how-to/set-up-https-certificates)

现有路由应先核对。新入口用独立端口，保留既有 Serve 进程和路由。用合成归档验证 TLS、正确身份、伪造身份拒绝与重启，再启动指定范围的私有归档。Mac 试点已经通过这些服务端检查，实际地址和账号留在私有交接记录。

## 手机操作和离线验收

1. 在手机的 Tailscale 应用连接与 Mac 相同的获准网络。
2. Android 用 Chrome 打开交付的私网 HTTPS 地址，在菜单选择安装应用或添加到主屏幕。iOS 可用 Safari 的添加到主屏幕。
3. 在线查找并选择「保存当前已审核摘要供离线查看」。断开网络后从同一浏览器配置或主屏幕图标重开，核对摘要和草稿。
4. 恢复网络后检查归档查询，以及草稿使用同一重试 ID 提交一次。

可主动保存已审核摘要和本地草稿。原件与候选接口保持联网查询。离线存储以浏览器配置和固定 HTTPS 来源为边界。清理站点数据会移除本地缓存，迁移来源时须先处理未提交草稿。应用壳对 502、503、504 尝试离线回退，对 403 保留拒绝响应。合成 Chrome 已验证断网重载与重启，真实手机验收另行记录。[Android 网页安装说明](https://developer.chrome.com/docs/modern-web-guidance/guides/pwa/install-web-app) · [Apple 主屏幕网页应用](https://developer.apple.com/videos/play/wwdc2023/10120/)

Mac 睡眠、关机或断网期间，手机可查看先前保存的摘要和草稿。常在线远端主机可后续迁移，届时需重新核对来源、访问策略、备份和真机体验。

## 恢复

如果私网 HTTPS 有效而网关返回 502，检查该路由对应的本机应用和专属端口，重启该网页服务后复查身份与范围。若要撤销，停用该网页服务并仅移除其自己的 Serve 端口，保留其他路由。归档、原件和设备缓存按各自的保留策略处理。
