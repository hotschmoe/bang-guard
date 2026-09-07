# Install the shared TypeScript extension on Windows x64 or ARM64; no admin required.
# Supports Windows PowerShell 5.1 and PowerShell 7.
[CmdletBinding()]
param(
    [ValidateSet('Pi', 'Omp', 'Both')][string]$Target = 'Both',
    [ValidatePattern('^[a-zA-Z0-9._-]+$')][string]$Version = 'v0.3.0',
    [string]$SourceDir,
    [ValidateNotNullOrEmpty()][string]$PiDir = (Join-Path $HOME '.pi/agent'),
    [ValidateNotNullOrEmpty()][string]$OmpDir = (Join-Path $HOME '.omp/agent'),
    [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
$marker = '// bang-guard: managed extension'

function Assert-ManagedDestination([string]$Path) {
    # Refuse junctions/symlinks at the destination or in its parent directories.
    $current = $Path
    while ($current) {
        $item = Get-Item -LiteralPath $current -Force -ErrorAction SilentlyContinue
        if ($item -and ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw "Refusing a symlink or junction: $current"
        }
        $current = [IO.Path]::GetDirectoryName($current)
    }
    if (Test-Path -LiteralPath $Path) {
        if (-not [IO.File]::Exists($Path)) { throw "Not a regular file: $Path" }
        if ((Get-Content -LiteralPath $Path -TotalCount 1) -cne $marker) {
            throw "Refusing to overwrite an unrecognized file: $Path"
        }
    }
}

$dirs = @()
if ($Target -ne 'Omp') { $dirs += [IO.Path]::GetFullPath($PiDir) }
if ($Target -ne 'Pi') { $dirs += [IO.Path]::GetFullPath($OmpDir) }
$destinations = @($dirs | ForEach-Object { Join-Path $_ 'extensions/bang-guard.ts' } | Select-Object -Unique)
# Check all selected profiles before modifying any of them.
foreach ($dest in $destinations) { Assert-ManagedDestination $dest }
if ($Uninstall) {
    foreach ($dest in $destinations) {
        if ([IO.File]::Exists($dest)) {
            Remove-Item -LiteralPath $dest
            Write-Host "Removed $dest"
        }
    }
    Write-Host 'Restart Pi/OMP to unload bang-guard. Other extensions and settings were preserved.'
    return
}

$scratch = Join-Path ([IO.Path]::GetTempPath()) ('bang-guard-' + [guid]::NewGuid().ToString('N'))
$staged = $null
$originalProtocol = [Net.ServicePointManager]::SecurityProtocol
try {
    $null = [IO.Directory]::CreateDirectory($scratch)
    $source = Join-Path $scratch 'bang-guard.ts'
    if ($SourceDir) {
        Copy-Item -LiteralPath (Join-Path $SourceDir 'src/bang-guard.ts') -Destination $source
    } else {
        # Older Windows PowerShell installations may not default to TLS 1.2.
        [Net.ServicePointManager]::SecurityProtocol = $originalProtocol -bor [Net.SecurityProtocolType]::Tls12
        $base = "https://raw.githubusercontent.com/hotschmoe/bang-guard/$Version"
        Invoke-WebRequest -UseBasicParsing -Uri "$base/src/bang-guard.ts" -OutFile $source
        $manifest = Join-Path $scratch 'checksums.sha256'
        Invoke-WebRequest -UseBasicParsing -Uri "$base/checksums.sha256" -OutFile $manifest
        $entries = @(Get-Content -LiteralPath $manifest | Where-Object { $_ -match '^\S+\s+\*?src/bang-guard\.ts\s*$' })
        if ($entries.Count -ne 1 -or $entries[0] -notmatch '^([a-fA-F0-9]{64})\s+\*?src/bang-guard\.ts\s*$') {
            throw 'Invalid checksum manifest; nothing installed'
        }
        $expected = $Matches[1]
        if ((Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash -ne $expected) {
            throw 'Checksum mismatch; nothing installed'
        }
    }
    if ((Get-Content -LiteralPath $source -TotalCount 1) -cne $marker) { throw 'Invalid extension file' }
    $sourceHash = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash
    foreach ($dest in $destinations) {
        Assert-ManagedDestination $dest
        $extensionDir = [IO.Path]::GetDirectoryName($dest)
        $null = [IO.Directory]::CreateDirectory($extensionDir)
        if ([IO.File]::Exists($dest) -and (Get-FileHash -LiteralPath $dest -Algorithm SHA256).Hash -eq $sourceHash) {
            Write-Host "Already current: $dest"
            continue
        }
        $staged = Join-Path $extensionDir ('.bang-guard-' + [guid]::NewGuid().ToString('N'))
        Copy-Item -LiteralPath $source -Destination $staged
        if ([IO.File]::Exists($dest)) {
            $backup = $dest + '.backup.' + [guid]::NewGuid().ToString('N')
            [IO.File]::Replace($staged, $dest, $backup)
            Write-Host "Previous version saved: $backup"
        } else {
            [IO.File]::Move($staged, $dest)
        }
        $staged = $null
        Write-Host "Installed $dest"
    }
    Write-Host 'Done. Restart Pi/OMP, then run /bang-guard to check status.'
} finally {
    [Net.ServicePointManager]::SecurityProtocol = $originalProtocol
    if ($staged -and [IO.File]::Exists($staged)) { Remove-Item -LiteralPath $staged -Force }
    if ([IO.Directory]::Exists($scratch)) { Remove-Item -LiteralPath $scratch -Recurse -Force }
}
