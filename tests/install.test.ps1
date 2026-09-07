$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
$root = Join-Path ([IO.Path]::GetTempPath()) ('bang-guard-tests-' + [guid]::NewGuid().ToString('N'))
$fixture = Join-Path $root 'fixture'
$pi = Join-Path $root 'pi profile'
$omp = Join-Path $root 'omp profile'
$piFile = Join-Path $pi 'extensions/bang-guard.ts'
$ompFile = Join-Path $omp 'extensions/bang-guard.ts'
$utf8 = New-Object Text.UTF8Encoding($false)
function Write-Utf8([string]$Path, [string]$Text) { [IO.File]::WriteAllText($Path, $Text, $utf8) }
function Assert([bool]$Condition, [string]$Message) { if (-not $Condition) { throw "FAIL: $Message" } }
function Install { & (Join-Path $repo 'install.ps1') -PiDir $pi -OmpDir $omp @args }
function Assert-Fails([scriptblock]$Action, [string]$Message) {
    $failed = $false
    try { & $Action } catch { $failed = $true }
    Assert $failed $Message
}
function Hash([string]$Path) { (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash }
# Stub downloads while exercising the real checksum and installation paths.
function Invoke-WebRequest {
    param([switch]$UseBasicParsing, [string]$Uri, [string]$OutFile)
    Assert ($Uri -like 'https://raw.githubusercontent.com/hotschmoe/bang-guard/v0.3.0/*') 'unexpected download URL'
    if ($Uri.EndsWith('/src/bang-guard.ts')) { $file = 'src/bang-guard.ts' }
    elseif ($Uri.EndsWith('/checksums.sha256')) { $file = 'checksums.sha256' }
    else { throw 'Unexpected download' }
    Copy-Item -LiteralPath (Join-Path $fixture $file) -Destination $OutFile
}
try {
    $null = [IO.Directory]::CreateDirectory((Join-Path $fixture 'src'))
    $null = [IO.Directory]::CreateDirectory((Join-Path $pi 'extensions'))
    $source = Join-Path $fixture 'src/bang-guard.ts'
    Write-Utf8 $source "// bang-guard: managed extension`nexport default function () {}`n"
    Write-Utf8 (Join-Path $pi 'settings.json') '{"keep":"this setting"}'
    Write-Utf8 (Join-Path $pi 'extensions/other.ts') 'keep this extension'
    $original = Hash $source
    Install -SourceDir $fixture
    Assert ((Hash $piFile) -eq $original -and (Hash $ompFile) -eq $original) 'both profiles installed'
    Install -SourceDir $fixture
    Assert (@(Get-ChildItem -LiteralPath (Split-Path $piFile) -Filter '*.backup.*').Count -eq 0) 'idempotent install created backup'
    [IO.File]::AppendAllText($source, "// revised`n", $utf8)
    Install -Target Pi -SourceDir $fixture
    $backups = @(Get-ChildItem -LiteralPath (Split-Path $piFile) -Filter '*.backup.*')
    Assert ($backups.Count -eq 1) 'update missing backup'
    Assert ((Hash $backups[0].FullName) -eq $original) 'backup contents changed'
    Assert ((Hash $piFile) -eq (Hash $source) -and (Hash $ompFile) -eq $original) 'target selection failed'
    Install -Uninstall
    Install -Uninstall
    Assert (-not (Test-Path -LiteralPath $piFile) -and -not (Test-Path -LiteralPath $ompFile)) 'uninstall left extension'
    Assert ([IO.File]::ReadAllText((Join-Path $pi 'settings.json')) -eq '{"keep":"this setting"}') 'settings changed'
    Assert ([IO.File]::ReadAllText((Join-Path $pi 'extensions/other.ts')) -eq 'keep this extension') 'unrelated extension changed'
    Write-Utf8 $ompFile 'unrelated user file'
    Assert-Fails { Install -SourceDir $fixture } 'overwrote unrecognized file'
    Assert (-not (Test-Path -LiteralPath $piFile)) 'preflight partially installed'
    Assert-Fails { Install -Uninstall } 'removed unrecognized file'
    Remove-Item -LiteralPath $ompFile
    $null = [IO.Directory]::CreateDirectory($ompFile)
    Assert-Fails { Install -SourceDir $fixture } 'overwrote directory'
    Remove-Item -LiteralPath $ompFile
    # Windows junctions require no developer mode or administrator privileges.
    if ($env:OS -eq 'Windows_NT') {
        $linkDir = Join-Path $root 'linked profile'
        $null = New-Item -ItemType Junction -Path $linkDir -Target $omp
        Assert-Fails { & (Join-Path $repo 'install.ps1') -Target Omp -OmpDir $linkDir -SourceDir $fixture } 'followed junction'
        [IO.Directory]::Delete($linkDir)
    } else {
        $null = New-Item -ItemType SymbolicLink -Path $ompFile -Target $source
        Assert-Fails { Install -SourceDir $fixture } 'overwrote symlink'
        Assert-Fails { Install -Uninstall } 'removed symlink'
        Remove-Item -LiteralPath $ompFile
    }
    Assert-Fails { Install -Target Invalid } 'invalid target accepted'
    Assert-Fails { Install -Version '../main' } 'invalid ref accepted'
    Assert-Fails { & (Join-Path $repo 'install.ps1') -PiDir '' -OmpDir $omp -SourceDir $fixture } 'empty path accepted'
    Assert-Fails { Install -SourceDir (Join-Path $root 'missing') } 'missing source accepted'
    $manifest = Join-Path $fixture 'checksums.sha256'
    Write-Utf8 $manifest ((Hash $source).ToLowerInvariant() + "  src/bang-guard.ts`n")
    Install -Target Omp
    Assert (-not (Test-Path -LiteralPath $piFile) -and (Hash $ompFile) -eq (Hash $source)) 'OMP remote install failed'
    Install -Uninstall
    [IO.File]::AppendAllText($source, "// tampered`n", $utf8)
    Assert-Fails { Install } 'checksum mismatch accepted'
    Assert (-not (Test-Path -LiteralPath $piFile)) 'checksum failure installed file'
    Write-Utf8 $manifest 'invalid manifest'
    Assert-Fails { Install } 'invalid manifest accepted'
    $entry = (Hash $source).ToLowerInvariant() + "  src/bang-guard.ts`n"
    Write-Utf8 $manifest ($entry + $entry)
    Assert-Fails { Install } 'duplicate checksum entries accepted'
    Write-Utf8 $source 'unrecognized source'
    Assert-Fails { Install -SourceDir $fixture } 'invalid source accepted'
    # Also exercise the documented downloaded-scriptblock invocation form.
    Write-Utf8 $source "// bang-guard: managed extension`nexport default function () {}`n"
    & ([scriptblock]::Create([IO.File]::ReadAllText((Join-Path $repo 'install.ps1')))) -PiDir $pi -OmpDir $omp -SourceDir $fixture
    Assert ((Hash $piFile) -eq (Hash $source)) 'scriptblock install failed'
    Write-Host 'PowerShell installer tests passed'
} finally {
    if (Test-Path -LiteralPath $root) { Remove-Item -LiteralPath $root -Recurse -Force }
}
