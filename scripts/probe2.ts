import { mkdirSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";

type Sample = {
  provider: string;
  session: string;
  status: number;
  error?: string;
  headers_ms: number;
  first_frame_ms?: number;
  first_delta_ms?: number;
  total_ms: number;
  dispatch_ms?: number;
  runtime_open_ms?: number;
  pump_wait_ms?: number;
  sdk_open_ms?: number;
  laps: Record<string, number>;
  timing?: Record<string, unknown>;
};

const { values, positionals } = parseArgs({ allowPositionals: true, options: { sessions: { type: "string", default: "100" }, providers: { type: "string", default: "claude,codex" }, claude: { type: "string" }, codex: { type: "string" }, concurrency: { type: "string", default: "1" }, gap: { type: "string", default: "250" }, label: { type: "string", default: "probe2" }, prompt: { type: "string", default: "Reply with only the word ok." } } });
const base = new URL(positionals[0] ?? "https://cloudflare.nanocode.xyz/");
const token = process.env.WORKER_TOKEN;
if (!token || /[\r\n]/.test(token)) throw new Error("Provide the owner access token as WORKER_TOKEN");
const sessions = Number(values.sessions);
const concurrency = Number(values.concurrency);
const gap = Number(values.gap);
const providers = values.providers.split(",");
const models: Record<string, string | undefined> = { claude: values.claude, codex: values.codex };
const stamp = Date.now().toString(36);
const round = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? Math.round(value * 10) / 10 : undefined;
const sleep = (ms: number) => new Promise(done => setTimeout(done, ms));

const laps = (text: string) => Object.fromEntries([...text.matchAll(/([a-z_]+);dur=([0-9.]+)/g)].map(match => [match[1]!, Number(match[2])]));

function timingOf(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const timing = (value as { timing?: unknown }).timing;
  if (timing && typeof timing === "object" && "observed_ms" in timing) return timing as Record<string, unknown>;
  for (const inner of Object.values(value)) {
    const found = timingOf(inner);
    if (found) return found;
  }
  return undefined;
}

async function turn(provider: string, index: number): Promise<Sample> {
  const session = "p2-" + provider + "-" + stamp + "-" + index;
  const model = models[provider];
  const started = performance.now();
  const response = await fetch(new URL("/sessions/" + encodeURIComponent(session) + "/turns?live=1", base), { method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json", accept: "text/event-stream" }, body: JSON.stringify({ request_id: "first-" + stamp + "-" + index, prompt: values.prompt + " (" + session + ")", provider, ...(model ? { model } : {}) }) });
  const sample: Sample = { provider, session, status: response.status, headers_ms: round(performance.now() - started)!, total_ms: 0, laps: {} };
  let server = response.headers.get("server-timing") ?? "";
  if (!response.body) return { ...sample, error: "no body", total_ms: sample.headers_ms };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    buffer += decoder.decode(next.value, { stream: true });
    let cut: number;
    while ((cut = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      const at = round(performance.now() - started);
      if (block.startsWith(": server-timing")) { server += ", " + block.slice(": server-timing".length); continue; }
      if (block.startsWith(":")) continue;
      sample.first_frame_ms ??= at;
      if (block.startsWith("event: error")) sample.error = block.slice(0, 500);
      if (block.includes('"assistant.delta"')) sample.first_delta_ms ??= at;
      const data = block.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5)).join("");
      if (!data) continue;
      try { sample.timing ??= timingOf(JSON.parse(data)); } catch {}
    }
    if (sample.timing || sample.error) break;
  }
  await reader.cancel().catch(() => {});
  sample.total_ms = round(performance.now() - started)!;
  sample.laps = laps(server);
  const timing = sample.timing ?? {};
  const requests = timing.model_requests as { started_ms?: number }[] | undefined;
  const spans = timing.runtime_spans as Record<string, { total_ms?: number }> | undefined;
  sample.dispatch_ms = round(requests?.[0]?.started_ms);
  sample.runtime_open_ms = round(timing.runtime_open_ms);
  sample.pump_wait_ms = round(timing.pump_wait_ms);
  sample.sdk_open_ms = round(spans?.["sdk.open"]?.total_ms);
  if (!sample.timing && !sample.error) sample.error = "the stream ended without a result timing";
  return sample;
}

const jobs = Array.from({ length: sessions }, (_, index) => providers.map(provider => () => turn(provider, index))).flat();
const samples: Sample[] = [];
let next = 0;
await Promise.all(Array.from({ length: concurrency }, async () => {
  while (next < jobs.length) {
    const job = jobs[next++]!;
    const sample = await job().catch((error: unknown) => ({ provider: "unknown", session: "", status: 0, error: String(error), headers_ms: 0, total_ms: 0, laps: {} }) as Sample);
    samples.push(sample);
    console.error(JSON.stringify({ ...sample, timing: undefined }));
    await sleep(gap);
  }
}));

const pct = (list: unknown[], p: number) => {
  const sorted = list.filter((value): value is number => typeof value === "number" && Number.isFinite(value)).sort((a, b) => a - b);
  return sorted.length ? round(sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]) : undefined;
};
const timingKeys = ["admission_ms", "respond_ms", "consumed_ms", "log_commit_ms", "alarm_commit_ms", "commit_wait_ms", "pump_wait_ms", "runtime_open_ms"];
const summary = Object.fromEntries(providers.map(provider => {
  const own = samples.filter(sample => sample.provider === provider && !sample.error);
  const fields: [string, unknown[]][] = [
    ["dispatch_ms", own.map(sample => sample.dispatch_ms)],
    ["sdk_open_ms", own.map(sample => sample.sdk_open_ms)],
    ...timingKeys.map(key => [key, own.map(sample => sample.timing?.[key])] as [string, unknown[]]),
    ["client_headers_ms", own.map(sample => sample.headers_ms)],
    ["client_first_frame_ms", own.map(sample => sample.first_frame_ms)],
    ["client_first_delta_ms", own.map(sample => sample.first_delta_ms)],
    ...[...new Set(own.flatMap(sample => Object.keys(sample.laps)))].sort().map(lap => [lap, own.map(sample => sample.laps[lap])] as [string, unknown[]]),
  ];
  return [provider, { n: own.length, errors: samples.filter(sample => sample.provider === provider && sample.error).length, p50_p90_p99: Object.fromEntries(fields.map(([key, list]) => [key, [pct(list, 0.5), pct(list, 0.9), pct(list, 0.99)]])) }];
}));
mkdirSync("output", { recursive: true });
const file = "output/probe2-" + values.label + "-" + Date.now() + ".json";
writeFileSync(file, JSON.stringify({ base: base.origin, label: values.label, sessions, providers, concurrency, measured_at: new Date().toISOString(), summary, samples }, null, 2));
for (const [provider, row] of Object.entries(summary)) {
  console.log(provider + " n=" + row.n + " errors=" + row.errors);
  for (const [key, [p50, p90, p99]] of Object.entries(row.p50_p90_p99)) console.log("  " + key.padEnd(24) + " " + [p50, p90, p99].map(value => String(value ?? "-").padStart(8)).join(" "));
}
console.log(file);
