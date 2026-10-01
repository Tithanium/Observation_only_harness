$ErrorActionPreference = 'Continue'
$R = 'C:\Users\connessn\probe_gfl_manual'
$fd = 'C:\Users\connessn\.pi\agent\bin\fd.exe'
Remove-Item $R -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path (Join-Path $R 'sub') | Out-Null
Set-Content (Join-Path $R 'sub\c.py') 'x'
Set-Content (Join-Path $R 'a.py') 'y'
Set-Location $R
& $fd --version
Write-Host '--- T1: no full-path, pattern sub/**/*.py (basename mode? or path mode?) ---'
& $fd --glob --color=never --hidden --no-require-git -- 'sub/**/*.py' .
Write-Host "exit=$LASTEXITCODE"
Write-Host '--- T2: full-path, **/sub/**/*.py ---'
& $fd --glob --color=never --hidden --no-require-git --full-path -- '**/sub/**/*.py' .
Write-Host "exit=$LASTEXITCODE"
Write-Host '--- T3: full-path, windows-class **[/\\]sub[/\\]**[/\\]*.py ---'
& $fd --glob --color=never --hidden --no-require-git --full-path -- '**[/\\]sub[/\\]**[/\\]*.py' .
Write-Host "exit=$LASTEXITCODE"
Write-Host '--- T4: full-path, absolute search path (what the harness passes) ---'
& $fd --glob --color=never --hidden --no-require-git --full-path -- '**/sub/**/*.py' $R
Write-Host "exit=$LASTEXITCODE"
Write-Host '--- T5: full-path, windows-class, absolute search path ---'
& $fd --glob --color=never --hidden --no-require-git --full-path -- '**[/\\]sub[/\\]**[/\\]*.py' $R
Write-Host "exit=$LASTEXITCODE"
Write-Host '--- T6: no full-path, pattern *.py (basename mode control) ---'
& $fd --glob --color=never --hidden --no-require-git -- '*.py' .
Write-Host "exit=$LASTEXITCODE"
Remove-Item $R -Recurse -Force -ErrorAction SilentlyContinue
