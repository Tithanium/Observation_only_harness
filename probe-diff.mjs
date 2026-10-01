// COMPARE the real pi (built-in FooterComponent) + pi-tps-live renderFooterLines
// vs the Observation_only implementation — IDENTICAL input data → byte diff.
import { FooterComponent } from "C:/Users/connessn/AppData/Roaming/npm/node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/footer.js";
import { theme } from "C:/Users/connessn/AppData/Roaming/npm/node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { createUsageTotals, addUsageToTotals } from "C:/Users/connessn/AppData/Roaming/npm/node_modules/@earendil-works/pi-coding-agent/dist/core/usage-totals.js";
import * as tpl from "file:///C:/Users/connessn/.pi/agent/npm/node_modules/pi-tps-live/extensions/pi-tps-live/footer.ts";
import { TpsMeter } from "file:///C:/Users/connessn/.pi/agent/npm/node_modules/pi-tps-live/extensions/pi-tps-live/tps.ts";
import { renderFooter } from "./src/footer.js";

// ---- ONE data set: a mid-session state (input/output/cost like a real ALAN turn) ----
const USAGE = { input: 3218, output: 1, cacheRead: 0, cacheWrite: 0, cost: undefined };
const MODEL = { id: "deepseek-v4-flash", provider: "alan", contextWindow: 128000, reasoning: false };
const ctx = createUsageTotals();
addUsageToTotals(ctx, USAGE);
const entries = [
  { type: "message", role: "user", content: [] },
  { type: "message", role: "assistant", usage: USAGE },
];
const safe = (s2) => s2.replace(/\x1b\[[0-9;]*m/g, (m) => `\x1b[…m]`);
const show = (tag, lines) => {
  console.log(`----- ${tag} -----`);
  for (const [i, L] of lines.entries()) {
    const anim = i === 0 ? "R-2" : i === 1 ? "R-1" : `R-${3 - i}`;
    console.log(`${tag.padEnd(24)} ${anim}: "${L?.replace(/\x1b\[[0-9;]*m/g, "».«")}"`);
  }
};

const session = {
  state: { model: MODEL, thinkingLevel: "off" },
  thinkingLevel: "off",
  sessionManager: {
    getEntries: () => entries,
    getCwd: () => "C:/Users/connessn/Observation_only",
    getSessionName: () => undefined,
  },
  modelRuntime: { isUsingSubscription: () => false },
  getContextUsage: () => ({ tokens: 3218, contextWindow: 128000, percent: (3218 / 128000) * 100 }),
};
const footerData = {
  getGitBranch: () => null,
  getAvailableProviderCount: () => 1,
};
const fc = new FooterComponent(session, footerData);
show("PI builtin", fc.render(120).split("\n"));

// pi-tps-live (with a live reading like a real turn that finished at 9.4 tok/s)
const meter = new TpsMeter();
meter.start();
meter.addDelta("hello ", 0);
meter.addDelta("world " + "x".repeat(940), 1000);
const finalReading = meter.finish(1500, { outputTokens: 14, ok: true });
const lines2 = tpl.renderFooterLines(
  {
    cwd: "C:/Users/connessn/Observation_only",
    home: process.env.HOME || process.env.USERPROFILE,
    branch: null,
    sessionName: undefined,
    totals: { input: 3218, output: 14, cacheRead: 12, cacheWrite: 0, cost: 0.0042 },
    latestCacheHitRate: 12, // 12/3218… keep simple
    contextPercent: (3218 / 128000) * 100,
    contextWindow: 128000,
    autoCompactEnabled: true,
    modelId: MODEL.id,
    modelProvider: MODEL.provider,
    modelReasoning: false,
    thinkingLevel: "off",
    providerCount: 1,
    usingSubscription: false,
    statuses: new Map(),
    speed: { text: tpl.formatSpeedText(finalReading), live: false },
  },
  120,
  theme,
  { visibleWidth: tpl.visibleWidth, truncateToWidth: tpl.truncateToWidth },
);
show("pi-tps-live", lines2);

// Observation_only — SAME numbers → renderFooter (cursor end)
show("Observation_only", renderFooter({ usage: { ...ctx, totalTokens: 3218 }, model: MODEL, rate: finalReading.tps, providers: 1, cwd: "C:/Users/connessn/Observation_only", width: 120 }).split("\n"));
