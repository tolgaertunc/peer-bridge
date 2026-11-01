// Model choice for new ChatGPT threads, against a model list shaped like the
// app-server's model/list (the real app is never used).

import assert from "node:assert/strict";
import { pickModel, createThreadOn, ModelChoiceError } from "../src/codex.mjs";

const efforts = (...e) => e.map((reasoningEffort) => ({ reasoningEffort }));
const MODELS = [
  { id: "gpt-6.1-sol", model: "gpt-6.1-sol", displayName: "GPT-6.1-Sol", hidden: false, supportedReasoningEfforts: efforts("low", "medium", "high", "ultra") },
  { id: "gpt-6-astra", model: "gpt-6-astra", displayName: "GPT-6-Astra", hidden: false, supportedReasoningEfforts: efforts("low", "medium", "high", "ultra") },
  { id: "gpt-6.1-terra", model: "gpt-6.1-terra", displayName: "GPT-6.1 Terra", hidden: false, supportedReasoningEfforts: efforts("low", "medium", "high") },
  { id: "gpt-6-luna", model: "gpt-6-luna", displayName: "GPT-6-Luna", hidden: false, supportedReasoningEfforts: efforts("low", "medium", "high") },
  { id: "gpt-reserve", model: "gpt-reserve", displayName: "GPT-Reserve", hidden: true, supportedReasoningEfforts: efforts("medium") },
];
const refused = (fn, re) => assert.throws(fn, (e) => e instanceof ModelChoiceError && re.test(e.message));

// 1 a listed id is used as is
assert.equal(pickModel(MODELS, "gpt-6-astra"), "gpt-6-astra");
assert.equal(pickModel(MODELS, "gpt-6-luna", "high"), "gpt-6-luna");
console.log("codex 1 listed id: used as is");

// 2 the name the picker shows resolves to the id, in any case or spacing
assert.equal(pickModel(MODELS, "GPT-6-Astra"), "gpt-6-astra");
assert.equal(pickModel(MODELS, "gpt-6.1 terra"), "gpt-6.1-terra");
assert.equal(pickModel(MODELS, " GPT-6.1 Terra "), "gpt-6.1-terra");
console.log("codex 2 display name: resolves to the id");

// 3 a model the app doesn't have is refused with the visible list, so the
// agent can pick a real one (the reported case: 6.1 Astra doesn't exist)
refused(() => pickModel(MODELS, "gpt-6.1-astra"), /no model "gpt-6\.1-astra"/);
refused(() => pickModel(MODELS, "gpt-6.1-astra"), /gpt-6-astra \(GPT-6-Astra\)/);
refused(() => pickModel(MODELS, "gpt-6.1-astra"), /^(?![\s\S]*gpt-reserve)/);
console.log("codex 3 unknown model: refused with the visible list");

// 4 a hidden model still works when named exactly
assert.equal(pickModel(MODELS, "gpt-reserve", "medium"), "gpt-reserve");
console.log("codex 4 hidden model: works when named");

// 5 an effort the model doesn't offer is refused with its efforts
refused(() => pickModel(MODELS, "gpt-6-luna", "ultra"), /gpt-6-luna has no effort "ultra"\. Its efforts: low, medium, high/);
assert.equal(pickModel(MODELS, "gpt-6.1-sol", "ultra"), "gpt-6.1-sol");
console.log("codex 5 unsupported effort: refused with the model's efforts");

// 6 no list (an app version without model/list) or no model: unchecked
assert.equal(pickModel(null, "anything", "ultra"), "anything");
assert.equal(pickModel(MODELS, undefined, "ultra"), undefined);
console.log("codex 6 no list or no model: passed through unchecked");

// A stand-in app-server session: model/list answers from `pages` (an Error
// is thrown as the server's error), and every call is recorded
function server(...pages) {
  const calls = [];
  return {
    calls,
    started: () => calls.filter((c) => c.method === "thread/start"),
    async rpc(method, params) {
      calls.push({ method, params });
      if (method === "model/list") {
        const page = pages.shift();
        if (page instanceof Error) throw page;
        return page;
      }
      if (method === "thread/start") return { thread: { id: "T1" }, model: params.model ?? "gpt-6.1-sol" };
      return {};
    },
  };
}
const rpcError = (code, message) => Object.assign(new Error(message), { code });
const create = (s, args) => createThreadOn(s, { name: "x", seed: "y", sandbox: "read-only", ...args });

// 7 through the session: a picker name starts the thread with the id; an
// unknown one starts nothing
{
  const s = server({ data: MODELS, nextCursor: null });
  assert.equal((await create(s, { model: "GPT-6-Astra" })).model, "gpt-6-astra");
  assert.equal(s.started()[0].params.model, "gpt-6-astra");
  const bad = server({ data: MODELS, nextCursor: null });
  await assert.rejects(create(bad, { model: "gpt-6.1-astra" }), ModelChoiceError);
  assert.equal(bad.started().length, 0);
  console.log("codex 7 session: resolved id started, unknown model starts nothing");
}

// 8 a failing model list stops the thread instead of skipping the check
{
  for (const [what, s] of [
    ["catalog error", server(rpcError(-32603, "catalog temporarily unavailable"))],
    ["malformed answer", server({ models: MODELS })],
    ["failed later page", server({ data: MODELS.slice(0, 2), nextCursor: "c2" }, rpcError(-32600, "invalid cursor: c2"))],
    ["unsupported error on a later page", server({ data: MODELS.slice(0, 2), nextCursor: "c2" }, rpcError(-32601, "method not found"))],
  ]) {
    await assert.rejects(create(s, { model: "gpt-6.1-astra" }), (e) => e instanceof ModelChoiceError && /model list couldn't be read/.test(e.message), what);
    assert.equal(s.started().length, 0, `${what}: no thread`);
  }
  console.log("codex 8 failing model list: nothing created (error, malformed, later page)");
}

// 9 an app version without model/list (as measured, and JSON-RPC's own code):
// the thread is made unchecked, as before
{
  for (const err of [rpcError(-32600, "Invalid request: unknown variant `model/list`, expected one of `initialize`"), rpcError(-32601, "Method not found")]) {
    const s = server(err);
    assert.equal((await create(s, { model: "gpt-6.1-astra" })).threadId, "T1");
    assert.equal(s.started()[0].params.model, "gpt-6.1-astra");
  }
  console.log("codex 9 no model/list in this app: thread made unchecked");
}

// 10 no model asked for: the list isn't read at all
{
  const s = server(rpcError(-32603, "should not be called"));
  await create(s, { effort: "high" });
  assert.ok(!s.calls.some((c) => c.method === "model/list"));
  console.log("codex 10 no model: list not read");
}

console.log("codex: all passed");
