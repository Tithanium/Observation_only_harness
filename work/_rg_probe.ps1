$ErrorActionPreference = 'Continue'
$R = 'C:\Users\connessn\probe_rg_manual'
$rg = 'C:\Users\connessn\.pi\agent\bin\rg.exe'
Remove-Item $R -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $R | Out-Null
Set-Content (Join-Path $R 'ignored.txt') 'alpha ignored'
Set-Content (Join-Path $R 'keep.txt') 'alpha keep'
Set-Content (Join-Path $R '.gitignore') 'ignored.txt'
Set-Location $R
Write-Host "--- rg version ---"; & $rg --version
Write-Host "--- T1: plain (no --hidden), pattern alpha ---"
& $rg --color=never -- 'alpha' .
Write-Host "exit=$LASTEXITCODE"
Write-Host "--- T2: --hidden ---"
& $rg --color=never --hidden -- 'alpha' .
Write-Host "exit=$LASTEXITCODE"
Write-Host "--- T3: --no-require-git? (does rg have it?) ---"
& $rg --help | Select-String -Pattern 'require-git|untrusted'
Write-Host "--- T4: same tree but INSIDE a real git repo (init + no commit) ---"
git init -q $R 2>&1 | Out-Null
Set-Content (Join-Path $R '.gitignore') 'ignored.txt'
& $rg --color=never -- 'alpha' $R
Write-Host "exit=$LASTEXITCODE"
Remove-Item $R -Recurse -Force -ErrorAction SilentlyContinue
