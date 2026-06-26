# vhdx-spike.ps1 - Phase 0 feasibility spike for PopBot VHDX virtual workspaces.
#
# Proves the core assumption the whole "very large project" design rests on:
#   1. We can create an expandable base VHDX, saturate it, and freeze it read-only.
#   2. We can create multiple DIFFERENCING children off that one frozen base.
#   3. We can MOUNT several children SIMULTANEOUSLY (the many-slots scenario).
#   4. Children are ISOLATED (writes in A invisible to B and to base).
#   5. The base is never modified (immutable).
#   6. Children are DELTA-ONLY on disk (cheap clones).
#   7. A slot RESET (destroy child + recreate from base) yields an instant clean tree.
#
# Requires: Windows with Hyper-V PowerShell module, run ELEVATED.
# Writes a transcript + a machine-readable result line "SPIKE_RESULT=PASS|FAIL".

[CmdletBinding()]
param(
  [string]$Root = "C:\pbvhdx-spike",
  [string]$Log  = "$env:TEMP\pb-vhdx-spike.log"
)

$ErrorActionPreference = 'Stop'
$script:Fail = $false
function Check($name, [bool]$cond) {
  if ($cond) { Write-Host "PASS  $name" }
  else       { Write-Host "FAIL  $name"; $script:Fail = $true }
}

Start-Transcript -Path $Log -Force | Out-Null
Write-Host "=== VHDX differencing spike @ $(Get-Date -Format o) ==="
Write-Host "Root=$Root"

$base   = Join-Path $Root "base.vhdx"
$childA = Join-Path $Root "slotA.vhdx"
$childB = Join-Path $Root "slotB.vhdx"
$mounted = @()   # image paths we mounted, for cleanup

# Bring a mounted child's volume online + ensure it has a drive letter.
# Differencing children inherit the base's GPT disk/partition GUIDs, so the
# 2nd+ simultaneous mount can land OFFLINE due to a signature collision - we
# online it (Windows resignatures into the child diff) and assign a letter.
function Initialize-ChildMount($imgPath) {
  $disk = Get-DiskImage -ImagePath $imgPath | Get-Disk
  if ($disk.IsOffline)  { Set-Disk -Number $disk.Number -IsOffline $false }
  if ($disk.IsReadOnly) { Set-Disk -Number $disk.Number -IsReadOnly $false }
  Start-Sleep -Milliseconds 600
  $disk = Get-DiskImage -ImagePath $imgPath | Get-Disk
  $part = Get-Partition -DiskNumber $disk.Number |
          Where-Object { $_.Type -eq 'Basic' } |
          Sort-Object Size -Descending | Select-Object -First 1
  if (-not $part) { throw "no basic partition on disk $($disk.Number) for $imgPath" }
  if (-not $part.DriveLetter) {
    Add-PartitionAccessPath -DiskNumber $disk.Number -PartitionNumber $part.PartitionNumber -AssignDriveLetter
    $part = Get-Partition -DiskNumber $disk.Number -PartitionNumber $part.PartitionNumber
  }
  return [string]$part.DriveLetter
}

try {
  # ---- clean slate ----
  Get-VM -ErrorAction SilentlyContinue | Out-Null  # forces Hyper-V module load
  foreach ($img in @($childA,$childB,$base)) {
    try { Dismount-VHD -Path $img -ErrorAction SilentlyContinue } catch {}
  }
  if (Test-Path $Root) { Remove-Item $Root -Recurse -Force -ErrorAction SilentlyContinue }
  New-Item -ItemType Directory -Path $Root -Force | Out-Null

  # ---- 1. create + saturate base ----
  Write-Host "`n-- creating base VHDX --"
  New-VHD -Path $base -Dynamic -SizeBytes 1GB | Out-Null
  $bd = Mount-VHD -Path $base -Passthru | Get-Disk
  Initialize-Disk -Number $bd.Number -PartitionStyle GPT | Out-Null
  $bp = New-Partition -DiskNumber $bd.Number -UseMaximumSize -AssignDriveLetter
  Format-Volume -DriveLetter $bp.DriveLetter -FileSystem NTFS -NewFileSystemLabel PBBASE -Confirm:$false | Out-Null
  $bl = "$($bp.DriveLetter):"
  Write-Host "base mounted at $bl - writing ~200MB of marker content"
  Set-Content -Path "$bl\BASE_ONLY.txt" -Value "this file came from the frozen base"
  New-Item -ItemType Directory -Path "$bl\Source" | Out-Null
  1..20 | ForEach-Object {
    $buf = New-Object byte[] (10MB)
    (New-Object Random).NextBytes($buf)
    [IO.File]::WriteAllBytes("$bl\Source\asset$_.bin", $buf)
  }
  $baseContentBytes = (Get-ChildItem $bl -Recurse -File | Measure-Object Length -Sum).Sum
  Dismount-VHD -Path $base
  $baseSizeAfter = (Get-Item $base).Length

  # ---- 2. freeze base read-only ----
  Set-ItemProperty -Path $base -Name IsReadOnly -Value $true
  $baseFrozenTime = (Get-Item $base).LastWriteTime
  Check "base frozen read-only" ((Get-Item $base).IsReadOnly)

  # ---- 3. create two differencing children ----
  Write-Host "`n-- creating differencing children --"
  New-VHD -Path $childA -ParentPath $base -Differencing | Out-Null
  New-VHD -Path $childB -ParentPath $base -Differencing | Out-Null
  Check "child A is differencing off base" ((Get-VHD $childA).VhdType -eq 'Differencing' -and (Get-VHD $childA).ParentPath -eq $base)
  Check "child B is differencing off base" ((Get-VHD $childB).VhdType -eq 'Differencing')

  # ---- 4. mount BOTH simultaneously ----
  Write-Host "`n-- mounting both children at once --"
  Mount-VHD -Path $childA; $mounted += $childA
  $la = Initialize-ChildMount $childA
  Mount-VHD -Path $childB; $mounted += $childB
  $lb = Initialize-ChildMount $childB
  Write-Host "slotA=${la}: slotB=${lb}:"
  Check "both children mounted at distinct letters" ($la -and $lb -and $la -ne $lb)

  $ra = "${la}:"; $rb = "${lb}:"
  Check "child A sees inherited base file" (Test-Path "$ra\BASE_ONLY.txt")
  Check "child B sees inherited base file" (Test-Path "$rb\BASE_ONLY.txt")
  Check "child A sees inherited base assets" (Test-Path "$ra\Source\asset1.bin")

  # ---- 5. isolation: write distinct files into each ----
  Set-Content -Path "$ra\A_ONLY.txt" -Value "written only in slot A"
  Set-Content -Path "$rb\B_ONLY.txt" -Value "written only in slot B"
  Check "A_ONLY present in A"            (Test-Path "$ra\A_ONLY.txt")
  Check "A_ONLY NOT visible in B (isolated)" (-not (Test-Path "$rb\A_ONLY.txt"))
  Check "B_ONLY present in B"            (Test-Path "$rb\B_ONLY.txt")
  Check "B_ONLY NOT visible in A (isolated)" (-not (Test-Path "$ra\B_ONLY.txt"))

  # mutate an inherited file in A, confirm B's copy is untouched (copy-on-write)
  Add-Content -Path "$ra\BASE_ONLY.txt" -Value "APPENDED-IN-A"
  $bInBHasAppend = (Get-Content "$rb\BASE_ONLY.txt" -Raw) -match 'APPENDED-IN-A'
  Check "CoW edit of base file in A does NOT leak to B" (-not $bInBHasAppend)

  # ---- 6. base immutability + delta-only size ----
  $sizeA = (Get-Item $childA).Length
  $sizeB = (Get-Item $childB).Length
  Write-Host ("base content={0:N0}B  base.vhdx={1:N0}B  childA.vhdx={2:N0}B  childB.vhdx={3:N0}B" -f $baseContentBytes,$baseSizeAfter,$sizeA,$sizeB)
  # A fresh child diff is just NTFS first-mount metadata churn ($LogFile/$MFT/USN +
  # the GPT resignature) plus our few small writes - a small ABSOLUTE overhead that
  # is ~constant regardless of base size. So it must be far smaller than the full
  # base (not a copy), and small in absolute terms (it did NOT copy the 200MB of assets).
  Check "child A diff << full base (not a copy)" ($sizeA -lt ($baseSizeAfter / 2))
  Check "child B diff << full base (not a copy)" ($sizeB -lt ($baseSizeAfter / 2))
  Check "child A diff is small absolute overhead (<80MB, didn't copy 200MB base)" ($sizeA -lt 80MB)
  Check "child B diff is small absolute overhead (<80MB, didn't copy 200MB base)" ($sizeB -lt 80MB)
  Check "base.vhdx untouched since freeze" ((Get-Item $base).LastWriteTime -eq $baseFrozenTime)

  # ---- 7. slot reset: destroy A, recreate from base ----
  Write-Host "`n-- resetting slot A --"
  Dismount-VHD -Path $childA; $mounted = $mounted | Where-Object { $_ -ne $childA }
  Remove-Item $childA -Force
  New-VHD -Path $childA -ParentPath $base -Differencing | Out-Null
  Mount-VHD -Path $childA; $mounted += $childA
  $la2 = Initialize-ChildMount $childA
  $ra2 = "${la2}:"
  Check "reset slot A is clean (A_ONLY gone)" (-not (Test-Path "$ra2\A_ONLY.txt"))
  Check "reset slot A still warm (base files present)" (Test-Path "$ra2\Source\asset1.bin")
}
catch {
  Write-Host "EXCEPTION: $($_.Exception.Message)"
  Write-Host $_.ScriptStackTrace
  $script:Fail = $true
}
finally {
  Write-Host "`n-- cleanup --"
  foreach ($img in @($childA,$childB,$base)) {
    try { Dismount-VHD -Path $img -ErrorAction SilentlyContinue } catch {}
  }
  try {
    Set-ItemProperty -Path $base -Name IsReadOnly -Value $false -ErrorAction SilentlyContinue
    Remove-Item $Root -Recurse -Force -ErrorAction SilentlyContinue
  } catch {}
  $result = if ($script:Fail) { "FAIL" } else { "PASS" }
  Write-Host "`nSPIKE_RESULT=$result"
  Stop-Transcript | Out-Null
}