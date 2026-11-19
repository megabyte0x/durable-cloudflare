import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { execFileSync } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";

const TOKEN = "board-local-token";
const SECRET = "board-local-secret";
const LEASE_MS = process.env.BOARD_LEASE_MS ?? "1500";
const RENEW_MS = process.env.BOARD_RENEW_MS ?? "500";
const SETTLE_MS = Number(process.env.BOARD_SETTLE_MS ?? "60000");
const BUNDLE = "output/board";
const BOARD = "demo";
const ORIGIN = "http://board.local";
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

mkdirSync("output", { recursive: true });
if (!process.env.BOARD_SKIP_BUILD) execFileSync("npx", ["wrangler", "deploy", "--dry-run", "-c", "wrangler.board.jsonc", "--outdir", BUNDLE], { stdio: "inherit" });
const files = readdirSync(BUNDLE);
const script = files.find(file => file.endsWith(".js"));
const modules = [{ type: "ESModule", path: resolve(BUNDLE, script), contents: readFileSync(resolve(BUNDLE, script), "utf8") }, ...files.filter(file => file.endsWith(".wasm")).map(file => ({ type: "CompiledWasm", path: resolve(BUNDLE, file), contents: readFileSync(resolve(BUNDLE, file)) }))];
const persistence = resolve(mkdtempSync("output/board-state-"));

let mf;
function boot() {
  mf = new Miniflare(convertV4MiniflareOptions({
    resourcePersistencePath: persistence,
    workers: [{
      name: "board",
      modules,
      compatibilityDate: "2026-10-16",
      durableObjects: { BOARDS: { className: "BoardRoom", useSQLite: true }, AGENTS: { className: "BoardAgent", useSQLite: true } },
      bindings: { ACCESS_TOKEN_SHA256: createHash("sha256").update(TOKEN).digest("hex"), BOARD_WEBHOOK_SECRET: SECRET, BOARD_LEASE_MS: LEASE_MS, BOARD_RENEW_MS: RENEW_MS },
    }],
  }));
  return mf.ready;
}

const auth = { authorization: "Bearer " + TOKEN };
async function call(path, init = {}) {
  const response = await mf.dispatchFetch(ORIGIN + "/boards/" + BOARD + path, { ...init, headers: { ...auth, "content-type": "application/json", ...init.headers } });
  const body = await response.text();
  if (!response.ok) throw new Error(path + " " + response.status + " " + body);
  return JSON.parse(body);
}

async function deliver(id, event, payload) {
  const body = JSON.stringify(payload);
  const signature = "sha256=" + createHmac("sha256", SECRET).update(body).digest("hex");
  const response = await mf.dispatchFetch(ORIGIN + "/boards/" + BOARD + "/github", { method: "POST", body, headers: { "content-type": "application/json", "x-github-event": event, "x-github-delivery": id, "x-hub-signature-256": signature } });
  return { status: response.status, body: await response.json() };
}

const tailed = [];
async function tail(after, into) {
  const response = await mf.dispatchFetch(ORIGIN + "/boards/" + BOARD + "/tail?after=" + after, { headers: { ...auth, upgrade: "websocket" } });
  const socket = response.webSocket;
  if (!socket) throw new Error("tail did not upgrade: " + response.status);
  socket.accept();
  socket.addEventListener("message", message => into.push(...JSON.parse(message.data).entries));
  return socket;
}

const plan = {
  id: "launch",
  tasks: [
    { id: "design", parent: null, spec: "write the design", labels: { work_ms: "400" }, needs: [] },
    { id: "api", parent: null, spec: "build the api", labels: { fanout: "3", part_work_ms: "600" }, needs: ["design"] },
    { id: "ui", parent: null, spec: "build the ui", labels: { work_ms: "900" }, needs: ["design"] },
    { id: "docs", parent: null, spec: "write the docs", labels: { work_ms: "300" }, needs: ["design"] },
    { id: "integrate", parent: null, spec: "integrate api and ui", labels: { work_ms: "400" }, needs: ["api", "ui"] },
    { id: "release", parent: null, spec: "cut the release", labels: { work_ms: "200" }, needs: ["integrate", "docs"] },
  ],
};
const agents = ["lead", "ada", "bo", "cy"];
const issue = { number: 7, title: "flaky settlement test", body: null, labels: [{ name: "work_ms:300" }] };

const started = performance.now();
await boot();
const live = await tail(0, tailed);
const unsigned = await mf.dispatchFetch(ORIGIN + "/boards/" + BOARD + "/github", { method: "POST", body: "{}", headers: { "x-github-event": "issues", "x-github-delivery": "forged", "x-hub-signature-256": "sha256=" + "0".repeat(64) } });
const opened = await deliver("delivery-1", "issues", { action: "opened", issue });
const openedAgain = await deliver("delivery-1", "issues", { action: "opened", issue });
await call("/agents", { method: "POST", body: JSON.stringify({ agents, lead: "lead", plan }) });

let held;
for (const deadline = performance.now() + SETTLE_MS; performance.now() < deadline; await sleep(25)) {
  const view = await call("/view");
  held = view.tasks.find(task => task.id === "ui" && task.phase.state === "claimed");
  if (held) break;
}
if (!held) throw new Error("ui was never claimed");
const commented = await deliver("delivery-2", "issue_comment", { action: "created", issue, comment: { body: "seen in CI", user: { login: "octocat" } } });
const evicted = { at_ms: Date.now(), task: held.id, claim: held.phase.claim, worker: held.phase.worker, until_ms: held.phase.until_ms };
const seenBeforeRestart = tailed.length;
live.close();
const restartStarted = performance.now();
await mf.dispose();
await boot();
const restartMs = Math.round(performance.now() - restartStarted);
const resumed = await tail(tailed.at(-1)?.seq ?? 0, tailed);
const redelivered = await deliver("delivery-2", "issue_comment", { action: "created", issue, comment: { body: "seen in CI", user: { login: "octocat" } } });

let view;
for (const deadline = performance.now() + SETTLE_MS; performance.now() < deadline; await sleep(50)) {
  view = await call("/view");
  if (view.settled && view.tasks.length === plan.tasks.length + 3 + 1) break;
}
await sleep(200);
resumed.close();
const log = [];
const full = await tail(0, log);
for (let tries = 0; tries < 100 && log.length < tailed.length; tries++) await sleep(20);
full.close();
await mf.dispose();

const finishes = {};
for (const entry of log) if (entry.change.kind === "finished") finishes[entry.task] = (finishes[entry.task] ?? 0) + 1;
const seqs = log.map(entry => entry.seq);
const tailedSeqs = tailed.map(entry => entry.seq);
const takeovers = log.filter(entry => entry.change.kind === "claimed" && entry.change.took_over).map(entry => ({ task: entry.task, worker: entry.change.worker, at_ms: entry.at_ms }));
const evictedFinished = log.some(entry => entry.change.kind === "finished" && entry.task === evicted.task && entry.event === "finish:" + evicted.claim);
const reclaimed = takeovers.find(entry => entry.task === evicted.task);
const checks = {
  settled: view.settled,
  every_task_done: view.tasks.every(task => task.phase.state === "done"),
  tasks: view.tasks.length,
  every_task_finished_once: view.tasks.every(task => finishes[task.id] === 1),
  forged_webhook_refused: unsigned.status === 401,
  duplicate_delivery_same_verdict: JSON.stringify(opened.body.verdict) === JSON.stringify(openedAgain.body.verdict),
  redelivery_after_restart_same_verdict: JSON.stringify(commented.body.verdict) === JSON.stringify(redelivered.body.verdict),
  one_entry_per_delivery: ["github:delivery-1", "github:delivery-2"].every(event => log.filter(entry => entry.event === event).length === 1),
  evicted_claim_never_finished: !evictedFinished,
  evicted_task_reclaimed_after_lease: Boolean(reclaimed) && reclaimed.at_ms >= evicted.until_ms,
  log_contiguous: seqs.every((seq, index) => index === 0 || seq > seqs[index - 1]),
  tail_across_restart_matches_log: JSON.stringify(tailedSeqs) === JSON.stringify(seqs),
};
const report = {
  lease_ms: Number(LEASE_MS),
  renew_ms: Number(RENEW_MS),
  restart_ms: restartMs,
  total_ms: Math.round(performance.now() - started),
  entries: log.length,
  tailed_before_restart: seenBeforeRestart,
  tailed_after_restart: tailed.length - seenBeforeRestart,
  evicted,
  takeovers,
  finishes,
  checks,
};
writeFileSync(resolve(persistence, "report.json"), JSON.stringify({ ...report, log }, null, 2));
console.log(JSON.stringify(report, null, 2));
if (!Object.entries(checks).every(([name, value]) => name === "tasks" || value === true)) process.exit(1);
