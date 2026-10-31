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
const { call, inlineText, nextStep } = await import("../src/broker.mjs");
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
const adv = await call("advise", { endpoint: GPT, requestId: req.id, decision: "changes_requested", blocking: [{ title: "Parser drops the last token." }] });
assert.equal(adv.delivered, "now");
r = await listener;
assert.equal(r.code, 2, "listener must exit 2 to wake Claude");
assert.match(r.err, /flagged your last turn/);
console.log(`3 concern → Claude listener exited 2: ${r.err.split("\n")[0].slice(0, 90)}…`);

// 4. the fix loop: the turn after an advisory is reviewed again
const before = state().messages.length;
await call("receive", { side: "claude", endpoint: CLAUDE });
await runHook("claude", "stop", { session_id: CLAUDE.id, last_assistant_message: "Fixed the last token." });
const again = await until(() => state().messages.length === before + 1 && state().messages.at(-1));
assert.equal(again.kind, "review-request");
assert.match(again.text, /Fixed the last token/);
console.log("4 the turn after an advisory is reviewed again (fix loop)");

// 5. approval with nits: they wait for the next prompt, once; the same nits
// again are dropped
await call("advise", { endpoint: GPT, requestId: again.id, decision: "approved", nits: [{ title: "Name the test after the bug." }] });
await runHook("claude", "stop", { session_id: CLAUDE.id, last_assistant_message: "Added tests." });
const third = await until(() => state().messages.length === before + 2 && state().messages.at(-1));
const dup = await call("advise", { endpoint: GPT, requestId: third.id, decision: "approved", nits: [{ title: "Name the test after the bug." }] });
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
await call("advise", { endpoint: CLAUDE2, requestId: gptReq.id, decision: "changes_requested", blocking: [{ title: "Migration is not reversible." }] });
await until(() => events().some((e) => e.op === "fake-codex-deliver" && /flagged your last turn/.test(e.text)));
console.log("6 GPT primary → Claude advisor (join code): listener woke Claude (question + answer), changes requested queued back to the GPT thread");

// 6b. a question is only attached to its own turn: other turn id → not
// captured, and it is not reused for the turn after
await call("receive", { side: "claude", endpoint: CLAUDE2 });
await runHook("openai", "stop", { session_id: GPT.id, turn_id: "t10", last_assistant_message: "Applied the fix." }); // reviewed again (fix loop)
await runHook("openai", "prompt", { session_id: GPT.id, turn_id: "t11", prompt: "Old question." });
await runHook("openai", "stop", { session_id: GPT.id, turn_id: "t12", last_assistant_message: "Answer to t12." });
const t12 = await until(() => state().messages.find((m) => m.kind === "review-request" && /Primary's final message:\nAnswer to t12/.test(m.text)));
assert.match(t12.text, /User's message:\n\(not captured\)/);
const question = (m) => m.text.split("Primary's final message")[0]; // not the diff, which may quote this file
assert.doesNotMatch(question(t12), /Old question/);
await runHook("openai", "stop", { session_id: GPT.id, turn_id: "t13", last_assistant_message: "Answer to t13." });
const t13 = await until(() => state().messages.find((m) => m.kind === "review-request" && /Primary's final message:\nAnswer to t13/.test(m.text)));
assert.doesNotMatch(question(t13), /Old question/);
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
  await call("advise", { endpoint: REV, requestId: got.messages[0].id, decision: "approved" });
  r = await requester;
  assert.equal(r.code, 2);
  assert.match(r.err, /review you asked for is ready/);
  assert.equal(state().links[rl.id].active, false);
  console.log("10 one-off review: answer woke the requester, link closed (also when simply approved)");
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
  const reqB = msgs.find((m) => /Review B/.test(m.text)).id;
  await assert.rejects(call("advise", { endpoint: RV, decision: "approved" }), /request_id is required/);
  await call("advise", { endpoint: RV, requestId: reqA, decision: "approved", nits: [{ title: "A is fine." }] });
  const st = state();
  assert.equal(st.links[la.id].active, false, "A's review closed");
  assert.equal(st.links[lb.id].active, true, "B's review still open");
  assert.ok(st.messages.some((m) => m.kind === "review-result" && sameTo(m.toEndpoint, A) && /A is fine/.test(m.text)));
  assert.ok(!st.messages.some((m) => m.kind === "review-result" && sameTo(m.toEndpoint, B)));
  await call("advise", { endpoint: RV, requestId: reqB, decision: "approved" });
  assert.equal(state().links[lb.id].active, false);
  console.log("16 concurrent reviews: answer routed by request id, which is required");
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
        `try{console.log(JSON.stringify(await b.call("advise",{endpoint:${JSON.stringify(G)},requestId:"m1",decision:"changes_requested",blocking:[{title:"still answerable"}]})))}catch(e){console.log(JSON.stringify({error:e.message}))}process.exit(0);`], { env: env4 });
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

// 19. answers: one format, contradictions refused
{
  const RQ = { app: "claude", id: "claude-format" };
  const RV = { app: "claude", id: "claude-format-reviewer" };
  const l = await call("link_create", { primary: RQ, mode: "review", advisor: RV, request: "Check." });
  const id = state().messages.find((m) => m.linkId === l.id).id;
  await assert.rejects(call("advise", { endpoint: RV, requestId: id, decision: "approved", blocking: [{ title: "x" }] }), /an approval can't have must-fix items/);
  await assert.rejects(call("advise", { endpoint: RV, requestId: id, decision: "changes_requested", nits: [{ title: "x" }] }), /needs at least one must-fix item/);
  const a = await call("advise", { endpoint: RV, requestId: id, decision: "changes_requested", note: "Close.", blocking: [{ title: "Off by one", file: "a.js", line: 3, detail: "loop ends early" }], nits: [{ title: "Rename i" }] });
  assert.equal(a.text, "[CHANGES REQUESTED]\n\nClose.\n\nMust fix:\n- Off by one (a.js:3): loop ends early\n\nNits (optional, don't block approval):\n- Rename i");
  console.log("19 answers start with [APPROVED]/[CHANGES REQUESTED], nits apart; contradictions refused");
}

// 20. review rounds: the next round goes to the same reviewer with the same
// kind; one continuation per round; none after approval, for someone else's
// review, or past the cap
{
  process.env.PEER_BRIDGE_MAX_ROUNDS = "3";
  const RQ = { app: "claude", id: "claude-rounds" };
  const RV = { app: "openai", id: "gpt-rounds" };
  const answer = async (linkId, decision) => {
    const id = state().messages.find((m) => m.kind === "review-request" && m.linkId === linkId).id;
    return call("advise", { endpoint: RV, requestId: id, decision, ...(decision === "changes_requested" && { blocking: [{ title: "fix it" }] }) });
  };
  const l1 = await call("link_create", { primary: RQ, mode: "review", advisor: RV, request: "Plan: do it", plan: true });
  await assert.rejects(call("link_continue", { primary: RQ, roundOf: l1.id, request: "early" }), /still waiting for its answer/);
  await answer(l1.id, "changes_requested");
  const res1 = state().messages.find((m) => m.kind === "review-result" && m.linkId === l1.id);
  assert.match(inlineText(res1), new RegExp(`bridge_review\\(round_of="${l1.id}"\\)`));
  await assert.rejects(call("link_continue", { primary: { app: "claude", id: "someone-else" }, roundOf: l1.id, request: "x" }), /not a review this chat asked for/);
  await assert.rejects(call("link_continue", { primary: RQ, roundOf: l1.id, request: "x", plan: false }), /was a plan review/);
  await assert.rejects(call("link_continue", { primary: RQ, roundOf: l1.id, request: "x", threadId: "gpt-other" }), /reviewed in another chat/);
  const l2 = await call("link_continue", { primary: RQ, roundOf: l1.id, request: "Changed X; I disagree on Y because Z." });
  assert.equal(l2.round, 2);
  await assert.rejects(call("link_continue", { primary: RQ, roundOf: l1.id, request: "again" }), /already continued by/);
  const req2 = state().messages.find((m) => m.kind === "review-request" && m.linkId === l2.id);
  assert.deepEqual(req2.toEndpoint, RV);
  assert.ok(req2.plan, "a plan review stays a plan review");
  assert.match(req2.text, new RegExp(`^Round 2 of review ${l1.id}`));
  await answer(l2.id, "changes_requested");
  const l3 = await call("link_continue", { primary: RQ, roundOf: l2.id, request: "Round 3." });
  await answer(l3.id, "changes_requested");
  const res3 = state().messages.find((m) => m.kind === "review-result" && m.linkId === l3.id);
  assert.match(nextStep(res3), /last round allowed: stop and ask the user/);
  assert.match(nextStep(res3), /wait for the user's explicit approval/, "the plan gate stays");
  await assert.rejects(call("link_continue", { primary: RQ, roundOf: l3.id, request: "Round 4." }), /3 rounds without approval: stop and ask the user/);
  const k1 = await call("link_create", { primary: RQ, mode: "review", advisor: RV, request: "Code." });
  await answer(k1.id, "approved");
  await assert.rejects(call("link_continue", { primary: RQ, roundOf: k1.id, request: "more" }), /was approved; there is nothing to re-review/);
  delete process.env.PEER_BRIDGE_MAX_ROUNDS;
  console.log("20 review rounds: same reviewer and kind, round header, one continuation per round, refused after approval, for others, past the cap");
}

// 21. advisor fix loop: a prompt the bridge delivered doesn't reset the count,
// a real user prompt does; at the cap the primary is told once to stop and
// ask the user, and isn't reviewed until the user writes; answers to requests
// from before the user's latest prompt don't steer
{
  process.env.PEER_BRIDGE_MAX_ROUNDS = "2";
  const P = { app: "openai", id: "gpt-loop" };
  const A = { app: "claude", id: "claude-loop-advisor" };
  const l = await call("link_create", { primary: P, advisor: A });
  const openReq = () => until(() => state().messages.find((m) => m.kind === "review-request" && m.linkId === l.id && !m.answeredAt));
  const reject = async () => call("advise", { endpoint: A, requestId: (await openReq()).id, decision: "changes_requested", blocking: [{ title: "still wrong" }] });
  const stopTurn = (t) => runHook("openai", "stop", { session_id: P.id, turn_id: t, last_assistant_message: `turn ${t}` });
  const prompt = (t, text) => runHook("openai", "prompt", { session_id: P.id, turn_id: t, prompt: text });
  await prompt("u1", "Build it.");
  await stopTurn("u1");
  const adv1 = await reject();
  assert.equal(adv1.delivered, "now");
  // the advisory comes back as a queued prompt: the bridge's, not the user's
  const advisory = state().messages.find((m) => m.id === adv1.id);
  await prompt("b1", inlineText(advisory));
  await stopTurn("b1");
  const adv2 = await reject();
  assert.ok(adv2.stopped, "second rejection in a row hits the cap of 2");
  const stopMsg = state().messages.find((m) => m.id === adv2.id);
  assert.equal(stopMsg.kind, "stop");
  assert.match(inlineText(stopMsg), /Stop the fix loop now: tell the user where it stands and ask how to proceed/);
  assert.ok(state().links[l.id].stopped, "kept in state.json, so a broker restart keeps it");
  await prompt("b2", inlineText(stopMsg));
  await stopTurn("b2");
  await until(() => events().some((e) => e.op === "turn_end" && e.link === l.id && e.skipped === "stopped"));
  // a user typing a look-alike header is still the user
  await prompt("u2", "CODEX: Message m99999 (link L99999) please go on");
  await until(() => !state().links[l.id].stopped && state().links[l.id].rounds === 0); // a real user prompt lifts the stop
  await stopTurn("u2");
  const pending = await openReq();
  await prompt("u3", "Actually, do something else.");
  await until(() => state().links[l.id].generation > pending.generation);
  const late = await call("advise", { endpoint: A, requestId: pending.id, decision: "changes_requested", blocking: [{ title: "old" }] });
  assert.ok(late.stale && late.delivered === "none", "an answer from before the user's latest prompt doesn't steer");
  delete process.env.PEER_BRIDGE_MAX_ROUNDS;
  console.log("21 advisor loop: bridge prompts don't reset, user prompts do; stop at the cap, no reviews until the user writes; stale answers ignored");
}

// 22. telling the bridge's prompts from the user's: exact text, once per
// delivery, so the same text again is the user's; a delivery still being sent
// already counts, and "sending" is on disk before the thread can run it
{
  const P = { app: "openai", id: "gpt-detect" };
  const A = { app: "claude", id: "claude-detect-advisor" };
  const l = await call("link_create", { primary: P, advisor: A });
  const gen = () => state().links[l.id].generation;
  await call("turn_start", { endpoint: P, prompt: "Start." });
  assert.equal(gen(), 1);
  await call("turn_end", { endpoint: P, lastMessage: "done" });
  const req = state().messages.find((m) => m.kind === "review-request" && m.linkId === l.id);
  process.env.PEER_BRIDGE_FAKE_CODEX = "slow";
  const adv = await call("advise", { endpoint: A, requestId: req.id, decision: "changes_requested", blocking: [{ title: "no" }] });
  const msg = () => state().messages.find((m) => m.id === adv.id);
  assert.equal(msg().dispatch.state, "sending", "sending is saved before the delivery is handed over");
  const delivered = inlineText(msg());
  assert.ok((await call("turn_start", { endpoint: P, turnId: "b1", prompt: delivered })).fromBridge, "a delivery still being sent already counts as the bridge's");
  assert.equal(gen(), 1);
  assert.ok(!(await call("turn_start", { endpoint: P, turnId: "u2", prompt: delivered })).fromBridge, "the same text in a later turn is the user's");
  assert.equal(gen(), 2);
  assert.ok(!(await call("turn_start", { endpoint: P, turnId: "u3", prompt: delivered.split("\n")[0] })).fromBridge, "a header alone is the user's");
  await until(() => msg().dispatch.state === "sent");
  process.env.PEER_BRIDGE_FAKE_CODEX = "1";
  for (const bad of ["oops", "Infinity", "0", "-3", "2.5"]) {
    process.env.PEER_BRIDGE_MAX_ROUNDS = bad;
    const RQ = { app: "claude", id: `claude-cap-${bad}` };
    const prev = await call("link_create", { primary: RQ, mode: "review", advisor: A, request: "x" });
    const id = state().messages.find((m) => m.linkId === prev.id).id;
    await call("advise", { endpoint: A, requestId: id, decision: "changes_requested", blocking: [{ title: "x" }] });
    assert.equal((await call("link_continue", { primary: RQ, roundOf: prev.id, request: "y" })).round, 2, `cap "${bad}" falls back to 20`);
  }
  delete process.env.PEER_BRIDGE_MAX_ROUNDS;
  console.log("22 bridge prompts: exact text, once per delivery, counted while still sending; a bad cap falls back to 20");
}

// 23. an owner that takes over doesn't resend a delivery whose turn already
// ran: it was stuck in "sending", but its prompt was matched
{
  const dir5 = fs.mkdtempSync(path.join(os.tmpdir(), "peer-bridge-resend-"));
  try {
    const P = { app: "openai", id: "gpt-resend" };
    const old = Date.now() - 5 * 60_000;
    const m = (id, extra) => ({ id, from: "claude", to: "openai", toEndpoint: P, kind: "advisory", linkId: "L1", text: "x", ts: old, readAt: null, ...extra });
    fs.writeFileSync(
      path.join(dir5, "state.json"),
      JSON.stringify({
        seq: 3, linkSeq: 1, notes: [],
        links: { L1: { id: "L1", mode: "advisor", active: true, createdAt: old, primary: P, advisor: { app: "claude", id: "c" }, reviews: 1, advisories: [] } },
        messages: [m("m1", { dispatch: { state: "sending", at: old }, promptMatched: old }), m("m2", { dispatch: { state: "sending", at: old } })],
      }),
    );
    const env5 = { ...process.env, PEER_BRIDGE_DIR: dir5, PEER_BRIDGE_PORT: "7493", PEER_BRIDGE_FAKE_CODEX: "1" };
    await new Promise((resolve) => {
      const p = spawn(process.execPath, ["--input-type=module", "-e", `const b=await import(${JSON.stringify(brokerUrl)});await b.call("status");setTimeout(()=>process.exit(0),300);`], { env: env5 });
      p.on("close", resolve);
    });
    const st5 = JSON.parse(fs.readFileSync(path.join(dir5, "state.json"), "utf8"));
    const ev5 = fs.readFileSync(path.join(dir5, "events.jsonl"), "utf8");
    assert.equal(st5.messages.find((x) => x.id === "m1").dispatch.state, "sent");
    assert.ok(!/"op":"fake-codex-deliver"[^\n]*"text":"CLAUDE: Your advisor flagged your last turn: m1 /.test(ev5), "a matched delivery isn't sent again");
    assert.match(ev5, /"op":"fake-codex-deliver"[^\n]*m2 \(link L1\)/, "an unmatched stuck one is retried");
    console.log("23 a stuck delivery whose turn already ran isn't resent; an unmatched one is retried");
  } finally {
    fs.rmSync(dir5, { recursive: true, force: true });
  }
}

console.log("\nhooks log:\n" + fs.readFileSync(path.join(dir, "hooks.jsonl"), "utf8"));
process.exit(0);
