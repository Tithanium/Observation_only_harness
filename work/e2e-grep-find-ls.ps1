# work/e2e-grep-find-ls.ps1 — E2E for the imported grep/find/ls tools + fetch
# scope guard through the REAL harness one-shot path (src/round5.js):
# isolated dot dir (test-rig/work/pi-agent-dir, mock provider on 127.0.0.1:8407)
# + the stateful tool-call mock (work/mock-server-toolcall.mjs) that answers
# call 1 with a grep toolCall and call 2 with a final text. Proves:
#   (a) the 5 tools are DECLARED in request 1 (schema reached the provider),
#   (b) the harness EXECUTED the grep and the result traveled back into the
#       transcript of request 2 (role:"tool" message),
#   (c) the final answer is printed.
$ErrorActionPreference = 'Stop'
$root = 'C:\Users\connessn\Observation_only'
Set-Location $root # node src/round5.js + relative work/ paths resolve against the repo
$dot  = Join-Path $root 'test-rig\work\pi-agent-dir'
$tmp  = Join-Path $root 'work\probe_gfl_e2e_work' # the harness requires the work dir INSIDE the project
$log  = Join-Path $root 'work\e2e-requests.log'
$port = 8407
$fail = 0

function Check($name, $cond, $extra = '') {
  if ($cond) { Write-Host "PASS $name" } else { $script:fail = 1; Write-Host "FAIL $name $extra" }
}

# 1. temp working folder with a known match
Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path (Join-Path $tmp 'sub') | Out-Null
Set-Content (Join-Path $tmp 'a.txt') 'hello world'
Set-Content (Join-Path $tmp 'sub\n.txt') 'hello deep'

# 2. free port 8407 (a stale mock from an earlier suite would corrupt the run)
$stale = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if ($stale) { $stale | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }; Start-Sleep -Milliseconds 300 }

# 3. start the stateful tool-call mock
Set-Location $root
$mock = Start-Process -FilePath 'node' -ArgumentList "work\mock-server-toolcall.mjs" -WorkingDirectory $root -WindowStyle Hidden -PassThru
$opened = $false
for ($i = 0; $i -lt 50; $i++) {
  Start-Sleep -Milliseconds 100
  try { $c = New-Object Net.Sockets.TcpClient; $c.Connect('127.0.0.1', $port); $c.Close(); $opened = $true; break } catch { }
}
Check 'e2e: mock is listening' $opened

# 4. run the harness one-shot against it
# (the harness banner goes to STDERR — EAP Stop would turn native stderr into a
#  terminating error, so the node call runs under Continue + exit-code check)
$env:OBSERVATION_ONLY_DIR = $dot
$ErrorActionPreference = 'Continue'
$out = & node src/round5.js --work-dir $tmp "Use the grep tool to find the word hello in the working folder, then answer." 2>&1 | Out-String
$nodeExit = $LASTEXITCODE
$ErrorActionPreference = 'Stop'
Check 'e2e: harness exited 0' ($nodeExit -eq 0) "exit=$nodeExit"
Write-Host "----- harness output -----"
Write-Host $out
Write-Host "--------------------------"

# 5. stop the mock
Stop-Process -Id $mock.Id -Force -ErrorAction SilentlyContinue

# 6. assertions on the harness output + the mock's request log
Check 'e2e: final answer printed' ($out -match 'ANSWER: tool-result-received')

$reqs = @()
if (Test-Path $log) { $reqs = Get-Content $log | ForEach-Object { $_ | ConvertFrom-Json } }
Check 'e2e: two requests logged (tool round trip)' ($reqs.Count -ge 2) "got $($reqs.Count)"
if ($reqs.Count -ge 1) {
  $t1 = ($reqs[0].tools -join ',')
  Check 'e2e: request 1 declares fetch+subagent+grep+find+ls' (($reqs[0].tools -contains 'fetch') -and ($reqs[0].tools -contains 'subagent') -and ($reqs[0].tools -contains 'grep') -and ($reqs[0].tools -contains 'find') -and ($reqs[0].tools -contains 'ls')) "tools=[$t1]"
}
if ($reqs.Count -ge 2) {
  $toolMsgs = $reqs[1].messages | Where-Object { $_.role -eq 'tool' }
  $toolText = ($toolMsgs | ForEach-Object { $_.content }) -join ' '
  Check 'e2e: executed grep result in request 2 transcript' ($toolText -match 'a\.txt:1: hello world') "toolMsgs=$($toolMsgs.Count) text=[$toolText]"
}

# 7. cleanup
Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
Write-Host ""
if ($fail) { Write-Host "E2E VERDICT: FAIL"; exit 1 } else { Write-Host "E2E VERDICT: PASS"; exit 0 }
