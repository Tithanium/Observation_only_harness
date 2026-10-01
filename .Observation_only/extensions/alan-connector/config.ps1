# config.ps1 - Projet "Alan" (endpoint UGA deja heberge, sans tunnel/OAR/cluster)
# Source unique de verite pour launch_Harness.ps1 de ce projet.
#
# CE FICHIER EST AGNOSTIQUE / VERSIONNABLE : il ne doit contenir aucune information
# personnelle (cle API, chemins propres a une machine...). Toute particularisation
# utilisateur va dans "config.local.ps1" (a cote, non versionne - ajoutez-le a
# .gitignore), qui est charge EN DERNIER en bas de ce fichier : il peut donc surcharger
# n'importe laquelle des variables definies ci-dessous.

# --- Harnais client ---
# "dsh"     -> DeepSeek Harness (Web UI, http://127.0.0.1:$dshWebPort)
# "pi"      -> Pi (coding agent terminal)
# "omp"     -> Oh My Pi (coding agent terminal)
# "claude"  -> Claude Code - ATTENTION : necessite qu'Alan expose une API compatible Anthropic
#              Messages (/v1/messages), ce qui n'est pas garanti pour une instance Open WebUI
#              (qui n'expose en general que l'API OpenAI-compatible). A tester ; si echec,
#              utiliser un des 3 autres harnais.
# "Observation_only" -> Pi, variante "Observation_only" : strictement identique au
#              harnais "pi" (meme executable/paquet npm, meme providerId), seul le
#              dossier de config/donnees change (".Observation_only" au lieu de ".pi")
#              afin d'avoir un profil totalement separe (modeles/settings/packages
#              independants du "pi" normal).
$harness = "pi"
# valeurs possibles : "dsh"|"pi"|"omp"|"claude"|"Observation_only"

# --- Connexion Alan ---
$baseUrl = "https://alan.univ-grenoble-alpes.fr/api"

# Cle API : NE PAS versionner en clair si ce dossier est dans un depot Git. La valeur
# ci-dessous est un placeholder ; definissez la vraie cle dans config.local.ps1 :
#   $apiKey = "eyJhbGciOi..."
$apiKey = "<VOTRE_CLE_API_ALAN>"

# --- Modele ---
# ATTENTION : $modelId doit etre l'identifiant technique ("id"), pas le nom affiche dans l'UI
# Alan ("ARES\Qwen3.8-27B" est probablement un "name", pas un "id"). Verifier via :
#   Invoke-RestMethod -Uri "$baseUrl/models" -Headers @{Authorization="Bearer <cle>"}
$modelId       = "<ID_EXACT_DU_MODELE>"
$modelName     = "ARES Qwen3.8-27B (Alan UGA)"
$contextWindow = 32768   # a ajuster selon la fiche du modele sur Alan (ou auto-detecte au lancement)
$maxTokens     = 32768

# --- Effort de raisonnement (optionnel, cf. doc Ollama/omp "thinking") ---
$reasoningEffort = ""    # ""|"none"|"low"|"medium"|"high"|"max"

# --- Modeles preferes (optionnel) ---
# Liste d'IDs de modeles a proposer en tete de liste lors du choix interactif du modele
# au lancement (voir launch_Harness.ps1, fonction Select-Model). Definissez la liste
# complete dans config.local.ps1 (elle surcharge celle-ci).
$preferredModelIds = @()

# --- Nom affiche du provider, utilise dans les fichiers de config generes pour les harnais ---
$providerDisplayName = "Alan (UGA)"

# --- Dossier de travail par defaut du harnais (logs/tmp de la session, fichiers du projet
#     courant pour les harnais TUI qui lisent le repertoire courant : pi/omp/claude).
#     Valeur par defaut generique (basee sur le profil Windows de l'utilisateur courant) ;
#     surchargeable dans config.local.ps1 si vous voulez un autre dossier. ---
$localWorkDir = Join-Path $env:USERPROFILE ".omp"

# --- Dossiers de travail preferes (optionnel) ---
# Liste de chemins proposes au choix au lancement (en plus de la saisie libre d'un chemin
# et de $localWorkDir ci-dessus, utilise par defaut si Entree est pressee sans choix).
# Definissez la liste complete dans config.local.ps1 (elle surcharge celle-ci).
$preferredWorkDirs = @()

# --- Sous-parametres par harnais (ID de provider "custom" utilise dans chaque config client,
#     dossier de donnees du harnais, et paquet npm utilise en repli si l'executable local
#     n'est pas trouve dans le PATH) ---
$dshProviderId = "alan"
$dshHome       = Join-Path $env:USERPROFILE ".dsh"
$dshWebPort    = 3080
$dshNpmPackage = "@deepseek-ai/dsh@latest"

$piProviderId  = "alan"
$piHome        = Join-Path $env:USERPROFILE ".pi"
$piNpmPackage  = "@mariozechner/pi-coding-agent@latest"

# "Observation_only" = clone fonctionnel de "pi" (meme providerId, meme paquet npm,
# meme executable "pi") : seul le dossier de donnees ($observationOnlyHome) differe.
$observationOnlyProviderId = $piProviderId
$observationOnlyHome       = Join-Path $env:USERPROFILE ".Observation_only"
$observationOnlyNpmPackage = $piNpmPackage

# NOTE IMPORTANTE (pi / Observation_only) : l'executable "pi" ne lit ses fichiers de
# config que dans le dossier pointe par la variable d'environnement
# PI_CODING_AGENT_DIR (par defaut "~/.pi/agent" si elle n'est pas definie). Pour que
# "Observation_only" (dossier de donnees different de "pi") soit effectivement pris
# en compte par "pi" au lancement, launch_Harness.ps1 doit definir cette variable
# AVANT de lancer l'executable - voir Set-PiAgentDir dans launch_Harness.ps1.

$ompProviderId = "alan"
$ompHome       = Join-Path $env:USERPROFILE ".omp"
$ompNpmPackage = "@oh-my-pi/pi-coding-agent@latest"

$claudeNpmPackage = "@anthropic-ai/claude-code@latest"

# --- Fichier de log de diagnostic des appels reseau vers Alan (voir launch_Harness.ps1) ---
$probeLogFileName = "alan_model_probe.log"

# =====================================================================================
# SURCHARGES UTILISATEUR : config.local.ps1 (non versionne)
# Charge EN DERNIER : peut surcharger n'importe quelle variable definie plus haut
# (apiKey, localWorkDir, modelId, harness, baseUrl, ...).
# =====================================================================================
$localOverride = Join-Path $PSScriptRoot "config.local.ps1"
if (Test-Path $localOverride) { . $localOverride }
