# Phase 1: build the image and run the local proof. Requires Docker Desktop and ANTHROPIC_API_KEY in the environment
# (LOCAL TESTING ONLY - in production the key never enters the container).
param([string]$Topic = "Explain AI cost auditing to an SMB owner.", [int]$TargetSeconds = 120)
$ErrorActionPreference = "Stop"
Set-Location (Split-Path $PSScriptRoot -Parent)
if (Test-Path "~\.env") {
    Get-Content "~\.env" | ForEach-Object {
        if ($_ -match "^(ANTHROPIC_API_KEY|DEEPSEEK_API_KEY|AGENT|MODEL)=(.*)") { 
            Set-Item -Path "Env:$($matches[1])" -Value $matches[2] 
        }
    }
}
if (-not $env:ANTHROPIC_API_KEY -and -not $env:DEEPSEEK_API_KEY) { throw "Set ANTHROPIC_API_KEY or DEEPSEEK_API_KEY for local testing" }
if ($env:DEEPSEEK_API_KEY -and -not $env:AGENT) { $env:AGENT = "aider" }

$commit = (Get-Content vendor/UPSTREAM_COMMIT).Trim()
$actual = (git -C vendor/anything2explainer rev-parse HEAD).Trim()
if ($commit -ne $actual) { throw "vendor/anything2explainer is at $actual but UPSTREAM_COMMIT pins $commit" }
docker build -f container/Dockerfile --build-arg UPSTREAM_COMMIT=$commit -t explainer-container .
docker rm -f explainer-local 2>$null | Out-Null
docker run -d --name explainer-local -p 8080:8080 `
  -e ANTHROPIC_API_KEY=$env:ANTHROPIC_API_KEY -e DEEPSEEK_API_KEY=$env:DEEPSEEK_API_KEY `
  -e AGENT=$env:AGENT -e MODEL=$env:MODEL -e HF_HUB_OFFLINE=1 explainer-container
Start-Sleep -Seconds 3
try { node scripts/phase1-local.mjs $Topic $TargetSeconds } finally { docker logs --tail 30 explainer-local; docker rm -f explainer-local | Out-Null }
