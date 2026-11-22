import { DurableObject } from "cloudflare:workers";

export type Piece = { id: string; title: string; x: number; y: number; w: number; h: number; z: number; html: string; css: string; js: string; updated_at: number };
export type Theme = { css: string };
export type State = Record<string, unknown>;
export type Actor = { kind: "agent"; session: string } | { kind: "owner" };
export type Op = "add" | "update" | "remove" | "move" | "theme" | "restore";
type Side = { pieces?: Record<string, Piece | null>; theme?: Theme; state?: Record<string, State> };
type Version = { seq: number; op: Op; actor: Actor; at: number; summary: string; undone: boolean };
type Snapshot = { pieces: Piece[]; theme: Theme; state: Record<string, State>; version: number; canUndo: boolean; canRedo: boolean };
type Viewport = { x: number; y: number; w: number; h: number };

const EMPTY_THEME: Theme = { css: "" };
const TICKET_MS = 60_000;
const DEFAULT_SIZE = { w: 360, h: 280 };
const GAP = 24;

export class Canvas extends DurableObject {
  private sql: SqlStorage;
  private viewport: Viewport = { x: 0, y: 0, w: 1200, h: 800 };

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS pieces (id TEXT PRIMARY KEY, body TEXT NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS piece_state (id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (id, key))`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS versions (seq INTEGER PRIMARY KEY AUTOINCREMENT, op TEXT NOT NULL, actor TEXT NOT NULL, at INTEGER NOT NULL, summary TEXT NOT NULL, before TEXT NOT NULL, after TEXT NOT NULL, undone INTEGER NOT NULL DEFAULT 0)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS tickets (ticket TEXT PRIMARY KEY, expires INTEGER NOT NULL)`);
    const viewport = this.sql.exec<{ value: string }>(`SELECT value FROM meta WHERE key = 'viewport'`).toArray()[0];
    if (viewport) this.viewport = JSON.parse(viewport.value) as Viewport;
  }

  private pieces(): Record<string, Piece> {
    const out: Record<string, Piece> = {};
    for (const row of this.sql.exec<{ body: string }>(`SELECT body FROM pieces`)) {
      const piece = JSON.parse(row.body) as Piece;
      out[piece.id] = piece;
    }
    return out;
  }

  private piece(id: string): Piece | undefined {
    const row = this.sql.exec<{ body: string }>(`SELECT body FROM pieces WHERE id = ?`, id).toArray()[0];
    return row ? JSON.parse(row.body) as Piece : undefined;
  }

  private theme(): Theme {
    const row = this.sql.exec<{ value: string }>(`SELECT value FROM meta WHERE key = 'theme'`).toArray()[0];
    return row ? JSON.parse(row.value) as Theme : EMPTY_THEME;
  }

  private stateOf(id: string): State {
    const out: State = {};
    for (const row of this.sql.exec<{ key: string; value: string }>(`SELECT key, value FROM piece_state WHERE id = ?`, id)) out[row.key] = JSON.parse(row.value);
    return out;
  }

  private allState(): Record<string, State> {
    const out: Record<string, State> = {};
    for (const row of this.sql.exec<{ id: string; key: string; value: string }>(`SELECT id, key, value FROM piece_state`)) (out[row.id] ??= {})[row.key] = JSON.parse(row.value);
    return out;
  }

  private latest(): number {
    return this.sql.exec<{ seq: number | null }>(`SELECT MAX(seq) AS seq FROM versions WHERE undone = 0`).one().seq ?? 0;
  }

  private flags() {
    const undo = this.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM versions WHERE undone = 0`).one().n > 0;
    const redo = this.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM versions WHERE undone = 1`).one().n > 0;
    return { canUndo: undo, canRedo: redo };
  }

  snapshot(): Snapshot {
    return { pieces: Object.values(this.pieces()), theme: this.theme(), state: this.allState(), version: this.latest(), ...this.flags() };
  }

  private applySide(side: Side) {
    for (const [id, piece] of Object.entries(side.pieces ?? {})) {
      if (piece) this.sql.exec(`INSERT INTO pieces (id, body) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET body = excluded.body`, id, JSON.stringify(piece));
      else {
        this.sql.exec(`DELETE FROM pieces WHERE id = ?`, id);
        this.sql.exec(`DELETE FROM piece_state WHERE id = ?`, id);
      }
    }
    if (side.theme) this.sql.exec(`INSERT INTO meta (key, value) VALUES ('theme', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, JSON.stringify(side.theme));
    for (const [id, state] of Object.entries(side.state ?? {})) {
      this.sql.exec(`DELETE FROM piece_state WHERE id = ?`, id);
      for (const [key, value] of Object.entries(state)) this.sql.exec(`INSERT INTO piece_state (id, key, value) VALUES (?, ?, ?)`, id, key, JSON.stringify(value));
    }
  }

  private record(op: Op, actor: Actor, summary: string, before: Side, after: Side): number {
    this.sql.exec(`DELETE FROM versions WHERE undone = 1`);
    this.applySide(after);
    const seq = this.sql.exec<{ seq: number }>(`INSERT INTO versions (op, actor, at, summary, before, after) VALUES (?, ?, ?, ?, ?, ?) RETURNING seq`, op, JSON.stringify(actor), Date.now(), summary, JSON.stringify(before), JSON.stringify(after)).one().seq;
    this.broadcast({ type: "snapshot", snapshot: this.snapshot() });
    return seq;
  }

  private nextZ(): number {
    return Object.values(this.pieces()).reduce((max, piece) => Math.max(max, piece.z), 0) + 1;
  }

  private spot(w: number, h: number, x?: number, y?: number): { x: number; y: number } {
    if (x !== undefined && y !== undefined) return { x, y };
    const center = { x: x ?? Math.round(this.viewport.x + this.viewport.w / 2 - w / 2), y: y ?? Math.round(this.viewport.y + this.viewport.h / 2 - h / 2) };
    const taken = Object.values(this.pieces());
    const free = (left: number, top: number) => taken.every(piece => left + w + GAP <= piece.x || piece.x + piece.w + GAP <= left || top + h + GAP <= piece.y || piece.y + piece.h + GAP <= top);
    for (let ring = 0; ring <= taken.length + 1; ring++) {
      const step = ring * (Math.max(w, h) / 2 + GAP);
      const candidates = ring === 0 ? [[0, 0]] : [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]];
      for (const [dx, dy] of candidates) {
        const left = Math.round(center.x + dx * step * (x === undefined ? 1 : 0));
        const top = Math.round(center.y + dy * step * (y === undefined ? 1 : 0));
        if (free(left, top)) return { x: left, y: top };
      }
    }
    return center;
  }

  add(actor: Actor, input: { title: string; html: string; css?: string; js?: string; x?: number; y?: number; w?: number; h?: number }): Piece {
    const w = input.w ?? DEFAULT_SIZE.w;
    const h = input.h ?? DEFAULT_SIZE.h;
    const piece: Piece = {
      id: crypto.randomUUID().slice(0, 8),
      title: input.title,
      ...this.spot(w, h, input.x, input.y),
      w,
      h,
      z: this.nextZ(),
      html: input.html,
      css: input.css ?? "",
      js: input.js ?? "",
      updated_at: Date.now(),
    };
    this.record("add", actor, `added "${piece.title}"`, { pieces: { [piece.id]: null } }, { pieces: { [piece.id]: piece } });
    return piece;
  }

  update(actor: Actor, id: string, patch: Partial<Omit<Piece, "id" | "updated_at">>): Piece {
    const current = this.piece(id);
    if (!current) throw new Error(`no piece has id ${id}`);
    const next: Piece = { ...current, ...patch, id, updated_at: Date.now() };
    const moved = Object.keys(patch).every(key => ["x", "y", "w", "h", "z"].includes(key));
    this.record(moved ? "move" : "update", actor, `${moved ? "moved" : "changed"} "${next.title}"`, { pieces: { [id]: current } }, { pieces: { [id]: next } });
    return next;
  }

  remove(actor: Actor, id: string): void {
    const current = this.piece(id);
    if (!current) throw new Error(`no piece has id ${id}`);
    this.record("remove", actor, `removed "${current.title}"`, { pieces: { [id]: current }, state: { [id]: this.stateOf(id) } }, { pieces: { [id]: null } });
  }

  setTheme(actor: Actor, theme: Theme): void {
    this.record("theme", actor, theme.css ? "changed the look" : "reset the look", { theme: this.theme() }, { theme });
  }

  read(id?: string) {
    if (id) {
      const piece = this.piece(id);
      if (!piece) throw new Error(`no piece has id ${id}`);
      return { piece, state: this.stateOf(id) };
    }
    return {
      pieces: Object.values(this.pieces()).map(({ id, title, x, y, w, h, z }) => ({ id, title, x, y, w, h, z })),
      theme: this.theme(),
      version: this.latest(),
      viewport: this.viewport,
    };
  }

  history(limit: number, before?: number) {
    const rows = before === undefined
      ? this.sql.exec<{ seq: number; op: Op; actor: string; at: number; summary: string; undone: number }>(`SELECT seq, op, actor, at, summary, undone FROM versions ORDER BY seq DESC LIMIT ?`, limit).toArray()
      : this.sql.exec<{ seq: number; op: Op; actor: string; at: number; summary: string; undone: number }>(`SELECT seq, op, actor, at, summary, undone FROM versions WHERE seq < ? ORDER BY seq DESC LIMIT ?`, before, limit).toArray();
    return rows.map((row): Version => ({ seq: row.seq, op: row.op, actor: JSON.parse(row.actor) as Actor, at: row.at, summary: row.summary, undone: row.undone === 1 }));
  }

  private keep(applying: Side, other: Side): Side {
    const kept: Record<string, State> = { ...(other.state ?? {}) };
    for (const [id, piece] of Object.entries(applying.pieces ?? {})) if (!piece && this.piece(id)) kept[id] = this.stateOf(id);
    return { ...other, state: kept };
  }

  undo(): boolean {
    const row = this.sql.exec<{ seq: number; before: string; after: string }>(`SELECT seq, before, after FROM versions WHERE undone = 0 ORDER BY seq DESC LIMIT 1`).toArray()[0];
    if (!row) return false;
    const before = JSON.parse(row.before) as Side;
    const after = this.keep(before, JSON.parse(row.after) as Side);
    this.applySide(before);
    this.sql.exec(`UPDATE versions SET undone = 1, after = ? WHERE seq = ?`, JSON.stringify(after), row.seq);
    this.broadcast({ type: "snapshot", snapshot: this.snapshot() });
    return true;
  }

  redo(): boolean {
    const row = this.sql.exec<{ seq: number; before: string; after: string }>(`SELECT seq, before, after FROM versions WHERE undone = 1 ORDER BY seq ASC LIMIT 1`).toArray()[0];
    if (!row) return false;
    const after = JSON.parse(row.after) as Side;
    const before = this.keep(after, JSON.parse(row.before) as Side);
    this.applySide(after);
    this.sql.exec(`UPDATE versions SET undone = 0, before = ? WHERE seq = ?`, JSON.stringify(before), row.seq);
    this.broadcast({ type: "snapshot", snapshot: this.snapshot() });
    return true;
  }

  restore(actor: Actor, seq: number): number {
    if (seq !== 0 && !this.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM versions WHERE seq = ? AND undone = 0`, seq).one().n) throw new Error(`version ${seq} is not in the current history`);
    const current = this.pieces();
    const currentTheme = this.theme();
    const target: Record<string, Piece> = { ...current };
    let targetTheme = currentTheme;
    const revived: Record<string, State> = {};
    for (const row of this.sql.exec<{ before: string }>(`SELECT before FROM versions WHERE seq > ? AND undone = 0 ORDER BY seq DESC`, seq)) {
      const side = JSON.parse(row.before) as Side;
      for (const [id, piece] of Object.entries(side.pieces ?? {})) {
        if (piece) target[id] = piece;
        else {
          delete target[id];
          delete revived[id];
        }
      }
      if (side.theme) targetTheme = side.theme;
      for (const [id, state] of Object.entries(side.state ?? {})) revived[id] = state;
    }
    const ids = new Set([...Object.keys(current), ...Object.keys(target)]);
    const before: Side = { pieces: {}, theme: currentTheme, state: {} };
    const after: Side = { pieces: {}, theme: targetTheme, state: {} };
    for (const id of ids) {
      before.pieces![id] = current[id] ?? null;
      after.pieces![id] = target[id] ?? null;
      if (current[id] && !target[id]) before.state![id] = this.stateOf(id);
      if (!current[id] && target[id] && revived[id]) after.state![id] = revived[id];
    }
    return this.record("restore", actor, `restored version ${seq}`, before, after);
  }

  setState(id: string, key: string, value: unknown): void {
    if (!this.piece(id)) throw new Error(`no piece has id ${id}`);
    if (value === undefined || value === null) this.sql.exec(`DELETE FROM piece_state WHERE id = ? AND key = ?`, id, key);
    else this.sql.exec(`INSERT INTO piece_state (id, key, value) VALUES (?, ?, ?) ON CONFLICT(id, key) DO UPDATE SET value = excluded.value`, id, key, JSON.stringify(value));
    this.broadcast({ type: "state", id, key, value: value ?? null });
  }

  setViewport(viewport: Viewport): void {
    this.viewport = viewport;
    this.sql.exec(`INSERT INTO meta (key, value) VALUES ('viewport', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, JSON.stringify(viewport));
  }

  ticket(): string {
    const now = Date.now();
    this.sql.exec(`DELETE FROM tickets WHERE expires < ?`, now);
    const ticket = crypto.randomUUID();
    this.sql.exec(`INSERT INTO tickets (ticket, expires) VALUES (?, ?)`, ticket, now + TICKET_MS);
    return ticket;
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return new Response("expected a WebSocket", { status: 426 });
    const ticket = new URL(request.url).searchParams.get("ticket") ?? "";
    const valid = this.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM tickets WHERE ticket = ? AND expires >= ?`, ticket, Date.now()).one().n > 0;
    this.sql.exec(`DELETE FROM tickets WHERE ticket = ?`, ticket);
    if (!valid) return new Response("the ticket is missing, used or expired", { status: 401 });
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    pair[1].send(JSON.stringify({ type: "snapshot", snapshot: this.snapshot() }));
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") return;
    const data = JSON.parse(message) as
      | { type: "state"; id: string; key: string; value: unknown }
      | { type: "viewport"; viewport: Viewport }
      | { type: "move"; id: string; x: number; y: number; w: number; h: number; z?: number };
    try {
      if (data.type === "state") this.setState(data.id, data.key, data.value);
      else if (data.type === "viewport") this.setViewport(data.viewport);
      else if (data.type === "move") this.update({ kind: "owner" }, data.id, { x: data.x, y: data.y, w: data.w, h: data.h, ...(data.z === undefined ? {} : { z: data.z }) });
    } catch (error) {
      socket.send(JSON.stringify({ type: "error", message: error instanceof Error ? error.message : String(error) }));
    }
  }

  async webSocketClose(socket: WebSocket): Promise<void> {
    try {
      socket.close(1000, "closed");
    } catch {}
  }

  private broadcast(message: unknown): void {
    const text = JSON.stringify(message);
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.send(text);
      } catch {}
    }
  }
}
