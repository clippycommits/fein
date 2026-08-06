import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

/**
 * Minimal Google OAuth (loopback flow) + REST client — no googleapis dep.
 * Needs a Desktop-app OAuth client JSON from Google Cloud Console; point
 * GOOGLE_OAUTH_CREDENTIALS at it. Tokens cache in ~/.fein/ (a legacy
 * ~/.fundgraph/ is honored if present).
 * If you already use the gog CLI, prefer the gog adapter — no setup at all.
 */

export const SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/drive.metadata.readonly",
];

const CONFIG_DIR = existsSync(join(homedir(), ".fundgraph"))
  ? join(homedir(), ".fundgraph")
  : join(homedir(), ".fein");
const TOKEN_PATH = join(CONFIG_DIR, "google-token.json");

function loadCreds() {
  const path = process.env.GOOGLE_OAUTH_CREDENTIALS;
  if (!path) {
    throw new Error(
      "set GOOGLE_OAUTH_CREDENTIALS to a Desktop-app OAuth client JSON " +
      "(Google Cloud Console -> APIs & Services -> Credentials), " +
      "or use the gog adapter which needs no Google Cloud setup"
    );
  }
  const raw = JSON.parse(readFileSync(path, "utf8"));
  const c = raw.installed ?? raw.web ?? raw;
  if (!c.client_id || !c.client_secret) throw new Error(`no client_id/client_secret in ${path}`);
  return c;
}

function loadToken() {
  try {
    return JSON.parse(readFileSync(TOKEN_PATH, "utf8"));
  } catch {
    return null;
  }
}

function saveToken(token) {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(TOKEN_PATH, JSON.stringify(token, null, 2));
}

async function tokenRequest(params) {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`token endpoint ${res.status}: ${JSON.stringify(body)}`);
  return body;
}

async function loopbackConsent(creds) {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const redirect = `http://127.0.0.1:${server.address().port}`;
      const url =
        "https://accounts.google.com/o/oauth2/v2/auth?" +
        new URLSearchParams({
          client_id: creds.client_id,
          redirect_uri: redirect,
          response_type: "code",
          scope: SCOPES.join(" "),
          access_type: "offline",
          prompt: "consent",
        }).toString();
      console.error(`\nOpen this URL to authorize Fein (read-only scopes):\n\n  ${url}\n`);
      spawn("open", [url], { stdio: "ignore" }).on("error", () => {});
      server.on("request", async (req, res) => {
        const params = new URL(req.url, redirect).searchParams;
        const code = params.get("code");
        const error = params.get("error");
        if (error) {
          res.end(`authorization failed: ${error} — you can close this tab.`);
          server.close();
          reject(new Error(`Google authorization was refused (${error})`));
          return;
        }
        res.end(code ? "Fein authorized — you can close this tab." : "missing code");
        if (!code) return;
        server.close();
        try {
          const token = await tokenRequest({
            code,
            client_id: creds.client_id,
            client_secret: creds.client_secret,
            redirect_uri: redirect,
            grant_type: "authorization_code",
          });
          resolve(token);
        } catch (err) {
          reject(err);
        }
      });
    });
    server.on("error", reject);
  });
}

export async function authorize() {
  const creds = loadCreds();
  let token = loadToken();
  const expired = !token || !token.expiry || token.expiry < Date.now() + 60_000;
  if (!expired) return token.access_token;

  if (token?.refresh_token) {
    try {
      const fresh = await tokenRequest({
        refresh_token: token.refresh_token,
        client_id: creds.client_id,
        client_secret: creds.client_secret,
        grant_type: "refresh_token",
      });
      token = { ...token, ...fresh, expiry: Date.now() + fresh.expires_in * 1000 };
      saveToken(token);
      return token.access_token;
    } catch (err) {
      console.error(`token refresh failed (${err.message}) — re-running consent`);
    }
  }
  // No usable token: run (or re-run) the consent flow.
  const fresh = await loopbackConsent(creds);
  token = { ...fresh, expiry: Date.now() + fresh.expires_in * 1000 };
  saveToken(token);
  return token.access_token;
}

export async function apiGet(accessToken, url) {
  const res = await fetch(url, { headers: { authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`${url.split("?")[0]} -> ${res.status}: ${await res.text()}`);
  return res.json();
}
