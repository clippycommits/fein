# Deploying Fein to a client

The goal: a fund's own Fein, on a box they control, in under an hour. One
container, one volume, one token. Nothing leaves the box — the only outbound
call is the (optional) Anthropic API for mention extraction.

## What you need

- A Linux VPS the client controls (2 GB RAM is plenty to start) with Docker
  installed, or any machine with Node 20+ for a bare-metal run.
- Optionally a subdomain (e.g. `fein.clientfund.com`) pointed at the box —
  needed only if agents or teammates connect from outside it.

## One-box quickstart (Docker)

```bash
git clone https://github.com/clippycommits/fundgraph fein && cd fein
cp .env.example .env
openssl rand -hex 24        # paste as FEIN_AUTH_TOKEN in .env
docker compose up -d
```

That's the deployment. The dashboard and the MCP endpoint are on
`127.0.0.1:4321`, gated by the token, data in the `fein-data` volume.
The container **refuses to start without a token** — there is no accidentally
public install.

Check it: `curl http://127.0.0.1:4321/api/health` → `{"ok":true,...}`.

## TLS + a real hostname (recommended)

Keep the default loopback publish and put Caddy in front — it handles
certificates automatically:

```bash
apt install caddy    # or the distro equivalent
```

`/etc/caddy/Caddyfile`:

```
fein.clientfund.com {
    reverse_proxy 127.0.0.1:4321
}
```

`systemctl reload caddy`, and the dashboard is at
`https://fein.clientfund.com` (the login page asks for the token once per
browser; the cookie is HttpOnly and lasts 30 days).

## Connecting agents

```bash
claude mcp add --transport http fein https://fein.clientfund.com/mcp \
  --header "Authorization: Bearer <FEIN_AUTH_TOKEN>"
```

Append `?as=<member>` to the URL to bind an agent to one member's private
layer. Claude Desktop: Settings → Connectors → same URL, same header.

## Loading the client's data

Everything works from the dashboard's **Data** tab: drag in a Gmail `.mbox`
export, a calendar `.ics`, a CRM `.csv`, or paste an Attio API key and sync.
For privacy-sensitive clients set `FEIN_NO_BODIES=1` in `.env` before the
first ingest — Fein then stores participants and metadata only, never message
bodies. The trust model is documented in the README's privacy section; walk
the client through it before the first real ingest.

CLI ingests inside the container:

```bash
docker compose exec fein node src/cli.js ingest /data/inbox.mbox --as "Jane Doe"
```

(Embedded mode is single-process: prefer dashboard uploads while the server
is up, or use the Postgres profile.)

## Bigger installs: real Postgres

Past ~100k documents, or when several processes need the database at once:

```bash
docker compose --profile postgres up -d
```

and uncomment `DATABASE_URL` in `docker-compose.yml`. Migrating an existing
embedded install: re-ingest the sources (ingestion is idempotent; review
decisions and merges replay).

## Backups

Embedded mode — snapshot the volume (stop first; PGlite is a live database):

```bash
docker compose stop fein
docker run --rm -v fein_fein-data:/data -v "$PWD":/backup debian \
  tar czf /backup/fein-backup-$(date +%F).tar.gz -C /data .
docker compose start fein
```

Postgres mode: `docker compose exec db pg_dump -U fein fein | gzip > backup.sql.gz`.

Restores are the reverse. Test one before calling the deployment done.

## Upgrades

```bash
git pull && docker compose build && docker compose up -d
```

The database schema is created/upgraded on boot; review decisions, merges,
and settings survive.

## Bare metal (no Docker)

```bash
FEIN_AUTH_TOKEN=$(openssl rand -hex 24) FEIN_HOST=0.0.0.0 npm start
```

Same rules apply: non-loopback binds require the token (`FEIN_INSECURE=1`
overrides, only behind a VPN/firewall you trust). Data lands in
`./data/fein`; back that directory up.

## The security surface, in one paragraph

One shared token gates the dashboard, the API, and MCP (per-member *view*
scoping is separate: `?as=` / the viewer switch). `/api/health` is the only
open route and returns version + uptime only. The server sets CSP and
no-store headers, never returns stack traces, and binds loopback unless told
otherwise. Rotate the token by changing `.env` and `docker compose up -d`;
old cookies and agent configs stop working immediately.
