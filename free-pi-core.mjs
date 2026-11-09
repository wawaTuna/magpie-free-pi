// free-pi-core — shared reverse-proxy core for dsh-free-pi and magpie-free-pi.
//
// free-pi (freepi.ai) is an ad-funded terminal coding agent. Its backend is a
// plain OpenAI-compatible endpoint, but it is gated by three things a normal
// OpenAI client does not send:
//   1. Authorization: Bearer <JWT>   — a 90-day JWT issued after a GitHub
//      device-flow sign-in (stored by free-pi-cli in
//      ~/.free-pi/agent/credentials.json as {"token": "..."}).
//   2. x-session-id: <session id>    — the session/lease key the ad-funded
//      allowance is accounted against.
//   3. x-client-version: <version>  — the server hard-blocks clients below a
//      minimum CLI version (checked live against /client-version).
//
// This module is the single owner of those facts for both plugins:
// JWT loading, the persistent per-install session id, the live model
// catalogue (GET /client-version is unauthenticated), header injection, the
// device-flow login, and a standalone loopback proxy server that exposes
// free-pi as a vanilla OpenAI endpoint (including the /v1/models route the
// upstream does not provide).
//
// Plain Node >= 18, no dependencies. Vendored verbatim into both plugin
// packages by scripts/sync-core.mjs — edit the copy in core/, not the copies.

import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const FREEPI_BASE_URL = (process.env.FREEPI_BASE_URL || "https://api.freepi.ai").replace(/\/+$/, "");
// Sent as x-client-version. Must stay >= the server's `min` (0.6.2 when last
// checked, 2026-11-09) or completions are refused by the forced-update gate.
export const FREEPI_CLIENT_VERSION = "0.6.15";
// free-pi's current consent version (free-pi-cli src/consent.ts). The login
// flow records this version server-side before polling for the token.
export const FREEPI_CONSENT_VERSION = "4";
export const FREEPI_PROVIDER_ID = "free-pi";

// Offline floor: the catalogue snapshot from GET /client-version on
// 2026-11-09. Used only until the first live catalogue fetch lands; models
// flagged unavailable server-side are excluded.
export const FALLBACK_MODELS = [
  { id: "particle", name: "Particle · Free Unlimited: limited time" },
  { id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash · Free Unlimited: limited time" },
  { id: "glm-5.3-flash", name: "GLM 5.3 Flash · Free Unlimited: limited time" },
  { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash · Free Unlimited: limited time" },
  { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro · ~18x usage" },
  { id: "gpt-6-luna", name: "GPT-6 Luna · ~2.0x usage" },
  { id: "kimi-k3.1-pro", name: "Kimi K3.1 Pro · daily limit · ~41x usage" },
  { id: "mimo-v2.6-flash", name: "MiMo V2.6 Flash (Xiaomi) · ~2.8x usage" },
  { id: "solar-pro-4", name: "Solar Pro 4 · ~0.6x usage" },
];

export function freePiDir() {
  return join(homedir(), ".free-pi", "agent");
}

export function credentialsPath() {
  return join(freePiDir(), "credentials.json");
}

/**
 * Resolve the free-pi JWT, in priority order:
 *   1. an explicit value passed by the caller (plugin config),
 *   2. the FREEPI_JWT environment variable,
 *   3. ~/.free-pi/agent/credentials.json ({"token": "..."} — the file
 *      free-pi-cli itself writes, so logging in with the official CLI or
 *      with core/login.mjs both count),
 *   4. ~/.free-pi/agent/auth.json / credentials file holding {"access": ...}.
 * Read fresh on every call so a re-login takes effect without a restart.
 * Returns undefined when not signed in. Never logs the value.
 */
export function loadJwt(explicit) {
  if (typeof explicit === "string" && explicit.trim()) return explicit.trim();
  const env = process.env.FREEPI_JWT?.trim();
  if (env) return env;
  for (const file of [credentialsPath(), join(freePiDir(), "auth.json")]) {
    try {
      if (!existsSync(file)) continue;
      const parsed = JSON.parse(readFileSync(file, "utf8"));
      const token = parsed?.token || parsed?.access || parsed?.jwt;
      if (typeof token === "string" && token.trim()) return token.trim();
    } catch {
      // A malformed credentials file is the same as no credentials here;
      // the login script is the place that reports it.
    }
  }
  return undefined;
}

export function saveJwt(token) {
  const dir = freePiDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(credentialsPath(), JSON.stringify({ token }) + "\n", { mode: 0o600 });
}

/**
 * One stable session id per install, persisted in
 * ~/.free-pi/agent/session-id. free-pi-cli uses one id per terminal session;
 * a proxy has no terminal sessions, so a per-install id is the closest
 * honest equivalent — it keeps the allowance accounting on one lease
 * instead of minting a new "session" per request.
 */
export function getSessionId() {
  const file = join(freePiDir(), "session-id");
  try {
    if (existsSync(file)) {
      const existing = readFileSync(file, "utf8").trim();
      if (existing) return existing;
    }
  } catch { /* fall through and mint */ }
  const id = randomUUID();
  try {
    mkdirSync(freePiDir(), { recursive: true });
    writeFileSync(file, id + "\n", { mode: 0o600 });
  } catch { /* in-memory id still works for this process */ }
  return id;
}

/** Headers every upstream free-pi request must carry. */
export function upstreamHeaders({ jwt, sessionId, extra } = {}) {
  const headers = {
    "x-session-id": sessionId || getSessionId(),
    "x-client-version": FREEPI_CLIENT_VERSION,
    ...extra,
  };
  if (jwt) headers.authorization = `Bearer ${jwt}`;
  return headers;
}

let catalogCache = { at: 0, models: null };

/**
 * The live model catalogue. GET /client-version needs no auth and returns
 * { models: [{id, name, unavailable?, section?, stats_id?}] }.
 * Unavailable models are dropped; on any failure the last good list (or the
 * built-in snapshot) is returned instead of throwing.
 */
export async function fetchCatalog(fetchImpl = fetch, { maxAgeMs = 5 * 60 * 1000 } = {}) {
  const now = Date.now();
  if (catalogCache.models && now - catalogCache.at < maxAgeMs) return catalogCache.models;
  try {
    const res = await fetchImpl(new URL("/client-version", FREEPI_BASE_URL), {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    const models = (body?.models ?? [])
      .filter((m) => m && typeof m.id === "string" && !m.unavailable)
      .map((m) => ({ id: m.id, name: typeof m.name === "string" ? m.name : m.id, section: m.section }));
    if (models.length) {
      catalogCache = { at: now, models };
      return models;
    }
    throw new Error("empty catalogue");
  } catch {
    return catalogCache.models ?? FALLBACK_MODELS;
  }
}

/** OpenAI-shaped model records (for /v1/models and provider declarations). */
export async function openAiModels(fetchImpl = fetch) {
  const models = await fetchCatalog(fetchImpl);
  return models.map((m) => ({ id: m.id, object: "model", owned_by: FREEPI_PROVIDER_ID, name: m.name }));
}

// ---------------------------------------------------------------------------
// GitHub device-flow login (mirrors free-pi-cli src/auth-flow.ts):
//   POST /auth/github/device {}            -> { session_id, user_code,
//                                              verification_uri, interval? }
//   POST /auth/consent {session_id, consent_version}
//   POST /auth/token   {session_id}        -> poll until { token }
// The consent call records that the user accepted free-pi's terms (ads +
// training on sessions) on this machine before the token is issued.
// ---------------------------------------------------------------------------

async function postJson(path, body) {
  const res = await fetch(new URL(path, FREEPI_BASE_URL), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  return res;
}

export async function startDeviceFlow() {
  const res = await postJson("/auth/github/device", {});
  if (!res.ok) throw new Error(`device flow start failed: HTTP ${res.status}`);
  const body = await res.json();
  return {
    sessionId: body.session_id || body.sessionId || body.device_code,
    userCode: body.user_code || body.userCode,
    verificationUri: body.verification_uri || body.verification_url || body.verificationUri,
    interval: typeof body.interval === "number" ? body.interval : 5,
    raw: body,
  };
}

export async function submitConsent(sessionId) {
  const res = await postJson("/auth/consent", {
    session_id: sessionId,
    consent_version: FREEPI_CONSENT_VERSION,
  });
  if (!res.ok) throw new Error(`consent submission failed: HTTP ${res.status}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function pollForToken(sessionId, intervalSec = 5, { timeoutMs = 15 * 60 * 1000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let failures = 0;
  for (;;) {
    if (Date.now() > deadline) throw new Error("device flow timed out waiting for GitHub authorization");
    let res;
    try {
      res = await postJson("/auth/token", { session_id: sessionId });
      failures = 0;
    } catch (err) {
      if (++failures >= 6) throw new Error(`token poll network failure: ${err?.message ?? err}`);
      await sleep(Math.max(intervalSec, 5) * 1000);
      continue;
    }
    if (res.status === 403) {
      const body = await res.json().catch(() => undefined);
      if (body?.code === "consent_required") throw new Error("consent_required: server did not record consent");
    }
    if (!res.ok) throw new Error(`token poll failed: HTTP ${res.status}`);
    const body = await res.json().catch(() => ({}));
    if (typeof body?.token === "string" && body.token) return body.token;
    const retryAfter = typeof body?.retry_after === "number" ? body.retry_after : 0;
    await sleep(Math.max(intervalSec, retryAfter, 2) * 1000);
  }
}

/**
 * One token poll, for callers that drive the wait themselves (the DSH
 * panel polls over HTTP). Returns { token } once GitHub authorization
 * completes, or { pending: true, retryAfter? } while it has not. Throws
 * with .code === "consent_required" when the server never recorded the
 * consent for this session.
 */
export async function pollDeviceTokenOnce(sessionId) {
  const res = await postJson("/auth/token", { session_id: sessionId });
  if (res.status === 403) {
    const body = await res.json().catch(() => undefined);
    if (body?.code === "consent_required") {
      const err = new Error("consent_required: server did not record consent");
      err.code = "consent_required";
      throw err;
    }
  }
  if (!res.ok) throw new Error(`token poll failed: HTTP ${res.status}`);
  const body = await res.json().catch(() => ({}));
  if (typeof body?.token === "string" && body.token) return { token: body.token };
  return {
    pending: true,
    retryAfter: typeof body?.retry_after === "number" ? body.retry_after : undefined,
  };
}

/** Full login: start flow, let the caller present the code, consent, poll, save. */
export async function deviceLogin({ present, save = true } = {}) {
  const flow = await startDeviceFlow();
  if (!flow.sessionId) throw new Error("device flow response carried no session_id");
  if (present) await present(flow);
  await submitConsent(flow.sessionId);
  const token = await pollForToken(flow.sessionId, flow.interval);
  if (save) saveJwt(token);
  return token;
}

/** GET /me — true when the JWT is currently accepted, false on 401. */
export async function checkJwt(jwt) {
  try {
    const res = await fetch(new URL("/me", FREEPI_BASE_URL), {
      headers: { authorization: `Bearer ${jwt}` },
      signal: AbortSignal.timeout(8000),
    });
    if (res.status === 401) return false;
    return res.ok;
  } catch {
    return undefined; // network unknown — not the same as invalid
  }
}

/** GET /me — the account + quota record. Throws with .status on HTTP errors. */
export async function fetchMe(jwt, fetchImpl = fetch) {
  const res = await fetchImpl(new URL("/me", FREEPI_BASE_URL), {
    headers: { authorization: `Bearer ${jwt}` },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) {
    const err = new Error(`GET /me -> HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// Multi-account pool. One sign-in = one GitHub account = one daily budget
// (15,000 credits at the time of writing). Accounts live in
// ~/.free-pi/agent/accounts.json (0600):
//   [{ id, label, jwt, sessionId, addedAt }]
// credentials.json (the single-account file free-pi-cli writes) keeps
// working as the implicit first account, so nothing changes for existing
// single-account installs until a second login is added with
// `node core/login.mjs --label <name>`.
//
// Rotation is quota-aware round-robin: accounts whose JWT the server
// rejects (401) are marked invalid and skipped; accounts whose daily
// budget is spent are skipped until the refill time /me reports. Health
// state is per-process memory — a restart simply re-learns it.
// ---------------------------------------------------------------------------

export function accountsPath() {
  return join(freePiDir(), "accounts.json");
}

export function saveAccounts(list) {
  mkdirSync(freePiDir(), { recursive: true });
  writeFileSync(accountsPath(), JSON.stringify(list, null, 2) + "\n", { mode: 0o600 });
}

function readAccountPool() {
  try {
    const parsed = JSON.parse(readFileSync(accountsPath(), "utf8"));
    const list = Array.isArray(parsed) ? parsed : parsed?.accounts;
    if (!Array.isArray(list)) return [];
    return list.filter((e) => e && typeof e.jwt === "string" && e.jwt.trim());
  } catch {
    return [];
  }
}

/**
 * All known accounts, in priority order: an explicit JWT from the caller
 * (plugin config), then the accounts.json pool, then FREEPI_JWT, then the
 * single-account credentials file. Deduped by token value.
 */
export function loadAccounts(explicit) {
  const out = [];
  const push = (jwt, meta = {}) => {
    const token = typeof jwt === "string" ? jwt.trim() : "";
    if (!token || out.some((a) => a.jwt === token)) return;
    out.push({
      id: meta.id || `acct-${out.length + 1}`,
      label: meta.label || meta.id || "default",
      jwt: token,
      sessionId: typeof meta.sessionId === "string" && meta.sessionId ? meta.sessionId : undefined,
    });
  };
  if (typeof explicit === "string") push(explicit, { id: "config", label: "config" });
  for (const entry of readAccountPool()) push(entry.jwt, entry);
  if (process.env.FREEPI_JWT) push(process.env.FREEPI_JWT, { id: "env", label: "env" });
  const single = loadJwt();
  if (single) push(single, { id: "default", label: "default" });
  return out;
}

/** Add a sign-in to the pool (deduped by token). Returns the pool entry. */
export function addAccount({ label, jwt } = {}) {
  if (!jwt) throw new Error("addAccount: jwt required");
  const list = readAccountPool();
  const existing = list.find((e) => e.jwt === jwt);
  if (existing) return existing;
  const entry = {
    id: `acct-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`,
    label: label || `account ${list.length + 1}`,
    jwt,
    sessionId: randomUUID(),
    addedAt: new Date().toISOString(),
  };
  list.push(entry);
  saveAccounts(list);
  return entry;
}

/**
 * Account metadata for management UIs, aligned with loadAccounts():
 * where each sign-in comes from and whether it can be removed from here.
 * Only accounts.json pool entries are removable — the credentials.json
 * sign-in belongs to free-pi-cli's file (delete the file or re-run its
 * login to change it), and config/env values belong to the host.
 * Never carries JWT values.
 */
export function describeAccounts(explicit) {
  const poolById = new Map(readAccountPool().map((e) => [e.id, e]));
  return loadAccounts(explicit).map((account) => {
    const entry = poolById.get(account.id);
    const source = entry ? "pool" : account.id === "default" ? "credentials" : account.id;
    return {
      id: account.id,
      label: account.label,
      source,
      removable: Boolean(entry),
      addedAt: entry?.addedAt ?? null,
      ...accountStatus(account.id),
    };
  });
}

/**
 * Remove one accounts.json pool entry by id. Returns false when the id is
 * not a pool entry (the implicit credentials/config/env accounts are not
 * removable through the pool — see describeAccounts).
 */
export function removeAccount(id) {
  const list = readAccountPool();
  const index = list.findIndex((e) => e.id === id);
  if (index < 0) return false;
  list.splice(index, 1);
  saveAccounts(list);
  return true;
}

// --- per-process account health (quota / validity cache) -------------------

const accountHealth = new Map(); // id -> { invalid, exhaustedUntil, pauseReason, remainingCredits, quotaAt }
let rotationCursor = 0;

function healthOf(id) {
  let h = accountHealth.get(id);
  if (!h) {
    h = { invalid: false, exhaustedUntil: 0, pauseReason: null, remainingCredits: null, quotaAt: 0 };
    accountHealth.set(id, h);
  }
  return h;
}

export function markAccountInvalid(id) {
  healthOf(id).invalid = true;
}

export function markAccountExhausted(id, until = Date.now() + 10 * 60 * 1000) {
  const h = healthOf(id);
  h.exhaustedUntil = until;
  h.pauseReason = "quota";
}

/**
 * The upstream ads gate: free-pi pauses an account's free completions
 * (HTTP 403, "ads can't be skipped … free completions are paused") when
 * no ads were shown for it — a temporary per-account state that clears
 * on its own (observed clearing within minutes). Treat it like a spent
 * budget with a fixed cooldown, but remember the reason so listings can
 * surface it distinctly as "paused-ads" instead of a quota problem.
 */
export const ADS_PAUSE_COOLDOWN_MS = 30 * 60 * 1000;

export function markAccountAdsPaused(id, cooldownMs = ADS_PAUSE_COOLDOWN_MS) {
  const h = healthOf(id);
  h.exhaustedUntil = Date.now() + cooldownMs;
  h.pauseReason = "ads";
}

/**
 * The display status of one account, from the health map:
 * "ok" | "invalid" | "exhausted" (budget spent) | "paused-ads"
 * (upstream ads gate). pausedUntil is the ISO resume time for the two
 * paused states, else null.
 */
function accountStatus(id) {
  const h = accountHealth.get(id);
  if (!h) return { status: "ok", pausedUntil: null };
  if (h.invalid) return { status: "invalid", pausedUntil: null };
  if (h.exhaustedUntil > Date.now()) {
    return {
      status: h.pauseReason === "ads" ? "paused-ads" : "exhausted",
      pausedUntil: new Date(h.exhaustedUntil).toISOString(),
    };
  }
  return { status: "ok", pausedUntil: null };
}

function noteQuota(id, me) {
  const h = healthOf(id);
  h.quotaAt = Date.now();
  if (typeof me?.remaining_credits_today === "number") {
    h.remainingCredits = me.remaining_credits_today;
    if (me.remaining_credits_today <= 0) {
      const refill = Date.parse(me?.refill_at ?? "");
      h.exhaustedUntil = Number.isFinite(refill) && refill > Date.now() ? refill : Date.now() + 30 * 60 * 1000;
      h.pauseReason = "quota";
    } else if (h.exhaustedUntil && h.exhaustedUntil < Date.now() + 60 * 1000) {
      h.exhaustedUntil = 0;
      h.pauseReason = null;
    }
  }
}

/**
 * Candidate accounts for the next request, best first: healthy accounts in
 * round-robin order (the starting point advances on every call), skipping
 * invalid tokens and spent budgets. When everything looks spent, non-
 * invalid accounts are still returned as a last resort — /me data can be
 * stale, and the Free-Unlimited models cost nothing anyway.
 */
export function pickAccountCandidates(explicit) {
  const all = loadAccounts(explicit);
  if (!all.length) return [];
  const now = Date.now();
  const healthy = all.filter((a) => {
    const h = accountHealth.get(a.id);
    return !h?.invalid && !(h?.exhaustedUntil > now);
  });
  const usable = all.filter((a) => !accountHealth.get(a.id)?.invalid);
  const pool = healthy.length ? healthy : usable.length ? usable : all;
  const start = rotationCursor++ % pool.length;
  return [...pool.slice(start), ...pool.slice(0, start)];
}

/** The /me record of one account, normalized for display. Never carries the JWT. */
export function summarizeQuota(account, me) {
  const allowance = typeof me?.allowance_credits === "number" ? me.allowance_credits : null;
  const remaining = typeof me?.remaining_credits_today === "number" ? me.remaining_credits_today : null;
  return {
    id: account.id,
    label: account.label,
    ok: true,
    ...accountStatus(account.id),
    handle: me?.handle ?? null,
    tier: me?.tier ?? null,
    allowanceCredits: allowance,
    remainingCredits: remaining,
    usedCredits: allowance != null && remaining != null ? allowance - remaining : null,
    remainingUsd: typeof me?.remaining_usd_today === "number" ? me.remaining_usd_today : null,
    capUsd: typeof me?.cap_usd_today === "number" ? me.cap_usd_today : null,
    premiumCredits: typeof me?.premium_credits === "number" ? me.premium_credits : 0,
    refillAt: me?.refill_at ?? null,
    earnReward: Boolean(me?.earn_reward),
  };
}

export async function fetchAccountQuota(account, fetchImpl = fetch) {
  try {
    const me = await fetchMe(account.jwt, fetchImpl);
    noteQuota(account.id, me);
    return summarizeQuota(account, me);
  } catch (err) {
    if (err?.status === 401) markAccountInvalid(account.id);
    return {
      id: account.id,
      label: account.label,
      ok: false,
      error: err?.status === 401 ? "unauthorized — sign-in expired or revoked" : `unreachable — ${err?.message ?? err}`,
    };
  }
}

/** Quota summaries for every known account (parallel /me calls). */
export async function listQuotas(explicit, fetchImpl = fetch) {
  return Promise.all(loadAccounts(explicit).map((a) => fetchAccountQuota(a, fetchImpl)));
}

/** Refresh the quota cache in the background (hosts call this, then pick). */
export async function refreshQuotaCache(explicit, { maxAgeMs = 60 * 1000, fetchImpl = fetch } = {}) {
  const stale = loadAccounts(explicit).filter((a) => Date.now() - (accountHealth.get(a.id)?.quotaAt ?? 0) > maxAgeMs);
  await Promise.allSettled(stale.map((a) => fetchAccountQuota(a, fetchImpl)));
}

const QUOTA_ERROR_TEXT = /insufficient|quota|allowance|credit|balance|exhaust/i;
// The ads gate's own words (observed live 2026-11-09): "free-pi is free
// because ads pay for it, so ads can't be skipped. Ads aren't showing for
// this account, so free completions are paused. …"
const ADS_PAUSE_TEXT = /ads (can'?t be skipped|aren'?t showing)|free completions are paused/i;

/**
 * One upstream /v1 call with account failover. Candidates are tried in
 * pick order; a 401 marks the account invalid, a 402/429 whose body talks
 * about quota marks it exhausted, a 403 carrying the ads-gate text marks
 * it ads-paused for ADS_PAUSE_COOLDOWN_MS, and the next account is tried.
 * Error statuses are only peeked at before any body streams, so a
 * successful (possibly SSE) response is returned untouched.
 * Returns { res, account } — account is null when every candidate failed
 * and res is the last error response.
 */
export async function rotatingFetch(pathWithSearch, { method = "POST", headers = {}, body, explicit, fetchImpl = fetch } = {}) {
  const candidates = pickAccountCandidates(explicit);
  if (!candidates.length) return { res: null, account: null };
  let last = null;
  for (const account of candidates) {
    const res = await fetchImpl(new URL(pathWithSearch, FREEPI_BASE_URL), {
      method,
      headers: upstreamHeaders({ jwt: account.jwt, sessionId: account.sessionId || getSessionId(), extra: headers }),
      body,
    });
    if (res.status === 401) {
      markAccountInvalid(account.id);
      last = res;
      await res.text().catch(() => {});
      continue;
    }
    if (res.status === 402 || res.status === 429) {
      const text = await res.clone().text().catch(() => "");
      if (QUOTA_ERROR_TEXT.test(text)) {
        markAccountExhausted(account.id);
        void fetchAccountQuota(account, fetchImpl).catch(() => {});
        last = res;
        continue;
      }
    }
    if (res.status === 403) {
      const text = await res.clone().text().catch(() => "");
      if (ADS_PAUSE_TEXT.test(text)) {
        markAccountAdsPaused(account.id);
        last = res;
        continue;
      }
    }
    return { res, account };
  }
  return { res: last, account: null };
}

// ---------------------------------------------------------------------------
// Standalone loopback proxy. Exposes free-pi as a vanilla OpenAI endpoint:
//   GET  /health               -> { ok, signedIn, accounts, upstream }
//   GET  /quota                -> per-account balances (GET /me summaries)
//   GET  /v1/models            -> live catalogue (upstream has no such route)
//   POST /v1/chat/completions  -> forwarded with JWT/session/version headers,
//                                 streaming (SSE) passed through untouched
//   *    /v1/*                 -> forwarded the same way
// /v1 calls rotate across the account pool with failover (see
// rotatingFetch). An optional local token (proxyKey) can gate callers;
// hosts on the same machine only — the server binds 127.0.0.1 by default
// on purpose.
// ---------------------------------------------------------------------------

export function createProxyServer({ getJwt, sessionId, proxyKey, fetchImpl = fetch } = {}) {
  const explicitJwt = typeof getJwt === "function" ? undefined : getJwt;
  const resolveExplicit = () => (typeof getJwt === "function" ? getJwt() : explicitJwt);

  const server = createServer(async (req, res) => {
    const sendJson = (code, payload) => {
      const text = JSON.stringify(payload);
      res.writeHead(code, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text) });
      res.end(text);
    };
    try {
      const url = new URL(req.url || "/", "http://127.0.0.1");
      if (url.pathname === "/health") {
        const count = loadAccounts(resolveExplicit()).length;
        sendJson(200, { ok: true, signedIn: count > 0, accounts: count, upstream: FREEPI_BASE_URL });
        return;
      }
      if (proxyKey) {
        const given = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
        if (given !== proxyKey) {
          sendJson(401, { error: { message: "free-pi proxy: bad local key", type: "invalid_request_error" } });
          return;
        }
      }
      if (url.pathname === "/quota" && req.method === "GET") {
        sendJson(200, { object: "list", data: await listQuotas(resolveExplicit(), fetchImpl) });
        return;
      }
      if (url.pathname === "/v1/models" && req.method === "GET") {
        sendJson(200, { object: "list", data: await openAiModels(fetchImpl) });
        return;
      }
      if (!url.pathname.startsWith("/v1/")) {
        sendJson(404, { error: { message: "free-pi proxy: not found", type: "invalid_request_error" } });
        return;
      }
      if (!loadAccounts(resolveExplicit()).length) {
        sendJson(401, {
          error: {
            message: "free-pi: not signed in. Run the login script (core/login.mjs) once — each login adds one account to the rotation pool.",
            type: "authentication_error",
          },
        });
        return;
      }
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      void sessionId; // sessions are per-account now; the pool owns them
      const { res: upstream } = await rotatingFetch(url.pathname + url.search, {
        method: req.method,
        headers: { "content-type": req.headers["content-type"] || "application/json", accept: req.headers.accept || "*/*" },
        body: body.length ? body : undefined,
        explicit: resolveExplicit(),
        fetchImpl,
      });
      if (!upstream) {
        sendJson(502, { error: { message: "free-pi proxy: no account available", type: "proxy_error" } });
        return;
      }
      const responseHeaders = {};
      for (const name of ["content-type", "cache-control", "x-request-id"]) {
        const value = upstream.headers.get(name);
        if (value) responseHeaders[name] = value;
      }
      res.writeHead(upstream.status, responseHeaders);
      if (upstream.body) {
        const reader = upstream.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(Buffer.from(value));
        }
      }
      res.end();
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: { message: `free-pi proxy: ${err?.message ?? err}`, type: "proxy_error" } }));
      } else {
        res.end();
      }
    }
  });
  return server;
}

export function startProxy({ port = 18991, host = "127.0.0.1", ...rest } = {}) {
  const server = createProxyServer(rest);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve(server));
  });
}
