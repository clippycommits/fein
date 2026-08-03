/* global d3 */
const $ = (sel) => document.querySelector(sel);
const api = async (path, opts) => {
  const res = await fetch(path, opts);
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? res.statusText);
  return body;
};
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const pct = (x) => `${Math.round(x * 100)}%`;

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
  });
}

/* ---------- stat tiles ---------- */
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
}

/* ---------- graph ---------- */
let graphData = { nodes: [], links: [] };
let simulation = null;
const nameToId = new Map();

async function renderGraph() {
  graphData = await api("/api/graph");
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
  svg.call(d3.zoom().scaleExtent([0.3, 4]).on("zoom", (ev) => root.attr("transform", ev.transform)));

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
      const sig = Object.entries(d.signals).map(([k, v]) => `${v} ${k}${v === 1 ? "" : "s"}`).join(", ");
      tooltip.innerHTML =
        `<div class="t-name">${esc(d.source.name)} ↔ ${esc(d.target.name)}</div>` +
        `<div class="t-sub">strength ${pct(d.strength)} · ${esc(sig)}</div>`;
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
    $("#search-results").innerHTML = results.map((r) =>
      `<div class="result-row" data-id="${esc(r.id)}">
         <div>${esc(r.canonical_name)} ${r.kind === "org" ? "· <span class='sub'>org</span>" : ""}</div>
         <div class="sub">${esc([...r.orgs, ...r.emails].slice(0, 2).join(" · "))}</div>
       </div>`).join("");
    for (const row of document.querySelectorAll("#search-results .result-row")) {
      row.addEventListener("click", () => showBrief(row.dataset.id));
    }
  }, 150);
});

async function showBrief(id) {
  const b = await api(`/api/entity/${id}`);
  highlightPath([id]);
  const e = b.entity;
  $("#brief").innerHTML =
    `<h2>${esc(e.canonical_name)}</h2>
     <div class="sub">${esc([...e.orgs, ...e.emails].join(" · "))}</div>
     <h3>Strongest connections</h3>` +
    (b.connections.length ? b.connections.map((c) =>
      `<div class="conn" data-id="${esc(c.entity)}">
         <span style="flex:1">${esc(c.name)}</span>
         <span class="bar-wrap"><span class="bar" style="width:${pct(c.strength)}"></span></span>
         <span class="pct">${pct(c.strength)}</span>
       </div>`).join("") : `<div class="hint">none yet</div>`) +
    `<h3>Recent documents</h3>` +
    (b.recentDocuments.length ? b.recentDocuments.map((d) =>
      `<div class="doc-row">${esc(d.title ?? "(untitled)")} <span class="src">· ${esc(d.source)}${d.occurred_at ? " · " + d.occurred_at.slice(0, 10) : ""}</span></div>`).join("") : `<div class="hint">none</div>`);
  for (const row of document.querySelectorAll("#brief .conn")) {
    row.addEventListener("click", () => showBrief(row.dataset.id));
  }
  document.querySelector('[data-tab="explore"]').click();
}

/* ---------- warm path ---------- */
$("#find-path").addEventListener("click", async () => {
  const from = nameToId.get($("#path-from").value.trim().toLowerCase());
  const to = nameToId.get($("#path-to").value.trim().toLowerCase());
  const out = $("#path-result");
  if (!from || !to) { out.innerHTML = `<p class="hint">pick two people from the list</p>`; return; }
  const { path, introducers } = await api(`/api/path?from=${from}&to=${to}`);
  let html = "";
  if (!path) {
    html += `<p class="hint">no connecting path found</p>`;
    highlightPath([]);
  } else {
    highlightPath(path.path.map((s) => s.entity));
    html += `<div class="path-strength">path strength <strong>${pct(path.pathStrength)}</strong></div>`;
    html += path.path.map((s, i) =>
      `<div class="hop">${i ? `<span class="arrow">→</span><span class="pct">${pct(s.viaStrength)}</span>` : ""}
         <span>${esc(s.name)}</span></div>`).join("");
  }
  if (introducers.length) {
    html += `<h3 style="font-size:12px;text-transform:uppercase;letter-spacing:.05em;margin:14px 0 6px">Best introducers</h3>`;
    html += introducers.map((i) =>
      `<div class="conn"><span style="flex:1">${esc(i.name)}</span>
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
     </div>`).join("") : `<p class="hint">queue is empty — everything resolved deterministically.</p>`;
  for (const btn of document.querySelectorAll("#reviews button")) {
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      await api(`/api/reviews/${btn.dataset.id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision: btn.dataset.d }),
      });
      await Promise.all([renderReviews(), renderStats(), renderGraph()]);
    });
  }
}

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
      ${res.edges.edges} edges`;
    await Promise.all([renderStats(), renderGraph()]);
  } catch (err) {
    out.innerHTML = `<span class="err">✗ ${esc(err.message)}</span>`;
  }
}

/* ---------- boot ---------- */
renderStats();
renderGraph();
addEventListener("resize", () => renderGraph());
