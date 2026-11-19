import { DurableObject } from "cloudflare:workers";
import module from "../target/wasm32-unknown-unknown/release/durable_cloudflare_board.wasm";

interface Env {
  ACCESS_TOKEN_SHA256: string;
  BOARD_WEBHOOK_SECRET: string;
  BOARD_LEASE_MS: string;
  BOARD_RENEW_MS: string;
  BOARDS: DurableObjectNamespace<BoardRoom>;
  AGENTS: DurableObjectNamespace<BoardAgent>;
}

export interface NewTask {
  id: string;
  parent: string | null;
  spec: string;
  labels: Record<string, string>;
  needs: string[];
}

type Outcome = { kind: "done"; detail: string } | { kind: "failed"; detail: string };

export type Op =
  | { op: "post"; task: NewTask }
  | { op: "claim"; task: string; lease_ms: number }
  | { op: "renew"; task: string; claim: string; lease_ms: number }
  | { op: "release"; task: string; claim: string; note: string }
  | { op: "finish"; task: string; claim: string; outcome: Outcome }
  | { op: "cancel"; task: string; reason: string }
  | { op: "reply"; task: string; body: string };

type Rejection =
  | { kind: "exists" | "unknown_task" | "not_holder" | "terminal" }
  | { kind: "unknown_parent" | "unknown_need" | "waiting"; task: string }
  | { kind: "held"; claim: string; until_ms: number };

type Verdict =
  | { applied: { seq: number; event: string } }
  | { rejected: Rejection }
  | { unsettled: { event: string; error: string } };

type Phase =
  | { state: "open" }
  | { state: "claimed"; claim: string; worker: string; until_ms: number }
  | { state: "done"; result: string }
  | { state: "failed"; error: string }
  | { state: "cancelled"; reason: string };

interface Task extends NewTask {
  phase: Phase;
  attempts: number;
  replies: { by: string; body: string }[];
}

interface View {
  next: number;
  now_ms: number;
  tasks: Task[];
  ready: string[];
  settled: boolean;
  leases: number[];
}

interface Entry {
  seq: number;
  event: string;
  at_ms: number;
  task: string;
  change: { kind: string } & Record<string, unknown>;
}

interface Page {
  next: number;
  entries: Entry[];
}

interface Submitted {
  verdict: Verdict;
  task: Task | null;
}

type Request =
  | { call: "submit"; scope: string; writer: string; key: string; at_ms: number; op: Op }
  | { call: "view"; scope: string; at_ms: number }
  | { call: "entries"; scope: string; after: number };

type Answer<T> = { ok: T } | { error: string };

interface Exports {
  memory: WebAssembly.Memory;
  board_alloc(len: number): number;
  board_free(ptr: number, len: number): void;
  board_call(ptr: number, len: number): bigint;
}

const SCOPE = "board";
const NAME = /^[A-Za-z0-9._-]+$/;
const DIGEST = /^[0-9a-f]{64}$/;
const PROTOCOL = "nanocode-board";
const BEARER = "bearer.";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

class Log {
  readonly #exports: Exports;

  constructor(storage: DurableObjectStorage) {
    const instance = new WebAssembly.Instance(module, {
      host: { sql: (ptr: number, len: number) => this.#give(encoder.encode(JSON.stringify(Log.#transact(storage, JSON.parse(this.#read(ptr, len)))))) },
    });
    this.#exports = instance.exports as unknown as Exports;
  }

  static #transact(storage: DurableObjectStorage, request: { statements: [string, ...string[]][] }) {
    try {
      return { rows: storage.transactionSync(() => request.statements.map(([sql, ...params]) => [...storage.sql.exec(sql, ...params).raw()].map(row => row.map(cell => cell === null ? null : String(cell))))) };
    } catch (error) {
      return { error: String(error) };
    }
  }

  #read(ptr: number, len: number): string {
    return decoder.decode(new Uint8Array(this.#exports.memory.buffer, ptr, len));
  }

  #give(bytes: Uint8Array): bigint {
    const ptr = this.#exports.board_alloc(bytes.length);
    new Uint8Array(this.#exports.memory.buffer, ptr, bytes.length).set(bytes);
    return (BigInt(ptr) << 32n) | BigInt(bytes.length);
  }

  call<T>(request: Request): T {
    const bytes = encoder.encode(JSON.stringify(request));
    const ptr = this.#exports.board_alloc(bytes.length);
    new Uint8Array(this.#exports.memory.buffer, ptr, bytes.length).set(bytes);
    const packed = this.#exports.board_call(ptr, bytes.length);
    const [at, len] = [Number(packed >> 32n), Number(packed & 0xffffffffn)];
    const answer = JSON.parse(this.#read(at, len)) as Answer<T>;
    this.#exports.board_free(at, len);
    if ("error" in answer) throw new Error(answer.error);
    return answer.ok;
  }
}

export class BoardRoom extends DurableObject<Env> {
  #log: Log | undefined;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS board_waiters (agent TEXT PRIMARY KEY, board TEXT NOT NULL)");
  }

  #call<T>(request: Request): T {
    this.#log ??= new Log(this.ctx.storage);
    return this.#log.call<T>(request);
  }

  view(): View {
    return this.#call<View>({ call: "view", scope: SCOPE, at_ms: Date.now() });
  }

  entries(after: number): Page {
    return this.#call<Page>({ call: "entries", scope: SCOPE, after });
  }

  submit(writer: string, key: string, op: Op): Submitted {
    const verdict = this.#call<Verdict>({ call: "submit", scope: SCOPE, writer, key, at_ms: Date.now(), op });
    const view = this.view();
    if ("applied" in verdict) {
      this.#arm(view);
      this.#broadcast();
      if (op.op !== "renew" && op.op !== "reply") this.#wake();
    }
    return { verdict, task: view.tasks.find(task => task.id === op.task || (op.op === "post" && task.id === op.task.id)) ?? null };
  }

  wait(board: string, agent: string, seen: number): void {
    this.ctx.storage.sql.exec("INSERT INTO board_waiters (agent, board) VALUES (?, ?) ON CONFLICT (agent) DO NOTHING", agent, board);
    if (this.view().next > seen) this.#wake();
  }

  override async alarm(): Promise<void> {
    this.#wake();
    this.#arm(this.view());
  }

  #arm(view: View): void {
    const now = Date.now();
    const leases = view.leases.filter(until => until > now);
    if (leases.length) this.ctx.storage.setAlarm(Math.min(...leases));
    else this.ctx.storage.deleteAlarm();
  }

  #wake(): void {
    const waiters = this.ctx.storage.sql.exec<{ agent: string; board: string }>("DELETE FROM board_waiters RETURNING agent, board").toArray();
    for (const { agent, board } of waiters) this.ctx.waitUntil(this.env.AGENTS.get(this.env.AGENTS.idFromName(seat(board, agent))).wake());
  }

  #send(socket: WebSocket): void {
    const { cursor } = socket.deserializeAttachment() as { cursor: number };
    const page = this.entries(cursor);
    if (!page.entries.length) return;
    socket.send(JSON.stringify(page));
    socket.serializeAttachment({ cursor: page.entries.at(-1)!.seq });
  }

  #broadcast(): void {
    for (const socket of this.ctx.getWebSockets()) this.#send(socket);
  }

  override async fetch(request: Request_): Promise<Response> {
    const after = cursor(new URL(request.url).searchParams.get("after"));
    if (after === null) return refuse("after is a non-negative integer sequence", 400);
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ cursor: after });
    this.#send(server);
    const protocols = request.headers.get("sec-websocket-protocol")?.split(",").map(part => part.trim()) ?? [];
    return new Response(null, { status: 101, webSocket: client, headers: protocols.includes(PROTOCOL) ? { "sec-websocket-protocol": PROTOCOL } : {} });
  }

  override async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const after = typeof message === "string" ? cursor(String(JSON.parse(message).after)) : null;
    if (after === null) return socket.close(1003, "send {\"after\": <sequence>}");
    socket.serializeAttachment({ cursor: after });
    this.#send(socket);
  }
}

type Request_ = globalThis.Request;

interface Seat {
  board: string;
  name: string;
}

interface Plan {
  id: string;
  tasks: NewTask[];
}

type Work =
  | { kind: "work"; task: string; claim: string; until: number; done_at: number }
  | { kind: "join"; task: string; claim: string; until: number }
  | { kind: "invalid"; task: string; claim: string; until: number; error: string };

const terminal = (task: Task) => task.phase.state === "done" || task.phase.state === "failed" || task.phase.state === "cancelled";

function seat(board: string, agent: string): string {
  return board + "/" + agent;
}

function cursor(value: string | null): number | null {
  return value !== null && /^\d+$/.test(value) ? Number(value) : null;
}

function count(label: string | undefined): number | null {
  return label !== undefined && /^\d+$/.test(label) ? Number(label) : null;
}

export class BoardAgent extends DurableObject<Env> {
  #work: Work | undefined;

  async start(board: string, name: string, plan: Plan | null): Promise<void> {
    await this.ctx.storage.put<Seat>("seat", { board, name });
    if (plan) await this.ctx.storage.put<Plan>("plan", plan);
    await this.ctx.storage.setAlarm(Date.now());
  }

  async wake(): Promise<void> {
    await this.ctx.storage.setAlarm(Date.now());
  }

  holding(): Work | null {
    return this.#work ?? null;
  }

  override async alarm(): Promise<void> {
    const seat = await this.ctx.storage.get<Seat>("seat");
    if (!seat) return;
    const room = this.env.BOARDS.get(this.env.BOARDS.idFromName(seat.board));
    const lease = Number(this.env.BOARD_LEASE_MS);
    const renew = Number(this.env.BOARD_RENEW_MS);
    const plan = await this.ctx.storage.get<Plan>("plan");
    if (plan) {
      for (const task of plan.tasks) await room.submit(seat.name, "plan:" + plan.id + ":" + task.id, { op: "post", task });
      await this.ctx.storage.delete("plan");
    }
    for (;;) {
      const work = this.#work;
      if (work) {
        const view = await room.view();
        const outcome = this.#outcome(work, view);
        if (outcome) {
          await room.submit(seat.name, "finish:" + work.claim, { op: "finish", task: work.task, claim: work.claim, outcome });
          this.#work = undefined;
          continue;
        }
        if (Date.now() >= work.until - renew) {
          const until = Date.now() + lease;
          const renewed = await room.submit(seat.name, "renew:" + work.claim + ":" + work.until, { op: "renew", task: work.task, claim: work.claim, lease_ms: lease });
          if (!("applied" in renewed.verdict)) {
            this.#work = undefined;
            continue;
          }
          work.until = renewed.task?.phase.state === "claimed" ? renewed.task.phase.until_ms : until;
        }
        if (work.kind === "join") await room.wait(seat.board, seat.name, view.next);
        await this.ctx.storage.setAlarm(Math.min(work.until - renew, work.kind === "work" ? work.done_at : Infinity));
        return;
      }
      const view = await room.view();
      const tasks = new Map(view.tasks.map(task => [task.id, task]));
      const pick = view.ready.map(id => tasks.get(id)!).find(Boolean);
      if (!pick) {
        await room.wait(seat.board, seat.name, view.next);
        return;
      }
      const claimed = await room.submit(seat.name, "claim:" + pick.id + ":" + pick.attempts + ":" + seat.name, { op: "claim", task: pick.id, lease_ms: lease });
      if (!("applied" in claimed.verdict) || claimed.task?.phase.state !== "claimed") continue;
      this.#work = await this.#begin(room, seat, claimed.task, claimed.task.phase);
    }
  }

  async #begin(room: DurableObjectStub<BoardRoom>, seat: Seat, task: Task, phase: Extract<Phase, { state: "claimed" }>): Promise<Work> {
    const held = { task: task.id, claim: phase.claim, until: phase.until_ms };
    const fanout = task.labels.fanout;
    if (fanout !== undefined) {
      const parts = count(fanout);
      const work_ms = task.labels.part_work_ms;
      if (parts === null || count(work_ms) === null) return { kind: "invalid", ...held, error: "fanout and part_work_ms labels are non-negative integers" };
      for (let part = 1; part <= parts; part++) {
        const child: NewTask = { id: task.id + "." + part, parent: task.id, spec: task.spec + " (part " + part + " of " + parts + ")", labels: { work_ms: work_ms! }, needs: [] };
        await room.submit(seat.name, "part:" + child.id, { op: "post", task: child });
      }
      return { kind: "join", ...held };
    }
    const work_ms = count(task.labels.work_ms);
    if (work_ms === null) return { kind: "invalid", ...held, error: "work_ms label is a non-negative integer" };
    return { kind: "work", ...held, done_at: Date.now() + work_ms };
  }

  #outcome(work: Work, view: View): Outcome | null {
    if (work.kind === "invalid") return { kind: "failed", detail: work.error };
    if (work.kind === "work") return Date.now() >= work.done_at ? { kind: "done", detail: work.task + " done" } : null;
    const parts = view.tasks.filter(task => task.parent === work.task);
    if (!parts.every(terminal)) return null;
    const failed = parts.filter(task => task.phase.state !== "done").map(task => task.id);
    return failed.length ? { kind: "failed", detail: "parts did not finish: " + failed.join(", ") } : { kind: "done", detail: parts.length + " parts done" };
  }
}

function refuse(message: string, status: number): Response {
  return Response.json({ error: message }, { status });
}

async function digest(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}

async function authenticate(request: Request_, env: Env): Promise<boolean> {
  if (!DIGEST.test(env.ACCESS_TOKEN_SHA256)) return false;
  const header = request.headers.get("authorization") ?? "";
  const offered = request.headers.get("sec-websocket-protocol")?.split(",").map(part => part.trim()).find(part => part.startsWith(BEARER));
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : offered?.slice(BEARER.length);
  if (token === undefined) return false;
  const expected = Uint8Array.from(env.ACCESS_TOKEN_SHA256.match(/../g)!, byte => parseInt(byte, 16));
  return crypto.subtle.timingSafeEqual(await digest(token), expected);
}

async function signed(request: Request_, body: string, secret: string): Promise<boolean> {
  const signature = request.headers.get("x-hub-signature-256") ?? "";
  if (!/^sha256=[0-9a-f]{64}$/.test(signature)) return false;
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const actual = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(body)));
  const expected = Uint8Array.from(signature.slice("sha256=".length).match(/../g)!, byte => parseInt(byte, 16));
  return crypto.subtle.timingSafeEqual(actual, expected);
}

interface Delivery {
  action?: string;
  issue?: { number: number; title: string; body: string | null; labels: { name: string }[] };
  comment?: { body: string; user: { login: string } };
}

function translate(event: string, delivery: Delivery): Op | null {
  const issue = delivery.issue;
  if (!issue) return null;
  const task = "issue-" + issue.number;
  if (event === "issues" && delivery.action === "opened") {
    const labels = Object.fromEntries(issue.labels.map(label => label.name.split(":")).filter(parts => parts.length === 2));
    return { op: "post", task: { id: task, parent: null, spec: issue.title, labels: { ...labels, source: "github" }, needs: [] } };
  }
  if (event === "issues" && delivery.action === "closed") return { op: "cancel", task, reason: "closed on GitHub" };
  if (event === "issue_comment" && delivery.action === "created" && delivery.comment) return { op: "reply", task, body: delivery.comment.user.login + ": " + delivery.comment.body };
  return null;
}

async function github(request: Request_, env: Env, room: DurableObjectStub<BoardRoom>): Promise<Response> {
  if (!env.BOARD_WEBHOOK_SECRET) return refuse("BOARD_WEBHOOK_SECRET is not configured", 503);
  const body = await request.text();
  if (!(await signed(request, body, env.BOARD_WEBHOOK_SECRET))) return refuse("the signature does not match", 401);
  const event = request.headers.get("x-github-event");
  const id = request.headers.get("x-github-delivery");
  if (!event || !id) return refuse("x-github-event and x-github-delivery are required", 400);
  const op = translate(event, JSON.parse(body) as Delivery);
  if (!op) return Response.json({ ignored: event }, { status: 202 });
  return Response.json(await room.submit("github", "github:" + id, op));
}

const PAGE = String.raw`<!doctype html>
<meta charset="utf-8">
<title>nanocode board</title>
<style>body{font:14px ui-monospace,monospace;margin:24px;background:#0b0b0c;color:#e6e6e6}table{border-collapse:collapse;margin-bottom:24px}td,th{padding:4px 10px;border-bottom:1px solid #2a2a2e;text-align:left}.done{color:#5fd38d}.claimed{color:#e6c35c}.failed,.cancelled{color:#ef6b6b}#tail{white-space:pre;color:#9a9aa3}</style>
<h1 id="title"></h1>
<table><thead><tr><th>task</th><th>state</th><th>worker</th><th>needs</th><th>attempts</th></tr></thead><tbody id="tasks"></tbody></table>
<div id="tail"></div>
<script>
const board = location.pathname.split("/")[2];
const token = location.hash.slice(1);
const headers = { authorization: "Bearer " + token };
document.getElementById("title").textContent = "board " + board;
let after = 0;
async function render() {
  const view = await (await fetch("/boards/" + board + "/view", { headers })).json();
  document.getElementById("tasks").replaceChildren(...view.tasks.map(task => {
    const row = document.createElement("tr");
    for (const cell of [task.id, task.phase.state, task.phase.worker ?? "", task.needs.join(", "), task.attempts]) row.append(Object.assign(document.createElement("td"), { textContent: cell, className: task.phase.state }));
    return row;
  }));
}
function tail() {
  const socket = new WebSocket(location.origin.replace("http", "ws") + "/boards/" + board + "/tail?after=" + after, ["nanocode-board", "bearer." + token]);
  socket.onmessage = message => {
    const page = JSON.parse(message.data);
    for (const entry of page.entries) {
      after = entry.seq;
      document.getElementById("tail").prepend(entry.seq + "  " + new Date(entry.at_ms).toISOString().slice(11, 23) + "  " + entry.task + "  " + JSON.stringify(entry.change) + "\n");
    }
    render();
  };
  socket.onclose = () => setTimeout(tail, 1000);
}
render();
tail();
</script>`;

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    const match = /^\/boards\/([^/]+)(?:\/(view|tail|ops|agents|github))?$/.exec(pathname);
    if (!match || !NAME.test(match[1])) return refuse("not found", 404);
    const [, board, route] = match;
    const room = env.BOARDS.get(env.BOARDS.idFromName(board));
    if (route === undefined && request.method === "GET") return new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8" } });
    if (route === "github" && request.method === "POST") return github(request, env, room);
    if (!(await authenticate(request, env))) return refuse("this route needs the access token", 401);
    if (route === "view" && request.method === "GET") return Response.json(await room.view());
    if (route === "tail" && request.headers.get("upgrade")?.toLowerCase() === "websocket") return room.fetch(request);
    if (route === "ops" && request.method === "POST") {
      const { writer, key, op } = await request.json<{ writer: string; key: string; op: Op }>();
      if (!NAME.test(writer) || !key) return refuse("writer is a name and key is required", 400);
      return Response.json(await room.submit(writer, key, op));
    }
    if (route === "agents" && request.method === "POST") {
      const { agents, lead, plan } = await request.json<{ agents: string[]; lead: string; plan: Plan }>();
      if (!agents.every(agent => NAME.test(agent)) || !agents.includes(lead)) return refuse("agents are names and lead is one of them", 400);
      await Promise.all(agents.map(agent => env.AGENTS.get(env.AGENTS.idFromName(seat(board, agent))).start(board, agent, agent === lead ? plan : null)));
      return Response.json({ started: agents });
    }
    return refuse("not found", 404);
  },
} satisfies ExportedHandler<Env>;
