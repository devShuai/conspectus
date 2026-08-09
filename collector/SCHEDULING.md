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

## 安装 / 升级 / 卸载

```bash
npm install -g conspectus-collect   # 安装 / 升级
npm uninstall -g conspectus-collect # 卸载
conspectus-collect logout           # 清除本机令牌（卸载前）
```

## 隐私与降级

- 只上报 `bindingId` 与数值读数；`--dry-run` 可先核对完整载荷。
- 认证 token 与设备签名私钥存操作系统钥匙串（macOS Keychain / Windows Credential Manager / libsecret `secret-tool`）；平台工具不可用时回退到 `~/.conspectus/secrets.json`（0600）。旧版明文 `tokens.json` / `device.json` 内嵌私钥会在首次读取时自动迁入钥匙串并删除。
- 上报失败（网络 / 5xx / 429）的批次持久化在 `~/.conspectus/pending-reports.json`（0600），下次 `run` 先重放；保留 7 天、最多 50 批 / 1000 条读数，超出丢弃最旧批次。
- `conspectus-collect diagnose` 本机打印诊断（配置来源、token/私钥存在性不打印值、连通性、缓冲深度、collector 最近成败），输出不含任何密钥。
- 任一 collector 失败独立记录 `unavailable`，绝不用旧数字冒充新数据。
- 手动录入（通道 C）始终可用，不依赖 CLI。
