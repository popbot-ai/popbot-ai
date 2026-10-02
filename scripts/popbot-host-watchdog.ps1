# popbot-host-watchdog.ps1 - keep popbot-host answering on Windows.
#
# Run every minute by the "PopBot Host Watchdog" task that
# install-host-service.ps1 registers. Asks the host what it is
# (GET /v1/info with its own token). Two failed looks in a row - the
# process is gone, or alive but hung - and it kills whatever is left of
# it (with its child processes) and starts the "PopBot Host" task again.
#
# Task Scheduler's own restart-on-failure only covers a task that fails
# to start; a host that exits or hangs later is this script's job.

[CmdletBinding()]
param(
  [string]$ConfigPath = (Join-Path $env:USERPROFILE '.popbot-host\config.json'),
  [string]$TaskName = 'PopBot Host',
  [int]$FailuresToRestart = 2,
  [int]$TimeoutSec = 15
)

$ErrorActionPreference = 'Stop'
$dir = Split-Path -Parent $ConfigPath
$logDir = Join-Path $dir 'logs'
$logPath = Join-Path $logDir 'watchdog.log'
$statePath = Join-Path $dir 'watchdog.json'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

function Write-Log([string]$message) {
  Add-Content -Path $logPath -Value ("{0} {1}" -f (Get-Date -Format o), $message)
  # Keep the log small: past 1 MB, keep the last 2000 lines.
  if ((Get-Item $logPath).Length -gt 1MB) {
    $tail = Get-Content $logPath -Tail 2000
    Set-Content -Path $logPath -Value $tail
  }
}

if (-not (Test-Path $ConfigPath)) {
  Write-Log "no config at $ConfigPath; nothing to watch"
  exit 0
}
$cfg = Get-Content $ConfigPath -Raw | ConvertFrom-Json
$bind = [string]$cfg.bind
# A host bound to every address is reached on the loopback.
if ([string]::IsNullOrWhiteSpace($bind) -or $bind -eq '0.0.0.0' -or $bind -eq '::') { $bind = '127.0.0.1' }
if ($bind.Contains(':')) { $bind = "[$bind]" }
$url = "http://${bind}:$($cfg.port)/v1/info"

$failures = 0
if (Test-Path $statePath) {
  try { $failures = [int]((Get-Content $statePath -Raw | ConvertFrom-Json).failures) } catch { $failures = 0 }
}

$healthy = $false
$why = ''
try {
  $res = Invoke-WebRequest -Uri $url -Headers @{ Authorization = "Bearer $($cfg.token)" } -TimeoutSec $TimeoutSec -UseBasicParsing
  $healthy = ($res.StatusCode -eq 200)
  if (-not $healthy) { $why = "HTTP $($res.StatusCode)" }
} catch {
  $why = $_.Exception.Message
}

if ($healthy) {
  if ($failures -gt 0) { Write-Log "healthy again after $failures failed look(s)" }
  Set-Content -Path $statePath -Value (@{ failures = 0 } | ConvertTo-Json)
  exit 0
}

$failures += 1
Write-Log "no answer from $url ($why); failed looks in a row: $failures"
if ($failures -lt $FailuresToRestart) {
  Set-Content -Path $statePath -Value (@{ failures = $failures } | ConvertTo-Json)
  exit 0
}

# Restart: whatever is left of it (a hung node and the agents it ran)
# goes first, so the new one can take the port.
$procs = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*popbot-host.cjs*' })
foreach ($p in $procs) {
  Write-Log "stopping popbot-host pid $($p.ProcessId)"
  & taskkill.exe /PID $p.ProcessId /T /F | Out-Null
}
try { Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue } catch { }
Start-Sleep -Seconds 2
Start-ScheduledTask -TaskName $TaskName
Write-Log "started the '$TaskName' task again"
Set-Content -Path $statePath -Value (@{ failures = 0 } | ConvertTo-Json)
