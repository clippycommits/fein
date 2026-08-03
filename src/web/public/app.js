/* global d3 */
const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const pct = (x) => `${Math.round(x * 100)}%`;

function toast(msg, kind = "") {
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.textContent = msg;
  $("#toasts").appendChild(el);
  setTimeout(() => el.remove(), 4200);
}

async function api(path, opts) {
  let res;
  try {
    res = await fetch(path, opts);
  } catch {
    toast("fundgraph server is not reachable — is it still running?", "err");
    throw new Error("network");
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    // Surface every failure — a silent dead button is worse than an error.
    const msg = body.error ?? res.statusText;
    toast(msg, "err");
    throw new Error(msg);
  }
  return body;
}

/* ---------- theme ---------- */
$("#theme-toggle").addEventListener("click", () => {
  const cur = document.documentElement.dataset.theme;
  const next = cur === "dark" ? "light" : cur === "light" ? "dark"
    : matchMedia("(prefers-color-scheme: dark)").matches ? "light" : "dark";
  document.documentElement.dataset.theme = next;
});

/* ---------- tabs ---------- */
for (const tab of document.querySelectorAll(".tab")) {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
    tab.classList.add("active");
    $(`#tab-${tab.dataset.tab}`).classList.add("active");
    if (tab.dataset.tab === "reviews") renderReviews();
    if (tab.dataset.tab === "data") renderData();
    if (tab.dataset.tab === "settings") renderSettings();
  });
}

/* ---------- keyboard ---------- */
addEventListener("keydown", (ev) => {
  if (ev.key === "/" && !/INPUT|TEXTAREA/.test(document.activeElement?.tagName)) {
    ev.preventDefault();
    document.querySelector('[data-tab="explore"]').click();
    $("#search").focus();
  }
  if (ev.key === "Escape") highlightPath([]);
});

/* ---------- stat tiles ---------- */
let onboardingDismissed = false;

async function renderStats() {
  const s = await api("/api/stats");
  const tiles = [
    ["Documents", s.documents],
    ["People & orgs", s.entities],
    ["Connections", s.edges],
    ["Reviews", s.pendingReviews, s.pendingReviews > 0],
  ];
  $("#tiles").innerHTML = tiles
    .map(([l, v, warn]) =>
      `<div class="tile${warn ? " warn" : ""}"><div class="v">${v}</div><div class="l">${l}</div></div>`)
    .join("");
  const chip = $("#review-count");
  chip.hidden = !s.pendingReviews;
  chip.textContent = s.pendingReviews;
  $("#onboarding").hidden = onboardingDismissed || s.documents > 0;
  return s;
}

/* ---------- graph ---------- */
let graphData = { nodes: [], links: [] };
let simulation = null;
let zoomBehavior = null;
const nameToId = new Map();

async function renderGraph() {
  $("#graph-loading").hidden = false;
  try {
    graphData = await api("/api/graph");
  } finally {
    $("#graph-loading").hidden = true;
  }
  nameToId.clear();
  const list = $("#people-list");
  list.innerHTML = "";
  for (const n of graphData.nodes) {
    nameToId.set(n.name.toLowerCase(), n.id);
    const opt = document.createElement("option");
    opt.value = n.name;
    list.appendChild(opt);
  }

  const svg = d3.select("#graph");
  svg.selectAll("*").remove();
  const { width, height } = svg.node().getBoundingClientRect();
  const root = svg.append("g");
  zoomBehavior = d3.zoom().scaleExtent([0.2, 4]).on("zoom", (ev) => root.attr("transform", ev.transform));
  svg.call(zoomBehavior);
  // The svg node keeps its old __zoom across re-renders; re-apply it through
  // the new behavior so the next gesture doesn't jump the viewport.
  svg.call(zoomBehavior.transform, d3.zoomTransform(svg.node()));

  const link = root.append("g").selectAll("line")
    .data(graphData.links).join("line")
    .attr("class", "link")
    .attr("stroke-width", (d) => 1 + d.strength * 4);

  const node = root.append("g").selectAll("g")
    .data(graphData.nodes).join("g")
    .attr("class", "node")
    .call(d3.drag()
      .on("start", (ev, d) => { if (!ev.active) simulation.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; })
      .on("drag", (ev, d) => { d.fx = ev.x; d.fy = ev.y; })
      .on("end", (ev, d) => { if (!ev.active) simulation.alphaTarget(0); d.fx = d.fy = null; }));

  node.append("circle").attr("r", (d) => 6 + Math.min(10, d.degree * 1.6));
  node.append("text")
    .attr("dx", (d) => 9 + Math.min(10, d.degree * 1.6))
    .attr("dy", 4)
    .text((d) => d.name);

  const tooltip = $("#tooltip");
  node
    .on("mousemove", (ev, d) => {
      tooltip.hidden = false;
      tooltip.style.left = `${ev.offsetX + 14}px`;
      tooltip.style.top = `${ev.offsetY + 14}px`;
      tooltip.innerHTML =
        `<div class="t-name">${esc(d.name)}</div>` +
        `<div class="t-sub">${esc(d.orgs.join(", ") || "no org on record")} · ${d.degree} connection${d.degree === 1 ? "" : "s"}</div>`;
    })
    .on("mouseleave", () => { tooltip.hidden = true; })
    .on("click", (ev, d) => showBrief(d.id));

  link
    .on("mousemove", (ev, d) => {
      tooltip.hidden = false;
      tooltip.style.left = `${ev.offsetX + 14}px`;
      tooltip.style.top = `${ev.offsetY + 14}px`;
      const sig = Object.entries(d.signals).map(([k, v]) => `${v} ${esc(k)}${v === 1 ? "" : "s"}`).join(", ");
      tooltip.innerHTML =
        `<div class="t-name">${esc(d.source.name)} ↔ ${esc(d.target.name)}</div>` +
        `<div class="t-sub">strength ${pct(d.strength)} · ${sig}</div>`;
    })
    .on("mouseleave", () => { tooltip.hidden = true; });

  simulation = d3.forceSimulation(graphData.nodes)
    .force("link", d3.forceLink(graphData.links).id((d) => d.id)
      .distance((d) => 80 + (1 - d.strength) * 160))
    .force("charge", d3.forceManyBody().strength(-420))
    .force("center", d3.forceCenter(width / 2, height / 2))
    .force("collide", d3.forceCollide(26))
    .on("tick", () => {
      link.attr("x1", (d) => d.source.x).attr("y1", (d) => d.source.y)
        .attr("x2", (d) => d.target.x).attr("y2", (d) => d.target.y);
      node.attr("transform", (d) => `translate(${d.x},${d.y})`);
    });
}

function zoomTo(entityId) {
  const d = graphData.nodes.find((n) => n.id === entityId);
  if (!d || d.x === undefined) return;
  const svg = d3.select("#graph");
  const { width, height } = svg.node().getBoundingClientRect();
  svg.transition().duration(500).call(
    zoomBehavior.transform,
    d3.zoomIdentity.translate(width / 2 - d.x * 1.4, height / 2 - d.y * 1.4).scale(1.4)
  );
}

function fitView() {
  if (!graphData.nodes.length || graphData.nodes[0].x === undefined) return;
  const xs = graphData.nodes.map((n) => n.x);
  const ys = graphData.nodes.map((n) => n.y);
  const pad = 60;
  const [minX, maxX] = [Math.min(...xs) - pad, Math.max(...xs) + pad];
  const [minY, maxY] = [Math.min(...ys) - pad, Math.max(...ys) + pad];
  const svg = d3.select("#graph");
  const { width, height } = svg.node().getBoundingClientRect();
  const scale = Math.min(2.5, 0.95 * Math.min(width / (maxX - minX), height / (maxY - minY)));
  svg.transition().duration(500).call(
    zoomBehavior.transform,
    d3.zoomIdentity
      .translate(width / 2 - ((minX + maxX) / 2) * scale, height / 2 - ((minY + maxY) / 2) * scale)
      .scale(scale)
  );
}
$("#zoom-fit").addEventListener("click", fitView);
$("#zoom-in").addEventListener("click", () => {
  if (zoomBehavior) d3.select("#graph").transition().call(zoomBehavior.scaleBy, 1.35);
});
$("#zoom-out").addEventListener("click", () => {
  if (zoomBehavior) d3.select("#graph").transition().call(zoomBehavior.scaleBy, 1 / 1.35);
});

function highlightPath(ids) {
  const onPath = new Set(ids);
  const hops = new Set();
  for (let i = 0; i + 1 < ids.length; i++) hops.add([ids[i], ids[i + 1]].sort().join("|"));
  d3.selectAll(".node")
    .classed("on-path", (d) => onPath.has(d.id))
    .classed("dim", (d) => onPath.size > 0 && !onPath.has(d.id));
  d3.selectAll("line.link")
    .classed("on-path", (d) => hops.has([d.source.id, d.target.id].sort().join("|")))
    .classed("dim", (d) => onPath.size > 0 && !hops.has([d.source.id, d.target.id].sort().join("|")));
}

/* ---------- search + brief ---------- */
let searchTimer = null;
$("#search").addEventListener("input", (ev) => {
  clearTimeout(searchTimer);
  const q = ev.target.value.trim();
  if (!q) { $("#search-results").innerHTML = ""; return; }
  searchTimer = setTimeout(async () => {
    const results = await api(`/api/search?q=${encodeURIComponent(q)}`);
    $("#search-results").innerHTML = results.length ? results.map((r) =>
      `<div class="result-row" data-id="${esc(r.id)}">
         <div>${esc(r.canonical_name)} ${r.kind === "org" ? "· <span class='sub'>org</span>" : ""}</div>
         <div class="sub">${esc([...r.orgs, ...r.emails].slice(0, 2).join(" · "))}</div>
       </div>`).join("") : `<div class="empty"><p>No matches for “${esc(q)}”.</p></div>`;
    for (const row of document.querySelectorAll("#search-results .result-row")) {
      row.addEventListener("click", () => showBrief(row.dataset.id));
    }
  }, 150);
});

let currentBrief = null;

async function showBrief(id) {
  const b = await api(`/api/entity/${id}`);
  currentBrief = b;
  highlightPath([id]);
  zoomTo(id);
  const e = b.entity;
  $("#brief").innerHTML =
    `<h2>${esc(e.canonical_name)}</h2>
     <div class="sub">${esc([...e.orgs, ...e.emails].join(" · "))}</div>
     <div class="brief-actions"><button class="small" id="copy-brief">Copy brief as Markdown</button></div>
     <h3 class="section-title">Strongest connections</h3>` +
    (b.connections.length ? b.connections.map((c) =>
      `<div class="conn" data-id="${esc(c.entity)}">
         <span class="grow">${esc(c.name)}</span>
         <span class="bar-wrap"><span class="bar" data-w="${pct(c.strength)}"></span></span>
         <span class="pct">${pct(c.strength)}</span>
       </div>`).join("") : `<div class="empty"><p>No scored relationships yet.</p></div>`) +
    `<h3 class="section-title">Recent documents</h3>` +
    (b.recentDocuments.length ? b.recentDocuments.map((d) =>
      `<div class="doc-row">${esc(d.title ?? "(untitled)")} <span class="src">· ${esc(d.source)}${d.occurred_at ? " · " + esc(d.occurred_at.slice(0, 10)) : ""}</span></div>`).join("") : `<div class="empty"><p>None.</p></div>`);
  // CSSOM writes aren't governed by style-src, unlike parsed style attributes.
  for (const bar of document.querySelectorAll("#brief .bar")) bar.style.width = bar.dataset.w;
  for (const row of document.querySelectorAll("#brief .conn")) {
    row.addEventListener("click", () => showBrief(row.dataset.id));
  }
  $("#copy-brief").addEventListener("click", copyBrief);
  document.querySelector('[data-tab="explore"]').click();
}

async function copyBrief() {
  if (!currentBrief) return;
  const b = currentBrief;
  const md = [
    `# ${b.entity.canonical_name}`,
    ``,
    `${[...b.entity.orgs, ...b.entity.emails].join(" · ")}`,
    ``,
    `## Strongest connections`,
    ...b.connections.map((c) => {
      const sig = Object.entries(c.signals ?? {}).map(([k, v]) => `${v} ${k}${v === 1 ? "" : "s"}`).join(", ");
      return `- **${c.name}** — ${pct(c.strength)}${sig ? ` (${sig})` : ""}`;
    }),
    ``,
    `## Recent documents`,
    ...b.recentDocuments.map((d) =>
      `- ${d.title ?? "(untitled)"} — ${d.source}${d.occurred_at ? `, ${d.occurred_at.slice(0, 10)}` : ""}`),
    ``,
    `*Generated by fundgraph*`,
  ].join("\n");
  await navigator.clipboard.writeText(md);
  toast("Brief copied as Markdown", "good");
}

/* ---------- warm path ---------- */
$("#find-path").addEventListener("click", async () => {
  const from = nameToId.get($("#path-from").value.trim().toLowerCase());
  const to = nameToId.get($("#path-to").value.trim().toLowerCase());
  const out = $("#path-result");
  if (!from || !to) { out.innerHTML = `<div class="empty"><p>Pick two people from the suggestions.</p></div>`; return; }
  const { path, introducers } = await api(`/api/path?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
  let html = "";
  if (!path) {
    html += `<div class="empty"><p>No connecting path found within 4 hops.</p></div>`;
    highlightPath([]);
  } else {
    highlightPath(path.path.map((s) => s.entity));
    html += `<div class="path-strength">path strength <strong>${pct(path.pathStrength)}</strong></div>`;
    html += path.path.map((s, i) =>
      `<div class="hop">${i ? `<span class="arrow">→</span><span class="pct">${pct(s.viaStrength)}</span>` : ""}
         <span>${esc(s.name)}</span></div>`).join("");
  }
  if (introducers.length) {
    html += `<h3 class="section-title">Best introducers</h3>`;
    html += introducers.map((i) =>
      `<div class="conn"><span class="grow">${esc(i.name)}</span>
        <span class="pct">${pct(i.strengthToYou)} / ${pct(i.strengthToTarget)}</span></div>`).join("");
  }
  out.innerHTML = html;
});

/* ---------- review queue ---------- */
async function renderReviews() {
  const reviews = await api("/api/reviews");
  $("#reviews").innerHTML = reviews.length ? reviews.map((r) =>
    `<div class="review">
       <div><span class="score">⚠ ${r.score.toFixed(2)}</span> — is this the same person?</div>
       <div class="vs"><strong>${esc(r.mention_name ?? r.mention_email)}</strong>
         ${r.mention_email ? `&lt;${esc(r.mention_email)}&gt;` : ""}
         (in “${esc(r.doc_title ?? r.doc_source)}”)<br>vs entity
         <strong>${esc(r.candidate_name)}</strong></div>
       <div class="actions">
         <button class="accept" data-id="${esc(r.id)}" data-d="accept">✓ Same person</button>
         <button class="reject" data-id="${esc(r.id)}" data-d="reject">✗ Different</button>
       </div>
     </div>`).join("") : `<div class="empty"><p>Queue is empty — everything resolved deterministically.</p></div>`;
  for (const btn of document.querySelectorAll("#reviews button")) {
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      await api(`/api/reviews/${encodeURIComponent(btn.dataset.id)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision: btn.dataset.d }),
      });
      toast(btn.dataset.d === "accept" ? "Identities merged" : "Kept as separate people", "good");
      await Promise.all([renderReviews(), renderStats(), renderGraph()]);
    });
  }
}

/* ---------- data tab ---------- */
async function renderData() {
  const [docs, audit] = await Promise.all([api("/api/documents"), api("/api/audit?limit=15")]);
  $("#sources").innerHTML = docs.sources.length
    ? `<table class="mini"><tr><th>Source</th><th>Kinds</th><th class="num">Docs</th><th>Latest</th></tr>` +
      docs.sources.map((s) =>
        `<tr><td>${esc(s.source)}</td>
           <td>${esc(Object.entries(s.kinds).map(([k, v]) => `${v} ${k}`).join(", "))}</td>
           <td class="num">${s.count}</td>
           <td>${s.latest ? esc(s.latest.slice(0, 10)) : "—"}</td></tr>`).join("") + `</table>`
    : `<div class="empty"><p>Nothing ingested yet.</p></div>`;
  $("#audit").innerHTML = audit.length ? audit.map((a) =>
    `<div class="audit-row"><span class="when">${esc(String(a.at).slice(0, 16).replace("T", " "))}</span>
       · ${esc(a.action)}${a.detail?.file ? ` · ${esc(a.detail.file)}` : ""}${a.detail?.mention?.name ? ` · ${esc(a.detail.mention.name)}` : ""}</div>`).join("")
    : `<div class="empty"><p>No activity recorded yet.</p></div>`;
}

/* ---------- settings tab ---------- */
const WEIGHT_LABELS = {
  meeting: "Meeting notes (per meeting)",
  event: "Calendar co-attendance",
  email: "Direct email (from ↔ to)",
  emailCc: "Cc'd on an email",
  doc: "Co-authored document",
  note: "Shared note",
  record: "CRM co-mention",
  mentionedFactor: "Merely-mentioned multiplier",
};

async function renderSettings() {
  const [s, health] = await Promise.all([api("/api/settings"), api("/api/health")]);
  $("#settings-form").innerHTML =
    Object.entries(s.weights).map(([k, v]) =>
      `<div class="weight-row"><label for="w-${esc(k)}">${esc(WEIGHT_LABELS[k] ?? k)}</label>
         <input id="w-${esc(k)}" name="${esc(k)}" type="number" step="0.1" min="0" max="100" value="${esc(v)}"></div>`).join("") +
    `<div class="weight-row"><label for="w-halfLifeDays">Recency half-life (days)</label>
       <input id="w-halfLifeDays" name="halfLifeDays" type="number" step="1" min="1" max="3650" value="${esc(s.halfLifeDays)}"></div>
     <div class="weight-row"><label for="w-saturation">Evidence saturation</label>
       <input id="w-saturation" name="saturation" type="number" step="0.5" min="0.5" max="100" value="${esc(s.saturation)}"></div>`;
  $("#about").textContent = `fundgraph v${health.version} · up ${Math.floor(health.uptimeSeconds / 60)}m · MIT licensed`;
}

$("#save-settings").addEventListener("click", async () => {
  const patch = { weights: {} };
  for (const input of document.querySelectorAll("#settings-form input")) {
    const v = Number(input.value);
    if (input.name === "halfLifeDays") patch.halfLifeDays = v;
    else if (input.name === "saturation") patch.saturation = v;
    else patch.weights[input.name] = v;
  }
  const btn = $("#save-settings");
  btn.disabled = true;
  try {
    const res = await api("/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    });
    toast(`Saved — graph rebuilt (${res.edges.edges} connections)`, "good");
    await Promise.all([renderStats(), renderGraph()]);
  } finally {
    btn.disabled = false;
  }
});

$("#reresolve").addEventListener("click", async () => {
  if (!confirm("Re-run entity resolution from scratch? Pending review questions will be re-asked.")) return;
  const btn = $("#reresolve");
  btn.disabled = true;
  try {
    const res = await api("/api/reresolve", { method: "POST" });
    toast(`Rebuilt: ${res.stats.entities} entities, ${res.stats.edges} connections`, "good");
    await Promise.all([renderStats(), renderGraph()]);
  } finally {
    btn.disabled = false;
  }
});

/* ---------- ingest ---------- */
const dz = $("#dropzone");
dz.addEventListener("click", () => $("#file-input").click());
dz.addEventListener("dragover", (ev) => { ev.preventDefault(); dz.classList.add("over"); });
dz.addEventListener("dragleave", () => dz.classList.remove("over"));
dz.addEventListener("drop", (ev) => {
  ev.preventDefault();
  dz.classList.remove("over");
  if (ev.dataTransfer.files[0]) uploadFile(ev.dataTransfer.files[0]);
});
$("#file-input").addEventListener("change", (ev) => {
  if (ev.target.files[0]) uploadFile(ev.target.files[0]);
});

async function uploadFile(file) {
  const out = $("#ingest-result");
  out.innerHTML = `ingesting <strong>${esc(file.name)}</strong>…`;
  try {
    const res = await api(`/api/ingest?name=${encodeURIComponent(file.name)}`, {
      method: "POST",
      body: await file.text(),
    });
    out.innerHTML = `<span class="ok">✓</span> ${res.ingested.docCount} docs, ${res.ingested.mentionCount} mentions ·
      resolved ${res.resolved.attached + res.resolved.created}, queued ${res.resolved.queued} for review ·
      ${res.edges.edges} connections`;
    toast(`Ingested ${file.name}`, "good");
    await Promise.all([renderStats(), renderGraph(), renderData()]);
  } catch (err) {
    out.innerHTML = `<span class="err">✗ ${esc(err.message)}</span>`;
  }
}

/* ---------- onboarding ---------- */
$("#ob-sample").addEventListener("click", async () => {
  const btn = $("#ob-sample");
  btn.disabled = true;
  btn.textContent = "Loading…";
  try {
    const res = await api("/api/sample", { method: "POST" });
    $("#onboarding").hidden = true;
    toast(`Sample loaded: ${res.stats.entities} entities, ${res.stats.edges} connections`, "good");
    await Promise.all([renderStats(), renderGraph()]);
    setTimeout(fitView, 1600);
  } finally {
    btn.disabled = false;
    btn.textContent = "Load sample dataset";
  }
});
$("#ob-upload").addEventListener("click", () => {
  onboardingDismissed = true; // a 0-doc upload must not slam the modal back
  $("#onboarding").hidden = true;
  document.querySelector('[data-tab="data"]').click();
  $("#file-input").click();
});

/* ---------- boot ---------- */
(async () => {
  const s = await renderStats();
  await renderGraph();
  if (s.documents > 0) setTimeout(fitView, 1700);
})();
let resizeTimer = null;
addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(async () => {
    await renderGraph();
    setTimeout(fitView, 1500);
  }, 250);
});
