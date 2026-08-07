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
- 任一 collector 失败独立记录 `unavailable`，绝不用旧数字冒充新数据。
- 手动录入（通道 C）始终可用，不依赖 CLI。
