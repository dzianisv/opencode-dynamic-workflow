# Auth Provider Reference

> Conforms to `hooks.md` ground truth (`@opencode-ai/plugin` `index.ts`,
> `sst/opencode@dev`, 2026-06-06). The `AuthHook` shape below is the current
> surface; where older snapshots differ (e.g. `condition` callbacks, missing
> `metadata`/`accountId`), the fresh refs win.

The `auth` hook registers a custom credential flow for a provider so opencode can
acquire and refresh credentials for it (e.g. `opencode auth login`). It does
**not** by itself add models — pair it with the `provider` hook (see `hooks.md`)
when you also need to contribute a model list. Auth supplies *credentials*;
`provider` supplies *what to call with them*.

## Hook shape

```typescript
return {
  auth: {
    provider: "myservice",       // provider id these credentials are for
    loader,                      // optional: turn stored creds into runtime config
    methods: [ /* one or more login methods */ ],
  },
}
```

Full type (from `hooks.md`):

```typescript
type Rule = { key: string; op: "eq" | "neq"; value: string }

type AuthHook = {
  provider: string
  loader?: (auth: () => Promise<Auth>, provider: Provider) => Promise<Record<string, any>>
  methods: Array<OAuthMethod | ApiMethod>
}
```

`methods` may mix OAuth and API-key entries; opencode shows them as login
choices. Each method may declare `prompts` to collect inputs before authorizing.

## `loader` — credentials to runtime config

`loader` runs when opencode needs the live credential. It receives a thunk that
resolves the stored `Auth` record and the `Provider`, and returns whatever
config the provider SDK expects (commonly an API key / base URL map).

```typescript
loader: async (getAuth, provider) => {
  const auth = await getAuth()           // stored credential for this provider
  // shape depends on how you stored it (api key vs oauth token set)
  return { apiKey: "key" in auth ? auth.key : auth.access }
}
```

Use `loader` to refresh expired OAuth tokens before handing them back, or to map
a stored field into the provider's expected config key.

Two source facts that change how you write it (`provider/provider.ts:1503-1522`):

- `loader` runs **only when a stored auth entry exists** for this provider. No
  login → `loader` is never called.
- The first arg is a **live re-read thunk** (`getAuth = () => auth.get(id)`), not
  a snapshot. Call it *inside* the closure every time you need the credential —
  this is how a long-lived `fetch` override always sees the freshly-refreshed
  token instead of the one captured at load time.
- Whatever object you return is **merged into the provider's options**. The
  canonical shape is `{ apiKey, fetch }`.

### OAuth-as-API-key bridge (the most important undocumented pattern)

The AI SDK refuses to run without an `apiKey`. OAuth providers don't have one, so
first-party plugins set a **dummy** key and inject the real bearer token via a
`fetch` override returned from `loader`. This is how every shipped OAuth provider
(copilot, codex, xai) works.

```typescript
import { OAUTH_DUMMY_KEY } from "..."   // = "opencode-oauth-dummy-key" (auth/index.ts:7)

loader: async (getAuth) => {
  const info = await getAuth()
  if (!info || info.type !== "oauth") return {}
  return {
    apiKey: OAUTH_DUMMY_KEY,            // copilot uses "" — any non-undefined value works
    async fetch(request: RequestInfo | URL, init?: RequestInit) {
      const cur = await getAuth()       // re-read LIVE, not the outer `info`
      if (cur.type !== "oauth") return fetch(request, init)
      const headers: Record<string, string> = { ...(init?.headers as any) }
      // strip the SDK-injected dummy creds, then inject the real token:
      delete headers["authorization"]
      delete headers["x-api-key"]
      headers["Authorization"] = `Bearer ${cur.access}`
      return fetch(request, { ...init, headers })   // fresh object — never mutate `init`
    },
  }
}
```

Reference impls: copilot `copilot.ts:99-181`, codex `codex.ts:411-491`,
xai `xai.ts:581-657`.

### Header hygiene in fetch overrides

Two non-obvious rules the first-party overrides all follow:

1. **Strip the SDK creds first.** The SDK derives `authorization` / `x-api-key`
   from your dummy `apiKey`. If you don't delete them before injecting the real
   `Authorization`, a case-insensitive `Headers.set` can clobber your bearer.
   Normalize across all three `HeadersInit` shapes — `Headers`, `[k,v][]`, and
   `Record<string,string|undefined>` — because `init.headers` can be any of them.
   (codex `codex.ts:425-435,474-491` is the reference for handling all three.)
2. **Never mutate the caller's `RequestInit`.** The SDK reuses the same `init` on
   retry. Build a fresh `headers` object and pass `{ ...init, headers }`.

### Single-flight token refresh

Refresh inside the override, but collapse concurrent refreshes onto **one** HTTP
call via a closure-scoped `refreshPromise` cleared in `.finally()`. Otherwise two
in-flight requests both spend the same `refresh_token` and a rotating provider
invalidates the second. Persist the new tokens with `client.auth.set(...)`, and
store `tokens.refresh_token || oldRefreshToken` so non-rotating providers survive.
(codex `codex.ts:415-472`; gold-standard test of the idiom at
`test/plugin/codex.test.ts:143-238`.)

## Prompts

Both method types accept an optional `prompts` array to gather inputs (e.g. a
region, an API base, a token). Two prompt types:

```typescript
// text input
{ type: "text", key: "region", message: "Region", placeholder: "us-east-1",
  validate: (v) => v ? undefined : "required",   // return string = error
  when: { key: "tier", op: "eq", value: "enterprise" } }  // conditional display

// select input
{ type: "select", key: "tier", message: "Account tier",
  options: [{ label: "Free", value: "free" }, { label: "Enterprise", value: "enterprise" }],
  when: { key: "...", op: "neq", value: "..." } }
```

- Conditional display uses **`when: Rule`** (`{ key, op: "eq" | "neq", value }`).
  The old `condition: (inputs) => boolean` callback still type-checks but is
  **deprecated** — use `when`.
- Collected inputs are passed to `authorize(inputs)`.

## API-key method

The simplest flow. opencode collects a key (via `prompts` or its built-in key
entry) and stores it. Provide `authorize` only if you need to validate or
transform the key:

```typescript
methods: [
  {
    type: "api",
    label: "API Key",
    prompts: [
      { type: "text", key: "apiKey", message: "API key", validate: (v) => v ? undefined : "required" },
    ],
    async authorize(inputs) {
      const key = inputs?.apiKey ?? ""
      const ok = await fetch("https://api.myservice.com/v1/ping", {
        headers: { authorization: `Bearer ${key}` },
      }).then((r) => r.ok).catch(() => false)
      if (!ok) return { type: "failed" }
      return { type: "success", key, metadata: { verifiedAt: new Date().toISOString() } }
    },
  },
],
```

`authorize` on an `api` method returns:

```typescript
| { type: "success"; key: string; provider?: string; metadata?: Record<string, string> }
| { type: "failed" }
```

`provider` lets the result target a different provider id than the hook's;
`metadata` is optional free-form data stored alongside the key. If you omit
`authorize`, opencode just stores the collected key.

## OAuth method

`authorize()` returns an `AuthOAuthResult`: a `url` + `instructions` to show the
user, plus a `method` (`"auto"` or `"code"`) with a matching `callback`.

```typescript
methods: [
  {
    type: "oauth",
    label: "Connect MyService",
    async authorize() {
      return {
        url: "https://myservice.com/oauth/authorize?client_id=...&redirect_uri=...",
        instructions: "Open the URL, approve access, then paste the code shown.",
        method: "code",                         // user pastes a code back
        async callback(code) {
          const res = await fetch("https://myservice.com/oauth/token", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ code, grant_type: "authorization_code" }),
          })
          if (!res.ok) return { type: "failed" }
          const t = await res.json()
          return {
            type: "success",
            access: t.access_token,
            refresh: t.refresh_token,
            expires: Date.now() + t.expires_in * 1000,   // absolute ms epoch
            // optional: accountId, enterpriseUrl
          }
        },
      }
    },
  },
],
```

### Two callback flavours

`AuthOAuthResult` is `{ url; instructions }` plus one of:

- **`method: "code"`** — `callback(code: string)`. Use when the provider hands
  the user a code/redirect param they paste back into opencode. Most common.
- **`method: "auto"`** — `callback()` (no argument). Use when opencode can
  complete the exchange itself (e.g. a loopback redirect / device flow the
  callback polls).

### Success result (both flavours)

The `{ type: "success" }` branch is a union — return **one** shape:

```typescript
// OAuth token set:
{ type: "success"; provider?: string;
  refresh: string; access: string; expires: number;   // expires = absolute epoch ms
  accountId?: string; enterpriseUrl?: string }

// or, exchange yields a plain key:
{ type: "success"; provider?: string; key: string; metadata?: Record<string, string> }
```

Return `{ type: "failed" }` on any error — do not throw raw across the callback
boundary.

Snapshot drift to note: `accountId` / `enterpriseUrl` on the token result and
`metadata` on the key result are **newer fields** absent from older docs.
`AuthOuathResult` (misspelled) exists only as a deprecated alias of
`AuthOAuthResult`; use the correctly spelled type.

## Pairing with the `provider` hook

Auth alone gives opencode credentials. To make the provider's models selectable,
add the `provider` hook so a model list is contributed for the same id. `models`
runs at runtime, so it is also where you **rewrite the catalog** based on auth
state:

```typescript
return {
  auth: { provider: "myservice", methods: [/* ... */] },
  provider: {
    id: "myservice",
    async models(provider, { auth }) {
      // auth is the stored credential (may be undefined pre-login)
      return {
        "myservice-large": { /* ModelV2 */ } as any,
      }
    },
  },
}
```

See `hooks.md` for the exact `ProviderHook` / `ModelV2` shapes.

### `provider.models` patterns from first-party plugins

- **Auth-gated catalog** — return base/static models if `auth?.type !== "oauth"`,
  else fetch the live `/models` endpoint with the bearer and merge. Always
  `.catch()` back to the base list on fetch failure (copilot `copilot.ts:63-96`).
- **Cost-zeroing for subscription models** — OAuth models billed by subscription,
  not per-token, set `cost: { input: 0, output: 0, cache: { read: 0, write: 0 } }`
  so usage accounting doesn't double-charge (codex `codex.ts:383-389`).
- **Cache into a closure var** — store the fetched models in a `let models = {}`
  captured in the outer plugin function, so `experimental.provider.small_model`
  (which picks the cheap title/utility model) can reuse them without re-fetching
  (copilot `copilot.ts:61,83,358-362`).

### Cross-hook state lives in closures, not a store

Every first-party plugin keeps shared state — `let models = {}`, the
single-flight `refreshPromise`, the OAuth loopback-server singleton — in plain
closure variables captured in the outer plugin function. There is no plugin state
API; the closure *is* the store. (copilot `copilot.ts:61`, codex `codex.ts:239-240,357-358`.)

### Calling the SDK from inside a hook

`input.client` is callable from any hook, not just at startup. Copilot's
`chat.headers` calls `sdk.session.get(...)` / `sdk.session.message(...)` to detect
whether the turn is a subagent or compaction and tag the request with
`x-initiator: agent` (`copilot.ts:375-414`). Two rules:

- Pass the directory as `query: { directory: input.directory }`.
- Wrap in `.catch(() => undefined)` — the server may not have the record yet.

### Auth override is last-writer-wins by provider id

A user plugin re-declaring `auth.provider: "github-copilot"` (or any built-in's
id) **replaces** the built-in's methods, because external plugins load after
internal ones. Tested behavior (`test/plugin/auth-override.test.ts:46-89`). Use
this to override a shipped provider's login flow; avoid it by accident by not
reusing a built-in provider id.

## Discipline

- Validate credentials in `authorize` before returning `success` — a stored bad
  key fails later with a worse error message.
- Never log secrets. Route diagnostics through `ctx.client.app.log`
  (body-wrapped); never `console.log` (it corrupts the TUI / JSON-RPC stream).
- Store the **absolute** expiry (`Date.now() + expires_in * 1000`), not the
  relative `expires_in`. Refresh in `loader` when past expiry.
