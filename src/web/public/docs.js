// CSP-pure docs renderer: no inline script/style, no CDN. Fetches the authed
// OpenAPI document (same-origin, session cookie) and renders the grouped
// operation list. All styling is applied via the CSSOM (element.style), which
// the strict `style-src 'self'` CSP permits — the same mechanism d3 uses in the
// dashboard. Colours reuse /style.css design tokens plus fein's single accent.
const ACCENT = "#0070F3";
const css = (el, styles) => { for (const k in styles) el.style.setProperty(k, styles[k]); return el; };
const make = (tag, styles, text) => {
  const el = document.createElement(tag);
  if (styles) css(el, styles);
  if (text != null) el.textContent = text;
  return el;
};

function page() {
  css(document.body, {
    display: "block", height: "auto", overflow: "auto",
    background: "var(--plane)", color: "var(--ink)", padding: "0",
  });
  const main = document.getElementById("docs");
  css(main, { "max-width": "860px", margin: "0 auto", padding: "3rem 1.5rem 6rem" });
  css(document.querySelector(".docs-head h1"), {
    "font-size": "1.4rem", "font-weight": "600", "letter-spacing": "-0.01em", margin: "0",
  });
  css(document.getElementById("tagline"), { color: "var(--muted)", margin: ".25rem 0 0", "font-size": ".9rem" });
}

const METHOD_COLOR = { GET: ACCENT, POST: "var(--good-text)", DELETE: "var(--critical)", PUT: "var(--warning)" };

function badge(method) {
  return make("span", {
    display: "inline-block", "min-width": "48px", "text-align": "center",
    "font-size": ".68rem", "font-weight": "700", "letter-spacing": ".04em",
    padding: ".2rem .45rem", "border-radius": "5px", color: "#fff",
    background: METHOD_COLOR[method] || "var(--muted)", "font-family": "system-ui, sans-serif",
  }, method);
}

function paramList(op) {
  const params = op.parameters || [];
  const hasBody = op.requestBody != null;
  if (!params.length && !hasBody) return null;
  const wrap = make("div", { "margin-top": ".55rem", "font-size": ".82rem", color: "var(--ink-2)" });
  for (const p of params) {
    const row = make("div", { "margin-top": ".15rem" });
    const nm = make("code", { color: "var(--ink)" }, p.name);
    row.appendChild(nm);
    row.appendChild(make("span", { color: "var(--muted)" },
      `  ${p.in}${p.required ? " · required" : ""}${p.description ? " — " + p.description : ""}`));
    wrap.appendChild(row);
  }
  if (hasBody) {
    const row = make("div", { "margin-top": ".15rem" });
    row.appendChild(make("code", { color: "var(--ink)" }, "body"));
    row.appendChild(make("span", { color: "var(--muted)" }, "  application/json"));
    wrap.appendChild(row);
  }
  return wrap;
}

function operation(pathKey, method, op) {
  const card = make("div", {
    border: "1px solid var(--border)", "border-radius": "10px",
    padding: "1rem 1.1rem", "margin-top": ".7rem", background: "var(--surface)",
  });
  const head = make("div", { display: "flex", "align-items": "center", gap: ".7rem", "flex-wrap": "wrap" });
  head.appendChild(badge(method.toUpperCase()));
  head.appendChild(make("code", {
    "font-size": ".92rem", color: "var(--ink)", "font-weight": "600", "word-break": "break-all",
  }, pathKey));
  card.appendChild(head);
  if (op.summary) card.appendChild(make("p", { margin: ".5rem 0 0", color: "var(--ink-2)", "font-size": ".9rem" }, op.summary));
  const pl = paramList(op);
  if (pl) card.appendChild(pl);
  return card;
}

function render(spec) {
  page();
  document.getElementById("tagline").textContent =
    `${spec.info.title} · v${spec.info.version}`;
  const status = document.getElementById("status");
  const groups = document.getElementById("groups");
  status.remove();

  // Bucket operations by their first tag, in the spec's declared tag order.
  const order = (spec.tags || []).map((t) => t.name);
  const buckets = new Map(order.map((n) => [n, []]));
  for (const [pathKey, item] of Object.entries(spec.paths)) {
    for (const method of Object.keys(item)) {
      const op = item[method];
      const tag = (op.tags && op.tags[0]) || "Other";
      if (!buckets.has(tag)) buckets.set(tag, []);
      buckets.get(tag).push([pathKey, method, op]);
    }
  }

  for (const [name, ops] of buckets) {
    if (!ops.length) continue;
    const section = make("section", { "margin-top": "2.4rem" });
    section.appendChild(make("h2", {
      "font-size": "1rem", "font-weight": "600", margin: "0",
      "padding-bottom": ".4rem", "border-bottom": `2px solid ${ACCENT}`, display: "inline-block",
    }, name));
    const desc = (spec.tags || []).find((t) => t.name === name)?.description;
    if (desc) section.appendChild(make("p", { color: "var(--muted)", "font-size": ".85rem", margin: ".4rem 0 0" }, desc));
    for (const [pathKey, method, op] of ops) section.appendChild(operation(pathKey, method, op));
    groups.appendChild(section);
  }
}

async function load() {
  try {
    const res = await fetch("/api/v1/openapi.json", { headers: { accept: "application/json" } });
    if (!res.ok) {
      document.getElementById("status").textContent =
        res.status === 401 ? "Sign in to view the API reference." : `Could not load the spec (${res.status}).`;
      return;
    }
    render(await res.json());
  } catch (err) {
    document.getElementById("status").textContent = "Could not load the API reference.";
    console.error(err);
  }
}

load();
