$ErrorActionPreference = 'Continue'
$R = 'C:\Users\connessn\probe_rg_manual'
$rg = 'C:\Users\connessn\.pi\agent\bin\rg.exe'
Remove-Item $R -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path (Join-Path $R 'sub\deep') | Out-Null
Set-Content (Join-Path $R 'sub\b.md') 'alpha'
Set-Content (Join-Path $R 'sub\deep\c.md') 'alpha'
Set-Content (Join-Path $R 'a.md') 'alpha'
function Run($label, $glob) { Write-Host "--- $label : --glob '$glob' ---"; & $rg --color=never --hidden --no-require-git --glob $glob -- 'alpha' $R; Write-Host "exit=$LASTEXITCODE" }
Run 'G1: sub/**/*.md' 'sub/**/*.md'
Run 'G2: sub/*.md' 'sub/*.md'
Run 'G3: **/*.md' '**/*.md'
Run 'G4: sub/**' 'sub/**'
Run 'G5: sub/deep/*.md' 'sub/deep/*.md'
Run 'G6: *.md' '*.md'
Remove-Item $R -Recurse -Force -ErrorAction SilentlyContinue
