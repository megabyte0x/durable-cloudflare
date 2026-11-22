import "nds/zyzz.css";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Demo } from "./agent.tsx";
import "./dock.css";
import "./fonts.ts";

type Version = { seq: number; op: string; actor: { kind: "agent" | "owner"; session?: string }; at: number; summary: string; undone: boolean };
type Flags = { canUndo: boolean; canRedo: boolean; version: number };

const TOKEN_KEY = "nanocode-cloudflare-durable:token";
const PROMPTS = [
  "Add a pomodoro timer",
  "Make a to-do list I can tick off",
  "Show the weather in Tokyo",
  "Give the canvas a dark, calm look",
];

function headers(): Record<string, string> {
  let secret: string | null = null;
  try {
    secret = localStorage.getItem(TOKEN_KEY);
  } catch {}
  return secret ? { authorization: `Bearer ${secret}`, "content-type": "application/json" } : { "content-type": "application/json" };
}

async function call<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, body === undefined ? { headers: headers() } : { method: "POST", headers: headers(), body: JSON.stringify(body) });
  const data = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
  return data;
}

function when(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function Controls() {
  const [flags, setFlags] = useState<Flags>({ canUndo: false, canRedo: false, version: 0 });
  const [history, setHistory] = useState<Version[] | undefined>();
  const [problem, setProblem] = useState("");

  useEffect(() => {
    const channel = new BroadcastChannel("nanocode-canvas");
    channel.onmessage = event => {
      const data = event.data as { type: string } & Flags;
      if (data.type === "flags") setFlags({ canUndo: data.canUndo, canRedo: data.canRedo, version: data.version });
    };
    return () => channel.close();
  }, []);

  useEffect(() => {
    if (history) void call<Version[]>("api/canvas/history").then(setHistory, () => {});
  }, [flags.version, flags.canRedo]);

  const run = (action: () => Promise<unknown>) => () => {
    setProblem("");
    action().catch((error: unknown) => setProblem(error instanceof Error ? error.message : String(error)));
  };

  const toggleHistory = run(async () => setHistory(history ? undefined : await call<Version[]>("api/canvas/history")));

  return (
    <div className="dock-controls">
      <div className="dock-row">
        <button disabled={!flags.canUndo} onClick={run(() => call("api/canvas/undo", {}))} type="button">Undo</button>
        <button disabled={!flags.canRedo} onClick={run(() => call("api/canvas/redo", {}))} type="button">Redo</button>
        <button aria-pressed={!!history} onClick={toggleHistory} type="button">History</button>
        <button onClick={run(() => call("api/canvas/theme", { css: "" }))} type="button">Reset look</button>
      </div>
      {problem && <div className="dock-problem">{problem}</div>}
      {history && (
        <ol className="dock-history">
          {history.length === 0 && <li className="dock-muted">No changes yet</li>}
          {history.map(version => (
            <li className={version.undone ? "dock-undone" : ""} key={version.seq}>
              <span className="dock-seq">#{version.seq}</span>
              <span className="dock-summary">{version.actor.kind === "owner" ? "You" : "Agent"} {version.summary}</span>
              <span className="dock-muted">{when(version.at)}</span>
              {!version.undone && <button onClick={run(() => call("api/canvas/restore", { seq: version.seq }))} type="button">Restore</button>}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <div className="dock">
    <Controls />
    <div className="dock-chat">
      <Demo prompts={PROMPTS} theme="nanocode" />
    </div>
  </div>,
);
