param(
    [string]$ClaudeCommand = "claude"
)

$ErrorActionPreference = "Stop"
$probeRoot = $null
$previousCapturePath = $env:CONSPECTUS_M0_CLAUDE_CAPTURE

function Write-SanitizedResult {
    param([hashtable]$Result)

    $Result | ConvertTo-Json -Depth 8
}

try {
    $claude = Get-Command $ClaudeCommand -ErrorAction Stop
    $node = Get-Command node -ErrorAction Stop
    $captureScript = Join-Path $PSScriptRoot "m0-claude-statusline-capture.mjs"

    $tempBase = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
    $probeRoot = Join-Path $tempBase ("conspectus-m0-claude-" + [guid]::NewGuid().ToString("N"))
    $null = New-Item -ItemType Directory -Path $probeRoot

    $captureOutput = Join-Path $probeRoot "capture.json"
    $settingsPath = Join-Path $probeRoot "settings.json"
    $statusLineCommand = '"{0}" "{1}"' -f $node.Source, $captureScript
    $settings = @{
        statusLine = @{
            type = "command"
            command = $statusLineCommand
            padding = 0
        }
    } | ConvertTo-Json -Depth 4
    [System.IO.File]::WriteAllText($settingsPath, $settings)

    $versionOutput = (& $claude.Source --version 2>&1 | Out-String).Trim()
    $env:CONSPECTUS_M0_CLAUDE_CAPTURE = $captureOutput

    Push-Location $probeRoot
    try {
        $commandOutput = (& $claude.Source `
            -p "Reply exactly OK." `
            --output-format json `
            --no-session-persistence `
            --max-turns 1 `
            --tools "" `
            --settings $settingsPath `
            --setting-sources "" 2>&1 | Out-String)
        $commandExitCode = $LASTEXITCODE
    }
    finally {
        Pop-Location
    }

    $capture = $null
    if (Test-Path -LiteralPath $captureOutput) {
        $capture = Get-Content -LiteralPath $captureOutput -Raw | ConvertFrom-Json
    }

    $failureKind = $null
    if ($commandExitCode -ne 0) {
        $failureKind = switch -Regex ($commandOutput) {
            "(?i)auth|oauth|login|credential" { "authentication"; break }
            "(?i)rate.?limit|quota" { "rate_limit"; break }
            "(?i)network|connect|dns|timeout|socket" { "network"; break }
            "(?i)setting|argument|option|unknown flag" { "configuration"; break }
            "(?i)permission|access denied" { "permission"; break }
            default { "unknown" }
        }
    }

    Write-SanitizedResult @{
        probe = "claude_statusline_rate_limits"
        installed = $true
        version = $versionOutput
        commandSucceeded = ($commandExitCode -eq 0)
        captureGenerated = ($null -ne $capture)
        failureKind = $failureKind
        schema = $capture
    }
}
catch {
    Write-SanitizedResult @{
        probe = "claude_statusline_rate_limits"
        installed = $false
        commandSucceeded = $false
        captureGenerated = $false
        errorKind = $_.Exception.GetType().Name
    }
    exit 1
}
finally {
    $env:CONSPECTUS_M0_CLAUDE_CAPTURE = $previousCapturePath

    if ($probeRoot -and (Test-Path -LiteralPath $probeRoot)) {
        $resolvedTempBase = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
        $resolvedProbeRoot = [System.IO.Path]::GetFullPath($probeRoot)
        $leaf = Split-Path -Leaf $resolvedProbeRoot
        if ($resolvedProbeRoot.StartsWith($resolvedTempBase, [System.StringComparison]::OrdinalIgnoreCase) -and
            $leaf.StartsWith("conspectus-m0-claude-", [System.StringComparison]::Ordinal)) {
            Remove-Item -LiteralPath $resolvedProbeRoot -Recurse -Force
        }
    }
}
