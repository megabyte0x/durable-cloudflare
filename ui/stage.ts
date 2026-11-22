import "./stage.css";

type Piece = { id: string; title: string; x: number; y: number; w: number; h: number; z: number; html: string; css: string; js: string; updated_at: number };
type Snapshot = { pieces: Piece[]; theme: { css: string }; state: Record<string, Record<string, unknown>>; version: number; canUndo: boolean; canRedo: boolean };
type View = { x: number; y: number; k: number };
type Shown = { piece: Piece; root: HTMLDivElement; title: HTMLDivElement; frame: HTMLIFrameElement; code: string };
type Message =
  | { type: "snapshot"; snapshot: Snapshot }
  | { type: "state"; id: string; key: string; value: unknown }
  | { type: "error"; message: string };
type BridgeCall = { canvas: 1; id: number; op: "get" | "set" | "fetch" | "ask"; key?: string; value?: unknown; url?: string; init?: { method?: string; headers?: Record<string, string>; body?: string }; message?: string; context?: string; thread?: string; model?: string };
type TurnEvent = { request_id: string; event: { type?: string; status?: string; error?: string; ok?: { message?: string }; event?: { type?: string; payload?: { text?: string } } } };

const TOKEN_KEY = "nanocode-cloudflare-durable:token";
const VIEW_KEY = "nanocode-canvas:view";
const GRID = 24;
const ZOOM = { min: 0.1, max: 4 };
const VIEWPORT_DEBOUNCE_MS = 300;
const RECONNECT_MS = { first: 1000, max: 15000 };
const NULL_BODY = new Set([101, 204, 205, 304]);
const AGENT = { provider: "claude", model: "claude-sonnet-5-5", payer: "plan" };

const stage = document.getElementById("stage") as HTMLDivElement;
const world = document.getElementById("world") as HTMLDivElement;
const grid = stage.querySelector(".grid") as HTMLDivElement;
const empty = document.getElementById("empty") as HTMLDivElement;
const status = document.getElementById("status") as HTMLSpanElement;
const zoomButton = document.getElementById("zoom") as HTMLButtonElement;
const themeStyle = document.getElementById("theme") as HTMLStyleElement;
const channel = new BroadcastChannel("nanocode-canvas");

const shown = new Map<string, Shown>();
let states: Record<string, Record<string, unknown>> = {};
let socket: WebSocket | undefined;
let reconnectMs = RECONNECT_MS.first;
let view: View = load(VIEW_KEY) ?? { x: 0, y: 0, k: 1 };
let viewportTimer: ReturnType<typeof setTimeout> | undefined;

function load<T>(key: string): T | undefined {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) as T : undefined;
  } catch {
    return undefined;
  }
}

function token(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

function headers(): Record<string, string> {
  const secret = token();
  return secret ? { authorization: `Bearer ${secret}`, "content-type": "application/json" } : { "content-type": "application/json" };
}

function setStatus(text: string, kind: "live" | "problem" | "" = "") {
  status.textContent = text;
  status.className = `status ${kind}`;
}

function applyView() {
  world.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.k})`;
  grid.style.backgroundSize = `${GRID * view.k}px ${GRID * view.k}px`;
  grid.style.backgroundPosition = `${view.x}px ${view.y}px`;
  zoomButton.textContent = `${Math.round(view.k * 100)}%`;
  try {
    localStorage.setItem(VIEW_KEY, JSON.stringify(view));
  } catch {}
  clearTimeout(viewportTimer);
  viewportTimer = setTimeout(sendViewport, VIEWPORT_DEBOUNCE_MS);
}

function sendViewport() {
  const rect = stage.getBoundingClientRect();
  send({ type: "viewport", viewport: { x: Math.round(-view.x / view.k), y: Math.round(-view.y / view.k), w: Math.round(rect.width / view.k), h: Math.round(rect.height / view.k) } });
}

function send(message: unknown) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

const BRIDGE = `(() => {
  const pending = new Map();
  const listeners = [];
  let next = 0;
  const call = (op, args, update) => new Promise((resolve, reject) => {
    const id = ++next;
    pending.set(id, { resolve, reject, update });
    parent.postMessage({ canvas: 1, id, op, ...args }, "*");
  });
  addEventListener("message", event => {
    if (event.source !== parent || !event.data || !event.data.canvas) return;
    const data = event.data;
    if (data.reply) {
      const waiting = pending.get(data.reply);
      if (!waiting) return;
      pending.delete(data.reply);
      data.error ? waiting.reject(new Error(data.error)) : waiting.resolve(data.value);
    } else if (data.progress) {
      const waiting = pending.get(data.progress);
      if (waiting && waiting.update) {
        try { waiting.update(data.value); } catch (error) { console.error(error); }
      }
    } else if (data.change) {
      for (const listener of listeners) {
        try { listener(data.key, data.value); } catch (error) { console.error(error); }
      }
    }
  });
  const nullBody = [101, 204, 205, 304];
  window.canvas = {
    state: {
      get: key => call("get", { key: String(key) }),
      set: (key, value) => call("set", { key: String(key), value }),
      onChange: listener => { listeners.push(listener); },
    },
    fetch: async (url, init = {}) => {
      const headers = init.headers instanceof Headers ? Object.fromEntries(init.headers) : init.headers;
      const body = init.body === undefined || init.body === null ? undefined : typeof init.body === "string" ? init.body : JSON.stringify(init.body);
      const result = await call("fetch", { url: String(url), init: { method: init.method, headers, body } });
      return new Response(nullBody.includes(result.status) ? null : result.body, { status: result.status, headers: { "content-type": result.contentType } });
    },
    agent: {
      ask: (message, options = {}) => call("ask", {
        message: String(message),
        context: options.context === undefined ? undefined : typeof options.context === "string" ? options.context : JSON.stringify(options.context),
        thread: options.thread === undefined ? undefined : String(options.thread),
        model: options.model === undefined ? undefined : String(options.model),
      }, options.onUpdate),
    },
  };
})();`;

function classic(js: string): boolean {
  try {
    new Function(js);
    return true;
  } catch (error) {
    return !(error instanceof SyntaxError);
  }
}

function srcdoc(piece: Piece): string {
  const safe = (text: string) => text.replace(/<\/script/gi, "<\\/script");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>html,body{margin:0}body{font:14px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif}</style><style>${piece.css.replace(/<\/style/gi, "<\\/style")}</style><script>${BRIDGE}</script></head><body>${piece.html}<script${classic(piece.js) ? "" : ' type="module"'}>${safe(piece.js)}</script></body></html>`;
}

function place(item: Shown) {
  const { piece, root, title } = item;
  root.style.left = `${piece.x}px`;
  root.style.top = `${piece.y}px`;
  root.style.width = `${piece.w}px`;
  root.style.height = `${piece.h}px`;
  root.style.zIndex = String(piece.z);
  title.textContent = piece.title;
}

function create(piece: Piece, fresh: boolean): Shown {
  const root = document.createElement("div");
  root.className = fresh ? "piece fresh" : "piece";
  root.dataset.id = piece.id;
  const title = document.createElement("div");
  title.className = "piece-title";
  const frame = document.createElement("iframe");
  frame.className = "piece-frame";
  frame.setAttribute("sandbox", "allow-scripts allow-forms allow-popups allow-modals");
  const resize = document.createElement("div");
  resize.className = "piece-resize";
  root.append(title, frame, resize);
  world.append(root);
  const item: Shown = { piece, root, title, frame, code: "" };
  title.addEventListener("pointerdown", event => drag(event, item, "move"));
  resize.addEventListener("pointerdown", event => drag(event, item, "resize"));
  return item;
}

function render(snapshot: Snapshot, initial: boolean) {
  themeStyle.textContent = snapshot.theme.css;
  states = snapshot.state;
  const seen = new Set<string>();
  for (const piece of snapshot.pieces) {
    seen.add(piece.id);
    const item = shown.get(piece.id) ?? create(piece, !initial);
    item.piece = piece;
    place(item);
    const code = `${piece.html}\u0000${piece.css}\u0000${piece.js}`;
    if (item.code !== code) {
      item.code = code;
      item.frame.srcdoc = srcdoc(piece);
    }
    shown.set(piece.id, item);
  }
  for (const [id, item] of shown) {
    if (seen.has(id)) continue;
    item.root.remove();
    shown.delete(id);
  }
  empty.hidden = snapshot.pieces.length > 0;
  channel.postMessage({ type: "flags", canUndo: snapshot.canUndo, canRedo: snapshot.canRedo, version: snapshot.version });
}

function changed(id: string, key: string, value: unknown) {
  const current = (states[id] ??= {});
  if (JSON.stringify(current[key] ?? null) === JSON.stringify(value ?? null)) return;
  if (value === null) delete current[key];
  else current[key] = value;
  shown.get(id)?.frame.contentWindow?.postMessage({ canvas: 1, change: 1, key, value }, "*");
}

async function bridge(event: MessageEvent) {
  const data = event.data as BridgeCall | undefined;
  if (!data || data.canvas !== 1 || !data.op) return;
  const item = [...shown.values()].find(candidate => candidate.frame.contentWindow === event.source);
  if (!item) return;
  const reply = (value: unknown, error?: string) => item.frame.contentWindow?.postMessage({ canvas: 1, reply: data.id, value, error }, "*");
  try {
    if (data.op === "get") reply(states[item.piece.id]?.[data.key!] ?? null);
    else if (data.op === "set") {
      const value = data.value === undefined ? null : data.value;
      const current = (states[item.piece.id] ??= {});
      if (value === null) delete current[data.key!];
      else current[data.key!] = value;
      send({ type: "state", id: item.piece.id, key: data.key, value });
      reply(true);
    } else if (data.op === "ask") {
      reply(await ask(item, data, text => item.frame.contentWindow?.postMessage({ canvas: 1, progress: data.id, value: text }, "*")));
    } else if (data.op === "fetch") {
      const response = await fetch("api/canvas/fetch", { method: "POST", headers: headers(), body: JSON.stringify({ url: data.url, ...data.init }) });
      const refused = response.headers.get("x-canvas-proxy") === "refused";
      if (refused) return reply(undefined, ((await response.json()) as { error: string }).error);
      const body = NULL_BODY.has(response.status) ? null : await response.arrayBuffer();
      reply({ status: response.status, contentType: response.headers.get("content-type") ?? "application/octet-stream", body });
    }
  } catch (error) {
    reply(undefined, error instanceof Error ? error.message : String(error));
  }
}

function prompt(item: Shown, data: BridgeCall): string {
  const lines = [
    `[A message from the "${item.piece.title}" piece (id ${item.piece.id}) on the canvas. Your reply text is shown directly in that piece, so answer the message itself, as the piece's assistant.]`,
  ];
  if (data.context) lines.push("", "Context the piece sent:", data.context);
  lines.push("", "Message:", data.message ?? "");
  return lines.join("\n");
}

async function ask(item: Shown, data: BridgeCall, update: (text: string) => void): Promise<string> {
  const thread = data.thread ? `-${data.thread.toLowerCase().replace(/[^a-z0-9-]+/g, "-")}` : "";
  const requestId = `piece-${item.piece.id}-${crypto.randomUUID()}`;
  const response = await fetch(`sessions/piece-${item.piece.id}${thread}/turns`, {
    method: "POST",
    headers: { ...headers(), accept: "text/event-stream" },
    body: JSON.stringify({ request_id: requestId, prompt: prompt(item, data), provider: AGENT.provider, model: data.model ?? AGENT.model, payer: AGENT.payer }),
  });
  if (!response.ok || !response.body) throw new Error(`the agent refused the message: HTTP ${response.status} ${await response.text()}`);
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffered = "";
  for (;;) {
    const read = await reader.read();
    if (read.done) throw new Error("the agent's stream ended before its reply");
    buffered += read.value;
    let end;
    while ((end = buffered.indexOf("\n\n")) >= 0) {
      const block = buffered.slice(0, end);
      buffered = buffered.slice(end + 2);
      const line = block.split("\n").filter(part => part.startsWith("data:")).map(part => part.slice(5).trim()).join("");
      if (!line) continue;
      const turn = JSON.parse(line) as TurnEvent;
      if (turn.request_id !== requestId) continue;
      const inner = turn.event.event;
      if (inner?.type === "assistant.message" && inner.payload?.text) update(inner.payload.text);
      if (turn.event.type === "result") {
        await reader.cancel().catch(() => undefined);
        if (turn.event.status === "completed") return turn.event.ok?.message ?? "";
        throw new Error(turn.event.error ?? `the agent's turn ${turn.event.status}`);
      }
    }
  }
}

function drag(event: PointerEvent, item: Shown, mode: "move" | "resize") {
  event.preventDefault();
  event.stopPropagation();
  const start = { x: event.clientX, y: event.clientY, piece: { ...item.piece } };
  const top = Math.max(0, ...[...shown.values()].map(candidate => candidate.piece.z));
  if (item.piece.z < top) item.piece.z = top + 1;
  stage.classList.add("dragging");
  const target = event.currentTarget as HTMLElement;
  target.setPointerCapture(event.pointerId);
  const move = (next: PointerEvent) => {
    const dx = (next.clientX - start.x) / view.k;
    const dy = (next.clientY - start.y) / view.k;
    if (mode === "move") {
      item.piece.x = Math.round(start.piece.x + dx);
      item.piece.y = Math.round(start.piece.y + dy);
    } else {
      item.piece.w = Math.max(120, Math.round(start.piece.w + dx));
      item.piece.h = Math.max(80, Math.round(start.piece.h + dy));
    }
    place(item);
  };
  const end = () => {
    target.removeEventListener("pointermove", move);
    target.removeEventListener("pointerup", end);
    target.removeEventListener("pointercancel", end);
    stage.classList.remove("dragging");
    const { id, x, y, w, h, z } = item.piece;
    const before = start.piece;
    if (x !== before.x || y !== before.y || w !== before.w || h !== before.h || z !== before.z) send({ type: "move", id, x, y, w, h, z });
  };
  target.addEventListener("pointermove", move);
  target.addEventListener("pointerup", end);
  target.addEventListener("pointercancel", end);
}

stage.addEventListener("pointerdown", event => {
  if (event.target !== stage && event.target !== world && event.target !== grid && event.target !== empty) return;
  const start = { x: event.clientX, y: event.clientY, view: { ...view } };
  stage.classList.add("panning", "dragging");
  stage.setPointerCapture(event.pointerId);
  const move = (next: PointerEvent) => {
    view = { ...view, x: start.view.x + next.clientX - start.x, y: start.view.y + next.clientY - start.y };
    applyView();
  };
  const end = () => {
    stage.removeEventListener("pointermove", move);
    stage.removeEventListener("pointerup", end);
    stage.removeEventListener("pointercancel", end);
    stage.classList.remove("panning", "dragging");
  };
  stage.addEventListener("pointermove", move);
  stage.addEventListener("pointerup", end);
  stage.addEventListener("pointercancel", end);
});

function zoomAt(k: number, cx: number, cy: number) {
  const next = Math.min(ZOOM.max, Math.max(ZOOM.min, k));
  view = { k: next, x: cx - ((cx - view.x) / view.k) * next, y: cy - ((cy - view.y) / view.k) * next };
  applyView();
}

stage.addEventListener("wheel", event => {
  event.preventDefault();
  if (event.ctrlKey || event.metaKey) {
    const rect = stage.getBoundingClientRect();
    zoomAt(view.k * Math.exp(-event.deltaY * 0.01), event.clientX - rect.left, event.clientY - rect.top);
  } else {
    view = { ...view, x: view.x - event.deltaX, y: view.y - event.deltaY };
    applyView();
  }
}, { passive: false });

document.getElementById("fit")!.addEventListener("click", () => {
  const pieces = [...shown.values()].map(item => item.piece);
  const rect = stage.getBoundingClientRect();
  if (!pieces.length) {
    view = { x: 0, y: 0, k: 1 };
    return applyView();
  }
  const left = Math.min(...pieces.map(piece => piece.x));
  const top = Math.min(...pieces.map(piece => piece.y));
  const right = Math.max(...pieces.map(piece => piece.x + piece.w));
  const bottom = Math.max(...pieces.map(piece => piece.y + piece.h));
  const k = Math.min(ZOOM.max, Math.max(ZOOM.min, Math.min(rect.width / (right - left), rect.height / (bottom - top), 1) * 0.9));
  view = { k, x: rect.width / 2 - ((left + right) / 2) * k, y: rect.height / 2 - ((top + bottom) / 2) * k };
  applyView();
});

zoomButton.addEventListener("click", () => {
  const rect = stage.getBoundingClientRect();
  zoomAt(1, rect.width / 2, rect.height / 2);
});

async function connect() {
  if (!token()) return setStatus("enter your access token in the chat", "problem");
  setStatus("connecting");
  try {
    const response = await fetch("api/canvas/ticket", { method: "POST", headers: headers(), body: "{}" });
    if (response.status === 401) return setStatus("the access token in the chat is wrong", "problem");
    if (!response.ok) throw new Error(`ticket: HTTP ${response.status}`);
    const { ticket } = await response.json() as { ticket: string };
    const url = new URL("api/canvas/live", location.href);
    url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("ticket", ticket);
    let first = true;
    const live = new WebSocket(url);
    socket = live;
    live.addEventListener("open", () => {
      reconnectMs = RECONNECT_MS.first;
      setStatus("live", "live");
      sendViewport();
    });
    live.addEventListener("message", event => {
      const message = JSON.parse(String(event.data)) as Message;
      if (message.type === "snapshot") {
        render(message.snapshot, first);
        first = false;
      } else if (message.type === "state") changed(message.id, message.key, message.value);
      else console.error("canvas:", message.message);
    });
    live.addEventListener("close", () => {
      if (socket !== live) return;
      socket = undefined;
      retry();
    });
  } catch (error) {
    console.error(error);
    retry();
  }
}

function retry() {
  setStatus(`reconnecting in ${Math.round(reconnectMs / 1000)}s`, "problem");
  setTimeout(connect, reconnectMs);
  reconnectMs = Math.min(RECONNECT_MS.max, reconnectMs * 2);
}

addEventListener("message", event => void bridge(event));
addEventListener("storage", event => {
  if (event.key === TOKEN_KEY && !socket) void connect();
});
addEventListener("resize", () => applyView());
applyView();
void connect();
