# alan_probe.ps1 - Sondage DETERMINISTE du service Alan (piece 3 du gauntlet)
#
# Moteur de sondage autonome (aucune connexion LLM, aucun Read-Host, aucun choix
# interactif) : interroge GET {baseUrl}/models, extrait la liste des modeles et leurs
# limites, resout une selection AUTOMATIQUE, et ecrit probe_result.json consomme par
# le composant config-writer SEPARE (piece 4). Sortie = code de sortie uniquement (0 OK,
# 1 echec fatal). La cle API n'est JAMAIS imprimee ni logguee (elle transite uniquement
# dans l'en-tete HTTP et dans le champ apiKey de probe_result.json, consomme par le
# config-writer).
#
# Sources de verite (fidelite imposee) :
#   - launch_Harness_old.ps1 : Get-AlanModels (L56-77), selection du modele (L79-141),
#     Get-FirstProperty (L157-166), alias ctxNames/outNames/subKeys (L171-173),
#     Try-Extract (L180-204), resultats limits (L233-246), Write-ProbeLog (L25-37)
#   - config.ps1 : $baseUrl (L27), $apiKey (L29-32), $contextWindow/$maxTokens = 32768
#     (L40-41), $preferredModelIds (L55), probe log (L99), dot-source config.local.ps1 (L101-107)
#
# Usage :
#   pwsh alan_probe.ps1                       # selection par defaut : match config -> 1er favori -> 1er de la liste
#   pwsh alan_probe.ps1 --model <id>          # force la selection (id ou nom, match exact)
#   pwsh alan_probe.ps1 --model=<id>          # forme equivalente
#   pwsh alan_probe.ps1 --apiKey <key>        # cle fournie en argument (PRIORITAIRE sur config.ps1/config.local.ps1,
#   pwsh alan_probe.ps1 --apiKey=<key>         # forme equivalente ; contrat /ALAN_connector <apiKey> de la piece 2 ;
#                                            # apiKeyPresent=true ; la cle elle-meme n'est JAMAIS imprimee ni logguee.
#
# NE PAS appeler GET {baseUrl}/models/{id} : sur Alan cet endpoint n'existe pas
# (il repond 200 avec le SPA HTML Open WebUI - mort, cf. PROBE_RECIPE.md 8.1).

param([string]$ApiKey)

# CAPTURE IMMEDIATE de la cle passee en argument, AVANT le dot-source de config.ps1 :
# PowerShell est insensible a la casse, donc $ApiKey (param) et $apiKey (config.ps1 /
# config.local.ps1) sont le MEME variable : le dot-source l'ECRASERAIT (piege du round 2).
# $PassedKey est l'unique source de verite pour la branche d'override ci-dessous.
$PassedKey = $ApiKey

# =====================================================================================
# 0. Resolution de la configuration (config.ps1, qui dot-source config.local.ps1 en dernier)
# =====================================================================================
$configPath = Join-Path $PSScriptRoot "config.ps1"
if (-not (Test-Path $configPath)) {
    Write-Error "Fichier de configuration introuvable : $configPath"
    exit 1
}
. $configPath   # $baseUrl, $apiKey, $modelId, $preferredModelIds, $contextWindow, $maxTokens

# =====================================================================================
# 1. Log de diagnostic (fichier uniquement + console) - format du script original
# =====================================================================================
$probeLogFile = Join-Path $PSScriptRoot "alan_connector_probe.log"
Add-Content -Path $probeLogFile -Value "" -Encoding utf8
Add-Content -Path $probeLogFile -Value "===== Session $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') =====" -Encoding utf8

function Write-ProbeLog {
    param(
        [string]$Message,
        [ValidateSet("INFO", "OK", "WARN", "ERROR")] [string]$Level = "INFO",
        [switch]$FileOnly
    )
    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    Add-Content -Path $probeLogFile -Value "[$timestamp] [$Level] $Message" -Encoding utf8
    if (-not $FileOnly) {
        $color = switch ($Level) { "OK" { "Green" }; "WARN" { "Yellow" }; "ERROR" { "Red" }; default { "Gray" } }
        Write-Host "  $Message" -ForegroundColor $color
    }
}

# =====================================================================================
# 2. Arguments de ligne de commande : --model <id> | --model=<id> | -model <id>
#    (parse manuel : sans declaration param(), tous les tokens restent dans $args,
#    donc --model, -model et /model sont geres uniformement)
# =====================================================================================
$forcedModelId = $null
for ($i = 0; $i -lt $args.Count; $i++) {
    $a = [string]$args[$i]
    if ($a -match '^\s*(?:--?|/)model\s*=\s*(.+?)\s*$') { $forcedModelId = $Matches[1] }
    elseif ($a -match '^\s*(?:--?|/)model\s*$') { $forcedModelId = [string]$args[$i + 1]; $i++ }
    elseif ($a -match '^\s*(?:--?|/)apiKey\s*=\s*(.+?)\s*$') { $PassedKey = $Matches[1] }
    elseif ($a -match '^\s*(?:--?|/)apiKey\s*$') { $PassedKey = [string]$args[$i + 1]; $i++ }
    elseif ($a -in @("--help", "-h", "/?")) {
        Write-Host "Usage : pwsh alan_probe.ps1 [--model <id>|--model=<id>] [--apiKey <key>|--apiKey=<key>]"
        exit 0
    }
}

# =====================================================================================
# 3. Cle API : presente ? Priorite : --apiKey <key> (argument) -> config.ps1/config.local.ps1.
#    (placeholder / vide / absente -> apiKeyPresent=false : le sondage tente quand meme sans
#    en-tete Authorization ; sur Alan ce GET repond 401, cf. PROBE_RECIPE.md. Jamais imprimee.)
# =====================================================================================
$apiKeyPresent = $false
if (-not [string]::IsNullOrWhiteSpace($PassedKey)) {
    # Contrat piece 2 : la cle RECUE en argument (--apiKey <key> | --apiKey=<key>) est utilisee
    # TELLE QUELLE, prioritaire sur la cle config, et ecrite dans probe_result.json (section 8)
    # avec apiKeyPresent=true. $PassedKey a ete capture AVANT le dot-source de config.ps1 : la
    # casse insensible de PowerShell ferait ecraser $ApiKey par $apiKey de config.local.ps1
    # (et le message "fournie en argument" se declencherait a tort - piege du round 2 ferme).
    $apiKey = $PassedKey
    $apiKeyPresent = $true
    Write-ProbeLog "Cle API recue en argument (--apiKey <key> ou --apiKey=<key>) : utilisee telle quelle (prioritaire sur config), apiKeyPresent=true." -Level INFO
} elseif ($apiKey -and $apiKey -ne "<VOTRE_CLE_API_ALAN>" -and -not [string]::IsNullOrWhiteSpace($apiKey)) {
    $apiKeyPresent = $true
    Write-ProbeLog "Cle API resolue (config.ps1 -> config.local.ps1)." -Level INFO
} else {
    Write-ProbeLog "Aucune cle API exploitable (placeholder ou vide) : sondage sans en-tete Authorization (liste eventuellement publique), apiKeyPresent=false." -Level WARN
}

# =====================================================================================
# 4. GET {baseUrl}/models (timeout 20 s) - Get-AlanModels, launch_Harness_old.ps1:56-77
# =====================================================================================
$modelsUrl = "$baseUrl/models"
Write-ProbeLog "Appel GET $modelsUrl ..."
$resp = $null
try {
    if ($apiKeyPresent) {
        $resp = Invoke-RestMethod -Uri $modelsUrl -Headers @{ Authorization = "Bearer $apiKey" } -TimeoutSec 20
    } else {
        $resp = Invoke-RestMethod -Uri $modelsUrl -TimeoutSec 20   # pas de cle : tentative sans Authorization
    }
} catch {
    $httpStatus = $null
    if ($_.Exception.Response) {
        try { $httpStatus = [int]$_.Exception.Response.StatusCode } catch {}
    }
    if ($httpStatus -in @(401, 403) -and -not $apiKeyPresent) {
        # Piece 2 / round-2 : invocation SANS cle exploitable sur Alan -> 401/403 (Alan n'expose
        # pas GET /models sans Authorization). On ecrit quand meme un probe_result.json explicite
        # (apiKeyPresent=false) puis exit 1 avec le message CONTRAT EXACT (tiret long via
        # [char]0x2014 : fichier .ps1 UTF-8 sans BOM lu en ANSI par Windows PowerShell).
        $kl = [ordered]@{ baseUrl = $baseUrl; api = "openai-completions"; apiKeyPresent = $false; models = @(); selectedModelId = $null; probedAt = (Get-Date).ToString("o") }
        try {
            [System.IO.File]::WriteAllText((Join-Path $PSScriptRoot "probe_result.json"), ($kl | ConvertTo-Json -Depth 10), (New-Object System.Text.UTF8Encoding($false)))
        } catch { Write-ProbeLog "ECHEC ecriture du probe_result.json sans cle : $($_.Exception.Message)" -Level ERROR }
        Write-ProbeLog "HTTP $httpStatus sans cle exploitable : le sondage ne peut pas continuer sans cle (le handler /ALAN_connector fait remonter le message contrat)." -Level ERROR
        # Message CONTRAT ecrit en VERBATIM sur stderr (pas Write-Error : la vue d'erreur
        # powershell le couperait/replie, le texte exact doit rester contigu et donc etre
        # reperable tel quel par le handler .ts). Tiret long via [char]0x2014 (UTF-8 sans BOM).
        [Console]::Error.WriteLine(('API key required ' + [char]0x2014 + ' paste it as the only argument: /ALAN_connector <apiKey>'))
        [Console]::Error.Flush()
        exit 1
    }
    Write-ProbeLog "ECHEC GET $modelsUrl : $($_.Exception.Message)" -Level ERROR
    Write-Error "Echec de l'appel a $modelsUrl : $($_.Exception.Message)"
    exit 1
}

# Formes de reponse possibles (commentaire original L66-67) :
# { data: [ {id, name?}, ... ] } | { models: [...] } | [ {id, name?}, ... ] directement.
$list = if ($resp.data) { $resp.data } elseif ($resp.models) { $resp.models } else { $resp }

# Validation de la forme : vide / objet sans "id" => dump JSON brut dans le log + echec fatal
if ($null -eq $list -or @($list).Count -eq 0 -or ($list[0] -isnot [PSCustomObject]) -or ($list[0].PSObject.Properties.Name -notcontains "id")) {
    Write-ProbeLog "GET $modelsUrl a repondu mais sans liste de modeles exploitable (reponse vide ou format inattendu)." -Level ERROR
    try { Write-ProbeLog "    Dump JSON reponse brute : $($resp | ConvertTo-Json -Depth 8 -Compress)" -Level ERROR -FileOnly } catch { Write-ProbeLog "    (reponse brute non serialisable en JSON)" -Level ERROR -FileOnly }
    Write-Error "Aucun modele retourne par $modelsUrl (reponse vide ou format inattendu)."
    exit 1
}
Write-ProbeLog "OK : $(@($list).Count) modele(s) recupere(s) depuis $modelsUrl." -Level OK

# =====================================================================================
# 5. Extraction des limites par modele - alias EXACTS de launch_Harness_old.ps1:171-173
#    (ctxNames/outNames/subKeys) : champ de premier niveau d'abord, puis sous-objets.
# =====================================================================================
$ctxNames = @("context_length", "context_window", "contextWindow", "max_context_length", "n_ctx", "max_model_len", "max_position_embeddings")
$outNames = @("max_tokens", "max_completion_tokens", "max_output_tokens", "maxTokens", "max_new_tokens")
$subKeys  = @("meta", "info", "model_info", "params", "parameters")

function Get-FirstProperty {
    param([object]$Obj, [string[]]$Names)
    foreach ($n in $Names) {
        if ($null -ne $Obj -and $Obj.PSObject.Properties.Name -contains $n) {
            $val = $Obj.$n
            if ($null -ne $val -and $val -ne "") { return $val }
        }
    }
    return $null
}

$modelsInfo = @()   # [ordered]@{ Entry = <entree brute>; Ctx = <valeur ou $null>; Out = <valeur ou $null> } dans l'ordre serveur
foreach ($e in $list) {
    $c = Get-FirstProperty -Obj $e -Names $ctxNames
    $o = Get-FirstProperty -Obj $e -Names $outNames
    if ((-not $c -or -not $o) -and $e) {
        foreach ($sub in $subKeys) {
            if ($e.PSObject.Properties.Name -contains $sub) {
                $subObj = $e.$sub
                if (-not $c) { $c = Get-FirstProperty -Obj $subObj -Names $ctxNames }
                if (-not $o) { $o = Get-FirstProperty -Obj $subObj -Names $outNames }
            }
        }
    }
    $modelsInfo += [ordered]@{ Entry = $e; Ctx = $c; Out = $o }
}

# =====================================================================================
# 6. Selection du modele - ordre EXACT du script (launch_Harness_old.ps1:79-141) :
#    match (id OU nom) du --model force / de config -> 1er favori -> 1er de la liste.
# =====================================================================================
$preferredEntries = @()
foreach ($pref in $preferredModelIds) {
    $m = $list | Where-Object { $_.id -eq $pref } | Select-Object -First 1
    if ($m) { $preferredEntries += $m }
    else { Write-ProbeLog "Modele prefere '$pref' (config.local.ps1) introuvable dans la reponse de $baseUrl/models." -Level WARN }
}
$preferredIds   = @($preferredEntries | ForEach-Object { $_.id })
$others         = @($list | Where-Object { $preferredIds -notcontains $_.id })
$ordered        = @($preferredEntries) + @($others)

$selectedId   = $null
$selectionSrc = $null

if ($forcedModelId) {
    $forceMatch = $ordered | Where-Object { $_.id -eq $forcedModelId -or ($_.name -and $_.name -eq $forcedModelId) } | Select-Object -First 1
    $forceLabel = "id ou nom"
    $warned = $false
    if (-not $forceMatch -and $forcedModelId -match '^\d+$') {
        # --model <index> : numerotation 0-base affichee par /ALAN_connector --list
        # (ordre serveur = $list = ordre de probe_result.json.models).
        $forceIdx = [int]$forcedModelId
        if ($forceIdx -ge 0 -and $forceIdx -lt $list.Count) {
            $forceMatch = $list[$forceIdx]
            $forceLabel = "index [$forceIdx]"
        } else {
            Write-ProbeLog "Index force '--model $forcedModelId' hors bornes (valeurs possibles 0..$($list.Count - 1)) -> repli sur la selection par defaut (config.ps1)." -Level WARN
            $warned = $true
        }
    }
    if ($forceMatch) {
        $selectedId = $forceMatch.id
        $selectionSrc = "--model '$forcedModelId' -> auto-valide ($forceLabel) sur '$($forceMatch.id)'"
    } elseif (-not $warned) {
        # Repli sur la selection par defaut EXACTE du script : match de $modelId (config) -> 1er favori -> 1er de la liste
        Write-ProbeLog "Modele force '--model $forcedModelId' introuvable dans la liste (id, nom ou index) -> repli sur la selection par defaut (config.ps1)." -Level WARN
    }
}
if (-not $selectedId) {
    $match = $ordered | Where-Object { $_.id -eq $modelId -or ($_.name -and $_.name -eq $modelId) } | Select-Object -First 1
    if ($match) {
        $selectedId = $match.id
        $selectionSrc = "modelId='$modelId' (config.ps1/config.local.ps1) trouve dans la liste (id ou nom) -> '$($match.id)'"
    } elseif ($preferredEntries.Count -gt 0) {
        $selectedId = $preferredEntries[0].id
        $selectionSrc = "aucun match pour modelId='$modelId' -> 1er favori '$($preferredEntries[0].id)'"
    } else {
        $selectedId = $ordered[0].id
        $selectionSrc = "aucun match, aucun favori -> 1er modele de la liste '$($ordered[0].id)'"
    }
}
Write-ProbeLog "Selection du modele : $selectionSrc" -Level OK

# =====================================================================================
# 7. Limites du modele selectionne (+ RESULTAT comme le script L233-246 ; jamais d'exit ici)
# =====================================================================================
Write-ProbeLog "Debut de la recuperation des reglages serveur pour le modele '$selectedId'."
$sel = $modelsInfo | Where-Object { $_.Entry.id -eq $selectedId } | Select-Object -First 1
if ($sel.Ctx) {
    Write-ProbeLog "RESULTAT contextWindow = $($sel.Ctx) (source: serveur ; config.ps1 proposait $contextWindow)" -Level OK
} else {
    Write-ProbeLog "RESULTAT contextWindow = $contextWindow (source: config.ps1, rien trouve sur le serveur)" -Level WARN
    Write-ProbeLog "[GET /models (entree '$selectedId')] champ(s) non trouve(s) -> contextWindow=False, maxTokens=$([bool]$sel.Out). Proprietes de premier niveau disponibles : $(($sel.Entry.PSObject.Properties.Name -join ', '))" -Level WARN
    try { Write-ProbeLog "[GET /models (entree '$selectedId')] dump JSON complet (pour reperer le bon nom de champ a ajouter dans `$ctxNames/`$outNames) : $($sel.Entry | ConvertTo-Json -Depth 8 -Compress)" -Level INFO -FileOnly } catch {}
}
if ($sel.Out) {
    Write-ProbeLog "RESULTAT maxTokens = $($sel.Out) (source: serveur ; config.ps1 proposait $maxTokens)" -Level OK
} else {
    Write-ProbeLog "RESULTAT maxTokens = $maxTokens (source: config.ps1, rien trouve sur le serveur)" -Level WARN
}

# =====================================================================================
# 7b. Garde anti-exception : le champ contextWindow renvoye par le serveur peut etre non
#     numerique (chaine libre). Un cast [int] direct leverait une exception terminante ->
#     repli sur 32768 (defaut config.ps1) avec une ligne WARN (fix round du gauntlet).
# =====================================================================================
function Convert-ContextWindowInt {
    param($Value)
    try { return [int]$Value }
    catch {
        Write-ProbeLog "Champ contextWindow du serveur non numerique ('$Value') -> repli sur 32768 (defaut config.ps1)." -Level WARN
        return 32768
    }
}

function Convert-MaxTokensInt {
    param($Value)
    try { return [int]$Value }
    catch {
        Write-ProbeLog "Champ maxTokens du serveur non numerique ('$Value') -> repli sur 32768 (defaut config.ps1)." -Level WARN
        return 32768
    }
}

# =====================================================================================
# 8. Ecriture de probe_result.json - contrat EXACT consomme par le config-writer (piece 4)
#    {
#      "baseUrl": string, "api": "openai-completions", "apiKeyPresent": bool,
#      "apiKey": string (absent si pas de cle), "models": [ {id, name, contextWindow, maxTokens} ],
#      "selectedModelId": string, "probedAt": ISO, "raw": {...} (champs serveur pour reference)
#    }
# =====================================================================================
$modelsOut = foreach ($m in $modelsInfo) {
    [ordered]@{
        id            = $m.Entry.id
        name          = $m.Entry.name
        contextWindow = if ($m.Ctx) { Convert-ContextWindowInt $m.Ctx } else { [int]$contextWindow }
        maxTokens     = if ($m.Out) { Convert-MaxTokensInt $m.Out } else { [int]$maxTokens }
    }
}
$result = [ordered]@{}
$result.baseUrl          = $baseUrl
$result.api               = "openai-completions"
$result.apiKeyPresent     = [bool]$apiKeyPresent
if ($apiKeyPresent) { $result.apiKey = $apiKey }   # consomme par le config-writer ; jamais loggue, jamais imprime
$result.models           = @($modelsOut)
$result.selectedModelId  = $selectedId
$result.probedAt         = (Get-Date).ToString("o")
$result.raw              = $resp

$resultFile = Join-Path $PSScriptRoot "probe_result.json"
try {
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($resultFile, ($result | ConvertTo-Json -Depth 10), $utf8NoBom)
} catch {
    Write-ProbeLog "ECHEC ecriture de $resultFile : $($_.Exception.Message)" -Level ERROR
    Write-Error "Echec de l'ecriture de $resultFile : $($_.Exception.Message)"
    exit 1
}
Write-ProbeLog "OK : probe_result.json ecrit ($(@($modelsOut).Count) modeles, selection '$selectedId')." -Level OK

# Resume console (concat, sans aucune cle)
$keyTxt = if ($apiKeyPresent) { "presente" } else { "absente" }
Write-Host ""
Write-Host "Resume sondage Alan :" -ForegroundColor Cyan
Write-Host "  baseUrl        : $baseUrl"
Write-Host "  modeles        : $(@($modelsOut).Count)"
Write-Host "  selection      : $selectedId"
Write-Host "  apiKey         : $keyTxt"
Write-Host "  log            : $probeLogFile"
Write-Host "  sortie         : $resultFile"
Write-Host ""
exit 0
