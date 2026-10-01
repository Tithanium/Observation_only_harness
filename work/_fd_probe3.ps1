$ErrorActionPreference = 'Continue'
$R = 'C:\Users\connessn\probe_gfl_manual'
$fd = 'C:\Users\connessn\.pi\agent\bin\fd.exe'
Remove-Item $R -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path (Join-Path $R 'sub') | Out-Null
Set-Content (Join-Path $R 'sub\c.py') 'x'
Set-Content (Join-Path $R 'a.py') 'y'
Set-Location $R
Write-Host '--- A: full-path, *.py, RELATIVE search (.) ---'
& $fd --glob --color=never --hidden --no-require-git --full-path -- '*.py' .
Write-Host "exit=$LASTEXITCODE"
Write-Host '--- B: full-path, *.py, ABSOLUTE search ---'
& $fd --glob --color=never --hidden --no-require-git --full-path -- '*.py' $R
Write-Host "exit=$LASTEXITCODE"
Write-Host '--- C: full-path, sub/c.py literal abs ---'
& $fd --glob --color=never --hidden --no-require-git --full-path -- 'sub[/\\]c.py' .
Write-Host "exit=$LASTEXITCODE"
Write-Host '--- D: full-path, **[/\\]c.py ---'
& $fd --glob --color=never --hidden --no-require-git --full-path -- '**[/\\]c.py' .
Write-Host "exit=$LASTEXITCODE"
Write-Host '--- E: full-path, *[/\\]c.py ---'
& $fd --glob --color=never --hidden --no-require-git --full-path -- '*[/\\]c.py' .
Write-Host "exit=$LASTEXITCODE"
Write-Host '--- F: plain glob (NO full-path), **/sub/c.py ---'
& $fd --glob --color=never --hidden --no-require-git -- '**/sub/c.py' .
Write-Host "exit=$LASTEXITCODE"
Write-Host '--- G: plain glob, sub/c.py ---'
& $fd --glob --color=never --hidden --no-require-git -- 'sub/c.py' .
Write-Host "exit=$LASTEXITCODE"
Write-Host '--- H: plain glob, **/c.py ---'
& $fd --glob --color=never --hidden --no-require-git -- '**/c.py' .
Write-Host "exit=$LASTEXITCODE"
Remove-Item $R -Recurse -Force -ErrorAction SilentlyContinue
