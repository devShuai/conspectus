# conspectus-collect 调度

CLI 采集器不需要常驻：由系统调度器按周期拉起 `run` 即可。

## Windows（Task Scheduler）

```powershell
# 每小时运行一次（无需管理员）
$action = New-ScheduledTaskAction -Execute "conspectus-collect" -Argument "run"
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Hours 1)
Register-ScheduledTask -TaskName "conspectus-collect" -Action $action -Trigger $trigger -User $env:USERNAME
```

## macOS（launchd）

```xml
<!-- ~/Library/LaunchAgents/com.conspectus.collect.plist -->
<plist version="1.0">
<dict>
  <key>Label</key><string>com.conspectus.collect</string>
  <key>ProgramArguments</key>
  <array><string>/usr/local/bin/conspectus-collect</string><string>run</string></array>
  <key>StartInterval</key><integer>3600</integer>
</dict>
</plist>
```

```bash
launchctl load ~/Library/LaunchAgents/com.conspectus.collect.plist
```

## Linux（systemd timer）

```ini
# /etc/systemd/system/conspectus-collect.service
[Unit]
Description=conspectus collector

[Service]
Type=oneshot
ExecStart=/usr/local/bin/conspectus-collect run
```

```ini
# /etc/systemd/system/conspectus-collect.timer
[Timer]
OnCalendar=hourly
Persistent=true

[Install]
WantedBy=timers.target
```

```bash
systemctl enable --now conspectus-collect.timer
```

## 安装

采集器发布在自有 registry，包名带 scope：`@devshuai/conspectus-collect`（命令名仍是 `conspectus-collect`）。

> **不要执行 `npm install -g conspectus-collect`**（无 scope 的裸名字）。本项目从未在公共 npm 上注册该名字；哪天有人注册了，这条命令就会装到陌生人的代码并立刻运行，而本 CLI 持有 certus 设备授权令牌与 Ed25519 设备签名私钥。scope 绑定到自有 registry 后，npm 永远不会去公共源解析它。

```bash
# 一次性：把 @devshuai 这个 scope 绑到自有 registry
npm config set @devshuai:registry https://nexus.devshuai.com/repository/npm-hosted/

npm install -g @devshuai/conspectus-collect
```

**只映射 scope，不要改全局 registry。** `npm-hosted` 是纯 hosted 仓库，不代理公共 npm（实测 `openid-client` 在该仓库返回 404），把 `registry` 整体指过去会让采集器的依赖装不上。

该仓库当前允许匿名读取，安装无需登录；若日后收紧，执行 `npm login --scope=@devshuai --registry=https://nexus.devshuai.com/repository/npm-hosted/`。

首次使用需要两步，跳过 `configure` 会让 `login` 直接报 `config not found`：

```bash
conspectus-collect configure   # 交互填写服务器地址、certus issuer、CLI client id
conspectus-collect login       # 设备码授权，完成后设备出现在「设置 / 采集设备」
```

### 从源码安装（开发、或 registry 不可达时）

```bash
git clone https://github.com/devShuai/conspectus
cd conspectus/collector
npm install
npm run build          # 必须显式执行：npm 11 默认拦截 prepare 生命周期脚本
npm install -g .
```

`npm install -g .` 装的是指向该目录的链接（Windows 上是 Junction），**别删掉这个 clone**；想要独立副本就装 tarball：`npm pack` 后 `npm install -g devshuai-conspectus-collect-<版本>.tgz`。

## 升级 / 卸载

```bash
npm update -g @devshuai/conspectus-collect   # registry 安装
# 源码安装：git pull && cd collector && npm install && npm run build（链接安装无需重装）

conspectus-collect logout                    # 清除本机令牌与设备私钥（卸载前先做）
npm uninstall -g @devshuai/conspectus-collect
```

## 隐私与降级

- 只上报 `bindingId` 与数值读数；`--dry-run` 可先核对完整载荷。
- 认证 token 与设备签名私钥存操作系统钥匙串（macOS Keychain / Windows Credential Manager / libsecret `secret-tool`）；平台工具不可用时回退到 `~/.conspectus/secrets.json`（0600）。旧版明文 `tokens.json` / `device.json` 内嵌私钥会在首次读取时自动迁入钥匙串并删除。
- 上报失败（网络 / 5xx / 429）的批次持久化在 `~/.conspectus/pending-reports.json`（0600），下次 `run` 先重放；保留 7 天、最多 50 批 / 1000 条读数，超出丢弃最旧批次。
- `conspectus-collect diagnose` 本机打印诊断（配置来源、token/私钥存在性不打印值、连通性、缓冲深度、collector 最近成败），输出不含任何密钥。
- 任一 collector 失败独立记录 `unavailable`，绝不用旧数字冒充新数据。
- 手动录入（通道 C）始终可用，不依赖 CLI。
