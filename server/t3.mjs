// Connection to the local T3 Code server.
//
// Uses only T3's public surfaces:
//   - userdata/server-runtime.json to find the running server
//   - `t3 auth session issue` for a scoped bearer token (orchestration:read + orchestration:operate)
//   - POST /api/auth/websocket-ticket, then the /ws Effect-RPC socket
//   - `orchestration.subscribeShell` for the live map
//   - `orchestration.getThreadProjection` / `orchestration.dispatchCommand` for the thread panel
//   - `t3 thread start` to start new work
// Images use T3's attachment service. No direct terminal or arbitrary file access.

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";

const PROTOCOL = 2;
const T3_HOME = process.env.T3CODE_HOME || join(homedir(), ".t3");
const STATE_DIR = join(homedir(), ".t3-map");
const SESSION_FILE = join(STATE_DIR, "session.json");
const SCOPES = ["orchestration:read", "orchestration:operate"];

export async function discover() {
  const runtime = JSON.parse(await readFile(join(T3_HOME, "userdata", "server-runtime.json"), "utf8"));
  const environmentId = (await readFile(join(T3_HOME, "userdata", "environment-id"), "utf8").catch(() => "")).trim();
  return { origin: runtime.origin, serverVersion: runtime.serverVersion, environmentId: environmentId || null };
}

/** The user's favourite agent/model pairs from T3's own settings. */
export async function favorites() {
  try {
    const s = JSON.parse(await readFile(join(T3_HOME, "userdata", "settings.json"), "utf8"));
    return (s.favorites ?? []).filter((f) => f?.provider && f?.model);
  } catch {
    return [];
  }
}

/** T3 provider instances that are switched on, by id (e.g. "claudeTeam"). */
export async function providerInstances() {
  try {
    const s = JSON.parse(await readFile(join(T3_HOME, "userdata", "settings.json"), "utf8"));
    return Object.fromEntries(Object.entries(s.providerInstances ?? {}).filter(([, v]) => v?.enabled !== false));
  } catch {
    return {};
  }
}

export async function launchDefaults(projectId, project) {
  const s = JSON.parse(await readFile(join(T3_HOME, 'userdata', 'settings.json'), 'utf8'));
  const overrides = s.projectSettingsOverrides?.[projectId] ?? {};
  return {
    modelSelection: Object.hasOwn(overrides, 'defaultModelSelection') ? overrides.defaultModelSelection : (!s.projectSettingsFolded && project?.defaultModelSelection) || s.defaultModelSelection,
    runtimeMode: overrides.defaultRuntimeMode ?? s.defaultRuntimeMode ?? 'full-access',
  };
}

// The `t3` launcher is a .cmd on Windows. Run what it runs directly, so arguments
// (including user text) never pass through a shell.
let cliCache = null;
async function cli() {
  if (cliCache) return cliCache;
  if (process.platform !== "win32") return (cliCache = { cmd: join(T3_HOME, "bin", "t3"), pre: [], env: {} });
  const text = await readFile(join(T3_HOME, "bin", "t3.cmd"), "utf8");
  const m = /^"([^"]+\.exe)" "([^"]+bin\.mjs)" %\*/m.exec(text);
  if (!m) throw new Error("Couldn't read T3's command-line launcher.");
  return (cliCache = { cmd: m[1], pre: [m[2]], env: { ELECTRON_RUN_AS_NODE: "1", T3CODE_DESKTOP_CLI_LAUNCHER: "1", T3CODE_HOME: T3_HOME } });
}

export async function runCli(args, { input, timeout = 60_000 } = {}) {
  const c = await cli();
  return new Promise((resolve, reject) => {
    const child = execFile(c.cmd, [...c.pre, ...args], { env: { ...process.env, ...c.env }, timeout, windowsHide: true, maxBuffer: 4 << 20 }, (err, stdout, stderr) => {
      if (err) return reject(Object.assign(new Error(cleanCliError(stderr || err.message)), { stdout }));
      resolve(stdout);
    });
    if (input !== undefined) child.stdin.end(input);
  });
}

function cleanCliError(text) {
  const line = String(text).split("\n").map((l) => l.trim()).filter(Boolean).find((l) => !/^ERROR$/.test(l));
  return line?.slice(0, 200) ?? "T3 couldn't do that.";
}

async function issueSession() {
  const args = ["auth", "session", "issue", "--ttl", "30d", "--label", "t3-map", "--json"];
  for (const s of SCOPES) args.push("--scope", s);
  let stdout;
  try {
    stdout = await runCli(args, { timeout: 30_000 });
  } catch (e) {
    throw new Error(`Could not issue a T3 session: ${e.message}`);
  }
  try {
    const out = JSON.parse(stdout.slice(stdout.indexOf("{")));
    return { token: out.token, expiresAt: out.expiresAt, sessionId: out.sessionId, scopes: out.scopes ?? SCOPES };
  } catch {
    throw new Error("T3 returned an unreadable session.");
  }
}

async function loadSession({ fresh = false } = {}) {
  let old = null;
  try {
    old = JSON.parse(await readFile(SESSION_FILE, "utf8"));
  } catch {}
  const enough = old?.token && SCOPES.every((s) => old.scopes?.includes(s));
  if (!fresh && enough && Date.parse(old.expiresAt) - Date.now() > 24 * 3600_000) return old;
  const s = await issueSession();
  await mkdir(STATE_DIR, { recursive: true });
  await writeFile(SESSION_FILE, JSON.stringify(s, null, 2), { mode: 0o600 });
  // Retire the session this one replaces.
  if (old?.sessionId && old.sessionId !== s.sessionId) runCli(["auth", "session", "revoke", old.sessionId]).catch(() => {});
  return s;
}

const SHELL_ID = "1";

/**
 * Emits: "status" ({state, detail}), "snapshot" ({threads, projects}), "projects" (rawProject[]),
 * "projectRemoved" (projectId), "thread" (rawThread), "removed" (threadId).
 */
export class T3Shell extends EventEmitter {
  constructor() {
    super();
    this.status = { state: "connecting", detail: "Looking for T3 Code…" };
    this.info = null;
    this.ws = null;
    this.retry = 0;
    this.stopped = false;
    this.seq = 100;
    this.calls = new Map(); // requestId -> { resolve, reject, timer }
  }

  setStatus(state, detail) {
    this.status = { state, detail };
    this.emit("status", this.status);
  }

  start() {
    this.connect();
  }

  stop() {
    this.stopped = true;
    this.ws?.close();
  }

  async connect(freshToken = false) {
    if (this.stopped) return;
    try {
      this.info = await discover();
    } catch {
      return this.later("offline", "T3 Code isn't running");
    }
    let session;
    try {
      session = await loadSession({ fresh: freshToken });
    } catch (e) {
      return this.later("offline", e.message);
    }
    let ticket;
    try {
      const res = await fetch(`${this.info.origin}/api/auth/websocket-ticket`, {
        method: "POST",
        headers: { authorization: `Bearer ${session.token}` },
      });
      if (res.status === 401 || res.status === 403) {
        if (!freshToken) return this.connect(true);
        return this.later("offline", "T3 refused the map's session");
      }
      if (!res.ok) return this.later("offline", `T3 answered ${res.status}`);
      ticket = (await res.json()).ticket;
    } catch {
      return this.later("offline", "T3 Code isn't reachable");
    }

    const url = new URL("/ws", this.info.origin.replace(/^http/, "ws"));
    url.searchParams.set("wsTicket", ticket);
    url.searchParams.set("orchestrationProtocol", String(PROTOCOL));
    url.searchParams.set("clientSurface", "web");
    url.searchParams.set("clientDeviceType", "desktop");

    const ws = new WebSocket(url);
    this.ws = ws;
    let opened = false;
    ws.onopen = () => {
      opened = true;
      this.retry = 0;
      ws.send(JSON.stringify({ _tag: "Request", id: SHELL_ID, tag: "orchestration.subscribeShell", payload: {}, headers: [] }));
      this.setStatus("live", `T3 Code ${this.info.serverVersion ?? ""}`.trim());
    };
    ws.onmessage = (e) => this.onMessage(ws, e.data);
    ws.onclose = () => {
      if (this.ws !== ws) return;
      for (const [, c] of this.calls) (clearTimeout(c.timer), c.reject(new Error("Lost the connection to T3.")));
      this.calls.clear();
      this.later(opened ? "reconnecting" : "offline", opened ? "Reconnecting to T3…" : "T3 closed the connection");
    };
    ws.onerror = () => {};
  }

  later(state, detail) {
    if (this.stopped) return;
    this.setStatus(state, detail);
    const wait = Math.min(15_000, 800 * 2 ** this.retry++);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.connect(), wait);
  }

  /** One request/response over the shared socket. Resolves with the success value. */
  call(tag, payload, { timeout = 15_000 } = {}) {
    const ws = this.ws;
    if (!ws || ws.readyState !== 1) return Promise.reject(new Error("T3 isn't connected right now."));
    const id = String(++this.seq);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.calls.delete(id);
        reject(new Error("T3 took too long to answer."));
      }, timeout);
      this.calls.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ _tag: "Request", id, tag, payload, headers: [] }));
    });
  }

  /** Dispatch one orchestration command, the same way T3's own client does. */
  dispatch(command) {
    return this.call("orchestration.dispatchCommand", { commandId: randomUUID(), ...command });
  }

  onMessage(ws, data) {
    let msg;
    try {
      msg = JSON.parse(String(data));
    } catch {
      return;
    }
    if (msg._tag === "Ping") return ws.send(JSON.stringify({ _tag: "Pong" }));
    if (msg._tag === "Exit") {
      const call = this.calls.get(String(msg.requestId));
      if (call) {
        this.calls.delete(String(msg.requestId));
        clearTimeout(call.timer);
        if (msg.exit?._tag === "Success") call.resolve(msg.exit.value);
        else call.reject(new Error(failureMessage(msg.exit)));
        return;
      }
      // The shell stream ended (restart or rejection): reconnect.
      if (String(msg.requestId) === SHELL_ID) ws.close();
      return;
    }
    if (msg._tag !== "Chunk") return;
    ws.send(JSON.stringify({ _tag: "Ack", requestId: msg.requestId }));
    if (String(msg.requestId) !== SHELL_ID) return;
    for (const v of msg.values ?? []) this.onValue(v);
  }

  // Mirrors T3's own shell reducer (packages/client-runtime/src/state/shellReducer.ts).
  onValue(v) {
    switch (v.kind) {
      case "snapshot":
        // A snapshot carrying resolvedRepositoryIdentityRoots is a project-identity
        // enrichment, not a replacement of the whole shell.
        if (v.resolvedRepositoryIdentityRoots) return this.emit("projects", v.snapshot.projects ?? []);
        return this.emit("snapshot", { threads: v.snapshot.threads ?? [], projects: v.snapshot.projects ?? [] });
      case "project.updated":
        return this.emit("projects", [v.project]);
      case "project.removed":
        return this.emit("projectRemoved", v.projectId);
      case "thread.updated":
        // Archived threads leave the live shell.
        if (v.location && v.location !== "active") return this.emit("removed", v.thread.id);
        return this.emit("thread", v.thread);
      case "thread.removed":
        return this.emit("removed", v.threadId);
      default:
        return; // "synchronized" and future kinds need nothing from the map.
    }
  }
}

function failureMessage(exit) {
  // Effect RPC failures nest the domain error somewhere inside `cause`.
  let found = null;
  const walk = (x, depth = 0) => {
    if (found || !x || typeof x !== "object" || depth > 6) return;
    if (typeof x.message === "string" && x.message.trim()) return void (found = x.message);
    for (const v of Object.values(x)) walk(v, depth + 1);
  };
  walk(exit?.cause);
  return found ? found.slice(0, 240) : "T3 couldn't do that.";
}
