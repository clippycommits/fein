/**
 * Auth gate tests: FEIN_AUTH_TOKEN must gate every surface (API, MCP, pages,
 * static) while /api/health stays open for healthchecks, and both credential
 * flavors (Bearer for agents, cookie for browsers) must work. Also proves the
 * server refuses non-loopback binds without a token.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const dataDir = mkdtempSync(join(tmpdir(), "fein-auth-test-"));
const PORT = 4521;
const TOKEN = "test-token-correct-horse";
let failures = 0;

const ok = (cond, label) => {
  console.log(`  ${cond ? "ok " : "FAIL"} ${label}`);
  if (!cond) failures++;
};

function startServer(extraEnv) {
  return spawn(process.execPath, ["src/cli.js", "web", String(PORT)], {
    env: { ...process.env, FEIN_DATA: dataDir, ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function waitForServer() {
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`http://localhost:${PORT}/api/health`);
      if (res.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("server did not come up");
}

const server = startServer({ FEIN_AUTH_TOKEN: TOKEN });
try {
  await waitForServer();

  console.log("Without credentials:");
  ok((await fetch(`http://localhost:${PORT}/api/health`)).status === 200, "/api/health stays open");
  ok((await fetch(`http://localhost:${PORT}/api/stats`)).status === 401, "API is 401");
  ok(
    (await fetch(`http://localhost:${PORT}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 1 }),
    })).status === 401,
    "MCP is 401",
  );
  const page = await fetch(`http://localhost:${PORT}/`, { redirect: "manual" });
  ok(page.status === 302 && page.headers.get("location") === "/login", "pages redirect to /login");
  ok((await fetch(`http://localhost:${PORT}/app.js`, { redirect: "manual" })).status === 302, "static is gated too");

  console.log("Login flow:");
  ok((await fetch(`http://localhost:${PORT}/login`)).status === 200, "login page renders");
  ok((await fetch(`http://localhost:${PORT}/login?token=wrong`)).status === 401, "wrong token rejected");
  const login = await fetch(`http://localhost:${PORT}/login?token=${TOKEN}`, { redirect: "manual" });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
  ok(login.status === 302 && cookie.startsWith("fein_auth="), "right token sets cookie + redirects");
  ok(/HttpOnly/i.test(login.headers.get("set-cookie") ?? ""), "cookie is HttpOnly");
  ok(
    (await fetch(`http://localhost:${PORT}/api/stats`, { headers: { cookie } })).status === 200,
    "cookie unlocks the API",
  );

  console.log("Proxied deployment (writes behind a hostname):");
  {
    const put = (headers) => fetch(`http://localhost:${PORT}/api/settings`, {
      method: "PUT",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", ...headers },
      body: "{}",
    });
    ok((await put({ origin: "https://fein.client.example", "x-forwarded-host": "fein.client.example" })).status === 200,
      "same-origin write behind a proxy hostname works");
    ok((await put({ origin: "https://evil.example", "x-forwarded-host": "fein.client.example" })).status === 403,
      "cross-origin write is still refused");
    ok((await put({})).status === 200, "no-Origin write (curl/SDK) works with auth");
  }

  console.log("Bearer flow:");
  ok(
    (await fetch(`http://localhost:${PORT}/api/stats`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    })).status === 200,
    "bearer unlocks the API",
  );
  ok(
    (await fetch(`http://localhost:${PORT}/api/stats`, {
      headers: { authorization: "Bearer nope" },
    })).status === 401,
    "wrong bearer rejected",
  );
} finally {
  const gone = new Promise((r) => server.on("exit", r));
  server.kill();
  await gone; // free the port before the bind-guard servers reuse it
}

console.log("Bind guard:");
{
  // Non-loopback bind with no token must refuse to start.
  const bad = startServer({ FEIN_HOST: "0.0.0.0", FEIN_AUTH_TOKEN: "" });
  const code = await new Promise((r) => bad.on("exit", r));
  ok(code === 1, "0.0.0.0 without a token refuses to start");
  const good = startServer({ FEIN_HOST: "0.0.0.0", FEIN_AUTH_TOKEN: TOKEN });
  try {
    await waitForServer();
    ok(true, "0.0.0.0 with a token starts");
  } finally {
    const gone = new Promise((r) => good.on("exit", r));
    good.kill();
    await gone; // PGlite must release the data dir before we remove it
  }
}

rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
if (failures) {
  console.error(`\n${failures} AUTH TEST(S) FAILED`);
  process.exit(1);
}
console.log("\nAUTH TESTS PASSED");
