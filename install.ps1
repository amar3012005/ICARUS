# ICARUS Windows installer
#
# Run from PowerShell:
#   irm https://raw.githubusercontent.com/amar3012005/ICARUS/main/install.ps1 | iex
#
# Downloads only the public release artifact, verifies the checksum bound to that exact asset,
# executes the candidate before committing, and retains one rollback binary. It never reads or
# uploads existing ICARUS data/configuration.
[CmdletBinding()]
param(
  [string]$ReleaseTag = 'latest',
  [string]$InstallRoot = $(if ($env:ICARUS_HOME) { $env:ICARUS_HOME } else { Join-Path $env:USERPROFILE '.icarus' })
)

$ErrorActionPreference = 'Stop'
$Repository = 'https://github.com/amar3012005/ICARUS'
$Asset = 'icarus-win32-x64.exe'
$BinDir = Join-Path $InstallRoot 'bin'
$Target = Join-Path $BinDir 'icarus.exe'
$Candidate = Join-Path $BinDir 'icarus.update-tmp.exe'
$Staged = Join-Path $BinDir 'icarus.rollback-tmp.exe'
$Previous = Join-Path $BinDir 'icarus.previous.exe'

function Write-Info([string]$Message) { Write-Host "[icarus] $Message" -ForegroundColor Cyan }
function Write-Ok([string]$Message) { Write-Host "[icarus] $Message" -ForegroundColor Green }
function Fail([string]$Message) { throw "ICARUS install failed: $Message" }

function Recover-InterruptedInstall {
  if (Test-Path -LiteralPath $Target) { return }
  if (Test-Path -LiteralPath $Staged) {
    Write-Info 'Recovering a staged rollback binary.'
    Move-Item -LiteralPath $Staged -Destination $Target -Force
    return
  }
  if (Test-Path -LiteralPath $Previous) {
    Write-Info 'Recovering the last known-good binary.'
    Move-Item -LiteralPath $Previous -Destination $Target -Force
  }
}

function Release-Checksum([string]$ChecksumFile, [string]$ExpectedAsset) {
  $matches = @(Get-Content -LiteralPath $ChecksumFile | ForEach-Object {
    if ($_ -match '^([a-fA-F0-9]{64})\s+\*?([^\s]+)$' -and $Matches[2] -eq $ExpectedAsset) { $Matches[1].ToLowerInvariant() }
  })
  if ($matches.Count -ne 1) { Fail "release checksum is missing or ambiguous for $ExpectedAsset" }
  return $matches[0]
}

function Commit-VerifiedBinary {
  Recover-InterruptedInstall
  try {
    if (Test-Path -LiteralPath $Target) {
      Move-Item -LiteralPath $Target -Destination $Staged -Force
    }
    Move-Item -LiteralPath $Candidate -Destination $Target -Force
  } catch {
    if (-not (Test-Path -LiteralPath $Target) -and (Test-Path -LiteralPath $Staged)) {
      Move-Item -LiteralPath $Staged -Destination $Target -Force
    }
    throw
  }
  if (Test-Path -LiteralPath $Staged) {
    if (Test-Path -LiteralPath $Previous) { Remove-Item -LiteralPath $Previous -Force }
    Move-Item -LiteralPath $Staged -Destination $Previous -Force
  }
}

New-Item -ItemType Directory -Force -Path $BinDir, (Join-Path $InstallRoot 'data') | Out-Null
Recover-InterruptedInstall

if ($ReleaseTag -eq 'latest') {
  $Url = "$Repository/releases/latest/download/$Asset"
} else {
  $Url = "$Repository/releases/download/$ReleaseTag/$Asset"
}
$ChecksumUrl = "$Url.sha256"
Write-Info "Downloading verified release artifact ($Asset)."
try {
  Invoke-WebRequest -Uri $Url -OutFile $Candidate
  $ChecksumFile = "$Candidate.sha256"
  Invoke-WebRequest -Uri $ChecksumUrl -OutFile $ChecksumFile
  $ExpectedHash = Release-Checksum $ChecksumFile $Asset
  $ActualHash = (Get-FileHash -LiteralPath $Candidate -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($ActualHash -ne $ExpectedHash) { Fail "downloaded binary failed SHA-256 verification" }
  & $Candidate --version | Out-Null
  if ($LASTEXITCODE -ne 0) { Fail 'downloaded binary failed its execution preflight' }
  Commit-VerifiedBinary
} catch {
  Remove-Item -LiteralPath $Candidate, "$Candidate.sha256" -Force -ErrorAction SilentlyContinue
  throw
} finally {
  Remove-Item -LiteralPath "$Candidate.sha256" -Force -ErrorAction SilentlyContinue
}

$CurrentUserPath = [Environment]::GetEnvironmentVariable('Path', 'User')
$PathEntries = @($CurrentUserPath -split ';' | Where-Object { $_ })
if ($PathEntries -notcontains $BinDir) {
  [Environment]::SetEnvironmentVariable('Path', (($PathEntries + $BinDir) -join ';'), 'User')
  $env:Path = "$BinDir;$env:Path"
  Write-Info 'Added ICARUS to your user PATH; open a new PowerShell window after this session.'
}
Write-Ok "Installed ICARUS -> $Target"
& $Target --version
