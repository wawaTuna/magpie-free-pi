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
  modelCaps,
  pollForToken,
  startDeviceFlow,
  submitConsent,
} from "./free-pi-core.mjs";

const PROVIDER_ID = "free-pi";
const ICON_URL = "https://raw.githubusercontent.com/wawaTuna/magpie-free-pi/main/assets/icon.png";
const API_BASE = `${FREEPI_BASE_URL}/v1`;
const JWT_LIFETIME_MS = 90 * 24 * 60 * 60 * 1000;

// OpenCode-shape capability block for a model id, from the shared core
// caps table (the free-pi catalogue itself carries no capability fields).
const capsFields = (id) => {
  const caps = modelCaps(id);
  return {
    limit: { context: caps.context, output: caps.output },
    capabilities: {
      reasoning: caps.reasoning,
      toolcall: true,
      attachment: caps.image,
      input: { text: true, ...(caps.image ? { image: true } : {}) },
    },
    // Thinking-strength picker: the AI SDK forwards reasoningEffort to
    // the gateway as reasoning_effort (verified honoured upstream).
    ...(caps.effort
      ? {
          variants: {
            low: { reasoningEffort: "low" },
            medium: { reasoningEffort: "medium" },
            high: { reasoningEffort: "high" },
          },
        }
      : {}),
  };
};

const fallbackModelConfig = () =>
  Object.fromEntries(
    FALLBACK_MODELS.map((m) => [
      m.id,
      { name: m.name, ...capsFields(m.id), cost: { input: 0, output: 0 } },
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
      // Magpie: auth.icon wins over package.json's magpie.icon for the
      // provider's picture; both point at the same magpie-free-pi icon so
      // the plugin row and the provider row show the same face.
      icon: ICON_URL,

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
              // "auto": magpie calls callback() itself and waits for it to
              // resolve while the user approves in the browser. ("code"
              // would make magpie wait for the user to paste a code first,
              // which silently strands the device flow: GitHub's success
              // page shows no code to paste.)
              method: "auto",
              callback: async () => {
                await submitConsent(flow.sessionId);
                let token;
                try {
                  token = await pollForToken(flow.sessionId, flow.interval);
                } catch (err) {
                  return {
                    type: "failed",
                    error:
                      "The GitHub sign-in did not complete in time. " +
                      "Start it again and approve the code while it is fresh. " +
                      `(${String(err?.message || err).slice(0, 200)})`,
                  };
                }
                // Magpie keeps one account per accountId: the free-pi
                // handle is the account's identity, so signing in with a
                // second GitHub account ADDS an account (native Magpie
                // failover + per-account quota) instead of replacing the
                // first. The token also joins the shared core pool, so
                // dsh-free-pi and the standalone proxy rotate over the
                // same sign-ins on this machine.
                let accountId = null;
                try {
                  const me = await fetchMe(token);
                  accountId = me?.handle || me?.user_id || null;
                } catch {
                  // /me hiccup: fall back to the token's own claims below.
                }
                if (!accountId) {
                  try {
                    const claims = JSON.parse(
                      Buffer.from(token.split(".")[1], "base64url").toString("utf8"),
                    );
                    accountId = claims.handle || claims.login || claims.user_id || claims.sub || null;
                  } catch {
                    // Undecodable token: handled by the failure below.
                  }
                }
                if (!accountId) {
                  return {
                    type: "failed",
                    error:
                      "GitHub approved the sign-in, but free-pi did not say which " +
                      "account it belongs to, so it was not saved (saving it " +
                      "without an identity would replace the existing account). " +
                      "Please try adding it again.",
                  };
                }
                addAccount({ label: accountId, jwt: token });
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
            ...capsFields(m.id),
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
