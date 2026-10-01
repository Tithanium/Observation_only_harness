# alan_config_writer.ps1 — surgical pi-config writer (gauntlet piece 4)
#
# Merges a probe result into pi's harness config WITHOUT touching skills, agents,
# extensions, auth.json, or anything else. Backs up ~/.pi/agent/models.json and
# ~/.pi/agent/settings.json (.bak_yyyyMMdd_HHmmss) before ANY write. DryRun switch
# validates and prints the diff without writing. -Restore restores the latest
# .bak_yyyyMMdd_HHmmss pair (models.json + settings.json), verifies by SHA-256 that each
# restored file equals the .bak it came from, prints the hashes, and errors when no
# backup exists. -Restore touches nothing else.
#
# Contract IN (probe_result.json):
#   { "baseUrl", "api":"openai-completions", "apiKeyPresent": bool, "apiKey"?,
#     "models":[ {id,name,contextWindow,maxTokens} ], "selectedModelId", "probedAt", "raw" }
#
# Piece 2 contract on the key: apiKeyPresent=false (no config key, none passed) is a HARD
# ERROR, before ANY read/write/backup : without providers.alan.apiKey, pi hides the alan
# models. The key, when present, is written VERBATIM (byte-for-byte) into
# providers.alan.apiKey. The key never appears in logs or console.
#
# Ground truth: PI_PROVIDER_WIRING.md (models.json schema, TypeBox load rules) and
# PROBE_RECIPE.md §3 (exact reference payloads, backup naming, -Depth 6, UTF8 no BOM,
# pi dir = $env:USERPROFILE\.pi\agent via PI_CODING_AGENT_DIR).

param(
    [string]$ProbeResult = (Join-Path $PSScriptRoot 'probe_result.json'),
    [switch]$DryRun,
    [switch]$Restore
)

$ErrorActionPreference = 'Stop'
$LogFile = Join-Path $PSScriptRoot 'alan_config_writer.log'

function Write-Log {
    param([string]$Level = 'INFO', [string]$Msg)
    $ts = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    $line = "[$ts] [$Level] $Msg"
    $color = @{ INFO = 'Gray'; OK = 'Green'; WARN = 'Yellow'; ERROR = 'Red' }[$Level]
    Write-Host $line -ForegroundColor $color
    Add-Content -Path $LogFile -Value $line -Encoding utf8
}

function Resolve-PiAgentDir {
    # PIECE 2 (Observation_only port): the harness exports ITS dot-folder as
    # $env:OBSERVATION_ONLY_DIR (its mirror of PI_CODING_AGENT_DIR) so a PLAIN
    # harness run of /ALAN_connector backs up + rewrites the HARNESS dot-folder,
    # never pi's real ~/.pi/agent. pi NEVER reads OBSERVATION_ONLY_DIR (verified
    # on the real pi install), so under pi this rung is skipped and the reference
    # mechanism is unchanged: PI_CODING_AGENT_DIR -> $env:USERPROFILE\.pi\agent
    # (config.ps1:76 `$piHome = Join-Path $env:USERPROFILE ".pi"`; launch_Harness_old.ps1:761-772).
    if (-not [string]::IsNullOrWhiteSpace($env:OBSERVATION_ONLY_DIR)) { return $env:OBSERVATION_ONLY_DIR }
    if (-not [string]::IsNullOrWhiteSpace($env:PI_CODING_AGENT_DIR))   { return $env:PI_CODING_AGENT_DIR }
    if (-not [string]::IsNullOrWhiteSpace($env:USERPROFILE))         { return (Join-Path $env:USERPROFILE '.pi\agent') }
    if (-not [string]::IsNullOrWhiteSpace($env:HOME))                { return (Join-Path $env:HOME '.pi\agent') }
    throw "Cannot resolve pi agent dir: OBSERVATION_ONLY_DIR, PI_CODING_AGENT_DIR, USERPROFILE and HOME are all unset."
}

function ConvertTo-Hashtable {
    # PSCustomObject / dict / array / scalar -> pure hashtable tree (PS 5.1 has no -AsHashtable).
    param($o)
    if ($o -is [System.Management.Automation.PSCustomObject]) {
        $h = @{}
        foreach ($p in $o.PSObject.Properties) { $h[$p.Name] = ConvertTo-Hashtable $p.Value }
        return $h
    } elseif ($o -is [System.Collections.IDictionary]) {
        $h = @{}
        foreach ($k in @($o.Keys)) { $h[$k] = ConvertTo-Hashtable $o[$k] }
        return $h
    } elseif ($o -is [System.Collections.IEnumerable] -and $o -isnot [string] -and $o -isnot [byte[]]) {
        return @($o | ForEach-Object { ConvertTo-Hashtable $_ })
    }
    return ,$o
}

function Get-ObjDiff {
    # Recursive semantic diff between two value trees. Returns list of differing leaf paths; empty = equal.
    param($A, $B, [string]$Path = '$')
    $diff = @()
    $aIsDict  = ($A -is [System.Collections.IDictionary])
    $bIsDict  = ($B -is [System.Collections.IDictionary])
    $aIsArray = (-not $aIsDict -and $A -is [System.Collections.IEnumerable] -and $A -isnot [string] -and $A -isnot [byte[]])
    $bIsArray = (-not $bIsDict -and $B -is [System.Collections.IEnumerable] -and $B -isnot [string] -and $B -isnot [byte[]])
    if ($aIsDict -and $bIsDict) {
        foreach ($k in @($A.Keys)) {
            if (-not $B.Contains($k))  { $diff += "$Path.$k : present in old, ABSENT in new"                }
            else                      { $diff += Get-ObjDiff $A[$k] $B[$k] "$Path.$k"                       }
        }
        foreach ($k in @($B.Keys)) {
            if (-not $A.Contains($k)) { $diff += "$Path.$k : absent in old, PRESENT in new"                }
        }
    } elseif ($aIsArray -and $bIsArray) {
        $la = @($A); $lb = @($B)
        if ($la.Count -ne $lb.Count) { $diff += "$Path : array length $($la.Count) vs $($lb.Count)" }
        for ($i = 0; $i -lt [Math]::Min($la.Count, $lb.Count); $i++) { $diff += Get-ObjDiff $la[$i] $lb[$i] "$Path[$i]" }
    } else {
        if ($A -ne $B) { $diff += "$Path : old=[$A]  new=[$B]" }
    }
    return $diff
}

function Show-TextDiff {
    param([string]$Old, [string]$New)
    if ($null -eq $Old) { $Old = '' }
    if ($null -eq $New) { $New = '' }
    $l1 = @($Old -split "`n"); $l2 = @($New -split "`n")
    $d = Compare-Object -ReferenceObject $l1 -DifferenceObject $l2
    if ($d.Count -eq 0) { Write-Log 'OK' '    (no textual difference)' }
    foreach ($x in $d) {
        if ($x.SideIndicator -eq '<=') { Write-Host ("- " + $x.InputObject) -ForegroundColor Red }
        else                           { Write-Host ("+ " + $x.InputObject) -ForegroundColor Green }
    }
    return ,$d
}

function Read-JsonRaw {
    param([string]$Path, [bool]$Required = $true)
    if (-not (Test-Path -LiteralPath $Path)) {
        if ($Required) { throw "Missing file: $Path" }
        return $null, $null   # ($raw, $obj)
    }
    $raw = [System.IO.File]::ReadAllText($Path)   # byte-exact, preserves BOM/newlines/indent
    try   { return $raw, ($raw | ConvertFrom-Json) }
    catch {
        Write-Log 'WARN' "Unreadable JSON in $Path : $($_.Exception.Message). Treating previous content as absent (reference behavior: providers not recovered, non-fatal)."
        return $raw, $null
    }
}

function Write-Utf8NoBom {
    param([string]$Path, [string]$Text)
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($Path, $Text, $utf8NoBom)   # exactly as launch_Harness_old.ps1:520-521
}

# ---------------------------------------------------------------------------
# 0. Session header
# ---------------------------------------------------------------------------
try {
    Write-Log 'INFO' "===== Session $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') ====="
    $AgentDir = Resolve-PiAgentDir
    if ($Restore) {
        # -------------------------------------------------------------------
        # 0b. RESTORE MODE : latest .bak_yyyyMMdd_HHmmss pair, verify, nothing else
        # -------------------------------------------------------------------
        Write-Log 'INFO' 'Mode: RESTORE (-Restore) : restores the latest .bak_yyyyMMdd_HHmmss pair, verifies by SHA-256.'
        Write-Log 'INFO' "pi agent dir : $AgentDir"
        $baks = @(Get-ChildItem -LiteralPath $AgentDir -Filter '*.bak_*' -File -ErrorAction SilentlyContinue |
                 Where-Object { $_.Name -match '\.bak_\d{8}_\d{6}$' })
        if ($baks.Count -eq 0) {
            Write-Log 'ERROR' "No backup found under $AgentDir matching *.bak_yyyyMMdd_HHmmss : nothing to restore, aborting (exit 1)."
            exit 1
        }
        $latest = $baks | Group-Object { [regex]::Match($_.Name, '\.bak_(\d{8}_\d{6})$').Groups[1].Value } |
                  Sort-Object Name -Descending | Select-Object -First 1
        $ts = $latest.Name
        Write-Log 'INFO' "Latest backup timestamp : $ts ($($latest.Count) file(s))"
        $problems = 0
        foreach ($t in @(
            @{ Name = 'models.json';   Bak = (Join-Path $AgentDir ("models.json.bak_$ts")) }
            @{ Name = 'settings.json'; Bak = (Join-Path $AgentDir ("settings.json.bak_$ts")) }
        )) {
            $dst = Join-Path $AgentDir $t.Name
            if (Test-Path -LiteralPath $t.Bak) {
                Copy-Item -LiteralPath $t.Bak -Destination $dst -Force
                $hBak = (Get-FileHash -LiteralPath $t.Bak -Algorithm SHA256).Hash
                $hDst = (Get-FileHash -LiteralPath $dst -Algorithm SHA256).Hash
                Write-Log 'INFO' "Restored $($t.Name) <- $(Split-Path $t.Bak -Leaf)"
                Write-Log 'INFO' "  SHA256 backup   : $hBak"
                Write-Log 'INFO' "  SHA256 restored : $hDst"
                if ($hBak -ne $hDst) { Write-Log 'ERROR' "Hash MISMATCH after restoring $($t.Name)."; $problems++ }
                else                { Write-Log 'OK'    "Hash MATCH for $($t.Name)." }
            } elseif (Test-Path -LiteralPath $dst) {
                Remove-Item -LiteralPath $dst -Force
                Write-Log 'WARN' "$($t.Name) has no .bak_$ts (it did not exist before that write) -> removed to restore prior state exactly."
            } else {
                Write-Log 'INFO' "$($t.Name) has no .bak_$ts and the target is already absent : nothing to do."
            }
        }
        if ($problems -gt 0) {
            Write-Log 'ERROR' "Restore finished with $problems verification failure(s) : see hashes above. Exit 1."
            exit 1
        }
        Write-Log 'OK' "Restore OK : prior state restored from .bak_$ts. Nothing else was touched."
        exit 0
    }
    Write-Log 'INFO' "Mode: $(if ($DryRun) { 'DRY-RUN (no write, no backup)' } else { 'REAL WRITE (backup first)' })"
    Write-Log 'INFO' "pi agent dir : $AgentDir"
    $ModelsPath   = Join-Path $AgentDir 'models.json'
    $SettingsPath = Join-Path $AgentDir 'settings.json'

    # -----------------------------------------------------------------------
    # 1. Probe result validation
    # -----------------------------------------------------------------------
    if (-not (Test-Path -LiteralPath $ProbeResult)) {
        throw "Probe result not found: $ProbeResult"
    }
    $probe = (Get-Content -LiteralPath $ProbeResult -Raw | ConvertFrom-Json)
    if ($null -eq $probe) { throw "Probe result is empty: $ProbeResult" }
    if ([string]::IsNullOrWhiteSpace([string]$probe.baseUrl)) { throw "probe_result.baseUrl missing or empty." }
    if ([string]$probe.api -ne 'openai-completions') {
        throw "probe_result.api = '$($probe.api)' ; expected 'openai-completions'."
    }
    $apiKeyPresent  = [bool]$probe.apiKeyPresent
    $apiKey         = [string]$probe.apiKey
    if ($apiKeyPresent -and [string]::IsNullOrWhiteSpace($apiKey)) { throw 'probe_result.apiKeyPresent is true but apiKey is missing/blank.' }
    if (-not $apiKeyPresent) {
        # Piece 2 contract : une probe sans cle ne doit JAMAIS atteindre l'ecriture
        # (models.json sans providers.alan.apiKey -> pi masque les modeles alan).
        # Erreur ferme AVANT toute sauvegarde/ecriture (exit 1 via le catch final).
        # Le tiret long est construit via [char]0x2014 : le fichier .ps1 est en UTF-8 sans
        # BOM lu en ANSI par Windows PowerShell, un tiret long litteral serait corrompu.
        throw ('API key required ' + [char]0x2014 + ' paste it as the only argument: /ALAN_connector <apiKey>')
    }
    if (-not $probe.models -or @($probe.models).Count -eq 0) { throw 'probe_result.models is empty.' }
    foreach ($mdl in @($probe.models)) {
        if ([string]::IsNullOrWhiteSpace([string]$mdl.id)) { throw "probe_result.models entry without id." }
        $cw = [string]$mdl.contextWindow; $mt = [string]$mdl.maxTokens
        if ($cw -notmatch '^\d+$' -or [long]$cw -le 0) { throw "probe_result.models id '$($mdl.id)' : contextWindow must be an integer > 0 (got '$cw'). pi drops models with non-positive contextWindow/maxTokens." }
        if ($mt -notmatch '^\d+$' -or [long]$mt -le 0) { throw "probe_result.models id '$($mdl.id)' : maxTokens must be an integer > 0 (got '$mt')." }
    }
    $sel = [string]$probe.selectedModelId
    if ([string]::IsNullOrWhiteSpace($sel)) { throw 'probe_result.selectedModelId missing/empty.' }
    if (-not (@($probe.models).id -contains $sel)) {
        throw "probe_result.selectedModelId '$sel' is not among probed model ids: $((@($probe.models).id) -join ', ')."
    }
    Write-Log 'OK' "Probe result OK : baseUrl=$($probe.baseUrl) models=$(@($probe.models).Count) selected=$sel apiKeyPresent=$apiKeyPresent"

    # -----------------------------------------------------------------------
    # 2. Read existing config (byte-exact raw + parsed)
    # -----------------------------------------------------------------------
    $modelsRaw,   $modelsObj   = Read-JsonRaw -Path $ModelsPath   -Required $false
    $settingsRaw, $settingsObj = Read-JsonRaw -Path $SettingsPath -Required $false

    # -----------------------------------------------------------------------
    # 3. Build new models.json text  (merge, per-field, never a full replace)
    # -----------------------------------------------------------------------
    $hasModels = $null -ne $modelsObj
    if ($null -eq $modelsObj.providers) { $modelsObj = [ordered]@{ providers = [ordered]@{} } }
    $provObj = $modelsObj.providers                       # PSCustomObject (parsed file) or IDictionary (fresh)
    $newAlan = [ordered]@{}
    # preserve every existing key on providers.alan EXCEPT the four probed fields
    $exAlan = if ($provObj -is [System.Management.Automation.PSCustomObject]) { $provObj.PSObject.Properties['alan'].Value } else { $provObj['alan'] }
    if ($null -ne $exAlan) {
        foreach ($p in $exAlan.PSObject.Properties) {
            if ($p.Name -notin @('baseUrl', 'api', 'apiKey', 'models')) { $newAlan[$p.Name] = $p.Value }
        }
    }
    $newAlan['baseUrl'] = [string]$probe.baseUrl
    $newAlan['api']     = 'openai-completions'
    $newAlan['apiKey'] = $apiKey                                     # verbatim, byte-for-byte (garanti present : hard error ci-dessus si apiKeyPresent=false)
    # Display name = probe name + max context size in k (idempotent: a previous
    # "(32k)" suffix is stripped before re-appending the fresh value).
    $ctxK = { param([int]$cw)
        $k = [math]::Round($cw / 1024, 1)
        if ($k -eq [math]::Floor($k)) { "($([int]$k)k)" } else { "($($k)k)" }
    }
    $stripCtxK = { param([string]$s) ($s -replace '\s*\(\d+(\.\d+)?k\)$', '') }
    $newModels = @()
    foreach ($mdl in @($probe.models)) {
        $id = [string]$mdl.id
        $base = & $stripCtxK ([string]$mdl.name)
        $k = & $ctxK ([int]$mdl.contextWindow)
        $displayName = if ($base -eq $id) { "$id $k" } else { "$base  ($id) $k" }
        $newModels += [ordered]@{
            id            = $id
            name          = $displayName
            contextWindow = [int]$mdl.contextWindow
            maxTokens     = [int]$mdl.maxTokens
        }
    }
    $newAlan['models'] = $newModels
    if ($provObj -is [System.Management.Automation.PSCustomObject]) {
        $alanProp = $provObj.PSObject.Properties['alan']
        if ($null -ne $alanProp) { $alanProp.Value = $newAlan } else { $provObj | Add-Member -NotePropertyName 'alan' -NotePropertyValue $newAlan }
    } else {
        $provObj['alan'] = $newAlan
    }
    $newModelsText = $modelsObj | ConvertTo-Json -Depth 6            # reference used -Depth 6

    # -----------------------------------------------------------------------
    # 4. Build new settings.json text  (TEXT-SURGICAL: only the two keys; missing
    #    file -> minimal valid object; EVERY produced text must parse as JSON)
    # -----------------------------------------------------------------------
    $nl = "`n"; if ($null -ne $settingsRaw -and $settingsRaw -match "`r`n") { $nl = "`r`n" }
    $addKeys = @()
    $newSettingsText = $null
    if ($null -eq $settingsObj) {
        # settings.json absent (or unreadable): build a minimal valid pi settings.json
        # { defaultProvider, defaultModel } only (never leave $newSettingsText null ->
        # WriteAllText(null) would produce a 0-byte file).
        $addKeys = @('    "defaultProvider":  "alan"', ('    "defaultModel":  "' + $sel + '"'))
        $newSettingsText = '{' + $nl + ($addKeys -join (',' + $nl)) + $nl + '}' + $nl
    } else {
        $newSettingsText = $settingsRaw                       # byte-exact base, unchanged parts keep their formatting
        $p1Re = '(?m)^([ \t]*"defaultProvider")[ \t]*:[ \t]*"[^"]*"([ \t]*,?)'
        $p2Re = '(?m)^([ \t]*"defaultModel")[ \t]*:[ \t]*"[^"]*"([ \t]*,?)'
        $hasP1 = [regex]::IsMatch($settingsRaw, $p1Re)
        $hasP2 = [regex]::IsMatch($settingsRaw, $p2Re)
        $newSettingsText = [regex]::Replace($newSettingsText, $p1Re, ('$1:  "alan"' + '$2'))
        $newSettingsText = [regex]::Replace($newSettingsText, $p2Re, ('$1:  "' + $sel + '"' + '$2'))
        if (-not $hasP1) { $addKeys += '    "defaultProvider":  "alan"' }
        if (-not $hasP2) { $addKeys += '    "defaultModel":  "' + $sel + '"' }
        if ($addKeys.Count -gt 0) {
            $trim = $settingsRaw.Trim()
            if ($trim -eq '{}') {
                # empty object -> rebuild minimally in the reference's WS style
                $newSettingsText = '{' + $nl + ($addKeys -join (',' + $nl)) + $nl + '}' + $nl
            } else {
                # insert after the opening brace; every new key is comma-separated from
                # the next, and a trailing comma is added only when other keys follow,
                # so the result is valid JSON for ALL combinations (1 or 2 missing keys).
                $idx = $newSettingsText.IndexOf('{'); if ($idx -lt 0) { $idx = 0 }
                $head = $newSettingsText.Substring(0, $idx + 1)
                $tail = $newSettingsText.Substring($idx + 1).TrimStart("`r", "`n")
                $add = ''
                for ($k = 0; $k -lt $addKeys.Count; $k++) {
                    $add += $nl + $addKeys[$k]
                    if ($k -lt ($addKeys.Count - 1) -or $tail -notmatch '^[ \t]*\}') { $add += ',' }
                }
                $add += $nl
                $newSettingsText = $head + $add + $tail
            }
        }
    }

    # -----------------------------------------------------------------------
    # 5. Validation of the NEW content (both modes)
    # -----------------------------------------------------------------------
    $issues = @()
    $checks = @()
    try {
        $chk = $newModelsText | ConvertFrom-Json
        if ([string]$chk.providers.alan.baseUrl  -ne [string]$probe.baseUrl) { $issues += 'models.json: providers.alan.baseUrl lost after serialization' }
        if ([string]$chk.providers.alan.api     -ne 'openai-completions')   { $issues += 'models.json: providers.alan.api wrong after serialization' }
        $gotKey = ($null -ne $chk.providers.alan.PSObject.Properties['apiKey'])
        if ($apiKeyPresent -and -not $gotKey) { $issues += 'models.json: apiKey missing although apiKeyPresent=true' }
        foreach ($mdl in @($chk.providers.alan.models)) {
            if ([long]$mdl.contextWindow -le 0) { $issues += "models.json: model '$($mdl.id)' contextWindow <= 0 after serialization" }
            if ([long]$mdl.maxTokens     -le 0) { $issues += "models.json: model '$($mdl.id)' maxTokens <= 0 after serialization" }
        }
        if (-not (@($chk.providers.alan.models).id -contains $sel)) { $issues += "models.json: selectedModelId '$sel' not in providers.alan.models after serialization" }
        if ($hasModels) {
            $before = ConvertTo-Hashtable $modelsObj; $after = ConvertTo-Hashtable $chk
            $b = $before.providers; $a = $after.providers
            if ($null -eq $a) { $issues += 'models.json: providers object lost' }
            else {
                foreach ($pn in @($b.Keys)) {
                    if ($pn -ne 'alan') {
                        $d = Get-ObjDiff $b[$pn] $a[$pn] "providers.$pn"
                        if ($d.Count -gt 0) { $issues += "models.json other-provider check providers.$pn was NOT preserved: $($d -join ' ; ')" }
                    }
                }
                if (-not $a.Contains('alan')) { $issues += 'models.json: providers.alan missing after serialization' }
            }
        }
        $checks += 'models.json : JSON parses, alan provider present, probed fields exact, other providers preserved'
    } catch { $issues += "models.json post-build parse failed: $($_.Exception.Message)" }

    try {
        $chkS = $newSettingsText | ConvertFrom-Json
        if ([string]$chkS.defaultProvider -ne 'alan') { $issues += "settings.json: defaultProvider = '$($chkS.defaultProvider)' != 'alan'" }
        if ([string]$chkS.defaultModel    -ne $sel)   { $issues += "settings.json: defaultModel = '$($chkS.defaultModel)' != '$sel'" }
        if ($null -ne $settingsObj) {
            $bS = ConvertTo-Hashtable $settingsObj; $aS = ConvertTo-Hashtable $chkS
            $bS.Remove('defaultProvider'); $bS.Remove('defaultModel')
            $aS.Remove('defaultProvider'); $aS.Remove('defaultModel')
            $d = Get-ObjDiff $bS $aS
            if ($d.Count -gt 0) { $issues += "settings.json other keys NOT preserved: $($d -join ' ; ')" }
        }
        $checks += 'settings.json : JSON parses, defaultProvider=alan, defaultModel=selected, all other keys value-identical'
    } catch { $issues += "settings.json post-build parse failed: $($_.Exception.Message)" }

    # -----------------------------------------------------------------------
    # 6. Dry-run: show the diff, exit
    # -----------------------------------------------------------------------
    if ($DryRun) {
        Write-Log 'INFO' ("models.json  :" ); Show-TextDiff -Old $modelsRaw -New $newModelsText | Out-Null
        Write-Log 'INFO' ("settings.json:" ); Show-TextDiff -Old $settingsRaw -New $newSettingsText | Out-Null
        if ($issues.Count -gt 0) {
            foreach ($i in $issues) { Write-Log 'ERROR' "VALIDATION: $i" }
            throw "Dry-run validation FAILED ($($issues.Count) issue(s)). Nothing was written."
        }
        foreach ($c in $checks) { Write-Log 'OK' "VALIDATION: $c" }
        Write-Log 'OK' 'Dry-run OK : diff above shows exactly the expected changes. Nothing was written, no backup created.'
        exit 0
    }

    # -----------------------------------------------------------------------
    # 7. Real write: backup FIRST, write, verify, restore on failure
    # -----------------------------------------------------------------------
    $ts = Get-Date -Format 'yyyyMMdd_HHmmss'
    $bakModels   = $ModelsPath   + ".bak_$ts"
    $bakSettings = $SettingsPath + ".bak_$ts"
    if (Test-Path -LiteralPath $ModelsPath)   { Copy-Item -LiteralPath $ModelsPath   -Destination $bakModels;   Write-Log 'INFO' "Backup created : $bakModels" }
    if (Test-Path -LiteralPath $SettingsPath) { Copy-Item -LiteralPath $SettingsPath -Destination $bakSettings; Write-Log 'INFO' "Backup created : $bakSettings" }

    if ($issues.Count -gt 0) {
        Write-Utf8NoBom -Path $ModelsPath   -Text $newModelsText
        Write-Utf8NoBom -Path $SettingsPath -Text $newSettingsText
        # triggers the restore path below via re-verification loop? No: pre-write validation failed -> restore now (files were just overwritten).
        foreach ($i in $issues) { Write-Log 'ERROR' "PRE-WRITE VALIDATION FAILED: $i" }
        Write-Log 'ERROR' 'Restoring from backups taken just now (never delete backups).'
        if (Test-Path -LiteralPath $bakModels)   { Copy-Item -LiteralPath $bakModels   -Destination $ModelsPath   -Force }
        if (Test-Path -LiteralPath $bakSettings) { Copy-Item -LiteralPath $bakSettings -Destination $SettingsPath -Force }
        Write-Log 'ERROR' 'Restored. Config left untouched. See issues above.'
        exit 1
    }

    Write-Utf8NoBom -Path $ModelsPath    -Text $newModelsText
    Write-Utf8NoBom -Path $SettingsPath  -Text $newSettingsText
    Write-Log 'OK' 'Written models.json and settings.json (UTF8 no BOM, -Depth 6 merge semantics).'

    # post-write verification vs the pre-write snapshot
    $vIssues = @()
    $vModelsRaw   = [System.IO.File]::ReadAllText($ModelsPath)
    $vSettingsRaw = [System.IO.File]::ReadAllText($SettingsPath)
    $vM = $vModelsRaw | ConvertFrom-Json
    $vS = $vSettingsRaw | ConvertFrom-Json
    if ($vM.providers.alan.baseUrl -ne [string]$probe.baseUrl)            { $vIssues += 'POST model: providers.alan.baseUrl mismatch' }
    if (@($vM.providers.alan.models).id -notcontains $sel)               { $vIssues += 'POST model: selected model missing' }
    if ($vS.defaultProvider -ne 'alan')                                  { $vIssues += 'POST settings: defaultProvider mismatch' }
    if ($vS.defaultModel -ne $sel)                                       { $vIssues += 'POST settings: defaultModel mismatch' }
    if ($null -ne $settingsObj) {
        # only when settings.json pre-existed can we diff its pre-existing keys
        $bS2 = ConvertTo-Hashtable $settingsObj; $aS2 = ConvertTo-Hashtable $vS
        $bS2.Remove('defaultProvider'); $bS2.Remove('defaultModel')
        $aS2.Remove('defaultProvider'); $aS2.Remove('defaultModel')
        $d2 = Get-ObjDiff $bS2 $aS2
        if ($d2.Count -gt 0) { $vIssues += "POST settings other keys changed: $($d2 -join ' ; ')" }
    }
    if ($vIssues.Count -gt 0) {
        foreach ($i in $vIssues) { Write-Log 'ERROR' "POST-WRITE VERIFICATION FAILED: $i" }
        Write-Log 'ERROR' 'Restoring from backups taken just now.'
        if (Test-Path -LiteralPath $bakModels)   { Copy-Item -LiteralPath $bakModels   -Destination $ModelsPath   -Force }
        if (Test-Path -LiteralPath $bakSettings) { Copy-Item -LiteralPath $bakSettings -Destination $SettingsPath -Force }
        Write-Log 'ERROR' 'Restored. Config left at pre-write state. See issues above.'
        exit 1
    }
    Write-Log 'OK' 'Post-write verification PASSED : models.json parses, alan provider intact, settings.json other keys untouched.'
    Write-Log 'OK' "Done. Backups retained at .bak_$ts (never deleted)."
    exit 0
} catch {
    Write-Log 'ERROR' "FAILED: $($_.Exception.Message)"
    Write-Log 'ERROR' "  at $($_.InvocationInfo.ScriptName):$($_.InvocationInfo.ScriptLineNumber)"
    exit 1
}
