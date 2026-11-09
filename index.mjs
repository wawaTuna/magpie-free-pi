/**
 * magpie-free-pi — Magpie provider plugin for free-pi.
 *
 * Magpie's provider-plugin shape is the OpenCode v1 plugin shape
 * (export default { id, server }); the server function returns the
 * config / auth / provider hooks. This is the route-A design: the plugin's
 * own `fetch` IS the reverse proxy — Magpie translates agent requests to
 * OpenAI Chat Completions shape (npm: "@ai-sdk/openai-compatible"), and the
 * loader's fetch injects the three things free-pi's backend requires
 * (Authorization JWT, x-session-id, x-client-version) on the way out.
 * No separate proxy process is needed on the Magpie side; the shared core
 * (./free-pi-core.mjs, vendored from ../../core) owns the JWT/session/
 * catalogue logic for both this plugin and dsh-free-pi.
 *
 * Sign-in is free-pi's GitHub device flow, implemented as an oauth auth
 * method; a paste-a-JWT api method is kept as a fallback (the JWT is the
 * one core/login.mjs writes to ~/.free-pi/agent/credentials.json).
 */
import {
  FALLBACK_MODELS,
  FREEPI_BASE_URL,
  FREEPI_CLIENT_VERSION,
  addAccount,
  fetchCatalog,
  fetchMe,
  getSessionId,
  pollForToken,
  startDeviceFlow,
  submitConsent,
} from "./free-pi-core.mjs";

const PROVIDER_ID = "free-pi";
const API_BASE = `${FREEPI_BASE_URL}/v1`;
const JWT_LIFETIME_MS = 90 * 24 * 60 * 60 * 1000;

const fallbackModelConfig = () =>
  Object.fromEntries(
    FALLBACK_MODELS.map((m) => [
      m.id,
      { name: m.name, limit: { context: 1_048_576, output: 8192 }, cost: { input: 0, output: 0 } },
    ]),
  );

const server = async () => {
  // One stable session id per install (persisted by the core), shared by
  // the loader fetch and chat.headers so both injection points agree.
  const sessionId = getSessionId();

  return {
    config(cfg) {
      cfg.provider ??= {};
      cfg.provider[PROVIDER_ID] ??= {
        name: "free-pi",
        npm: "@ai-sdk/openai-compatible",
        api: API_BASE,
        models: fallbackModelConfig(),
      };
    },

    auth: {
      provider: PROVIDER_ID,

      methods: [
        {
          type: "oauth",
          label: "Sign in with GitHub (free-pi)",
          authorize: async () => {
            const flow = await startDeviceFlow();
            return {
              url: flow.verificationUri,
              instructions:
                `Open the URL, enter code ${flow.userCode}, and approve. ` +
                "Note: free-pi funds free inference with ads and training on session data.",
              method: "code",
              callback: async () => {
                await submitConsent(flow.sessionId);
                const token = await pollForToken(flow.sessionId, flow.interval);
                // Magpie keeps one account per accountId: the free-pi
                // handle is the account's identity, so signing in with a
                // second GitHub account ADDS an account (native Magpie
                // failover + per-account quota) instead of replacing the
                // first. The token also joins the shared core pool, so
                // dsh-free-pi and the standalone proxy rotate over the
                // same sign-ins on this machine.
                let accountId = PROVIDER_ID;
                try {
                  const me = await fetchMe(token);
                  accountId = me?.handle || me?.user_id || PROVIDER_ID;
                  addAccount({ label: accountId, jwt: token });
                } catch {
                  // /me hiccup: fall back to the shared id; the sign-in
                  // itself still works.
                }
                return {
                  type: "success",
                  access: token,
                  refresh: token,
                  expires: Date.now() + JWT_LIFETIME_MS,
                  accountId,
                };
              },
            };
          },
        },
        {
          type: "api",
          label: "Paste free-pi JWT",
          placeholder: "eyJ… (from ~/.free-pi/agent/credentials.json)",
        },
      ],

      loader: async (getAuth) => {
        const auth = await getAuth().catch(() => undefined);
        const jwt = auth?.access || auth?.key;
        if (!jwt) return {};
        return {
          baseURL: API_BASE,
          apiKey: jwt,
          headers: { "x-client-version": FREEPI_CLIENT_VERSION },
          fetch: (input, init = {}) => {
            const headers = new Headers(
              init.headers ?? (typeof Request !== "undefined" && input instanceof Request ? input.headers : undefined),
            );
            headers.set("authorization", `Bearer ${jwt}`);
            headers.set("x-session-id", sessionId);
            headers.set("x-client-version", FREEPI_CLIENT_VERSION);
            return fetch(input, { ...init, headers });
          },
        };
      },

      // Magpie's own hook: how much of this account's daily budget is
      // used. Runs in the account's scope, so each Magpie account reports
      // its own numbers; `magpie quota` and the Providers UI show them,
      // and Magpie's routing weighs accounts by what they have left.
      usage: async (getAuth) => {
        const auth = await getAuth().catch(() => undefined);
        const jwt = auth?.access || auth?.key;
        if (!jwt) return { error: "free-pi: not signed in", windows: [] };
        try {
          const me = await fetchMe(jwt);
          const allowance = me?.allowance_credits ?? 0;
          const remaining = me?.remaining_credits_today ?? 0;
          return {
            plan: me?.tier ? `free-pi (${me.tier})` : "free-pi",
            user: me?.handle ?? undefined,
            balance: me?.remaining_usd_today != null ? `$${me.remaining_usd_today.toFixed(4)} left today` : undefined,
            windows: [
              {
                name: "today",
                amount: Math.max(0, allowance - remaining),
                limit: allowance,
                unit: "credits",
                display: `${remaining} / ${allowance} credits left`,
                resetsAt: me?.refill_at ?? undefined,
                span: 24 * 3600,
              },
            ],
          };
        } catch (err) {
          if (err?.status === 401) return { error: "free-pi sign-in expired — sign in again", signIn: "expired", windows: [] };
          return { error: `free-pi usage check failed: ${err?.message ?? err}`, windows: [] };
        }
      },
    },

    provider: {
      // Dynamic catalogue: GET /client-version upstream is unauthenticated,
      // so the picker list tracks what free-pi actually serves right now.
      models: async () => {
        const catalogue = await fetchCatalog().catch(() => FALLBACK_MODELS);
        const out = {};
        for (const m of catalogue) {
          out[m.id] = {
            id: m.id,
            name: m.name,
            api: { id: m.id, url: API_BASE, npm: "@ai-sdk/openai-compatible" },
            limit: { context: 1_048_576, output: 8192 },
            capabilities: {
              reasoning: false,
              toolcall: true,
              attachment: false,
              input: { text: true },
            },
            cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
            ...(typeof m.name === "string" && m.name.includes("Free Unlimited") ? { free: true } : {}),
          };
        }
        return out;
      },
    },

    // Belt and braces: Magpie documents chat.headers' sessionID input as
    // the place for vendor session headers. Our session id is the stable
    // per-install one (the allowance lease), not Magpie's session id.
    "chat.headers": async (_input, output) => {
      output.headers ??= {};
      output.headers["x-session-id"] = sessionId;
      output.headers["x-client-version"] = FREEPI_CLIENT_VERSION;
    },
  };
};

export default { id: "magpie-free-pi", server };
