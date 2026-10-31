// Drive ChatGPT Desktop threads through the app's own queue (experimental,
// undocumented; see docs/notes/lab-notebook.tr.md, Q1/Q2). A private
// `codex app-server` started from the app's bundled CLI shares the app's
// state (threads, queue). Prompts are
// queued from that process and the desktop app runs them:
// - a thread the app has loaded picks its queue up by itself (~2 s);
// - an unloaded one needs codex://threads/wake/<id> (harmless when empty).
// Never queue onto a thread the private server has loaded and idle: it would
// run the turn itself, headless. So: create in one session, queue in another.

import { spawn } from "node:child_process";
import readline from "node:readline";
import crypto from "node:crypto";
import { findCodexCli, openUrl } from "./platform.mjs";

export class AppServer {
  static async open({ debug = false } = {}) {
    const bin = findCodexCli();
    if (!bin) throw new Error("ChatGPT Desktop's codex CLI not found (set PEER_BRIDGE_CODEX_BIN)");
    const s = new AppServer(bin, debug);
    await s.rpc("initialize", { clientInfo: { name: "peer-bridge", version: "0.1.0" }, capabilities: { experimentalApi: true } });
    s.notify("initialized");
    return s;
  }

  constructor(bin, debug) {
    this.bin = bin;
    this.seq = 0;
    this.pending = new Map();
    this.listeners = new Set();
    // without our own MCP server: one spawned here would grab the broker and
    // die with this short-lived process
    this.proc = spawn(bin, ["-c", "mcp_servers.peer_bridge.enabled=false", "app-server"], { stdio: ["pipe", "pipe", "pipe"] });
    this.proc.stderr.on("data", (d) => debug && process.stderr.write(d));
    readline.createInterface({ input: this.proc.stdout }).on("line", (line) => {
      let m;
      try {
        m = JSON.parse(line);
      } catch {
        return;
      }
      if (m.id != null && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? reject(new Error(`${m.error.message ?? JSON.stringify(m.error)}`)) : resolve(m.result);
      } else if (m.method) for (const l of this.listeners) l(m);
    });
  }

  rpc(method, params) {
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      this.pending.set(id, { resolve, reject });
      this.proc.stdin.write(JSON.stringify({ id, method, params }) + "\n");
    });
  }

  notify(method, params) {
    this.proc.stdin.write(JSON.stringify({ method, ...(params && { params }) }) + "\n");
  }

  onNotification(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  close() {
    this.proc.stdin.end();
    this.proc.kill();
  }
}

// Fresh session per call, so the private server never holds the thread loaded
async function withServer(fn, opts) {
  const s = await AppServer.open(opts);
  try {
    return await fn(s);
  } finally {
    s.close();
  }
}

// New named thread with a chosen model, without running a model turn
// (`inject_items` is what makes a turn-less thread persist)
// (`effort` is set both as a config override and as a thread setting, so it
// holds whichever the desktop app picks up when it resumes the thread)
export function createThread({ model, effort, cwd, name, seed, sandbox }, opts) {
  return withServer(async (s) => {
    const r = await s.rpc("thread/start", {
      model: model ?? null,
      cwd: cwd ?? process.cwd(),
      sandbox: sandbox ?? null,
      ...(effort && { config: { model_reasoning_effort: effort } }),
    });
    const threadId = r.thread.id;
    if (effort) await s.rpc("thread/settings/update", { threadId, effort });
    const text = seed ?? "This thread is driven by peer-bridge.";
    await s.rpc("thread/inject_items", { threadId, items: [{ type: "message", role: "developer", content: [{ type: "input_text", text }] }] });
    if (name) await s.rpc("thread/name/set", { threadId, name });
    return { threadId, model: r.model };
  }, opts);
}

// Queue a prompt for the desktop app and make sure it picks it up
export async function sendToThread(threadId, prompt, { wake = true, ...opts } = {}) {
  const queued = await withServer(async (s) => {
    const r = await s.rpc("thread/queue/add", { threadId, input: [{ type: "text", text: prompt }], clientUserMessageId: crypto.randomUUID() });
    return r.queuedSubmission.id;
  }, opts);
  if (wake) openUrl(`codex://threads/wake/${threadId}`);
  return { queued };
}

export function listQueue(threadId, opts) {
  return withServer(async (s) => (await s.rpc("thread/queue/list", { threadId })).data, opts);
}

export function clearQueue(threadId, opts) {
  return withServer(async (s) => {
    const items = (await s.rpc("thread/queue/list", { threadId })).data;
    for (const item of items) await s.rpc("thread/queue/delete", { threadId, queuedSubmissionId: item.id });
    return items.length;
  }, opts);
}
