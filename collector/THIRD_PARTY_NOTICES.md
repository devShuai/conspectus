# 第三方声明

## codeburn

- 项目：https://github.com/getagentseal/codeburn
- 许可：MIT（Copyright (c) 2026 AgentSeal）

采集器通过 codeburn 的 `export --format json` 契约取得 Claude 的 token 消耗（conspectus#136）。

选择依赖而非自行实现的原因记录在此，以免日后被当作可有可无的依赖移除：

- **去重**。本机实测 `~/.claude/projects` 下 14 个文件共 9856 条带 usage 的记录，唯一
  `message.id` 只有 5334 —— 会话 resume / fork 会把同一条 assistant 消息写进多个文件，
  不去重会虚高约 85%。codeburn 以 `message.id` 为去重键。
- **多根发现**。除用户级 `~/.claude/projects`，桌面端 local agent mode 的会话另存在
  `%APPDATA%/Claude/local-agent-mode-sessions/<app>/<workspace>/local_<id>/.claude/projects/`，
  只扫前者会静默少计。
- **成本口径**。按 conspectus#143 的决定直接采信其 `costUSD`，服务端不另维护价格表。

只依赖其导出契约（产物带 `schema: codeburn.export.v2`），不 deep-import 其内部模块 ——
codeburn 的 package.json 没有 `exports` 也没有 `types`，内部文件不构成契约。
