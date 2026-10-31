import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";

// Pure recipes: chrome.ts never imports react-native values, so the bundle
// loads bare in node, the same trick rows.test.ts uses.
const bundle = await build({ entryPoints: [new URL("../client/chrome.ts", import.meta.url).pathname],
  bundle: true, write: false, platform: "node", format: "esm" });
const { glassChrome, taskTone } = (await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0]!.text).toString("base64")}`)) as typeof import("../client/chrome.ts");

const LIGHT = {
  surface0: "#eef1f6", surface1: "#ecf0f6", surface2: "#e6eaf1", border: "#d7dbe3",
  foreground: "#151a23", foregroundMuted: "#646e7e", accent: "#7d8591", accentForeground: "#ffffff",
  statusSuccess: "#209c56", statusWarning: "#ce7c0e", statusDanger: "#da3c2e",
} as const;
const DARK = {
  surface0: "#0f1114", surface1: "#13161b", surface2: "#1b1f26", border: "#252a33",
  foreground: "#f0f2f5", foregroundMuted: "#8a9199", accent: "#8d99a8", accentForeground: "#0f1114",
  statusSuccess: "#7fb26a", statusWarning: "#e9b45a", statusDanger: "#ef7d6b",
} as const;

test("one chassis: the same 9px glass panel for every card", () => {
  const light = glassChrome(LIGHT, "web");
  assert.equal(light.borderRadius, 9);
  assert.equal(light.borderWidth, 0.5);
  assert.match(String(light.boxShadow), /inset 0 1px 0/);
});

test("gradients are spelled per platform — Fabric drops the web property silently", () => {
  const web = glassChrome(LIGHT, "web") as Record<string, unknown>;
  assert.ok(typeof web.backgroundImage === "string" && web.backgroundImage.includes("linear-gradient"));
  assert.ok(!("experimental_backgroundImage" in web));
  const ios = glassChrome(LIGHT, "ios") as Record<string, unknown>;
  assert.ok(typeof ios.experimental_backgroundImage === "string" && ios.experimental_backgroundImage.includes("linear-gradient"));
  assert.ok(!("backgroundImage" in ios));
});

test("a tone adds exactly one corner wash; untoned glass stays plain", () => {
  const plain = glassChrome(LIGHT, "web") as Record<string, unknown>;
  assert.ok(!String(plain.backgroundImage).includes("radial-gradient"));
  const toned = glassChrome(LIGHT, "web", "ok") as Record<string, unknown>;
  assert.match(String(toned.backgroundImage), /^radial-gradient\([^)]*rgba\(32,156,86,/);
  const darkToned = glassChrome(DARK, "ios", "bad") as Record<string, unknown>;
  assert.match(String(darkToned.experimental_backgroundImage), /^radial-gradient\([^)]*rgba\(239,125,107,/);
});

test("taskTone maps states and wait outcomes to the four tones", () => {
  assert.equal(taskTone({ state: "running" }), "run");
  assert.equal(taskTone({ state: "completed", exitCode: 0 }), "ok");
  assert.equal(taskTone({ state: "failed" }), "bad");
  assert.equal(taskTone({ state: "completed", exitCode: 2 }), "bad");
  assert.equal(taskTone({ state: "running" }, "timeout"), "run");
  assert.equal(taskTone({ state: "running" }, "interrupted"), "neutral");
});
