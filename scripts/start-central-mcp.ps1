param(
    [int]$Port = 0,
    [string]$FilesystemAllowedDirs = "",
    [switch]$EnableFakeQdrant,
    [int]$FakeQdrantPort = 0,
    [string]$FakeQdrantHost = "",
    [string]$FakeQdrantDataDir = ""
)

$ErrorActionPreference = "Stop"

# Apply defaults from environment if not provided via parameters
$enableFakeQdrantFinal = $EnableFakeQdrant.IsPresent

if ($Port -eq 0) {
    if ($env:PORT) { $Port = [int]$env:PORT } else { $Port = 3300 }
}
if (-not $FilesystemAllowedDirs -and $env:FILESYSTEM_ALLOWED_DIRS) {
    $FilesystemAllowedDirs = $env:FILESYSTEM_ALLOWED_DIRS
}
if (-not $enableFakeQdrantFinal -and $env:FAKE_QDRANT_ENABLED -eq "1") {
    $enableFakeQdrantFinal = $true
}
if ($FakeQdrantPort -eq 0) {
    if ($env:FAKE_QDRANT_HTTP_PORT) { $FakeQdrantPort = [int]$env:FAKE_QDRANT_HTTP_PORT } else { $FakeQdrantPort = 6333 }
}
if (-not $FakeQdrantHost) {
    if ($env:FAKE_QDRANT_HTTP_HOST) { $FakeQdrantHost = $env:FAKE_QDRANT_HTTP_HOST } else { $FakeQdrantHost = "127.0.0.1" }
}
if (-not $FakeQdrantDataDir -and $env:FAKE_QDRANT_DATA_DIR) {
    $FakeQdrantDataDir = $env:FAKE_QDRANT_DATA_DIR
}

function Stop-ProcessOnPort {
    param ([int]$TargetPort)

    try {
        $connections = Get-NetTCPConnection -LocalPort $TargetPort -State Listen -ErrorAction Stop
    } catch {
        return
    }

    $procIds = $connections | Select-Object -ExpandProperty OwningProcess -Unique
    foreach ($procId in $procIds) {
        try {
            Write-Host "Stopping existing process on port $TargetPort (PID $procId)..." -ForegroundColor Yellow
            Stop-Process -Id $procId -Force -ErrorAction Stop
        } catch {
            Write-Warning "Failed to stop PID ${procId}: $($_.Exception.Message)"
        }
    }
}

Stop-ProcessOnPort -TargetPort $Port
if ($enableFakeQdrantFinal -and $FakeQdrantPort -gt 0) {
    Stop-ProcessOnPort -TargetPort $FakeQdrantPort
}

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$centralDir = Join-Path $repoRoot "central-mcp"

if (-not (Test-Path $centralDir)) {
    throw "central-mcp directory not found at $centralDir"
}

# Install root project dependencies (needed by src/* servers)
$rootNodeModules = Join-Path $repoRoot "node_modules"
if (-not (Test-Path $rootNodeModules)) {
    Write-Host "Installing root project dependencies..." -ForegroundColor Cyan
    Push-Location $repoRoot
    npm install
    Pop-Location
}

Set-Location $centralDir

# Install central-mcp dependencies
if (-not (Test-Path "node_modules")) {
    Write-Host "Installing central-mcp dependencies..." -ForegroundColor Cyan
    npm install
}

$env:PORT = $Port
if ($FilesystemAllowedDirs) {
    $env:FILESYSTEM_ALLOWED_DIRS = $FilesystemAllowedDirs
}
if ($enableFakeQdrantFinal) {
    $env:FAKE_QDRANT_ENABLED = "1"
    $env:FAKE_QDRANT_HTTP_PORT = $FakeQdrantPort
    $env:FAKE_QDRANT_HTTP_HOST = $FakeQdrantHost
    if ($FakeQdrantDataDir) {
        $env:FAKE_QDRANT_DATA_DIR = $FakeQdrantDataDir
    }
    Write-Host "Fake Qdrant HTTP shim enabled on http://$FakeQdrantHost:$FakeQdrantPort" -ForegroundColor Green
} else {
    Remove-Item Env:FAKE_QDRANT_ENABLED -ErrorAction SilentlyContinue
    Remove-Item Env:FAKE_QDRANT_HTTP_PORT -ErrorAction SilentlyContinue
    Remove-Item Env:FAKE_QDRANT_HTTP_HOST -ErrorAction SilentlyContinue
}

Write-Host "Starting central-mcp on port $Port..." -ForegroundColor Green
npm start

