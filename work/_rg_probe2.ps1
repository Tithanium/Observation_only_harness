$ErrorActionPreference = 'Continue'
$R = 'C:\Users\connessn\probe_rg_manual'
$rg = 'C:\Users\connessn\.pi\agent\bin\rg.exe'
Remove-Item $R -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $R | Out-Null
Set-Content (Join-Path $R 'ignored.txt') 'alpha ignored'
Set-Content (Join-Path $R 'keep.txt') 'alpha keep'
Set-Content (Join-Path $R '.gitignore') 'ignored.txt'
Set-Location $R
Write-Host "--- T5: OUTSIDE repo, WITH --no-require-git ---"
& $rg --color=never --no-require-git -- 'alpha' .
Write-Host "exit=$LASTEXITCODE"
Write-Host "--- T6: full pi-style args + --no-require-git (what the port will run) ---"
& $rg --json --line-number --color=never --hidden --no-require-git -- 'alpha' .
Write-Host "exit=$LASTEXITCODE"
Remove-Item $R -Recurse -Force -ErrorAction SilentlyContinue
