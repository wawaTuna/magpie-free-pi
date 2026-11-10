// Hermetic smoke tests for the vendored free-pi core + this plugin's
// hooks. No network: every upstream call is stubbed. Run: node tests/smoke.mjs
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolate all ~/.free-pi state before the core reads homedir().
process.env.HOME = mkdtempSync(join(tmpdir(), "magpie-free-pi-test-"));
delete process.env.FREEPI_JWT;

const core = await import("../free-pi-core.mjs");
const meRecord = {
  handle: "tester",
  tier: "young",
  allowance_credits: 15000,
  remaining_credits_today: 12000,
  remaining_usd_today: 0.9,
  cap_usd_today: 1.125,
  premium_credits: 0,
  refill_at: "2026-11-10T00:00:00.000Z",
  earn_reward: null,
};
const jsonRes = (status, body) => ({
  status,
  ok: status >= 200 && status < 300,
  json: async () => body,
  text: async () => JSON.stringify(body),
  clone() { return this; },
});

// --- account pool -----------------------------------------------------------
assert.equal(core.loadAccounts().length, 0, "pool starts empty");
core.addAccount({ label: "a", jwt: "jwt-a" });
core.addAccount({ label: "b", jwt: "jwt-b" });
core.addAccount({ label: "a-again", jwt: "jwt-a" }); // dedupe by token
const accounts = core.loadAccounts();
assert.equal(accounts.length, 2, "two accounts after dedupe");
const firsts = new Set(Array.from({ length: 6 }, () => core.pickAccountCandidates()[0]?.jwt));
assert.deepEqual([...firsts].sort(), ["jwt-a", "jwt-b"], "round-robin covers both accounts");
core.markAccountInvalid(accounts.find((x) => x.jwt === "jwt-a").id);
assert.ok(core.pickAccountCandidates().every((x) => x.jwt !== "jwt-a"), "invalid account skipped");

// --- quota ------------------------------------------------------------------
const summary = core.summarizeQuota({ id: "x", label: "x" }, meRecord);
assert.equal(summary.usedCredits, 3000);
assert.equal(summary.remainingCredits, 12000);
const quota = await core.fetchAccountQuota({ id: "q", label: "q", jwt: "jwt-b" }, async () => jsonRes(200, meRecord));
assert.equal(quota.ok, true);
assert.equal(quota.handle, "tester");
const deadQuota = await core.fetchAccountQuota({ id: "q2", label: "q2", jwt: "nope" }, async () => jsonRes(401, {}));
assert.equal(deadQuota.ok, false, "401 quota reads as unauthorized");

// --- rotating fetch failover --------------------------------------------------
const stubFetch = async (_url, init) => {
  const auth = init.headers.authorization || "";
  return auth.includes("jwt-a") ? jsonRes(401, { error: "bad token" }) : jsonRes(200, { ok: true });
};
const rotated = await core.rotatingFetch("/v1/chat/completions", { body: "{}", fetchImpl: stubFetch });
assert.equal(rotated.res.status, 200, "failover lands on the healthy account");
assert.equal(rotated.account.jwt, "jwt-b");

// --- catalogue ----------------------------------------------------------------
const catalog = await core.fetchCatalog(async () =>
  jsonRes(200, { models: [{ id: "deepseek-v4.1-flash", name: "V4.1" }, { id: "gone", name: "Gone", unavailable: true }] }),
);
assert.deepEqual(catalog.map((m) => m.id), ["deepseek-v4.1-flash"], "unavailable models filtered");

// --- package manifest: display name + icon --------------------------------------
import { readFileSync } from "node:fs";
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
assert.equal(pkg.magpie.name, "magpie-free-pi", "Installed row shows magpie-free-pi, not free-pi");
assert.match(pkg.magpie.icon, /^https:\/\/.+\.png$/, "magpie.icon is an https png URL");
assert.ok(pkg.files.includes("assets/icon.png"), "icon file ships in the npm package");

// --- plugin hooks ---------------------------------------------------------------
const plugin = (await import("../index.mjs")).default;
assert.equal(plugin.id, "magpie-free-pi");
const hooks = await plugin.server();
const cfg = {};
await hooks.config(cfg);
assert.equal(cfg.provider["free-pi"].npm, "@ai-sdk/openai-compatible");
assert.deepEqual(hooks.auth.methods.map((m) => m.type), ["oauth", "api"]);
assert.equal(hooks.auth.icon, pkg.magpie.icon, "auth.icon matches magpie.icon so the provider row shows the same icon");
globalThis.fetch = async (url) =>
  String(url).includes("/me") ? jsonRes(200, meRecord) : jsonRes(200, { models: [{ id: "deepseek-v4.1-flash", name: "V4.1" }] });
const usage = await hooks.auth.usage(async () => ({ type: "oauth", access: "jwt-b" }));
assert.equal(usage.windows[0].limit, 15000);
assert.match(usage.windows[0].display, /12000/);
const models = await hooks.provider.models();
assert.ok(models["deepseek-v4.1-flash"], "dynamic catalogue reaches provider.models");

console.log("smoke: all assertions passed");
