$ErrorActionPreference = 'Continue'
$R = 'C:\Users\connessn\probe_gfl_manual'
$fd = 'C:\Users\connessn\.pi\agent\bin\fd.exe'
Remove-Item $R -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path (Join-Path $R 'sub') | Out-Null
Set-Content (Join-Path $R 'sub\c.py') 'x'
Set-Content (Join-Path $R 'a.py') 'y'
Set-Location $R
Write-Host '--- help: --glob / --full-path text ---'
& $fd --help | Select-String -Pattern 'glob|full-path' -Context 0,2
Write-Host '--- T7: full-path, backslash pattern sub\**\*.py ---'
& $fd --glob --color=never --hidden --no-require-git --full-path -- 'sub\**\*.py' .
Write-Host "exit=$LASTEXITCODE"
Write-Host '--- T8: full-path, **c.py (no slash at all) ---'
& $fd --glob --color=never --hidden --no-require-git --full-path -- '**c.py' .
Write-Host "exit=$LASTEXITCODE"
Write-Host '--- T9: full-path, ./sub/**/*.py ---'
& $fd --glob --color=never --hidden --no-require-git --full-path -- './sub/**/*.py' .
Write-Host "exit=$LASTEXITCODE"
Write-Host '--- T10: plain (no full-path) sub/*.py ---'
& $fd --glob --color=never --hidden --no-require-git -- 'sub/*.py' .
Write-Host "exit=$LASTEXITCODE"
Write-Host '--- T11: plain (no full-path) sub\*.py backslash ---'
& $fd --glob --color=never --hidden --no-require-git -- 'sub\*.py' .
Write-Host "exit=$LASTEXITCODE"
Remove-Item $R -Recurse -Force -ErrorAction SilentlyContinue
