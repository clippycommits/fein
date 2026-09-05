/* Ask — a question box over the graph. Vanilla JS, no dependencies. */
(() => {
  const $ = (s) => document.querySelector(s);
  const thread = $("#thread"), form = $("#ask"), q = $("#q"), send = $("#send"), stop = $("#stop");
  const notice = $("#notice"), status = $("#status"), viewerSel = $("#viewer"), sub = $("#sub");
  const KEY = () => `fein.ask.${viewerSel.value || "shared"}`;
  let transcript = [];      // [{role, content}] — text only; tools are re-run each question
  let controller = null;    // AbortController for the in-flight question

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  /* ---------- a small, safe Markdown renderer: paragraphs, headings, lists, tables, code, bold, links ---------- */
  function inline(s) {
    let t = esc(s);
    t = t.replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`);
    t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    t = t.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>");
    t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_, a, u) => `<a href="${u}" target="_blank" rel="noopener">${a}</a>`);
    return t;
  }
  function table(lines) {
    const rows = lines.map((l) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim()));
    const head = rows[0], body = rows.slice(2);
    const isNum = (v) => /^[-+]?[\d.,]+%?$/.test(v) || v === "";
    const numCol = head.map((_, i) => body.length && body.every((r) => isNum(r[i] ?? "")));
    const th = head.map((h, i) => `<th class="${numCol[i] ? "num" : ""}">${inline(h)}</th>`).join("");
    const tr = body.map((r) => `<tr>${head.map((_, i) => `<td class="${numCol[i] ? "num" : ""}">${inline(r[i] ?? "")}</td>`).join("")}</tr>`).join("");
    return `<div class="tbl"><table><thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table></div>`;
  }
  function render(md) {
    const lines = md.replace(/\r/g, "").split("\n");
    const out = [];
    let i = 0;
    while (i < lines.length) {
      const l = lines[i];
      if (/^```/.test(l)) {
        const buf = []; i++;
        while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
        i++; out.push(`<pre><code>${esc(buf.join("\n"))}</code></pre>`); continue;
      }
      if (/^\s*\|.*\|\s*$/.test(l) && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] ?? "")) {
        const buf = [];
        while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) buf.push(lines[i++]);
        out.push(table(buf)); continue;
      }
      const h = /^(#{1,4})\s+(.*)$/.exec(l);
      if (h) { out.push(`<h3>${inline(h[2])}</h3>`); i++; continue; }
      if (/^\s*[-*•]\s+/.test(l)) {
        const buf = [];
        while (i < lines.length && /^\s*[-*•]\s+/.test(lines[i])) buf.push(lines[i++].replace(/^\s*[-*•]\s+/, ""));
        out.push(`<ul>${buf.map((x) => `<li>${inline(x)}</li>`).join("")}</ul>`); continue;
      }
      if (/^\s*\d+[.)]\s+/.test(l)) {
        const buf = [];
        while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) buf.push(lines[i++].replace(/^\s*\d+[.)]\s+/, ""));
        out.push(`<ol>${buf.map((x) => `<li>${inline(x)}</li>`).join("")}</ol>`); continue;
      }
      if (!l.trim()) { i++; continue; }
      const buf = [];
      while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|```|\s*[-*•]\s|\s*\d+[.)]\s|\s*\|)/.test(lines[i])) buf.push(lines[i++]);
      out.push(`<p>${inline(buf.join(" "))}</p>`);
    }
    return out.join("");
  }

  /* ---------- state ---------- */
  function load() {
    try { transcript = JSON.parse(localStorage.getItem(KEY()) || "[]"); } catch { transcript = []; }
    thread.innerHTML = "";
    for (const t of transcript) paint(t.role, t.content);
    document.body.classList.toggle("chatting", transcript.length > 0);
    scroll();
  }
  function save() { try { localStorage.setItem(KEY(), JSON.stringify(transcript.slice(-40))); } catch {} }
  function scroll() { requestAnimationFrame(() => window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" })); }
  function say(msg, kind) {
    notice.hidden = !msg; notice.textContent = msg || ""; notice.className = kind === "err" ? "err" : "";
  }

  function paint(role, text) {
    const el = document.createElement("div");
    el.className = `turn ${role}`;
    if (role === "user") el.innerHTML = `<div class="bubble">${esc(text)}</div>`;
    else el.innerHTML = `<div class="steps"></div><div class="answer">${render(text)}</div>`;
    thread.appendChild(el);
    return el;
  }

  /* ---------- asking ---------- */
  async function askQuestion(text) {
    text = text.trim();
    if (!text || controller) return;
    say("");
    document.body.classList.add("chatting");
    transcript.push({ role: "user", content: text });
    paint("user", text);
    const el = paint("assistant", "");
    const steps = el.querySelector(".steps"), answer = el.querySelector(".answer");
    answer.classList.add("cursor");
    let acc = "";
    const live = new Map();
    q.value = ""; grow();
    send.hidden = true; stop.hidden = false; q.disabled = true;
    controller = new AbortController();
    scroll();

    try {
      const as = viewerSel.value ? `?as=${encodeURIComponent(viewerSel.value)}` : "";
      const res = await fetch(`/api/ask${as}`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: transcript }), signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        let msg = `The graph answered ${res.status}.`;
        try { msg = (await res.json()).error || msg; } catch {}
        throw new Error(msg);
      }
      const reader = res.body.getReader(), dec = new TextDecoder();
      let buf = "";
      let painted = 0;
      const flush = () => { if (acc.length !== painted) { answer.innerHTML = render(acc); painted = acc.length; scroll(); } };
      const timer = setInterval(flush, 120);
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let idx;
          while ((idx = buf.indexOf("\n\n")) >= 0) {
            const chunk = buf.slice(0, idx); buf = buf.slice(idx + 2);
            const ev = /^event: (.*)$/m.exec(chunk)?.[1];
            const data = /^data: (.*)$/m.exec(chunk)?.[1];
            if (!ev || data === undefined) continue;
            let d = {}; try { d = JSON.parse(data); } catch {}
            if (ev === "text") acc += d.delta ?? "";
            else if (ev === "tool") {
              const s = document.createElement("div"); s.className = "step live";
              const args = Object.entries(d.input || {}).map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`).join(" ");
              s.innerHTML = `<span class="dot"></span><span class="what">${esc(label(d.name))}</span><span class="args">${esc(args)}</span>`;
              steps.appendChild(s); live.set(d.id, s); scroll();
            } else if (ev === "tool_result") {
              const s = live.get(d.id); if (s) { s.classList.remove("live"); s.querySelector(".args").textContent += `  · ${d.ok ? d.summary : "failed"}`; }
            } else if (ev === "error") { say(d.message || "Something went wrong.", "err"); }
          }
        }
      } finally { clearInterval(timer); flush(); }
    } catch (err) {
      if (err.name !== "AbortError") say(err.message || "Something went wrong.", "err");
      else if (!acc) say("Stopped.");
    } finally {
      answer.classList.remove("cursor");
      if (acc) {
        transcript.push({ role: "assistant", content: acc });
        const row = document.createElement("div"); row.className = "tools-row";
        row.innerHTML = `<button type="button">Copy</button>`;
        row.querySelector("button").addEventListener("click", () => navigator.clipboard.writeText(acc).catch(() => {}));
        el.appendChild(row);
      } else if (!steps.childElementCount) {
        el.remove();
      }
      save();
      controller = null;
      send.hidden = false; stop.hidden = true; q.disabled = false; q.focus();
    }
  }
  const label = (name) => ({
    search_entities: "Searching people and organizations", entity_brief: "Reading a profile", find_warm_path: "Finding the warmest path",
    find_introducers: "Ranking introducers", strongest_connections: "Reading strongest connections", meeting_prep: "Preparing the meeting brief",
    company_memory: "Reading company memory", relationship_radar: "Checking the radar", list_events: "Listing events",
    event_history: "Reading event history", event_guests: "Reading the guest list", guest_league: "Building the league table",
    graph_stats: "Counting the graph", review_queue: "Reading the review queue", review_resolve: "Resolving a review",
  }[name] || name.replace(/_/g, " "));

  /* ---------- wiring ---------- */
  function grow() { q.style.height = "auto"; q.style.height = Math.min(q.scrollHeight, 200) + "px"; }
  q.addEventListener("input", grow);
  q.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); } });
  form.addEventListener("submit", (e) => { e.preventDefault(); askQuestion(q.value); });
  stop.addEventListener("click", () => controller?.abort());
  $("#new").addEventListener("click", () => { if (controller) controller.abort(); transcript = []; save(); load(); q.focus(); });
  for (const chip of document.querySelectorAll(".chip")) {
    chip.addEventListener("click", () => {
      const t = chip.textContent;
      if (/…$/.test(t)) { q.value = t.replace(/…$/, ""); grow(); q.focus(); q.setSelectionRange(q.value.length, q.value.length); }
      else askQuestion(t);
    });
  }
  viewerSel.addEventListener("change", () => { if (controller) controller.abort(); load(); });

  (async () => {
    try {
      const [members, st] = await Promise.all([
        fetch("/api/members").then((r) => r.json()),
        fetch("/api/ask/status").then((r) => r.json()),
      ]);
      for (const m of members) {
        const o = document.createElement("option"); o.value = m.email || m.name; o.textContent = m.name; viewerSel.appendChild(o);
      }
      if (st.firm && st.firm !== "the firm") sub.textContent = `${st.firm}'s people, organizations, events and relationships, from the CRM and every guest list.`;
      if (st.configured === false) say(st.provider === "claude-code"
        ? "Ask is not set up on this instance yet: Claude Code has no subscription token."
        : "Ask is not set up on this instance yet: it has no Anthropic credentials.", "err");
      else status.textContent = `Answers come from the graph as of the last sync${st.lastSyncAt ? " · " + st.lastSyncAt.slice(0, 16).replace("T", " ") + " UTC" : ""}.`;
    } catch {}
    load();
    q.focus();
  })();
})();
