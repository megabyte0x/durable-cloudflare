# Live Canvas: an agent-owned website

Date: 2026-11-22. Deployment: https://nanocode.harpocrates.workers.dev (Worker `nanocode`, this checkout).

## Intent

The owner wants the website to stop being a fixed chat demo and become an infinite canvas that the agent builds live from the conversation. The owner asks for something in the chat; the agent builds it onto the canvas; the page changes in front of them within a second, with no rebuild, no deploy and no involvement of the owner's machine. What goes on the canvas is open-ended: whatever the conversation calls for (widgets, tools, notes, charts, games, layout and look changes).

The site is private: only the owner, holding the existing access token, ever opens it.

## Goals

- `/` is a full-screen infinite canvas (pan and zoom) with the chat docked on the right.
- The agent owns the canvas: it adds, changes, moves, resizes and removes pieces, and sets the site-wide look (background, colours, fonts, board layout), through tools that run in the Worker.
- Changes show up live in an open page in under a second, without reloading.
- Everything persists in Cloudflare: the canvas survives reloads, new chat sessions and redeploys.
- Every change is a version. The owner can undo the last change and roll back to any earlier version from the page; the agent can also read and restore versions.
- The owner can drag and resize pieces by hand; those edits are versions too.
- Pieces can keep their own state (a to-do list remembers its items) and can call public web APIs.
- Works with the owner's Mac off. Nothing runs outside Cloudflare.

## Non-goals

- Visitors or sharing. Single owner only.
- Multiplayer or several people editing at once.
- Freehand drawing or whiteboard tools.
- The agent editing the deployed source code, the chat dock or the Worker. It edits canvas data only.
- Several canvases. There is one canvas for the deployment.

## Anti-goals (failure even if it works)

- A bad agent change that breaks the chat, so the owner cannot ask for a fix.
- A broken piece that takes the whole page down.
- Losing canvas history, or a change that cannot be undone.
- Any dependence on the owner's Mac (hands, local builds) to make or show a change.
- Changes that need a reload or a redeploy to appear.

## Constraints

- Cloudflare Workers + Durable Objects, built on this repository (nanocodexyz/durable-cloudflare) and its runtime nanocode-ts, pinned in `package-lock.json`.
- nanocode-ts `App.create` options used: `tools` (host tools: `definitions` + `call(call, env, signal)`, where `call.authority` identifies the session) and `instructions` (text added to the agent's instructions).
- Authentication stays as it is: the bearer token whose SHA-256 is `ACCESS_TOKEN_SHA256`. Every new route requires it. Browsers cannot set an `Authorization` header on a WebSocket, so the live channel needs another way to present it (left to the builder; see below).
- The model is the owner's Claude plan (the ChatGPT plan is blocked on Cloudflare, see the session notes); the design must not depend on a particular provider.
- The repository's `AGENTS.md` conventions apply to code style (small changes, no code comments). Tests are decided in the plan.

## Approaches considered

1. **Canvas as data, edited through host tools (chosen).** Canvas state lives in a Durable Object; the agent changes it through Worker tools; the page renders it and receives changes live. Truly live, works without the Mac, full history, chat protected. Cost: a new page and a set of tools; pieces are self-contained mini-apps rather than edits to the site's source.
2. **Agent edits `ui/*.tsx` and redeploys through the owner's machine (hands).** Rejected: needs the Mac, takes minutes per change, a bad edit can break the chat, undo depends on git.
3. **tldraw as the canvas with agent pieces as custom shapes.** Rejected: heavy dependency, production licence key required to remove the watermark, and drawing is a non-goal.

The owner chose 1 and added: agent-owned only, no access to the Mac.

## Design

### Pieces

A piece is a self-contained bit of web UI the agent wrote:

- `id` (stable, assigned by the canvas), `title`
- `x`, `y`, `w`, `h` in canvas coordinates, `z` order
- `html`, `css`, `js` (strings, written by the agent)
- `updated_at`

Each piece renders in its own `<iframe sandbox="allow-scripts allow-forms allow-popups allow-modals">` built with `srcdoc`, without `allow-same-origin`, so a broken or runaway piece cannot break the page or read the page's storage (where the access token lives). The iframe has a small header strip with the title, used for dragging, with a resize handle in the corner.

### Piece state and the bridge

Pieces need to remember things. The page injects a tiny script into every piece that provides `canvas.state.get(key)`, `canvas.state.set(key, value)`, `canvas.state.onChange(fn)` and `canvas.fetch(url, init)`, implemented with `postMessage` to the page, which reads and writes the piece's state through the canvas API. Piece state is stored per piece in the canvas object and is not versioned (typing in a to-do list should not flood the history), but it is deleted with its piece and kept when the agent updates the piece's code. The agent can read a piece's state through `canvas_read`, so "what's on my list?" works.

### Site-wide look

A single `theme` record holds `css` (applied to the page shell: background, colours, fonts, canvas grid) and a few variables the shell reads. The chat dock styles are not reachable by the theme: the dock is isolated (shadow DOM or its own iframe, builder's choice) so no theme CSS can hide or break it. A "reset look" button in the dock clears the theme.

### Storage: the `Canvas` Durable Object

One new SQLite-backed Durable Object class, `Canvas`, with one instance named `main`. It holds:

- `pieces`: current pieces
- `theme`: the current site-wide look
- `piece_state`: per-piece key/value state
- `versions`: an append-only log. Each entry records the operation (`add`, `update`, `remove`, `move`, `theme`, `restore`), who made it (`agent` with the session ID, or `owner`), the time, and the before and after values of what changed, so any version can be restored and undo is "apply the before of the last entry"

It also holds the live connections (hibernatable WebSockets) and broadcasts every change to them.

### Agent tools (host tools in `worker/tools.ts`)

- `canvas_read`: lists pieces (id, title, position, size), the theme, and the latest version number; optionally returns one piece's full code and state.
- `canvas_add`: creates a piece from `title`, `html`, `css`, `js` and an optional position and size. Without a position it is placed near the owner's current view (the page reports its viewport to the canvas object as it moves).
- `canvas_update`: changes any subset of a piece's fields.
- `canvas_remove`: deletes a piece.
- `canvas_theme`: sets or clears the site-wide look.
- `canvas_history` and `canvas_restore`: list recent versions and restore the canvas to a version (restoring is itself a new version, so it can be undone).

The existing demo `charge` tool is removed.

Every canvas tool checks that the calling session belongs to the owner (`authority` is the owner account, not a visitor), and refuses otherwise.

The tools are available in every owner session, not only the dock's (builder's call, decided here): there is one owner and one canvas, so any of the owner's chats may change it.

### Agent instructions

The `instructions` option tells the agent that it owns a live canvas the owner is looking at; that building things means making pieces with the tools above, not answering with code in chat; that pieces are sandboxed (no access to the page, state through `canvas.state`, public APIs through `fetch`); to check `canvas_read` before changing things; and to keep the look readable.

### Undo, redo and restoring removed pieces

- Undo steps back through history one change at a time, whoever made it (agent or owner); pressing it again keeps going back. Redo steps forward again until a new change is made, which discards the redo steps. This needs an undo cursor in the version log, not "undo the last entry".
- A `remove` version captures the piece's state as well as its code, so undoing a removal or restoring a version where the piece existed brings back its data (a deleted to-do list comes back with its items).
- Restoring an earlier version keeps the current state of pieces that exist both now and in that version; only code, position, size and theme roll back.

### Network access from pieces

Pieces can call any public web API, including ones that do not send CORS headers: the bridge exposes `canvas.fetch(url, init)`, which the page forwards to an authenticated Worker proxy route (`/api/canvas/fetch`). The proxy allows only `http` and `https` to public hosts, refuses private, loopback, link-local and Cloudflare-internal addresses and this Worker's own host, never forwards the owner's access token or cookies, and returns the response with its status and content type. Plain `fetch` also works for CORS-enabled APIs.

### Live updates

The page opens a WebSocket to the canvas object, receives a full snapshot on connect, then one message per change. A change made by a tool call is visible in the open page in under a second. Owner drags and resizes are sent the same way, saved as `move` versions, and coalesced so a drag makes one version, not hundreds.

### The page

- `/` serves the canvas page; the current demo page moves to `/demo`, and `/chatgpt` and `/claude` stay.
- Left: the canvas. Drag empty space to pan, wheel or pinch to zoom, a "fit all" button, a dotted grid.
- Right: the chat dock, built from the existing nanocode chat component (`ui/agent.tsx`) with one long-lived session for the canvas, plus Undo, History (a list of versions with Restore) and Reset look.
- The access-token prompt is the existing one.

### Deployment

Migration: a new tag after `v1` adding `Canvas` to `new_sqlite_classes`.

New migration adding the `Canvas` class; new routes behind the existing authentication; deployed with `npx wrangler deploy` to the private `nanocode` Worker only. This checkout is the owner's own deployment: the upstream demo scripts (`deploy:demo`, `deploy:demo:raw`, which target nanocode's account) are not used and not supported by this change, and `CHAT_PUBLIC` stays off.

The relay container is out of scope and stays as it is. Removing it means a `deleted_classes` migration and is decided separately.

## Calls made without the owner (check these)

- Canvas tools work in every owner session, not only the dock's.
- Undo steps back through history (with redo), across agent and owner changes.
- Undoing a removal brings back the piece's data; restoring a version keeps surviving pieces' current data.
- Pieces get a Worker proxy for APIs without CORS headers, limited to public hosts.
- Only the private `nanocode` Worker is supported; the upstream demo deploy is not.
- The relay container is left alone in this change.

## Left to the builder

- How the WebSocket presents the access token (for example a short-lived ticket from an authenticated `POST`, or the `Sec-WebSocket-Protocol` header).
- Whether the chat dock is isolated with shadow DOM or an iframe.
- Pan and zoom implementation (CSS transforms on a world element is the expected default; no heavy library).
- Size limits on pieces and state, taken from Durable Object storage limits rather than invented.
- How many history entries the History panel shows and how they're paginated.
- Test approach, consistent with the repository's validation commands (`npm run build`, `npm run dry-run`, `npm run drill`).
