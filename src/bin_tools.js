// src/bin_tools.js
// Port of pi's utils/tools-manager.js (pi v0.86.1, read 2026-10-01) — the
// ensureTool mechanism the imported grep/find tools rely on (pi's grep spawns
// rg, pi's find spawns fd; pi resolves them "own bin dir → PATH → download the
// latest GitHub release into the bin dir").
//
// ONE deliberate difference from pi: the resolution order inserts PI'S OWN bin
// dir (~/.pi/agent/bin) between the harness cache and PATH, so a machine that
// already runs pi (this one — rg.exe + fd.exe are there) REUSES the installed
// binaries instead of downloading ~10 MB again. Order:
//   1. <userDotDir()>/bin/          (the harness's own cache — downloads land here)
//   2. ~/.pi/agent/bin/             (pi's cache — reuse when pi is installed)
//   3. system PATH                  (pi's commandExists: spawn --version)
//   4. GitHub release download      (pi's exact repos/tags/asset names; cached in 1.)
// Offline mode: OBSERVATION_ONLY_OFFLINE=1|true|yes (pi's PI_OFFLINE analog)
// skips the download — the tool then answers "not available".
//
// Only the two tools the harness imports are registered (fd, rg) — pi's full
// manager stays as the reference. Never prints secrets.
import { spawnSync } from "node:child_process";
import { chmodSync, createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { arch, homedir, platform } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { userDotDir } from "./config.js";

const NETWORK_TIMEOUT_MS = 10_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;
const APP_NAME = "observation-only";

/** The harness's tool cache dir (pi's getBinDir analog): <userDotDir()>/bin. */
export function getBinDir() {
  return join(userDotDir(), "bin");
}

/** Pi's bin dir — checked second so an existing pi install's rg/fd are reused. */
function piBinDir() {
  return join(homedir(), ".pi", "agent", "bin");
}

function isOfflineModeEnabled() {
  const value = process.env.OBSERVATION_ONLY_OFFLINE;
  if (!value) return false;
  return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}

// Pi's exact release metadata (tools-manager.js TOOLS): repos, tag prefixes and
// per-platform asset names — DO NOT "simplify"; an asset-name change 404s.
const TOOLS = {
  fd: {
    name: "fd",
    repo: "sharkdp/fd",
    binaryName: "fd",
    systemBinaryNames: ["fd", "fdfind"],
    tagPrefix: "v",
    getAssetName: (version, plat, architecture) => {
      if (plat === "darwin") {
        const archStr = architecture === "arm64" ? "aarch64" : "x86_64";
        return `fd-v${version}-${archStr}-apple-darwin.tar.gz`;
      } else if (plat === "linux") {
        const archStr = architecture === "arm64" ? "aarch64" : "x86_64";
        return `fd-v${version}-${archStr}-unknown-linux-musl.tar.gz`;
      } else if (plat === "win32") {
        const archStr = architecture === "arm64" ? "aarch64" : "x86_64";
        return `fd-v${version}-${archStr}-pc-windows-msvc.zip`;
      }
      return null;
    },
  },
  rg: {
    name: "ripgrep",
    repo: "BurntSushi/ripgrep",
    binaryName: "rg",
    systemBinaryNames: ["rg"],
    tagPrefix: "",
    getAssetName: (version, plat, architecture) => {
      if (plat === "darwin") {
        const archStr = architecture === "arm64" ? "aarch64" : "x86_64";
        return `ripgrep-${version}-${archStr}-apple-darwin.tar.gz`;
      } else if (plat === "linux") {
        const archStr = architecture === "arm64" ? "aarch64" : "x86_64";
        return `ripgrep-${version}-${archStr}-unknown-linux-musl.tar.gz`;
      } else if (plat === "win32") {
        const archStr = architecture === "arm64" ? "aarch64" : "x86_64";
        return `ripgrep-${version}-${archStr}-pc-windows-msvc.zip`;
      }
      return null;
    },
  },
};

// Pi's commandExists: try running `<cmd> --version`.
function commandExists(cmd) {
  try {
    const result = spawnSync(cmd, ["--version"], { stdio: "pipe" });
    return result.error === undefined || result.error === null;
  } catch {
    return false;
  }
}

/** Resolve an already-available binary: harness bin → pi bin → PATH.
 *  (pi's getToolPath + the pi-bin reuse step; returns null when nowhere.) */
export function getToolPath(tool) {
  const config = TOOLS[tool];
  if (!config) return null;
  const binaryExt = platform() === "win32" ? ".exe" : "";
  const localPath = join(getBinDir(), config.binaryName + binaryExt);
  if (existsSync(localPath)) return localPath;
  const piPath = join(piBinDir(), config.binaryName + binaryExt);
  if (existsSync(piPath)) return piPath;
  for (const systemBinaryName of config.systemBinaryNames ?? [config.binaryName]) {
    if (commandExists(systemBinaryName)) return systemBinaryName;
  }
  return null;
}

/** Pi's getLatestVersion: the GitHub web /releases/latest redirect (no API
 *  quota cost — pi's comment, kept). */
async function getLatestVersion(repo) {
  const response = await fetchWithRetry(`https://github.com/${repo}/releases/latest`, {
    headers: { "User-Agent": APP_NAME },
    redirect: "manual",
  }, { timeoutMs: NETWORK_TIMEOUT_MS });
  try {
    await response.body?.cancel();
  } catch {
    /* discarding the body is best-effort (pi) */
  }
  const location = response.status >= 300 && response.status < 400 ? response.headers.get("location") : null;
  if (!location) {
    throw new Error(`Failed to resolve latest ${repo} release: HTTP ${response.status} without redirect`);
  }
  const tag = new URL(location, "https://github.com").pathname.split("/").pop();
  if (!tag || !location.includes("/releases/tag/")) {
    throw new Error(`Failed to resolve latest ${repo} release: unexpected redirect: ${location}`);
  }
  return decodeURIComponent(tag).replace(/^v/, "");
}

/** Minimal fetchWithRetry (pi's management-http analog): 3 attempts, 1s/2s
 *  backoff, per-attempt AbortSignal.timeout. */
async function fetchWithRetry(url, init, { timeoutMs }) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      lastError = error;
      if (attempt < 2) await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
  throw lastError;
}

async function downloadFile(url, dest) {
  const response = await fetchWithRetry(url, undefined, { timeoutMs: DOWNLOAD_TIMEOUT_MS });
  if (!response.ok) {
    throw new Error(`Download failed with HTTP ${response.status}: ${url}`);
  }
  if (!response.body) {
    throw new Error("No response body");
  }
  const fileStream = createWriteStream(dest);
  await pipeline(Readable.fromWeb(response.body), fileStream);
}

function findBinaryRecursively(rootDir, binaryFileName) {
  const stack = [rootDir];
  while (stack.length > 0) {
    const currentDir = stack.pop();
    if (!currentDir) continue;
    const entries = readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(currentDir, entry.name);
      if (entry.isFile() && entry.name === binaryFileName) return fullPath;
      if (entry.isDirectory()) stack.push(fullPath);
    }
  }
  return null;
}

function formatSpawnFailure(result) {
  if (result.error?.message) return result.error.message;
  const stderr = result.stderr?.toString().trim();
  if (stderr) return stderr;
  const stdout = result.stdout?.toString().trim();
  if (stdout) return stdout;
  return `exit status ${result.status ?? "unknown"}`;
}

function runExtractionCommand(command, args) {
  const result = spawnSync(command, args, { stdio: "pipe" });
  if (!result.error && result.status === 0) return null;
  return `${command}: ${formatSpawnFailure(result)}`;
}

function extractTarGzArchive(archivePath, extractDir, assetName) {
  const failure = runExtractionCommand("tar", ["xzf", archivePath, "-C", extractDir]);
  if (failure) throw new Error(`Failed to extract ${assetName}: ${failure}`);
}

function getWindowsTarCommand() {
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
  if (systemRoot) {
    const systemTar = join(systemRoot, "System32", "tar.exe");
    if (existsSync(systemTar)) return systemTar;
  }
  return "tar.exe";
}

function extractZipArchive(archivePath, extractDir, assetName) {
  const failures = [];
  if (platform() === "win32") {
    // Windows ships bsdtar as tar.exe, which supports zip files. Prefer the
    // System32 binary over Git Bash's GNU tar, which does not handle zip
    // archives. (pi's comment, kept.)
    const tarFailure = runExtractionCommand(getWindowsTarCommand(), ["xf", archivePath, "-C", extractDir]);
    if (!tarFailure) return;
    failures.push(tarFailure);
    const script = "& { param($archive, $destination) $ErrorActionPreference = 'Stop'; Expand-Archive -LiteralPath $archive -DestinationPath $destination -Force }";
    const powershellFailure = runExtractionCommand("powershell.exe", [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script, archivePath, extractDir,
    ]);
    if (!powershellFailure) return;
    failures.push(powershellFailure);
  } else {
    const unzipFailure = runExtractionCommand("unzip", ["-q", archivePath, "-d", extractDir]);
    if (!unzipFailure) return;
    failures.push(unzipFailure);
    const tarFailure = runExtractionCommand("tar", ["xf", archivePath, "-C", extractDir]);
    if (!tarFailure) return;
    failures.push(tarFailure);
  }
  throw new Error(`Failed to extract ${assetName}: ${failures.join("; ")}`);
}

async function downloadTool(tool) {
  const config = TOOLS[tool];
  if (!config) throw new Error(`Unknown tool: ${tool}`);
  const plat = platform();
  const architecture = arch();
  // Pi's fd darwin/x64 pin (kept verbatim).
  const version = tool === "fd" && plat === "darwin" && architecture === "x64" ? "10.3.0" : await getLatestVersion(config.repo);
  const assetName = config.getAssetName(version, plat, architecture);
  if (!assetName) {
    throw new Error(`Unsupported platform: ${plat}/${architecture}`);
  }
  const toolsDir = getBinDir();
  mkdirSync(toolsDir, { recursive: true });
  const downloadUrl = `https://github.com/${config.repo}/releases/download/${config.tagPrefix}${version}/${assetName}`;
  const archivePath = join(toolsDir, assetName);
  const binaryExt = plat === "win32" ? ".exe" : "";
  const binaryPath = join(toolsDir, config.binaryName + binaryExt);
  await downloadFile(downloadUrl, archivePath);
  // Extract into a unique temp directory. fd and rg downloads can run
  // concurrently, so sharing a fixed directory causes races. (pi's comment.)
  const extractDir = join(toolsDir, `extract_tmp_${config.binaryName}_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`);
  mkdirSync(extractDir, { recursive: true });
  try {
    if (assetName.endsWith(".tar.gz")) {
      extractTarGzArchive(archivePath, extractDir, assetName);
    } else if (assetName.endsWith(".zip")) {
      extractZipArchive(archivePath, extractDir, assetName);
    } else {
      throw new Error(`Unsupported archive format: ${assetName}`);
    }
    // Some archives contain files directly at root, others nest under a
    // versioned subdirectory. (pi)
    const binaryFileName = config.binaryName + binaryExt;
    const extractedDir = join(extractDir, assetName.replace(/\.(tar\.gz|zip)$/, ""));
    const extractedBinaryCandidates = [join(extractedDir, binaryFileName), join(extractDir, binaryFileName)];
    let extractedBinary = extractedBinaryCandidates.find((candidate) => existsSync(candidate));
    if (!extractedBinary) {
      extractedBinary = findBinaryRecursively(extractDir, binaryFileName) ?? undefined;
    }
    if (extractedBinary) {
      renameSync(extractedBinary, binaryPath);
    } else {
      throw new Error(`Binary not found in archive: expected ${binaryFileName} under ${extractDir}`);
    }
    if (plat !== "win32") {
      chmodSync(binaryPath, 0o755);
    }
  } finally {
    rmSync(archivePath, { force: true });
    rmSync(extractDir, { recursive: true, force: true });
  }
  return binaryPath;
}

/**
 * Pi's ensureTool, ported: resolve an existing binary, else download it.
 * `onStatus` receives {type:"info"|"warning", message} — the importing tools
 * stay silent (pi's grep/find pass nothing; the harness's chart shows the tool
 * as pending until it resolves). Returns the tool path, or undefined when
 * unavailable (offline mode / download failed / unsupported platform).
 */
export async function ensureTool(tool, onStatus) {
  const existingPath = getToolPath(tool);
  if (existingPath) return existingPath;
  const config = TOOLS[tool];
  if (!config) return undefined;
  if (isOfflineModeEnabled()) {
    onStatus?.({ type: "warning", message: `${config.name} not found. Offline mode enabled, skipping download.` });
    return undefined;
  }
  onStatus?.({ type: "info", message: `${config.name} not found. Downloading...` });
  try {
    const path = await downloadTool(tool);
    onStatus?.({ type: "info", message: `${config.name} installed to ${path}` });
    return path;
  } catch (e) {
    // Include the error cause chain (pi's comment, kept): fetch failures
    // surface as a bare "fetch failed" TypeError with the actionable detail
    // hidden in the cause. Depth-capped against circular chains.
    const messages = [];
    for (let current = e, depth = 0; current instanceof Error && depth < 5; current = current.cause, depth++) {
      if (!messages.includes(current.message)) messages.push(current.message);
    }
    onStatus?.({ type: "warning", message: `Failed to download ${config.name}: ${messages.length > 0 ? messages.join(": ") : String(e)}` });
    return undefined;
  }
}
