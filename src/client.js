// src/client.js
// The LLM send/receive layer of the harness. Builds a pi-ai Models collection the
// same way pi does for a models.json custom provider (provider-composer.js
// modelFromJson + createProvider), then completes round trips through the same
// provider SDK pi uses ("openai-completions").
import { createModels, createProvider, openAICompletionsApi } from "./pi-ai.js";
import { appendFileSync } from "node:fs";
import { emitExtensionEvent } from "./extensions.js";
import { createTokenRateMeter } from "./footer.js";
import { createWorkingIndicator } from "./working.js";
import { resolveSelection } from "./config.js";

/** pi's usage totals accumulator (core/usage-totals.js createUsageTotals +
 *  addUsageToTotals), plus totalTokens so the footer's ctx field accumulates across
 *  turns: ALL footer token fields then cover the SAME session-cumulative scope (pi's
 *  footer sums every session entry). The last round trip's usage stays available as
 *  `client.usage` for the OPT-IN per-turn footer view only. */
export function createUsageTotals() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, totalTokens: 0 };
}
export function addUsageToTotals(totals, usage) {
  if (!usage) return;
  totals.input += usage.input ?? 0;
  totals.output += usage.output ?? 0;
  totals.cacheRead += usage.cacheRead ?? 0;
  totals.cacheWrite += usage.cacheWrite ?? 0;
  totals.cost += usage.cost?.total ?? 0;
  totals.totalTokens += usage.totalTokens ?? 0;
}

/** Build a pi-ai Model from a models.json definition, mirroring pi's modelFromJson. */
export function modelFromConfig(providerId, providerConfig, modelId) {
  const definition = (providerConfig.models ?? []).find((m) => m.id === modelId);
  if (!definition) {
    throw new Error(`Model "${modelId}" not found for provider "${providerId}" in models.json`);
  }
  return {
    id: definition.id,
    name: definition.name ?? definition.id,
    api: definition.api ?? providerConfig.api ?? "openai-completions",
    provider: providerId,
    baseUrl: definition.baseUrl ?? providerConfig.baseUrl,
    reasoning: definition.reasoning ?? false,
    input: definition.input ?? ["text"],
    cost: definition.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: definition.contextWindow ?? 128000,
    maxTokens: definition.maxTokens ?? 16384,
  };
}

/** Merge together: returns { providerId, modelId, complete(text) -> { text, reply } }. */
export async function createClient(overrides = {}) {
  const { providerId, modelId, providerConfig, apiKey } = resolveSelection(overrides);
  if (apiKey === undefined) {
    throw new Error(
      `No API key for provider "${providerId}": configure it in auth.json, models.json, or pass --api-key`
    );
  }

  const models = await createModels();
  models.setProvider(
    await createProvider({
      id: providerId,
      baseUrl: providerConfig.baseUrl,
      auth: {
        apiKey: {
          name: providerId,
          resolve: async () => ({ auth: { apiKey }, source: "configured API key" }),
        },
      },
      models: [modelFromConfig(providerId, providerConfig, modelId)],
      api: await openAICompletionsApi(),
    })
  );
  const model = models.getModel(providerId, modelId);
  // Round 8: the "working" indicator (src/working.js) — pi's spinner over the
  // in-flight window. TTY-only; when stdout is piped (or the tests inject
  // isTTY:false) start/stop are silent no-ops.
  const indicator = createWorkingIndicator();

  const client = {
    providerId,
    modelId,
    /** One send/receive round trip. `text` is the user message; resolves to the reply text. */
    async complete(text, options = {}) {
      const reply = await this._send({
        messages: [{ role: "user", content: text, timestamp: Date.now() }],
        ...(options.systemPrompt ? { systemPrompt: options.systemPrompt } : {}),
      });
      const textBlocks = (reply.content ?? [])
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("");
      return { text: textBlocks, reply };
    },
    /** Round 3: raw multi-turn drive of the same round-1 connection. Sends a pi
     *  transcript (`messages`) plus optional `tools`/`systemPrompt`, resolves to
     *  the raw AssistantMessage reply (text, thinking and toolCall blocks). */
    async run(messages, options = {}) {
      return this._send({ messages, ...options });
    },
    /** Round 8: the working indicator — active EXACTLY over the in-flight window
     *  (start → reply), erased cleanly in `finally` so the reply and the footer
     *  follow on clean lines; silent entirely when stdout is not a TTY. Round 7:
     *  same request path as models.complete (stream → result), walked event by
     *  event so the meter samples every streamed partial assistant message
     *  (token-rate.ts's sampling window + interval) while the round trip runs, and
     *  the exchange's provider-reported usage + wall time are recorded for the
     *  footer (input/output tokens, context size, tok/s). */
    indicator,
    async _send(request) {
      const started = Date.now();
      this.indicator.start(); // round 8: "Working" while this request is in flight — PIECE 2 (C): `this.indicator` (NOT the createClient-local const) so the chart's reassignment (interactive.js) silences the raw-stdout spinner; line mode keeps the same default instance → byte-identical
      try {
        const { signal, onPartial, ...requestContext } = request; // interactive Ctrl+C travels as the request signal, onPartial feeds the round-16 chart's LIVE view — neither ever enters the transcript
        const stream = models.stream(model, requestContext, { signal });
        // Round 21: the extension event bus (token-rate.ts) watches the message
        // lifecycle pi emits — message_start when the exchange opens,
        // message_update for every streamed partial, message_end on the reply.
        emitExtensionEvent("message_start", { message: { role: "assistant", content: [] } });
        let _evt = 0;
        for await (const event of stream) {
          _evt += 1;
          if (process.env.OBS_PROBE_EVENTS) {
            try {
              appendFileSync(process.env.OBS_PROBE_EVENTS, JSON.stringify({ where: "client", n: _evt, type: event?.type, keys: Object.keys(event ?? {}).sort(), has: event?.partial ? (event.partial.content ?? []).map((b) => b?.type) : null, short: String(event?.partial?.content?.[0]?.text ?? event?.partial?.content?.[0]?.thinking ?? "").slice(0, 40) }) + "\n");
            } catch { /* probe */ }
          }
          // PIECE-3 (F2): a round trip that FAILED (an aborted/cut/errored stream
          // surfaces as {type:"error"}) is THROWN instead of swallowed into an
          // empty stopReason reply — pi's round-trip adapter errors out on a
          // failed stream; the interactive loop then maps the AbortError to
          // "(interrupted)" and any other failure to "Error: …" (line mode:
          // `request failed: …` — byte-identical).
          if (event?.type === "error") {
            // PIECE-3 (F2): an ABORTED round trip surfaces as {type:"error",
            // reason:"aborted", error:<the opaque output record>} — rethrow a REAL
            // AbortError so the session's isAbortError maps it to "(interrupted)"
            // (pi's interrupted stop-reason banner) instead of an opaque record
            // that printed as "Error: request failed: [object Object]". Non-abort
            // stream errors keep the plain throw ("request failed: <msg>").
            if (event.reason === "aborted" || signal?.aborted) throw signal?.reason ?? new DOMException("The operation was aborted", "AbortError");
            throw event.error ?? new Error(String(event.reason ?? "stream error"));
          }
          if (event?.partial) {
            this.meter.sample(event.partial);
            // Round 16: the STREAMED partial assistant message is handed to the
            // interactive chart ON THE GO (the caller's onPartial — the interactive
            // session paints it live in the main area; the one-shot path never
            // passes it, so every non-TTY/injected run keeps the exact current
            // post-turn line output).
            if (typeof onPartial === "function") onPartial(event.partial);
            emitExtensionEvent("message_update", { message: event.partial });
          }
        }
        const reply = await stream.result();
        emitExtensionEvent("message_end", { message: reply });
        this.elapsedMs += Date.now() - started;
        this.meter.finish(reply, Date.now() - started);
        if (reply && typeof reply === "object" && reply.usage !== undefined) {
          this.usage = reply.usage; // last round trip ONLY - the opt-in per-turn view
          addUsageToTotals(this.totals, reply.usage); // session-cumulative, pi's addUsageToTotals scope
        }
        return reply;
      } finally {
        this.indicator.stop(); // erase cleanly: the reply + footer follow on clean lines (PIECE 2 (C): `this.indicator` — swappable, like start)
      }
    },
  };
  // Round 7 footer data, live on the client: the pi-ai model config (footer max
  // context + model name), the session-cumulative provider-reported usage totals
  // (footer input/output/context size — pi's addUsageToTotals over every round
  // trip, so in/out/ctx cover the WHOLE exchange like pi's session-cumulative
  // footer), the LAST round trip's usage (per-turn view, opt-in flag only) and
  // the token-rate meter (pi-tps-live measurement, itself session-cumulative).
  client.elapsedMs = 0;
  client.usage = undefined;
  client.totals = createUsageTotals();
  client.meter = createTokenRateMeter();
  client.model = model;
  return client;
}
