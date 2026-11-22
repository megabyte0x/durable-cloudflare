import type { Contracts } from "nanocode-ts";
import type { App } from "nanocode-ts/cloudflare";
import type { Actor, Canvas, Piece } from "./canvas";

type HostTool = Contracts.HostTool;
type HostToolCall = App.HostToolCall;
type Env = { CANVAS: DurableObjectNamespace<Canvas> };

export const OWNER = "owner";
const HISTORY_PAGE = 20;

const box = { x: { type: "number" }, y: { type: "number" }, w: { type: "number" }, h: { type: "number" } };
const code = { title: { type: "string" }, html: { type: "string" }, css: { type: "string" }, js: { type: "string" } };

const definitions: HostTool[] = [
  {
    name: "canvas_read",
    description: "Reads the live canvas. Without id: every piece's id, title, position and size, the site-wide theme, the latest version and the owner's current viewport (canvas coordinates). With id: that piece's full html, css, js and its saved state.",
    parameters: { type: "object", properties: { id: { type: "string" } }, additionalProperties: false },
  },
  {
    name: "canvas_add",
    description: "Adds a piece to the canvas and shows it to the owner at once. A piece is a self-contained web page: html (body content), css and js, rendered in its own sandboxed iframe. Omit x and y to place it in the middle of the owner's view; w and h default to 360x280 pixels. Returns the new piece's id.",
    parameters: { type: "object", properties: { ...code, ...box }, required: ["title", "html"], additionalProperties: false },
  },
  {
    name: "canvas_update",
    description: "Changes any subset of a piece's fields (title, html, css, js, x, y, w, h, z). Fields you leave out stay as they are; the piece's saved state is kept.",
    parameters: { type: "object", properties: { id: { type: "string" }, ...code, ...box, z: { type: "number" } }, required: ["id"], additionalProperties: false },
  },
  {
    name: "canvas_remove",
    description: "Removes a piece from the canvas. The owner can undo it, which brings the piece back with its saved state.",
    parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
  },
  {
    name: "canvas_theme",
    description: "Sets the site-wide look: CSS applied to the canvas page (body background, colours, fonts, the .grid background, .piece frames and .piece-title strips). Pass an empty string to reset to the default look. The chat dock is never affected.",
    parameters: { type: "object", properties: { css: { type: "string" } }, required: ["css"], additionalProperties: false },
  },
  {
    name: "canvas_history",
    description: "Lists canvas versions, newest first: seq, operation, who made it, time, summary and whether it is currently undone. Pass before (a seq) to page further back.",
    parameters: { type: "object", properties: { before: { type: "number" } }, additionalProperties: false },
  },
  {
    name: "canvas_restore",
    description: "Restores the whole canvas (pieces, positions, code and theme) to how it was right after version seq (0 is the empty canvas). The restore is itself a new version, so it can be undone.",
    parameters: { type: "object", properties: { seq: { type: "number" } }, required: ["seq"], additionalProperties: false },
  },
];

export const INSTRUCTIONS = `You own a live canvas: the website the owner is looking at right now is an infinite canvas next to this chat, and you build it. When the owner asks for something to see or use (a widget, tool, note, chart, game, layout or look), build it on the canvas with the canvas tools instead of answering with code in the chat, then reply in one or two sentences.

- Call canvas_read before changing existing things, and canvas_read with an id before editing a piece's code.
- Each piece is a self-contained page in a sandboxed iframe: it cannot reach the parent page or other pieces. Write complete html, css and js; the js runs after the html.
- Pieces keep data with the injected canvas API: await canvas.state.get(key), await canvas.state.set(key, value) (JSON values), canvas.state.onChange((key, value) => ...). Use it for anything that should survive a reload, such as list items or settings.
- For network requests use await canvas.fetch(url, init), which goes through the server and works with APIs that send no CORS headers; it resolves to a Response. Only public http(s) hosts are allowed.
- Size pieces to their content and place new ones where they don't overlap others; omit x and y to drop a piece in the middle of the owner's view.
- canvas_theme restyles the whole page (background, fonts, colours, .piece and .piece-title). Keep text readable.
- Every change is versioned and the owner can undo, redo or restore, so act directly.`;

function actor(call: HostToolCall): Actor {
  return { kind: "agent", session: call.authority.session_name ?? call.authority.session_id };
}

function pick<T extends object>(input: Record<string, unknown>, keys: readonly (keyof T)[]): Partial<T> {
  return Object.fromEntries(keys.filter(key => input[key as string] !== undefined).map(key => [key, input[key as string]])) as Partial<T>;
}

export const canvasTools = {
  definitions,
  async call(call: HostToolCall, env: unknown): Promise<unknown> {
    if (call.authority.account_id !== OWNER) throw new Error("the canvas belongs to the owner; this session cannot change it");
    const canvas = (env as Env).CANVAS.getByName("main");
    const input = (call.input ?? {}) as Record<string, unknown>;
    switch (call.name) {
      case "canvas_read":
        return await canvas.read(typeof input.id === "string" ? input.id : undefined);
      case "canvas_add": {
        const piece = await canvas.add(actor(call), input as Parameters<Canvas["add"]>[1]);
        return { id: piece.id, x: piece.x, y: piece.y, w: piece.w, h: piece.h };
      }
      case "canvas_update": {
        const piece = await canvas.update(actor(call), String(input.id), pick<Piece>(input, ["title", "html", "css", "js", "x", "y", "w", "h", "z"]));
        return { id: piece.id, x: piece.x, y: piece.y, w: piece.w, h: piece.h };
      }
      case "canvas_remove":
        await canvas.remove(actor(call), String(input.id));
        return "removed";
      case "canvas_theme":
        await canvas.setTheme(actor(call), { css: String(input.css ?? "") });
        return input.css ? "theme set" : "theme reset";
      case "canvas_history":
        return await canvas.history(HISTORY_PAGE, typeof input.before === "number" ? input.before : undefined);
      case "canvas_restore":
        return { seq: await canvas.restore(actor(call), Number(input.seq)) };
      default:
        throw new Error(`no host tool is named ${call.name}`);
    }
  },
};
