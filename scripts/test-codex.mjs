// Model choice for new ChatGPT threads, against a model list shaped like the
// app-server's model/list (the real app is never used).

import assert from "node:assert/strict";
import { pickModel, ModelChoiceError } from "../src/codex.mjs";

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

console.log("codex: all passed");
