// End-to-end test of links and hooks against a throwaway data dir: the broker
// runs in this process, src/hook.mjs runs as a real subprocess with hook JSON
// on stdin, Codex delivery is faked (PEER_BRIDGE_FAKE_CODEX).

import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "peer-bridge-link-"));
Object.assign(process.env, { PEER_BRIDGE_DIR: dir, PEER_BRIDGE_PORT: "7498", PEER_BRIDGE_FAKE_CODEX: "1" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sameTo = (a, b) => !!a && a.app === b.app && a.id === b.id;

// 0. a stale owner (older protocol, e.g. a helper left over from before an
// update) steps down when a newer client calls, and the client takes over
const brokerUrl = new URL("../src/broker.mjs", import.meta.url).href;
const stale = spawn(process.execPath, ["--input-type=module", "-e", `const b=await import(${JSON.stringify(brokerUrl)});await b.call("status");console.log("owner");setInterval(()=>{},1000);`], {
  env: { ...process.env, PEER_BRIDGE_TEST_PROTOCOL: "1" },
});
await new Promise((r) => stale.stdout.once("data", r));
const { call } = await import("../src/broker.mjs");
await call("link_create", { primary: { app: "claude", id: "probe" } }); // op the stale owner wouldn't run new code for
await call("link_close", { endpoint: { app: "claude", id: "probe" } });
stale.kill();
assert.ok(fs.readFileSync(path.join(dir, "events.jsonl"), "utf8").includes('"op":"broker-step-down"'));
console.log("0 stale broker owner stepped down, newer client took over");

const hook = path.resolve(import.meta.dirname, "../src/hook.mjs");
const events = () => fs.readFileSync(path.join(dir, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const state = () => JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8"));
async function until(fn, ms = 4000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out waiting");
    await sleep(50);
  }
}

function runHook(app, event, input, { killAfter } = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const p = spawn(process.execPath, [hook, "--app", app, "--event", event], { env: process.env });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    if (killAfter) setTimeout(() => p.kill(), killAfter);
    p.on("close", (code) => resolve({ code, out, err, ms: Date.now() - t0 }));
    p.stdin.end(JSON.stringify({ hook_event_name: event, cwd: ".", ...input }));
  });
}

const CLAUDE = { app: "claude", id: "claude-session-1" };
const GPT = { app: "openai", id: "gpt-thread-1" };
const CLAUDE2 = { app: "claude", id: "claude-session-2" };

// 1. unlinked chats: hooks exit at once, nothing queued
let r = await runHook("claude", "stop", { session_id: CLAUDE.id, last_assistant_message: "hi" });
assert.equal(r.code, 0);
assert.equal(r.out, "");
r = await runHook("claude", "listen", { session_id: CLAUDE.id });
assert.equal(r.code, 0);
assert.equal(fs.readdirSync(path.join(dir, "outbox")).length, 0);
console.log(`1 unlinked: stop/listen exit 0 at once (${r.ms} ms)`);

// 2. Claude primary, GPT advisor: Stop queues a review, GPT gets it via the thread queue
const link = await call("link_create", { primary: CLAUDE, advisor: GPT });
r = await runHook("claude", "prompt", { session_id: CLAUDE.id, prompt: "Please refactor the parser." });
assert.equal(r.out, "", "no notes yet, so no context output");
r = await runHook("claude", "stop", { session_id: CLAUDE.id, last_assistant_message: "Refactored the parser." });
assert.equal(r.code, 0);
assert.equal(r.out, "", "Stop must not block or print");
assert.ok(r.ms < 1500, `stop hook took ${r.ms} ms`);
const req = await until(() => state().messages.find((m) => m.kind === "review-request"));
assert.deepEqual(req.toEndpoint, GPT);
assert.match(req.text, /Refactored the parser/);
assert.match(req.text, /User's message:\nPlease refactor the parser\./, "review request must carry the user's question");
await until(() => events().find((e) => e.op === "fake-codex-deliver" && e.threadId === GPT.id));
console.log(`2 Claude→GPT review request ${req.id} (question + answer) queued by Stop (${r.ms} ms), delivered to the GPT thread`);

// 3. GPT receives and advises a concern → Claude's listener wakes it (exit 2)
// the thread got the whole request, so there is nothing left to receive
await until(() => state().messages.find((m) => m.id === req.id)?.readAt);
assert.equal((await call("receive", { side: "openai", endpoint: GPT })).messages.length, 0);
const listener = runHook("claude", "listen", { session_id: CLAUDE.id });
await sleep(1500);
const adv = await call("advise", { endpoint: GPT, verdict: "incorrect", severity: "concern", note: "Parser drops the last token." });
assert.equal(adv.delivered, "now");
r = await listener;
assert.equal(r.code, 2, "listener must exit 2 to wake Claude");
assert.match(r.err, /flagged your last turn/);
console.log(`3 concern → Claude listener exited 2: ${r.err.split("\n")[0].slice(0, 90)}…`);

// 4. the follow-up turn the advisory triggered is not sent back for review
const before = state().messages.length;
await call("receive", { side: "claude", endpoint: CLAUDE });
await runHook("claude", "stop", { session_id: CLAUDE.id, last_assistant_message: "Fixed the last token." });
await until(() => events().some((e) => e.op === "turn_end" && e.skipped === "advisory follow-up"));
assert.equal(state().messages.length, before);
console.log("4 advisory follow-up turn not re-reviewed (no cascade)");

// 5. nits wait for the next prompt, once; duplicates are dropped
await runHook("claude", "stop", { session_id: CLAUDE.id, last_assistant_message: "Added tests." });
await until(() => state().messages.length === before + 1);
await call("advise", { endpoint: GPT, verdict: "correct", severity: "nit", note: "Name the test after the bug." });
const dup = await call("advise", { endpoint: GPT, verdict: "correct", severity: "nit", note: "Name the test after the bug." });
assert.ok(dup.dup);
r = await runHook("claude", "prompt", { session_id: CLAUDE.id, prompt: "next" });
const ctx = JSON.parse(r.out).hookSpecificOutput;
assert.equal(ctx.hookEventName, "UserPromptSubmit");
assert.match(ctx.additionalContext, /Name the test after the bug/);
await until(() => state().notes.every((n) => n.deliveredAt));
r = await runHook("claude", "prompt", { session_id: CLAUDE.id, prompt: "again" });
assert.equal(r.out, "");
console.log("5 nit delivered once with the next prompt, duplicate dropped");

// 6. reverse direction: GPT primary, Claude advisor via join code
await call("link_close", { endpoint: CLAUDE });
const l2 = await call("link_create", { primary: GPT });
assert.ok(l2.joinCode);
await call("link_join", { code: l2.joinCode, endpoint: CLAUDE2 });
const advisorListener = runHook("claude", "listen", { session_id: CLAUDE2.id });
await sleep(1200);
await runHook("openai", "prompt", { session_id: GPT.id, turn_id: "t9", prompt: "Write a reversible migration." });
r = await runHook("openai", "stop", { session_id: GPT.id, turn_id: "t9", last_assistant_message: "Wrote the migration." });
assert.equal(r.out, "");
r = await advisorListener;
assert.equal(r.code, 2);
assert.match(r.err, /Review request/);
const gptReq = await until(() => state().messages.find((m) => m.kind === "review-request" && m.linkId === l2.id));
assert.match(gptReq.text, /User's message:\nWrite a reversible migration\./);
await call("advise", { endpoint: CLAUDE2, verdict: "incorrect", severity: "blocker", note: "Migration is not reversible." });
await until(() => events().some((e) => e.op === "fake-codex-deliver" && /flagged your last turn/.test(e.text)));
console.log("6 GPT primary → Claude advisor (join code): listener woke Claude (question + answer), blocker queued back to the GPT thread");

// 6b. a question is only attached to its own turn: other turn id → not
// captured, and it is not reused for the turn after
await call("receive", { side: "claude", endpoint: CLAUDE2 });
await runHook("openai", "stop", { session_id: GPT.id, turn_id: "t10", last_assistant_message: "Applied the fix." }); // advisory follow-up, skipped
await runHook("openai", "prompt", { session_id: GPT.id, turn_id: "t11", prompt: "Old question." });
await runHook("openai", "stop", { session_id: GPT.id, turn_id: "t12", last_assistant_message: "Answer to t12." });
const t12 = await until(() => state().messages.find((m) => m.kind === "review-request" && /Answer to t12/.test(m.text)));
assert.match(t12.text, /User's message:\n\(not captured\)/);
assert.doesNotMatch(t12.text, /Old question/);
await runHook("openai", "stop", { session_id: GPT.id, turn_id: "t13", last_assistant_message: "Answer to t13." });
const t13 = await until(() => state().messages.find((m) => m.kind === "review-request" && /Answer to t13/.test(m.text)));
assert.doesNotMatch(t13.text, /Old question/);
console.log("6b question attached only to its own turn, never reused");

// 7. one listener per session: a newer one supersedes the older
await call("receive", { side: "claude", endpoint: CLAUDE2 });
const older = runHook("claude", "listen", { session_id: CLAUDE2.id });
await sleep(800);
const newer = runHook("claude", "listen", { session_id: CLAUDE2.id }, { killAfter: 3000 });
r = await older;
assert.equal(r.code, 0, "older listener must step aside quietly");
await newer;
console.log("7 newer listener superseded the older one (exit 0, no wake)");

// 8. unlink: listener and hooks go quiet
await call("link_close", { endpoint: GPT });
r = await runHook("claude", "listen", { session_id: CLAUDE2.id });
assert.equal(r.code, 0);
console.log(`8 after unlink the listener exits at once (${r.ms} ms)`);

// 10. a one-off review answer still wakes the requester, although its link
// closes as the answer is posted
{
  const REQ = { app: "claude", id: "claude-requester" };
  const REV = { app: "claude", id: "claude-reviewer" };
  const rl = await call("link_create", { primary: REQ, mode: "review", advisor: REV, request: "Check the parser." });
  const requester = runHook("claude", "listen", { session_id: REQ.id });
  await sleep(1200);
  const got = await call("receive", { side: "claude", endpoint: REV });
  assert.match(got.messages[0].text, /Check the parser/);
  await call("advise", { endpoint: REV, verdict: "correct", severity: "none", note: "" });
  r = await requester;
  assert.equal(r.code, 2);
  assert.match(r.err, /review you asked for is ready/);
  assert.equal(state().links[rl.id].active, false);
  console.log("10 one-off review: answer woke the requester, link closed (even with severity none)");
}

// 11. Claude advisor not listening → the primary is told with its next prompt
{
  const P = { app: "openai", id: "gpt-primary-offline" };
  const A = { app: "claude", id: "claude-advisor-offline" };
  const l = await call("link_create", { primary: P });
  await call("link_join", { code: l.joinCode, endpoint: A });
  await runHook("openai", "stop", { session_id: P.id, turn_id: "x1", last_assistant_message: "done" });
  await until(() => state().notes.some((n) => n.kind === "bridge" && sameTo(n.to, P)));
  r = await runHook("openai", "prompt", { session_id: P.id, turn_id: "x2", prompt: "next" });
  assert.match(JSON.parse(r.out).hookSpecificOutput.additionalContext, /isn't listening/);
  await call("link_close", { linkId: l.id });
  console.log("11 offline Claude advisor reported to the primary with its next prompt");
}

// 12. no message cap; old state is pruned
{
  const P = { app: "claude", id: "claude-bulk" };
  const A = { app: "claude", id: "claude-bulk-advisor" };
  await call("link_create", { primary: P, advisor: A });
  for (let i = 0; i < 250; i++) await call("turn_end", { endpoint: P, turnId: `b${i}`, lastMessage: `turn ${i}` });
  assert.ok(state().messages.filter((m) => sameTo(m.toEndpoint, A)).length >= 250, "250 review requests, no cap");
  // age everything: read a day+ ago, or older than a week
  const s = state();
  for (const m of s.messages) m.ts = Date.now() - 8 * 24 * 3600_000;
  fs.writeFileSync(path.join(dir, "state.json.aged"), JSON.stringify(s));
  console.log(`12 250 review requests accepted (no cap); pruning checked below`);
}

// 16. one chat reviewing for two links at once: the answer goes to the
// request it names, and without a name it's refused instead of guessed
{
  const RV = { app: "claude", id: "claude-busy-reviewer" };
  const A = { app: "claude", id: "claude-requester-a" };
  const B = { app: "claude", id: "claude-requester-b" };
  const la = await call("link_create", { primary: A, mode: "review", advisor: RV, request: "Review A." });
  const lb = await call("link_create", { primary: B, mode: "review", advisor: RV, request: "Review B." });
  const msgs = (await call("receive", { side: "claude", endpoint: RV })).messages;
  const reqA = msgs.find((m) => /Review A/.test(m.text)).id;
  await assert.rejects(call("advise", { endpoint: RV, verdict: "correct", severity: "none", note: "" }), /several review requests are open/);
  await call("advise", { endpoint: RV, requestId: reqA, verdict: "correct", severity: "nit", note: "A is fine." });
  const st = state();
  assert.equal(st.links[la.id].active, false, "A's review closed");
  assert.equal(st.links[lb.id].active, true, "B's review still open");
  assert.ok(st.messages.some((m) => m.kind === "review-result" && sameTo(m.toEndpoint, A) && /A is fine/.test(m.text)));
  assert.ok(!st.messages.some((m) => m.kind === "review-result" && sameTo(m.toEndpoint, B)));
  await call("advise", { endpoint: RV, verdict: "correct", severity: "none", note: "" }); // only B open now
  assert.equal(state().links[lb.id].active, false);
  console.log("16 concurrent reviews: answer routed by request id, ambiguity refused");
}

// 17. pruning never drops unread messages by count
{
  const P = { app: "claude", id: "claude-flood" };
  const A = { app: "claude", id: "claude-flood-advisor" };
  await call("link_create", { primary: P, advisor: A });
  for (let i = 0; i < 600; i++) await call("turn_end", { endpoint: P, turnId: `f${i}`, lastMessage: `turn ${i}` });
  const unread = state().messages.filter((m) => sameTo(m.toEndpoint, A) && !m.readAt).length;
  assert.equal(unread, 600, `all 600 unread review requests kept (got ${unread})`);
  console.log("17 600 unread messages kept; only read ones are capped");
}

// 14. owner dies while idle: a surviving server's keepOwner ping takes over and
// ingests the hook's request (this process stops owning by exiting the child
// test below, so run it on a fresh port + dir)
{
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "peer-bridge-owner-"));
  const env2 = { ...process.env, PEER_BRIDGE_DIR: dir2, PEER_BRIDGE_PORT: "7497" };
  const proc = (code) => spawn(process.execPath, ["--input-type=module", "-e", code], { env: env2 });
  const ownerA = proc(`const b=await import(${JSON.stringify(brokerUrl)});await b.call("link_create",{primary:{app:"claude",id:"S9"},advisor:{app:"claude",id:"A9"}});console.log("ready");setInterval(()=>{},1000);`);
  await new Promise((r) => ownerA.stdout.once("data", r));
  const serverB = proc(`const b=await import(${JSON.stringify(brokerUrl)});await b.call("ping");b.keepOwner(500);console.log("ready");setInterval(()=>{},1000);`);
  await new Promise((r) => serverB.stdout.once("data", r));
  ownerA.kill();
  await sleep(300);
  const t0 = Date.now();
  await new Promise((resolve) => {
    const p = spawn(process.execPath, [hook, "--app", "claude", "--event", "stop"], { env: env2 });
    p.on("close", resolve);
    p.stdin.end(JSON.stringify({ session_id: "S9", last_assistant_message: "x" }));
  });
  const ev = () => fs.readFileSync(path.join(dir2, "events.jsonl"), "utf8");
  const end = Date.now() + 4000;
  while (!ev().includes('"kind":"review-request"') && Date.now() < end) await sleep(50);
  serverB.kill();
  assert.ok(ev().includes('"kind":"review-request"'), "surviving server must take over and ingest");
  console.log(`14 owner died while idle: surviving server took over, request ingested in ${Date.now() - t0} ms`);
}

// 15. a failed ChatGPT delivery reaches the waiting primary, and an owner
// loading week-old state prunes it (fresh broker so the failing fake applies)
{
  const dir3 = fs.mkdtempSync(path.join(os.tmpdir(), "peer-bridge-fail-"));
  fs.copyFileSync(path.join(dir, "state.json.aged"), path.join(dir3, "state.json"));
  const env3 = { ...process.env, PEER_BRIDGE_DIR: dir3, PEER_BRIDGE_PORT: "7495", PEER_BRIDGE_FAKE_CODEX: "fail" };
  const P = { app: "claude", id: "claude-fail" };
  const owner = spawn(process.execPath, ["--input-type=module", "-e",
    `const b=await import(${JSON.stringify(brokerUrl)});await b.call("link_create",{primary:${JSON.stringify(P)},advisor:{app:"openai",id:"gpt-gone"}});console.log("ready");setInterval(()=>{},1000);`], { env: env3 });
  await new Promise((r) => owner.stdout.once("data", r));
  const st3 = () => JSON.parse(fs.readFileSync(path.join(dir3, "state.json"), "utf8"));
  assert.ok(st3().messages.length < 10, `week-old messages pruned (left ${st3().messages.length})`);
  const run3 = (event, input) =>
    new Promise((resolve) => {
      const p = spawn(process.execPath, [hook, "--app", "claude", "--event", event], { env: env3 });
      let out = "";
      p.stdout.on("data", (d) => (out += d));
      p.on("close", () => resolve(out));
      p.stdin.end(JSON.stringify({ session_id: P.id, cwd: ".", ...input }));
    });
  await run3("stop", { last_assistant_message: "x" });
  const end = Date.now() + 4000;
  while (!st3().notes.some((n) => n.kind === "bridge" && sameTo(n.to, P)) && Date.now() < end) await sleep(50);
  const out = await run3("prompt", { prompt: "next" });
  owner.kill();
  assert.match(JSON.parse(out).hookSpecificOutput.additionalContext, /Couldn't hand review-request .* ChatGPT Desktop not reachable/);
  console.log("15 failed delivery shown to the primary with its next prompt; week-old state pruned on load");
}

// 18. a review request handed to a ChatGPT thread counts as read, but stays
// answerable until answered: not pruned after a day, nor by the read cap
{
  const dir4 = fs.mkdtempSync(path.join(os.tmpdir(), "peer-bridge-open-"));
  const P = { app: "claude", id: "claude-slow" };
  const G = { app: "openai", id: "gpt-slow" };
  const old = Date.now() - 2 * 24 * 3600_000;
  const msg = (id, extra) => ({ id, from: "claude", to: "openai", toEndpoint: G, linkId: "L1", text: "x", ts: Date.now(), readAt: Date.now(), dispatch: { state: "sent", at: Date.now() }, ...extra });
  const seeded = {
    seq: 700, linkSeq: 1, notes: [],
    links: { L1: { id: "L1", mode: "advisor", active: true, createdAt: old, primary: P, advisor: G, reviews: 1, advisories: [] } },
    messages: [msg("m1", { kind: "review-request", ts: old, readAt: old }), ...Array.from({ length: 600 }, (_, i) => msg(`m${i + 2}`, { kind: "message" }))],
  };
  try {
    fs.writeFileSync(path.join(dir4, "state.json"), JSON.stringify(seeded));
    const env4 = { ...process.env, PEER_BRIDGE_DIR: dir4, PEER_BRIDGE_PORT: "7494" };
    const out = await new Promise((resolve) => {
      const p = spawn(process.execPath, ["--input-type=module", "-e",
        `const b=await import(${JSON.stringify(brokerUrl)});await b.call("status");` +
        `try{console.log(JSON.stringify(await b.call("advise",{endpoint:${JSON.stringify(G)},requestId:"m1",verdict:"incorrect",severity:"concern",note:"still answerable"})))}catch(e){console.log(JSON.stringify({error:e.message}))}process.exit(0);`], { env: env4 });
      let o = "";
      p.stdout.on("data", (d) => (o += d));
      p.on("close", () => resolve(o));
    });
    const res = JSON.parse(out);
    assert.equal(res.error, undefined, res.error);
    assert.equal(res.delivered, "now");
    const kept = JSON.parse(fs.readFileSync(path.join(dir4, "state.json"), "utf8")).messages.filter((m) => m.kind === "message").length;
    assert.ok(kept <= 500, `read messages still capped (kept ${kept})`);
    console.log("18 a day-old review request already handed to ChatGPT is still answerable; read messages still capped");
  } finally {
    fs.rmSync(dir4, { recursive: true, force: true });
  }
}

console.log("\nhooks log:\n" + fs.readFileSync(path.join(dir, "hooks.jsonl"), "utf8"));
process.exit(0);
