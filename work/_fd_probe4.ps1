$ErrorActionPreference = 'Continue'
$R = 'C:\Users\connessn\probe_gfl_manual'
$fd = 'C:\Users\connessn\.pi\agent\bin\fd.exe'
Remove-Item $R -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path (Join-Path $R 'sub\deep') | Out-Null
Set-Content (Join-Path $R 'sub\c.py') 'x'
Set-Content (Join-Path $R 'sub\deep\d.py') 'y'
Set-Content (Join-Path $R 'a.py') 'z'
Set-Location $R
function Run($label, $args_) { Write-Host "--- $label : fd $($args_ -join ' ') ---"; & $fd @args_; Write-Host "exit=$LASTEXITCODE" }
$base = @('--glob', '--color=never', '--hidden', '--no-require-git')
Run 'J: plain, sub[/\\]*.py' ($base + @('--', 'sub[/\\]*.py', '.'))
Run 'K: plain, **/sub[/\\]*.py' ($base + @('--', '**/sub[/\\]*.py', '.'))
Run 'M: full-path, **[/\\]sub[/\\]*.py' ($base + @('--full-path', '--', '**[/\\]sub[/\\]*.py', '.'))
Run 'O: full-path, **[/\\]sub/**' ($base + @('--full-path', '--', '**[/\\]sub/**', '.'))
Run 'P: plain, sub/**' ($base + @('--', 'sub/**', '.'))
Run 'Q: plain, **/sub/**' ($base + @('--', '**/sub/**', '.'))
Run 'R: full-path, **[/\\]sub[/\\]**[/\\]*.py (pi exact)' ($base + @('--full-path', '--', '**[/\\]sub[/\\]**[/\\]*.py', '.'))
Remove-Item $R -Recurse -Force -ErrorAction SilentlyContinue
