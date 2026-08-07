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
    toast("Fein server is not reachable — is it still running?", "err");
    throw new Error("network");
  }
  const body = await res.json().catch(() => ({}));
  if (res.status === 401) {
    // Session cookie expired or missing — the login page is the only fix.
    location.href = "/login";
    throw new Error("unauthorized");
  }
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
    if (tab.dataset.tab === "radar") renderRadar();
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

/* ---------- viewer (privacy layer) ---------- */
let viewer = localStorage.getItem("fein.viewer") || localStorage.getItem("fundgraph.viewer") || "";
const asParam = (sep = "?") => (viewer ? `${sep}as=${encodeURIComponent(viewer)}` : "");

async function renderViewers() {
  const members = await api("/api/members");
  const sel = $("#viewer");
  // A stored viewer that no longer exists must not silently keep filtering.
  if (viewer && !members.some((m) => m.id === viewer)) {
    viewer = "";
    localStorage.removeItem("fein.viewer");
    localStorage.removeItem("fundgraph.viewer");
  }
  sel.innerHTML = `<option value="">Shared layer only</option>` +
    members.map((m) =>
      `<option value="${esc(m.id)}"${m.id === viewer ? " selected" : ""}>${esc(m.name)}${
        m.documents ? ` (${m.documents})` : ""}</option>`).join("");
  $("#viewer-wrap").hidden = members.length === 0;
  return members;
}

$("#viewer").addEventListener("change", async (ev) => {
  viewer = ev.target.value;
  if (viewer) localStorage.setItem("fein.viewer", viewer);
  else localStorage.removeItem("fein.viewer");
  localStorage.removeItem("fundgraph.viewer"); // legacy key, superseded either way
  const label = ev.target.selectedOptions[0]?.textContent ?? "shared layer";
  toast(`Viewing as ${label}`, "good");
  await Promise.all([renderGraph(), renderStats()]);
  $("#brief").innerHTML = `<div class="empty"><p>Viewing as ${esc(label)}. Search or click a node.</p></div>`;
  $("#path-result").innerHTML = `<div class="empty"><p>Warm paths now reflect this viewer's layers.</p></div>`;
});

/* ---------- stat tiles ---------- */
let onboardingDismissed = false;

async function renderStats() {
  const s = await api(`/api/stats${asParam()}`);
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
    graphData = await api(`/api/graph${asParam()}`);
  } finally {
    $("#graph-loading").hidden = true;
  }
  const meta = $("#graph-meta");
  meta.hidden = !graphData.truncated;
  if (graphData.truncated) {
    meta.textContent = `showing ${graphData.nodes.length} of ${graphData.totalNodes} people — strongest connections first`;
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
    .attr("class", (d) => (d.private ? "link private" : "link"))
    .attr("stroke-width", (d) => 1 + d.strength * 4);

  const node = root.append("g").selectAll("g")
    .data(graphData.nodes).join("g")
    .attr("class", "node")
    .call(d3.drag()
      .on("start", (ev, d) => { if (!ev.active) simulation.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; })
      .on("drag", (ev, d) => { d.fx = ev.x; d.fy = ev.y; })
      .on("end", (ev, d) => { if (!ev.active) simulation.alphaTarget(0); d.fx = d.fy = null; }));

  node.append("circle").attr("r", (d) => 6 + Math.min(10, d.degree * 1.6));
  // On a large graph, labelling every node is unreadable: label the best-
  // connected ones and let hover/selection reveal the rest.
  const LABEL_BUDGET = 28;
  const labelFloor = graphData.nodes.length > LABEL_BUDGET
    ? [...graphData.nodes].sort((a, b) => b.degree - a.degree)[LABEL_BUDGET - 1].degree
    : -1;
  node.append("text")
    .attr("dx", (d) => 9 + Math.min(10, d.degree * 1.6))
    .attr("dy", 4)
    .classed("faint", (d) => d.degree < labelFloor)
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
    .on("click", (ev, d) => showBrief(d.id))
    .on("mouseenter", function () { d3.select(this).raise().select("text").classed("faint", false); });

  link
    .on("mousemove", (ev, d) => {
      tooltip.hidden = false;
      tooltip.style.left = `${ev.offsetX + 14}px`;
      tooltip.style.top = `${ev.offsetY + 14}px`;
      const sig = Object.entries(d.signals ?? {}).map(([k, v]) => `${v} ${esc(k)}${v === 1 ? "" : "s"}`).join(", ");
      tooltip.innerHTML =
        `<div class="t-name">${esc(d.source.name)} ↔ ${esc(d.target.name)}</div>` +
        (d.private
          ? `<div class="t-sub">🔒 in a colleague's private layer — existence only</div>`
          : `<div class="t-sub">strength ${pct(d.strength)} · ${sig}</div>`);
    })
    .on("mouseleave", () => { tooltip.hidden = true; });

  simulation = d3.forceSimulation(graphData.nodes)
    .force("link", d3.forceLink(graphData.links).id((d) => d.id)
      .distance((d) => 80 + (1 - d.strength) * 160))
    .force("charge", d3.forceManyBody().strength(-420))
    .force("center", d3.forceCenter(width / 2, height / 2))
    // Weak pull toward centre: without it, disconnected components (e.g. two
    // unrelated data sources) drift apart until the whole graph is unreadable.
    .force("x", d3.forceX(width / 2).strength(0.045))
    .force("y", d3.forceY(height / 2).strength(0.06))
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
  // Trim outliers: a couple of far-flung 2-node components must not shrink the
  // main cluster to a dot. Fit the 2nd–98th percentile of positions.
  const span = (values) => {
    const sorted = [...values].sort((a, b) => a - b);
    const lo = sorted[Math.floor(sorted.length * 0.02)];
    const hi = sorted[Math.ceil(sorted.length * 0.98) - 1];
    return [lo, hi];
  };
  const [loX, hiX] = span(graphData.nodes.map((n) => n.x));
  const [loY, hiY] = span(graphData.nodes.map((n) => n.y));
  const pad = 60;
  const [minX, maxX] = [loX - pad, hiX + pad];
  const [minY, maxY] = [loY - pad, hiY + pad];
  const svg = d3.select("#graph");
  const { width, height } = svg.node().getBoundingClientRect();
  const scale = Math.max(0.35,
    Math.min(2.5, 0.95 * Math.min(width / (maxX - minX), height / (maxY - minY))));
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
    const results = await api(`/api/search?q=${encodeURIComponent(q)}${asParam("&")}`);
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
  const b = await api(`/api/entity/${encodeURIComponent(id)}${asParam()}`);
  currentBrief = b;
  highlightPath([id]);
  zoomTo(id);
  const e = b.entity;
  $("#brief").innerHTML =
    `<h2>${esc(e.canonical_name)}</h2>
     <div class="sub">${esc([...e.orgs, ...e.emails].join(" · "))}</div>
     ${e.automated
       ? `<p class="hint">🤖 Automated sender — hidden from the radar${
           e.automated_reason ? `: ${esc(e.automated_reason)}` : ""}${
           e.automated_override != null ? " · set by a person" : ""}</p>`
       : ""}
     <div class="brief-actions">
       <button class="small" id="copy-brief">Copy brief as Markdown</button>
       <button class="small" id="merge-into">Merge a duplicate…</button>
       <button class="small" id="toggle-automated">${
         e.automated ? "Not a robot — mark human" : "Mark as automated sender"}</button>
     </div>
     <h3 class="section-title">Strongest connections</h3>` +
    (b.connections.length ? b.connections.map((c) =>
      `<div class="conn" data-id="${esc(c.entity)}">
         <span class="grow">${esc(c.name)}</span>
         <span class="bar-wrap"><span class="bar" data-w="${pct(c.strength)}"></span></span>
         <span class="pct">${pct(c.strength)}</span>
       </div>`).join("") : `<div class="empty"><p>No scored relationships yet.</p></div>`) +
    (b.deals?.length
      ? `<h3 class="section-title">Fund memory · deal history</h3>` + b.deals.map((d) =>
        `<div class="doc-row">
           <strong class="${d.status === "invested" ? "ok" : d.status === "passed" ? "err" : ""}">${esc(d.status.toUpperCase())}</strong>
           ${d.stage ? ` · ${esc(d.stage)}` : ""}
           <span class="src">· ${esc(d.document_title ?? "")}${d.occurred_at ? " · " + esc(String(d.occurred_at).slice(0, 10)) : ""}</span>
           ${d.summary ? `<br><span class="sub">${esc(d.summary)}</span>` : ""}
         </div>`).join("")
      : "") +
    `<h3 class="section-title">Recent documents</h3>` +
    (b.withheldDocuments
      ? `<p class="hint">🔒 ${b.withheldDocuments} document${b.withheldDocuments === 1 ? "" : "s"} withheld — in colleagues' private layers.</p>`
      : "") +
    (b.recentDocuments.length ? b.recentDocuments.map((d) =>
      `<div class="doc-row">${esc(d.title ?? "(untitled)")} <span class="src">· ${esc(d.source)}${d.occurred_at ? " · " + esc(d.occurred_at.slice(0, 10)) : ""}</span></div>`).join("") : `<div class="empty"><p>None.</p></div>`);
  // CSSOM writes aren't governed by style-src, unlike parsed style attributes.
  for (const bar of document.querySelectorAll("#brief .bar")) bar.style.width = bar.dataset.w;
  for (const row of document.querySelectorAll("#brief .conn")) {
    row.addEventListener("click", () => showBrief(row.dataset.id));
  }
  $("#copy-brief").addEventListener("click", copyBrief);
  $("#merge-into").addEventListener("click", () => startMerge(e));
  $("#toggle-automated").addEventListener("click", async () => {
    await api(`/api/entity/${encodeURIComponent(e.id)}/automated${asParam()}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ automated: !e.automated }),
    });
    toast(e.automated
      ? `${e.canonical_name} confirmed human`
      : `${e.canonical_name} marked as automated sender`, "good");
    await showBrief(e.id);
  });
  document.querySelector('[data-tab="explore"]').click();
}

/**
 * Merge a duplicate into the entity currently on screen. Resolution is
 * conservative by design, so real data always leaves a few — this is the fix.
 */
async function startMerge(keeper) {
  const q = prompt(`Merge a duplicate INTO "${keeper.canonical_name}".\n\n` +
    `Type the duplicate's name or email. Its documents, relationships and addresses ` +
    `move to ${keeper.canonical_name}; the merge is reversible and survives rebuilds.`);
  if (!q?.trim()) return;
  const matches = (await api(`/api/search?q=${encodeURIComponent(q.trim())}${asParam("&")}`))
    .filter((m) => m.id !== keeper.id && m.kind === keeper.kind);
  if (!matches.length) { toast(`No other ${keeper.kind} matching "${q.trim()}"`, "err"); return; }
  const pick = matches.length === 1 ? matches[0] : matches[
    Math.max(0, Number(prompt(`Which one?\n\n${matches.map((m, i) =>
      `${i}: ${m.canonical_name} (${[...m.orgs, ...m.emails].slice(0, 2).join(", ")})`).join("\n")}`) || 0))
  ];
  if (!pick) return;
  if (!confirm(`Merge "${pick.canonical_name}" into "${keeper.canonical_name}"?`)) return;
  await api(`/api/merge${asParam()}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ keep: keeper.id, lose: pick.id }),
  });
  toast(`Merged ${pick.canonical_name} into ${keeper.canonical_name}`, "good");
  await Promise.all([renderStats(), renderGraph()]);
  await showBrief(keeper.id);
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
    `*Generated by Fein*`,
  ].join("\n");
  await navigator.clipboard.writeText(md);
  toast("Brief copied as Markdown", "good");
}

/* ---------- warm path ---------- */
// A person pruned from the bounded graph payload can still be a path
// endpoint: when the datalist misses a typed name, ask search for an exact
// (case-insensitive) match before giving up.
async function pathEndpointId(raw) {
  const name = raw.trim();
  if (!name) return null;
  const hit = nameToId.get(name.toLowerCase());
  if (hit) return hit;
  const results = await api(`/api/search?q=${encodeURIComponent(name)}${asParam("&")}`);
  return results.find((r) => r.canonical_name.toLowerCase() === name.toLowerCase())?.id ?? null;
}

$("#find-path").addEventListener("click", async () => {
  const from = await pathEndpointId($("#path-from").value);
  const to = await pathEndpointId($("#path-to").value);
  const out = $("#path-result");
  if (!from || !to) { out.innerHTML = `<div class="empty"><p>Pick two people from the suggestions.</p></div>`; return; }
  const { path, introducers, viaPrivate } =
    await api(`/api/path?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}${asParam("&")}`);
  const hops = (steps) => steps.map((s, i) =>
    `<div class="hop">${i
        ? `<span class="arrow">→</span>` +
          (s.private
            ? `<span class="pct locked" title="Held in ${esc(s.via)}'s private layer">🔒</span>`
            : `<span class="pct">${pct(s.viaStrength)}</span>`)
        : ""}<span>${esc(s.name)}</span></div>`).join("");

  let html = "";
  if (!path?.path) {
    html += `<div class="empty"><p>No connecting path you can see within 4 hops.</p></div>`;
    highlightPath([]);
  } else {
    highlightPath(path.path.map((s) => s.entity));
    html += `<div class="path-strength">path strength <strong>${pct(path.pathStrength)}</strong></div>`;
    html += hops(path.path);
  }

  // A route through someone else's private layer: existence and owner only.
  if (path?.privatePath) {
    html += `<h3 class="section-title">Private route</h3>`;
    html += hops(path.privatePath.path);
    html += `<p class="hint locked-note">🔒 ${esc(path.privatePath.note)}</p>`;
    highlightPath(path.privatePath.path.map((s) => s.entity));
  }

  if (introducers.length) {
    html += `<h3 class="section-title">Best introducers</h3>`;
    html += introducers.map((i) =>
      `<div class="conn"><span class="grow">${esc(i.name)}</span>
        <span class="pct">${pct(i.strengthToYou)} / ${pct(i.strengthToTarget)}</span></div>`).join("");
  }
  if (viaPrivate?.length) {
    html += `<h3 class="section-title">Ask a colleague</h3>`;
    html += viaPrivate.map((v) =>
      `<div class="conn"><span class="grow">${esc(v.owner)}</span>
        <span class="pct locked" title="Private connection">🔒</span></div>`).join("");
  }
  out.innerHTML = html;
});

/* ---------- radar (timing intelligence) ---------- */
const STATUS_LABEL = { cold: "cold", overdue: "overdue", due: "due now", dormant: "dormant", new: "new", active: "active" };

async function renderRadar() {
  const s = await api(`/api/radar${asParam()}`);
  const order = ["cold", "overdue", "due", "active", "new", "dormant"];
  $("#radar-counts").innerHTML =
    `<div class="radar-counts">` +
    order.filter((k) => s.counts[k]).map((k) =>
      `<span class="badge ${esc(k)}">${s.counts[k]} ${esc(STATUS_LABEL[k])}</span>`).join("") +
    `</div>`;
  $("#radar").innerHTML = s.needsAttention.length
    ? s.needsAttention.map((r) =>
        `<div class="radar-row">
           <div class="radar-pair"><span class="badge ${esc(r.status)}">${esc(STATUS_LABEL[r.status])}</span>
             ${esc(r.aName)} ↔ ${esc(r.bName)}</div>
           <div class="radar-meta">last contact ${r.daysSinceContact}d ago${
             r.cadenceDays !== null ? ` · usually every ${r.cadenceDays}d` : ""}${
             r.overdueBy ? ` · <strong>${r.overdueBy}d overdue</strong>` : ""} · ${r.contacts} touches</div>
         </div>`).join("")
    : `<div class="empty"><p>Nothing overdue — every relationship is inside its usual rhythm.</p></div>`;
}

/* ---------- review queue ---------- */
async function renderReviews() {
  const reviews = await api(`/api/reviews${asParam()}`);
  $("#reviews").innerHTML = reviews.length ? reviews.map((r) =>
    `<div class="review">
       <div><span class="score">⚠ ${r.score.toFixed(2)}</span> — is this the same person?</div>
       <div class="vs"><strong>${esc(r.mention_name ?? r.mention_email)}</strong>
         ${r.mention_email ? `&lt;${esc(r.mention_email)}&gt;` : ""}
         (in “${esc(r.doc_title ?? r.doc_source)}”)<br>vs entity
         <strong>${esc(r.candidate_name)}</strong></div>
       ${r.mention_origin === "extracted" && r.mention_context
         ? `<div class="hint">extracted from text: “${esc(r.mention_context)}”</div>` : ""}
       <div class="actions">
         <button class="accept" data-id="${esc(r.id)}" data-d="accept">✓ Same person</button>
         <button class="reject" data-id="${esc(r.id)}" data-d="reject">✗ Different</button>
       </div>
     </div>`).join("") : `<div class="empty"><p>Queue is empty — everything resolved deterministically.</p></div>`;
  for (const btn of document.querySelectorAll("#reviews button")) {
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      await api(`/api/reviews/${encodeURIComponent(btn.dataset.id)}${asParam()}`, {
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
  const [docs, audit] = await Promise.all([api(`/api/documents${asParam()}`), api("/api/audit?limit=15")]);
  renderExtractStatus(); // independent fetch; the tab must not block on it
  renderConnector("attio");
  renderConnector("affinity");
  renderMembers();
  renderMcp();
  $("#sources").innerHTML = docs.sources.length
    ? `<table class="mini"><tr><th>Source</th><th>Kinds</th><th class="num">Docs</th><th>Latest</th></tr>` +
      docs.sources.map((s) =>
        `<tr><td>${esc(s.source)}</td>
           <td>${esc(Object.entries(s.kinds).map(([k, v]) => `${v} ${k}`).join(", "))}</td>
           <td class="num">${s.count}</td>
           <td>${s.latest ? esc(s.latest.slice(0, 10)) : "—"}</td></tr>`).join("") + `</table>`
    : `<div class="empty"><p>Nothing ingested yet.</p></div>`;
  if (docs.withheld) {
    $("#sources").innerHTML +=
      `<p class="hint">🔒 ${docs.withheld} document${docs.withheld === 1 ? "" : "s"} in other members' private layers.</p>`;
  }
  $("#audit").innerHTML = audit.length ? audit.map((a) =>
    `<div class="audit-row"><span class="when">${esc(String(a.at).slice(0, 16).replace("T", " "))}</span>
       · ${esc(a.action)}${a.detail?.file ? ` · ${esc(a.detail.file)}` : ""}${a.detail?.mention?.name ? ` · ${esc(a.detail.mention.name)}` : ""}${a.actor && a.actor !== "local" ? ` · ${esc(a.actor)}` : ""}</div>`).join("")
    : `<div class="empty"><p>No activity recorded yet.</p></div>`;
}

/* ---------- members & privacy layers ---------- */
async function renderMembers() {
  const members = await renderViewers();
  const layerSel = $("#upload-layer");
  const kept = layerSel.value;
  layerSel.innerHTML = `<option value="">Shared layer — whole team</option>` +
    members.map((m) => `<option value="${esc(m.id)}">${esc(m.name)}&#39;s private layer 🔒</option>`).join("");
  if ([...layerSel.options].some((o) => o.value === kept)) layerSel.value = kept;
  $("#members").innerHTML = members.length
    ? `<table class="mini"><tr><th>Member</th><th class="num">Private docs</th><th></th></tr>` +
      members.map((m) =>
        `<tr><td>${esc(m.name)}${m.email ? `<br><span class="src">${esc(m.email)}</span>` : ""}</td>
           <td class="num">${m.documents}</td>
           <td class="num"><button class="small member-remove" data-id="${esc(m.id)}"
             data-name="${esc(m.name)}" data-docs="${m.documents}">Remove</button></td></tr>`).join("") +
      `</table>`
    : `<div class="empty"><p>No members yet — the whole graph is one shared layer.</p></div>`;
  for (const btn of document.querySelectorAll(".member-remove")) {
    btn.addEventListener("click", () => removeMember(btn.dataset));
  }
}

$("#member-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const name = $("#member-name").value.trim();
  if (!name) { toast("A member needs a name", "err"); return; }
  await api(`/api/members${asParam()}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, email: $("#member-email").value.trim() || null }),
  });
  $("#member-name").value = "";
  $("#member-email").value = "";
  toast(`Added ${name}`, "good");
  await renderMembers();
});

async function removeMember({ id, name, docs }) {
  const n = Number(docs);
  if (!n) {
    if (!confirm(`Remove ${name}?`)) return;
    await api(`/api/members/${encodeURIComponent(id)}${asParam()}`, { method: "DELETE" });
  } else {
    // Cancel/Escape must ABORT. A two-button confirm cannot offer three
    // outcomes, and mapping Cancel to "publish their private mail to the whole
    // team" is the worst possible default — so ask for the destination in
    // words, and treat anything unrecognised (including dismissal) as abort.
    const answer = prompt(
      `Remove ${name}? They own ${n} private document${n === 1 ? "" : "s"}.\n\n` +
      `Type DELETE to delete those documents with them,\n` +
      `or SHARE to keep them by moving them into the shared layer (everyone will see them).\n\n` +
      `Anything else cancels.`
    );
    const choice = answer?.trim().toUpperCase();
    if (choice !== "DELETE" && choice !== "SHARE") { toast("Cancelled — nothing changed"); return; }
    const q = choice === "SHARE" ? "?reassign=shared" : "";
    await api(`/api/members/${encodeURIComponent(id)}${q}${asParam(q ? "&" : "?")}`, { method: "DELETE" });
    toast(choice === "SHARE"
      ? `Removed ${name}; their ${n} document${n === 1 ? "" : "s"} moved to the shared layer`
      : `Removed ${name} and their ${n} private document${n === 1 ? "" : "s"}`, "good");
    await Promise.all([renderMembers(), renderStats(), renderGraph()]);
    return;
  }
  toast(`Removed ${name}`, "good");
  await Promise.all([renderMembers(), renderStats(), renderGraph()]);
}

/* ---------- MCP endpoint ---------- */
function renderMcp() {
  const cmd = `claude mcp add --transport http fein ${location.origin}/mcp`;
  $("#mcp-info").innerHTML =
    `<div class="mcp-cmd"><code>${esc(cmd)}</code>
       <button id="copy-mcp" class="small">Copy</button></div>
     <p class="hint">…or in Claude Desktop: Settings → Connectors → add <code>${esc(location.origin)}/mcp</code>.
       Append <code>?as=Seb%20Larkin</code> to the URL to bind an agent to that member's private
       layer. Headless alternative (dashboard not running): <code>fein mcp</code> over stdio.</p>`;
  $("#copy-mcp").addEventListener("click", async () => {
    await navigator.clipboard.writeText(cmd);
    toast("MCP connect command copied", "good");
  });
}

/* ---------- CRM connectors (Attio, Affinity — one card each) ---------- */
const CONNECTOR_HELP = {
  attio: `Paste an Attio access token to pull people, companies, and notes.
     Create one in Attio under <em>Workspace settings → Developers</em> with read
     access to records (add the notes scope to include notes).`,
  affinity: `Paste an Affinity API key to pull people, organizations, and note
     participants. Generate one in Affinity under <em>Settings → API</em>.`,
};

const ago = (iso) => {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 90) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
};
const countdown = (iso) => {
  const s = (new Date(iso).getTime() - Date.now()) / 1000;
  if (s <= 90) return "soon";
  if (s < 3600) return `in ${Math.round(s / 60)} min`;
  if (s < 86400) return `in ${Math.round(s / 3600)} h`;
  return `in ${Math.round(s / 86400)} d`;
};

// Presets stay hourly-or-slower biased: every sync is a full workspace pull
// plus an edge rebuild.
const SYNC_INTERVALS = [[0, "Off"], [30, "Every 30 min"], [60, "Hourly"], [360, "Every 6 h"], [1440, "Daily"]];

async function renderConnector(provider) {
  const panel = $(`#${provider}-panel`);
  let s;
  try {
    s = await api(`/api/connectors/${provider}`);
  } catch {
    panel.innerHTML = `<div class="empty"><p>Could not read connector status.</p></div>`;
    return;
  }
  const label = s.label;

  if (!s.connected) {
    panel.innerHTML =
      `<div class="connector">
         <div class="status"><span class="dot"></span><strong>Not connected</strong></div>
         <p class="hint">${CONNECTOR_HELP[provider]}</p>
         <input id="${provider}-key" type="password" placeholder="${label} API key" autocomplete="off" spellcheck="false">
         <label class="check"><input id="${provider}-notes" type="checkbox" checked> Include notes</label>
         <button id="${provider}-connect" class="primary">Connect &amp; sync</button>
       </div>`;
    $(`#${provider}-key`).addEventListener("keydown", (ev) => { if (ev.key === "Enter") connectConnector(provider); });
    $(`#${provider}-connect`).addEventListener("click", () => connectConnector(provider));
    return;
  }

  const where = s.origin === "env" ? `from ${s.envVar}` : `key ${s.keyHint}`;
  const lastAt = s.lastRun?.at ?? s.lastSyncAt;
  const interval = s.syncIntervalMinutes ?? 0;
  // A non-preset interval (set via the API) still needs a selected option.
  const intervals = SYNC_INTERVALS.some(([v]) => v === interval)
    ? SYNC_INTERVALS : [...SYNC_INTERVALS, [interval, `Every ${interval} min`]];
  panel.innerHTML =
    `<div class="connector">
       <div class="status"><span class="dot on"></span>
         <strong>Connected</strong>${s.workspace ? ` · ${esc(s.workspace)}` : ""}</div>
       <div class="meta">${esc(where)}${s.includeNotes ? " · notes included" : " · notes skipped"}<br>
         ${lastAt
            ? `last synced ${esc(ago(lastAt))}${s.lastDocCount != null ? ` — ${s.lastDocCount} documents` : ""}`
            : "not synced yet"}${
         s.lastRun && !s.lastRun.ok
            ? `<br><span class="err">last attempt failed: ${esc(s.lastRun.error ?? "")}</span>` : ""}${
         s.nextSyncAt
            ? `<br>auto-sync every ${interval}m · next ${esc(countdown(s.nextSyncAt))}` : ""}</div>
       <div class="row">
         <button id="${provider}-sync" class="primary">${s.lastSyncAt ? "Sync now" : "Sync workspace"}</button>
         <label class="check">Auto-sync
           <select id="${provider}-interval">${intervals.map(([v, l]) =>
             `<option value="${v}"${v === interval ? " selected" : ""}>${esc(l)}</option>`).join("")}</select>
         </label>
         ${s.origin === "stored" ? `<button id="${provider}-disconnect" class="small">Disconnect</button>` : ""}
       </div>
       <div id="${provider}-result"></div>
     </div>`;
  $(`#${provider}-sync`).addEventListener("click", () => syncConnector(provider));
  $(`#${provider}-interval`).addEventListener("change", async (ev) => {
    const minutes = Number(ev.target.value);
    try {
      await api(`/api/connectors/${provider}${asParam()}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ syncIntervalMinutes: minutes }),
      });
      toast(minutes ? `${label} auto-sync every ${minutes} min` : `${label} auto-sync off`, "good");
    } catch { /* api() already toasted */ }
    await renderConnector(provider);
  });
  $(`#${provider}-disconnect`)?.addEventListener("click", () => disconnectConnector(provider));
}

async function connectConnector(provider) {
  const key = $(`#${provider}-key`).value.trim();
  if (!key) { toast("Paste an API key first", "err"); return; }
  const btn = $(`#${provider}-connect`);
  btn.disabled = true;
  btn.textContent = "Verifying…";
  try {
    const s = await api(`/api/connectors/${provider}${asParam()}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiKey: key, includeNotes: $(`#${provider}-notes`).checked }),
    });
    toast(`${s.label} connected`, "good");
    await renderConnector(provider);
    await syncConnector(provider); // "paste it and it works" — connecting implies the first pull
  } catch {
    btn.disabled = false;
    btn.textContent = "Connect & sync";
  }
}

async function syncConnector(provider) {
  const btn = $(`#${provider}-sync`);
  if (btn) { btn.disabled = true; btn.textContent = "Syncing…"; }
  const out = $(`#${provider}-result`);
  if (out) out.innerHTML = `<p class="hint">Pulling people, companies and notes…</p>`;
  try {
    const res = await api(`/api/connectors/${provider}/sync${asParam()}`, { method: "POST" });
    toast(`${res.label} synced: ${res.ingested.docCount} records`, "good");
    await Promise.all([renderStats(), renderGraph(), renderData()]);
  } catch (err) {
    if (out) out.innerHTML = `<p class="hint err">${esc(err.message)}</p>`;
    if (btn) { btn.disabled = false; btn.textContent = "Sync now"; }
  }
}

async function disconnectConnector(provider) {
  if (!confirm("Disconnect? The stored key is deleted; data already ingested stays.")) return;
  const s = await api(`/api/connectors/${provider}${asParam()}`, { method: "DELETE" });
  toast(`${s.label} disconnected`, "good");
  await renderConnector(provider);
}

/* ---------- extraction ---------- */
async function renderExtractStatus() {
  const el = $("#extract-status");
  try {
    const s = await api("/api/extract/status");
    const creds = s.credentials === "ambient"
      ? `no key in the server's environment — the SDK will try an <code>ant auth login</code> profile`
      : `credentials: ${esc(s.credentials)}`;
    el.innerHTML =
      `<div class="hint">${s.docsWithBody} document${s.docsWithBody === 1 ? "" : "s"} with text bodies ·
        ${s.extracted} extracted (${s.extractedMentions} mentions${s.deals ? `, ${s.deals} deal signals` : ""}) ·
        ${s.exhausted ? `<span class="err">${s.exhausted} given up after repeated failures</span> · ` : ""}
        <strong>${s.pending} pending</strong><br>
        model <code>${esc(s.model)}</code> · ${creds}</div>`;
    const btn = $("#run-extract");
    btn.hidden = false;
    btn.disabled = s.running || s.pending === 0;
    btn.textContent = s.running ? "Extraction running…"
      : s.pending === 0 ? "Nothing pending"
      : `Extract ${s.pending} document${s.pending === 1 ? "" : "s"}`;
  } catch {
    el.innerHTML = `<div class="empty"><p>Extraction status unavailable.</p></div>`;
  }
}

$("#run-extract").addEventListener("click", async () => {
  const btn = $("#run-extract");
  const out = $("#extract-result");
  btn.disabled = true;
  btn.textContent = "Extracting… (this calls the Anthropic API)";
  out.innerHTML = "";
  try {
    const res = await api(`/api/extract${asParam()}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const x = res.extract;
    out.innerHTML = `<span class="ok">✓</span> ${x.extracted} docs mined · ${x.mentions} mentions${x.deals ? ` + ${x.deals} deal signals` : ""} extracted
      (${x.dropped} dropped by grounding) ·
      ${x.failed ? `<span class="err">${x.failed} failed</span> · ` : ""}
      ${(x.tokens.input + x.tokens.output).toLocaleString()} tokens
      ${res.resolved ? ` · resolved ${res.resolved.attached + res.resolved.created}, queued ${res.resolved.queued} for review` : ""}
      ${x.aborted ? `<br><span class="err">${esc(x.aborted)}</span>` : ""}`;
    toast(`Extraction complete: ${x.mentions} mentions from ${x.extracted} docs`, "good");
    await Promise.all([renderStats(), renderGraph(), renderExtractStatus(), renderData()]);
  } catch (err) {
    out.innerHTML = `<span class="err">✗ ${esc(err.message)}</span>`;
    await renderExtractStatus();
  }
});

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

// Explicitly whitelisted rows, never an iteration over the settings object:
// non-numeric keys (privateEntityVisibility) must not render as number inputs.
// Dotted names post as nested groups; flat names keep their special cases.
const TUNING_ROWS = [
  ["resolution.autoMerge", "Auto-merge confidence", 'step="0.01" min="0.5" max="1"'],
  ["resolution.review", "Review-queue floor", 'step="0.01" min="0.1" max="1"'],
  ["radar.overdueRatio", "Overdue at × cadence", 'step="0.1" min="1" max="100"'],
  ["radar.coldRatio", "Cold at × cadence", 'step="0.1" min="1" max="100"'],
  ["radar.dormantAfterDays", "Dormant after (days)", 'step="1" min="1" max="3650"'],
  ["privateHopStrength", "Private-hop routing strength", 'step="0.05" min="0.01" max="0.99"'],
];

async function renderSettings() {
  const [s, health] = await Promise.all([api("/api/settings"), api("/api/health")]);
  const valueOf = (name) => name.split(".").reduce((o, k) => o?.[k], s);
  $("#settings-form").innerHTML =
    Object.entries(s.weights).map(([k, v]) =>
      `<div class="weight-row"><label for="w-${esc(k)}">${esc(WEIGHT_LABELS[k] ?? k)}</label>
         <input id="w-${esc(k)}" name="${esc(k)}" type="number" step="0.1" min="0" max="100" value="${esc(v)}"></div>`).join("") +
    `<div class="weight-row"><label for="w-halfLifeDays">Recency half-life (days)</label>
       <input id="w-halfLifeDays" name="halfLifeDays" type="number" step="1" min="1" max="3650" value="${esc(s.halfLifeDays)}"></div>
     <div class="weight-row"><label for="w-saturation">Evidence saturation</label>
       <input id="w-saturation" name="saturation" type="number" step="0.5" min="0.5" max="100" value="${esc(s.saturation)}"></div>
     <div class="weight-row"><label for="w-maxDocParticipants">Participant cap (larger docs build no connections)</label>
       <input id="w-maxDocParticipants" name="maxDocParticipants" type="number" step="1" min="2" max="10000" value="${esc(s.maxDocParticipants)}"></div>` +
    TUNING_ROWS.map(([name, label, attrs]) => {
      const id = `w-${name.replace(".", "-")}`;
      return `<div class="weight-row"><label for="${id}">${esc(label)}</label>
         <input id="${id}" name="${esc(name)}" type="number" ${attrs} value="${esc(valueOf(name))}"></div>`;
    }).join("") +
    `<p class="hint">Threshold changes apply to future resolution runs — run
       <strong>Re-run entity resolution</strong> below to apply them to the whole corpus.</p>`;
  $("#about").textContent = `Fein v${health.version} · up ${Math.floor(health.uptimeSeconds / 60)}m · MIT licensed`;
}

$("#save-settings").addEventListener("click", async () => {
  const patch = { weights: {} };
  for (const input of document.querySelectorAll("#settings-form input")) {
    const v = Number(input.value);
    if (input.name.includes(".")) {
      const [g, k] = input.name.split(".");
      (patch[g] ??= {})[k] = v;
    }
    else if (input.name === "halfLifeDays") patch.halfLifeDays = v;
    else if (input.name === "saturation") patch.saturation = v;
    else if (input.name === "maxDocParticipants") patch.maxDocParticipants = v;
    else if (input.name === "privateHopStrength") patch.privateHopStrength = v;
    else patch.weights[input.name] = v;
  }
  const btn = $("#save-settings");
  btn.disabled = true;
  try {
    const res = await api(`/api/settings${asParam()}`, {
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
    const res = await api(`/api/reresolve${asParam()}`, { method: "POST" });
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
  const layer = $("#upload-layer").value;
  out.innerHTML = `ingesting <strong>${esc(file.name)}</strong>…`;
  try {
    const res = await api(
      `/api/ingest?name=${encodeURIComponent(file.name)}${layer ? `&as=${encodeURIComponent(layer)}` : ""}`,
      { method: "POST", body: await file.text() }
    );
    out.innerHTML = `<span class="ok">✓</span> ${res.ingested.docCount} docs, ${res.ingested.mentionCount} mentions ·
      resolved ${res.resolved.attached + res.resolved.created}, queued ${res.resolved.queued} for review ·
      ${res.edges.edges} connections` +
      (res.layer ? `<br><span class="hint">🔒 into ${esc(res.layer)}'s private layer</span>` : "") +
      (res.stats.pendingExtraction > 0
        ? `<br><span class="hint">${res.stats.pendingExtraction} document bodies ready for LLM extraction ↓</span>`
        : "");
    toast(res.layer ? `Ingested ${file.name} into ${res.layer}'s private layer` : `Ingested ${file.name}`, "good");
    renderExtractStatus();
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
    const res = await api(`/api/sample${asParam()}`, { method: "POST" });
    $("#onboarding").hidden = true;
    toast(`Sample loaded: ${res.stats.entities} entities, ${res.stats.edges} connections`, "good");
    await Promise.all([renderStats(), renderGraph(), renderViewers()]);
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
  await renderViewers();
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
