param(
    [int]$Port = 0,
    [string]$FilesystemAllowedDirs = ""
)

$ErrorActionPreference = "Stop"

# Apply defaults from environment if not provided via parameters
if ($Port -eq 0) {
    if ($env:PORT) { $Port = [int]$env:PORT } else { $Port = 3300 }
}
if (-not $FilesystemAllowedDirs -and $env:FILESYSTEM_ALLOWED_DIRS) {
    $FilesystemAllowedDirs = $env:FILESYSTEM_ALLOWED_DIRS
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

Write-Host "Starting central-mcp on port $Port..." -ForegroundColor Green
npm start

