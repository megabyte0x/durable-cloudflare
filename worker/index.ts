import { Remote } from "nanocode-ts";
import { App, Gateway, HandRelay, Limit, McpListings, PlanVault, Pool, PublicLimit, Relay, RelayContainer, SessionPool } from "nanocode-ts/cloudflare";
import { Tempo } from "nanocode-ts/machines";
import { Env as Machines, Wallets } from "nanocode-ts/machines/cloudflare";
import * as Account from "nanocode-ts/machines/server";
import { CLAUDE_MODELS, PLAN_MODELS, PUBLIC_MODELS } from "./models";
import { Canvas } from "./canvas";
import { canvasTools, INSTRUCTIONS, OWNER } from "./tools";
import pshModule from "nanocode-ts/psh.wasm";
import pythonModule from "nanocode-ts/python.wasm";

const visitor = Account.visitor;
const VISITOR = Account.visitorHeader;

interface Env extends Machines.Env {
  AI: Ai;
  ASSETS: Fetcher;
  AI_GATEWAY_ID: string;
  OPENAI_SERVICE_TIER: string;
  MODEL_FIRST_BYTE_MS?: string;
  ACCESS_TOKEN_SHA256: string;
  CHAT_PUBLIC: string;
  HAND_RELAYS: DurableObjectNamespace<HandRelay>;
  PUBLIC_LIMITS: DurableObjectNamespace<PublicLimit>;
  PUBLIC_RATE: RateLimit;
  MCP_LISTINGS: DurableObjectNamespace<McpListings>;
  MCP_LISTINGS_KV: KVNamespace;
  MCP_LISTING_CACHE_TTL_S: string;
  PLANS: DurableObjectNamespace<PlanVault>;
  RELAY: DurableObjectNamespace<RelayContainer>;
  SESSION_POOL: DurableObjectNamespace<SessionPool>;
  SESSION_POOL_CACHED_NAMES: string;
  SESSION_POOL_KEEPALIVE_MS: string;
  SESSION_POOL_SIZE: string;
  PLAN_SECRET: string;
  CANVAS: DurableObjectNamespace<Canvas>;
  TEMPO_SPONSOR_KEY?: string;
  TEMPO_SPONSOR_ACCOUNT?: string;
}

const THEMES = new Map([["claude", "/claude"], ["codex", "/chatgpt"], ["nanocode", "/nanocode"]]);
const DIGEST = /^[0-9a-f]{64}$/;
const ACCOUNT = OWNER;
const PUBLIC_ACCOUNT = "public";
const PUBLIC_PROMPT_CHARACTERS = 2000;
const PUBLIC_ROUTE = /^\/(?:sessions\/[^/]+\/(?:turns(?:\/[^/]+(?:\/cancel)?)?|events|crash|warm|hands(?:\/[^/]+)?|files(?:\/.+)?|blobs\/[^/]+)|v1\/(?:keys|me)|api\/device\/(?:code|token)|plans(?:\/(?:claude|codex)(?:\/(?:sign-in|complete))?)?)$/;

async function owner(request: Request, env: Env): Promise<boolean> {
  const header = request.headers.get("authorization") ?? "";
  if (!DIGEST.test(env.ACCESS_TOKEN_SHA256) || !header.startsWith("Bearer ")) return false;
  const actual = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(header.slice("Bearer ".length)));
  const expected = Uint8Array.from(env.ACCESS_TOKEN_SHA256.match(/../g)!, byte => parseInt(byte, 16));
  return crypto.subtle.timingSafeEqual(actual, expected);
}

async function account(request: Request, env: Env): Promise<string | null> {
  if (await owner(request, env)) return ACCOUNT;
  return env.CHAT_PUBLIC === "1" ? visitor(request) : null;
}

async function visiting(request: Request): Promise<string | null> {
  const query = new URL(request.url).searchParams.get("visitor");
  return await visitor(request) ?? (query ? await visitor(new Request(request.url, { headers: { [VISITOR]: query } })) : null);
}

async function authenticate(request: Request, env: Env): Promise<string | null> {
  if (await owner(request, env)) return ACCOUNT;
  return env.CHAT_PUBLIC === "1" ? await visiting(request) ?? PUBLIC_ACCOUNT : null;
}

function refuse(error: string, status: number): Response {
  return Response.json({ error }, { status });
}

const ARCHIVE = /^\/api\/github\/([\w.-]+)\/([\w.-]+)\/(.+)$/;

async function archive(pathname: string): Promise<Response> {
  const match = ARCHIVE.exec(pathname);
  if (!match) return refuse("use /api/github/OWNER/REPO/REF", 404);
  const upstream = await fetch(`https://codeload.github.com/${match[1]}/${match[2]}/tar.gz/${match[3]}`, { headers: { "user-agent": "nanocode-cloudflare-durable" } });
  return new Response(upstream.body, { headers: { "cache-control": "public, max-age=300", "content-type": upstream.headers.get("content-type") ?? "application/x-gzip" }, status: upstream.status });
}

async function admit(request: Request, env: Env): Promise<Response | undefined> {
  const { pathname } = new URL(request.url);
  if (pathname === "/health") return;
  if (!PUBLIC_ROUTE.test(pathname)) return refuse("this route needs the access token", 403);
  if (/\/hands(?:\/[^/]+)?$/.test(pathname) && request.headers.get("upgrade")?.toLowerCase() === "websocket" && !Remote.bearerToken(request)?.startsWith("nch_")) return refuse("hands attach with the session's hand token", 403);
  if (!(await env.PUBLIC_RATE.limit({ key: Limit.client(request.headers.get("cf-connecting-ip")!) })).success) return refuse("too many requests, try again in a minute", 429);
  if (request.method !== "POST" || !/\/(?:turns|warm)$/.test(pathname)) return;
  const body = await request.clone().json().catch(() => undefined) as { model?: unknown; payer?: unknown; prompt?: unknown; provider?: unknown; thinking?: unknown } | undefined;
  if (typeof body?.prompt === "string" && body.prompt.length > PUBLIC_PROMPT_CHARACTERS) return refuse(`prompts are limited to ${PUBLIC_PROMPT_CHARACTERS} characters`, 413);
  const provider = body?.provider ?? "claude";
  const model = String(body?.model ?? (provider === "codex" ? "gpt-6.1-sol" : env.CLAUDE_MODEL ?? "claude-opus-5-5"));
  const payer = body?.payer;
  if (payer === "wallet") return provider === "claude" || provider === "codex" ? undefined : refuse("provider is claude or codex", 400);
  const open = PUBLIC_MODELS[model];
  const fits = open?.provider === provider && (body?.thinking === undefined || open.efforts.includes(String(body.thinking)));
  const planned = payer === "plan" || (payer === undefined && !fits && await onPlan(request, env, provider));
  const catalog = payer === "plan" ? PLAN_MODELS : planned ? { ...PUBLIC_MODELS, ...PLAN_MODELS } : PUBLIC_MODELS;
  const allowed = catalog[model];
  if (!allowed || allowed.provider !== provider) return refuse(payer === "plan" ? `your plan serves ${Object.keys(catalog).join(", ")}` : `this deployment serves ${Object.keys(catalog).join(", ")}, and more with Tempo ID or your own ChatGPT or Claude plan`, 403);
  if (body?.thinking !== undefined && !allowed.efforts.includes(String(body.thinking))) return refuse(`${model} takes ${allowed.efforts.join(", ")}`, 403);
}

async function onPlan(request: Request, env: Env, provider: unknown): Promise<boolean> {
  const name = await visitor(request);
  if (!name || (provider !== "claude" && provider !== "codex")) return false;
  return await env.PLANS.get(env.PLANS.idFromName(name)).signedIn(provider).catch(() => false);
}

const hex = (name: string, value: string | undefined): `0x${string}` | undefined => {
  if (value === undefined) return undefined;
  if (!/^0x[0-9a-fA-F]+$/.test(value)) throw new Error(`${name} is not a 0x-prefixed hex string`);
  return value as `0x${string}`;
};

const sponsor = (env: Env) => {
  const key = hex("TEMPO_SPONSOR_KEY", env.TEMPO_SPONSOR_KEY);
  return key && {
    key,
    account: hex("TEMPO_SPONSOR_ACCOUNT", env.TEMPO_SPONSOR_ACCOUNT),
    allowance: { budget: "0.05", calls: 10, windowMs: 3_600_000 },
    deposit: { opening: "0.01", topUp: "0.01", maximum: "0.05" },
  };
};

const wallets = Wallets.create<Env>({ account, kv: true, scripts: true, sponsor });

const nanocode = App.create<Env>({
  activeCacheMs: 30_000,
  authenticate,
  egress: wallets.egress(env => Gateway.create(env.AI, { id: env.AI_GATEWAY_ID, serviceTier: env.OPENAI_SERVICE_TIER, firstByteMs: Number(env.MODEL_FIRST_BYTE_MS) || undefined })),
  limits: session => session.provider === "claude" && session.model && !CLAUDE_MODELS.has(session.model) ? { max_tokens: Tempo.outputTokens } : undefined,
  payers: ["deployment", "plan", "wallet"],
  plans: { vault: env => env.PLANS, relay: env => env.RELAY, account },
  retainedTurns: 8,
  tools: canvasTools,
  instructions: INSTRUCTIONS,
  chaos: true,
  workspace: { psh: pshModule, pythonModule },
  ...wallets.nanocode,
  ...(wallets.nanocode.mcp ? { mcp: { ...wallets.nanocode.mcp, store: env => ({ get: key => env.MCP_LISTINGS_KV.get(key, { cacheTtl: Number(env.MCP_LISTING_CACHE_TTL_S) }), put: (key, value, ttlMs) => env.MCP_LISTINGS_KV.put(key, value, { expirationTtl: Math.max(60, Math.ceil(ttlMs / 1000)) }) }) } } : {}),
});

export const { AgentSession } = nanocode;
export const { Wallet } = wallets;
export { Canvas, HandRelay, McpListings, PlanVault, PublicLimit, RelayContainer, SessionPool };

const PRIVATE_HOST = /^(?:localhost|.*\.localhost|.*\.local|.*\.internal|0\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|127\.\d+\.\d+\.\d+|169\.254\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+|192\.168\.\d+\.\d+|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+|\[(?:::1?|f[cd][0-9a-f:]*|fe[89ab][0-9a-f:]*|::ffff:[0-9a-f.:]*)\])$/i;
const HISTORY_PAGE = 50;

async function proxy(request: Request): Promise<Response> {
  const input = await request.json().catch(() => undefined) as { url?: unknown; method?: unknown; headers?: unknown; body?: unknown } | undefined;
  let target: URL;
  try {
    target = new URL(String(input?.url));
  } catch {
    return Response.json({ error: "url is not a valid URL" }, { status: 400, headers: { "x-canvas-proxy": "refused" } });
  }
  if (target.protocol !== "https:" && target.protocol !== "http:") return Response.json({ error: "only http and https URLs are allowed" }, { status: 400, headers: { "x-canvas-proxy": "refused" } });
  if (PRIVATE_HOST.test(target.hostname) || target.hostname === new URL(request.url).hostname) return Response.json({ error: `${target.hostname} is not a public host` }, { status: 400, headers: { "x-canvas-proxy": "refused" } });
  const headers = new Headers(input?.headers && typeof input.headers === "object" ? input.headers as Record<string, string> : {});
  headers.delete("cookie");
  if (!headers.has("user-agent")) headers.set("user-agent", "nanocode-canvas");
  if (headers.get("authorization") === request.headers.get("authorization")) headers.delete("authorization");
  const method = typeof input?.method === "string" ? input.method.toUpperCase() : "GET";
  const upstream = await fetch(target, { method, headers, body: method === "GET" || method === "HEAD" || input?.body === undefined ? undefined : String(input.body) });
  return new Response(upstream.body, { status: upstream.status, headers: { "content-type": upstream.headers.get("content-type") ?? "application/octet-stream", "cache-control": "no-store" } });
}

async function canvasRoute(request: Request, env: Env, pathname: string): Promise<Response> {
  const canvas = env.CANVAS.getByName("main");
  if (pathname === "/api/canvas/live") return await canvas.fetch(request);
  if (!(await owner(request, env))) return refuse("this route needs the access token", 401);
  const route = `${request.method} ${pathname}`;
  const body = request.method === "POST" && pathname !== "/api/canvas/fetch" ? await request.json().catch(() => ({})) as Record<string, unknown> : {};
  const by = { kind: "owner" } as const;
  try {
    switch (route) {
      case "POST /api/canvas/ticket": return Response.json({ ticket: await canvas.ticket() });
      case "GET /api/canvas/snapshot": return Response.json(await canvas.snapshot());
      case "GET /api/canvas/history": {
        const before = new URL(request.url).searchParams.get("before");
        return Response.json(await canvas.history(HISTORY_PAGE, before ? Number(before) : undefined));
      }
      case "POST /api/canvas/undo": return Response.json({ changed: await canvas.undo() });
      case "POST /api/canvas/redo": return Response.json({ changed: await canvas.redo() });
      case "POST /api/canvas/restore": return Response.json({ seq: await canvas.restore(by, Number(body.seq)) });
      case "POST /api/canvas/theme": {
        await canvas.setTheme(by, { css: String(body.css ?? "") });
        return Response.json({ ok: true });
      }
      case "POST /api/canvas/fetch": return await proxy(request);
      default: return refuse(`no canvas route ${route}`, 404);
    }
  } catch (error) {
    return refuse(error instanceof Error ? error.message : String(error), 400);
  }
}

let loaded: number | undefined;
let served = 0;

export default {
  async scheduled(_controller, env) {
    await Pool.warm(env.SESSION_POOL);
  },
  async fetch(request, env) {
    loaded ??= Date.now();
    served++;
    const { pathname, searchParams } = new URL(request.url);
    if ((request.method === "GET" || request.method === "HEAD") && pathname === "/") return env.ASSETS.fetch(new URL("/canvas", request.url), { method: request.method });
    if (pathname.startsWith("/api/canvas/")) return await canvasRoute(request, env, pathname);
    if ((request.method === "GET" || request.method === "HEAD") && pathname === "/demo") {
      const page = THEMES.get(searchParams.get("theme") ?? "nanocode");
      return page ? env.ASSETS.fetch(new URL(page, request.url), { method: request.method }) : refuse("theme is claude, codex or nanocode", 404);
    }
    if (request.method === "POST" && (pathname === "/api/device/code" || pathname === "/api/device/token")) return Account.device(request, pathname.slice("/api/device/".length));
    if (request.method === "GET" && pathname.startsWith("/api/github/")) return archive(pathname);
    if (request.method === "GET" && pathname === "/install") return Response.redirect("https://nanocode.xyz/install", 308);
    if ((request.method === "GET" || request.method === "HEAD") && pathname === "/how-it-works") return Response.redirect("https://nanocode.xyz/experiments/durable-nanocode-on-cloudflare", 308);
    if (request.method === "GET" && pathname === "/relay") return Relay.route(request, { namespace: env.HAND_RELAYS });
    const started = performance.now();
    const refused = env.CHAT_PUBLIC === "1" && !(await owner(request, env)) ? await admit(request, env) : undefined;
    const admitted = performance.now();
    const response = refused ?? await wallets.fetch(request, env) ?? await nanocode.fetch(request, env);
    if (response.webSocket || response.status === 101) return response;
    const timed = new Response(response.body, response);
    timed.headers.append("server-timing", "admit;dur=" + Math.round(admitted - started) + ", worker;dur=" + Math.round(performance.now() - started) + ", isolate;dur=" + (Date.now() - loaded) + ";desc=" + served);
    return timed;
  },
} satisfies ExportedHandler<Env>;
