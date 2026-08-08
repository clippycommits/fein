# Security Policy

## Reporting a vulnerability

Email **security@fein.vc** with details and, if you can, a minimal
reproduction. *(Placeholder address — confirm it routes before relying on
it.)* Please do not open a public issue for a security report.

We aim to acknowledge within a few business days and will keep you posted on a
fix and disclosure timeline. Coordinated disclosure is appreciated: give us a
chance to ship a fix before going public.

## Supported versions

fein is pre-1.0 and ships fixes on the latest minor. Security fixes land on
the current `0.x` line; older lines are not backported.

| Version | Supported |
|---|---|
| 0.5.x | ✅ |
| < 0.5 | ❌ — upgrade (run `fein reresolve` once after upgrading) |

## Security model

fein is designed to run as a **single trusted deployment for one firm**, and
its guarantees are scoped to that.

- **Token-gated surface.** In a deployment, `FEIN_AUTH_TOKEN` gates every
  surface — the dashboard, the `/api/*` endpoints, and the `/mcp` endpoint
  alike. Agents authenticate with `Authorization: Bearer <token>`; browsers
  sign in once at `/login` and get an `HttpOnly; SameSite=Lax` cookie. Token
  comparisons are timing-safe, and the login page gives the same response for
  "no token yet" and "wrong token" so it is not an oracle. `/api/health` is the
  only open data endpoint, for container healthchecks; the `/login` page is likewise unauthenticated so browsers can obtain the session cookie.
- **Fail-closed on exposure.** The server binds **loopback by default**
  (`127.0.0.1`). If configured to bind a non-loopback interface *without* a
  token, it refuses to start rather than publish the whole graph — override
  only with an explicit `FEIN_INSECURE=1` when a firewall or VPN already gates
  access. A missing token on loopback stays local; a missing token anywhere
  else is a hard stop.
- **Cross-origin and host defenses.** Writes require a same-origin (or
  loopback) origin, and Host headers are validated, to blunt DNS-rebinding and
  cross-origin write attempts against loopback installs.
- **Privacy layers are cooperative, not hostile-tenant isolation.** Per-member
  private layers are enforced server-side on every query (and continuously
  probed by the `test-leaks.js` suite), but this is a trust model for one team
  on one database: anyone with filesystem access to `./data`, the deployment
  token, or the ability to pass an arbitrary `?as=` can read any layer. Real
  multi-tenant isolation (per-user login) is on the roadmap and is **not**
  claimed today.
- **Stored connector keys.** Keys pasted into the dashboard (Attio, Affinity)
  are write-only across the API — never returned, shown only as a masked hint,
  kept out of the audit log — but they are stored in plain text at the same
  trust level as the graph. For shared or server deployments, prefer the
  environment-variable form (`ATTIO_API_KEY`, `AFFINITY_API_KEY`), which the
  dashboard uses without storing anything.
- **Extraction is sandboxed by construction.** The LLM extractor returns only
  typed, text-grounded mention candidates; a prompt-injected document can at
  worst distort which candidates come back, never make the pipeline take an
  action. See [docs/extraction.md](docs/extraction.md) for the threat model.

If you find a way to read across a privacy layer inside the intended trust
boundary, bypass the auth gate, exfiltrate a stored key, or get the extractor
to do more than propose grounded candidates, that's a vulnerability — please
report it.
