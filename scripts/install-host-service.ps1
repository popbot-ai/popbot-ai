# install-host-service.ps1 - run popbot-host on Windows as a service:
# started at boot whether or not anyone is signed in, and restarted when
# it stops answering.
#
# Registers two scheduled tasks:
#   "PopBot Host"          runs node dist-host\popbot-host.cjs at startup,
#                          as you, with its output in
#                          %USERPROFILE%\.popbot-host\logs\host-output.log
#   "PopBot Host Watchdog" every minute, runs popbot-host-watchdog.ps1,
#                          which restarts the host after two failed health
#                          checks in a row (crashed, or hung)
#
# Run it from an ELEVATED PowerShell in the repository, after
# `npm run build:host`:
#   powershell -ExecutionPolicy Bypass -File scripts\install-host-service.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\install-host-service.ps1 -Uninstall
#
# The host runs with the PATH this script is run with, so node, git, gh
# and the claude / codex CLIs it finds now are the ones it uses. Stop any
# copy you started by hand first; it holds the port.

[CmdletBinding()]
param(
  [string]$RepoDir = (Split-Path -Parent $PSScriptRoot),
  [string]$Node = '',
  [string]$ConfigPath = (Join-Path $env:USERPROFILE '.popbot-host\config.json'),
  [string]$ExtraArgs = '',
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
$HostTask = 'PopBot Host'
$WatchdogTask = 'PopBot Host Watchdog'

$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) { throw 'Run this from an elevated PowerShell (Run as administrator): a task that runs while nobody is signed in needs it.' }

if ($Uninstall) {
  foreach ($name in @($WatchdogTask, $HostTask)) {
    if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) {
      Stop-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
      Unregister-ScheduledTask -TaskName $name -Confirm:$false
      Write-Host "Removed '$name'."
    }
  }
  $procs = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*popbot-host.cjs*' })
  foreach ($p in $procs) { & taskkill.exe /PID $p.ProcessId /T /F | Out-Null; Write-Host "Stopped popbot-host pid $($p.ProcessId)." }
  return
}

if (-not $Node) {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if (-not $cmd) { throw 'node is not on PATH; pass -Node C:\path\to\node.exe' }
  $Node = $cmd.Source
}
$bundle = Join-Path $RepoDir 'dist-host\popbot-host.cjs'
if (-not (Test-Path $bundle)) { throw "No $bundle - run 'npm run build:host' in $RepoDir first." }
if (-not (Test-Path $ConfigPath)) { throw "No host config at $ConfigPath - run 'node $bundle --init' first." }
$watchdog = Join-Path $RepoDir 'scripts\popbot-host-watchdog.ps1'
$logDir = Join-Path (Split-Path -Parent $ConfigPath) 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$output = Join-Path $logDir 'host-output.log'
$user = [Security.Principal.WindowsIdentity]::GetCurrent().Name

# The host: cmd.exe so its output can go to a file, with today's PATH.
$hostCmd = "set `"PATH=$env:PATH`" && `"$Node`" `"$bundle`" --config `"$ConfigPath`" $ExtraArgs >> `"$output`" 2>&1"
$hostAction = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/d /c $hostCmd" -WorkingDirectory $RepoDir
$hostTrigger = New-ScheduledTaskTrigger -AtStartup
# S4U: runs as you, signed in or not, without storing your password.
$hostPrincipal = New-ScheduledTaskPrincipal -UserId $user -LogonType S4U -RunLevel Limited
$hostSettings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName $HostTask -Action $hostAction -Trigger $hostTrigger -Principal $hostPrincipal -Settings $hostSettings `
  -Description 'PopBot host: runs PopBot chats and bots on this machine.' -Force | Out-Null
Write-Host "Registered '$HostTask' (runs as $user at startup)."

# The watchdog: as SYSTEM, so it can stop a hung host and start the task.
$wdArgs = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$watchdog`" -ConfigPath `"$ConfigPath`" -TaskName `"$HostTask`""
$wdAction = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $wdArgs
$wdTrigger = New-ScheduledTaskTrigger -Once -At ((Get-Date).AddMinutes(1)) -RepetitionInterval (New-TimeSpan -Minutes 1)
$wdPrincipal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$wdSettings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 2) -MultipleInstances IgnoreNew `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
Register-ScheduledTask -TaskName $WatchdogTask -Action $wdAction -Trigger $wdTrigger -Principal $wdPrincipal -Settings $wdSettings `
  -Description 'Restarts the PopBot host when it stops answering.' -Force | Out-Null
Write-Host "Registered '$WatchdogTask' (every minute, as SYSTEM)."

Start-ScheduledTask -TaskName $HostTask
Write-Host "Started '$HostTask'. Output: $output"
Write-Host "Watchdog log: $(Join-Path $logDir 'watchdog.log')"
