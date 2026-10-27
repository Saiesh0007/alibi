// The live playground: loads Pyodide, copies the real alibi/ package into it, and runs scenarios through web.py.
(() => {
  const CFG = JSON.parse(document.getElementById("cfg").textContent);
  const TOOLS = ["search_suppliers", "read_file", "read_ticket", "create_purchase_request", "send_email",
                 "ask_agent", "http_post", "export_report", "track_shipment"];
  const STOPPED = ["RESTRICT", "QUARANTINE", "BLOCKED"];
  const $ = (s, el = document) => el.querySelector(s);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

  const state = {
    preset: null, sessions: [], steps: [], tokens: clone(CFG.tokens), cards: clone(CFG.cards), uploads: {},
    cardSel: Object.keys(CFG.cards)[0],
    results: null,      // one row per step from web.run, or null before a run
    live: null,         // token per agent while a run is replayed
    current: null,      // step being replayed
    stale: false,       // something was edited after the last run
    open: new Set(),    // steps whose edit form is open
    tokEdit: false, running: false,
  };
  const agents = () => Object.keys(CFG.tokens);
  const cardAgent = (text) => (text.match(/^agent:\s*(\S+)/m) || [])[1];
  const docs = () => [...CFG.samples, ...Object.keys(state.uploads)];
  const agentOf = (st) => { const s = state.sessions.find((x) => x.id === st.session); return s ? s.agent : st.agent; };

  // ---------------------------------------------------------------- Python
  const loader = $("#loader");
  const setStatus = (text, pct, cls = "") => {
    $("#py-status").textContent = text;
    $("#load-bar").style.width = pct + "%";
    loader.className = "loader " + cls;
  };
  const written = new Set();
  const py = (async () => {
    setStatus("Loading Python in your browser (Pyodide)…", 8);
    const p = await loadPyodide({ indexURL: CFG.pyodide });
    setStatus("Loading scikit-learn and PyYAML (about 30 MB the first time, cached after)…", 35);
    await p.loadPackage(["pyyaml", "scikit-learn", "micropip"]);
    setStatus("Installing pypdf…", 80);
    p.globals.set("WHEEL", new URL(CFG.wheel, location.href).href);
    await p.runPythonAsync("import micropip\nawait micropip.install(WHEEL)");
    setStatus("Loading the ALIBI engine…", 92);
    for (const f of CFG.files) {
      const text = await (await fetch("py/" + f)).text();
      p.FS.mkdirTree(("/work/" + f).split("/").slice(0, -1).join("/"));
      p.FS.writeFile("/work/" + f, text);
    }
    p.FS.mkdirTree("/work/docs");
    p.runPython("import sys, os\nsys.path.insert(0, '/work')\nos.chdir('/work')\nimport web");
    setStatus("Engine ready: the repo's own Python code, running in your browser.", 100, "ok");
    $("#run").disabled = false;
    return p;
  })().catch((e) => { setStatus("Could not load the engine: " + e, 100, "err"); throw e; });

  async function ensureDoc(p, name) {
    if (written.has(name)) return;
    const bytes = state.uploads[name] || new Uint8Array(await (await fetch("samples/" + name)).arrayBuffer());
    p.FS.writeFile("/work/docs/" + name, bytes);
    written.add(name);
  }

  // ---------------------------------------------------------------- args "k=v; k=v"
  const argsToText = (a) => Object.entries(a || {}).map(([k, v]) => `${k}=${v}`).join("; ");
  function textToArgs(t) {
    const out = {};
    for (const part of t.split(";")) {
      const i = part.indexOf("=");
      if (i < 1) continue;
      const k = part.slice(0, i).trim(), v = part.slice(i + 1).trim();
      out[k] = /^\d+$/.test(v) ? Number(v) : v;
    }
    return out;
  }

  // ---------------------------------------------------------------- presets
  function loadPreset(id) {
    const pr = CFG.presets.find((p) => p.id === id);
    Object.assign(state, { preset: id, sessions: clone(pr.sessions), steps: clone(pr.steps), tokens: clone(CFG.tokens),
                           results: null, live: null, current: null, stale: false, open: new Set() });
    $("#blurb").textContent = pr.blurb;
    $("#summary").hidden = true;
    const first = (state.sessions[0] || state.steps[0] || {}).agent;
    state.cardSel = Object.keys(state.cards).find((c) => cardAgent(state.cards[c]) === first) || state.cardSel;
    document.querySelectorAll("#presets .scen").forEach((b) => b.setAttribute("aria-selected", b.dataset.id === id));
    render();
  }

  function edited() {
    if (state.results && !state.stale) {
      state.stale = true;
      $("#steps").classList.add("stale");
      $("#summary").hidden = true;
    }
  }

  // ---------------------------------------------------------------- render
  const opt = (v, label, sel) => `<option value="${esc(v)}"${v === sel ? " selected" : ""}>${esc(label)}</option>`;

  function render() {
    renderSteps();
    renderSessions();
    renderTokens();
    $("#card-sel").innerHTML = Object.keys(state.cards).map((c) => opt(c, c, state.cardSel)).join("");
    $("#card").value = state.cards[state.cardSel];
    $("#docs").innerHTML = docs().map((d) => {
      const tag = state.uploads[d] ? '<span class="tagx ok">yours</span>' : CFG.poisoned.includes(d) ? '<span class="tagx">hidden text</span>' : '<span class="tagx ok">clean</span>';
      return `<button class="doc" data-doc="${esc(d)}"><span>📄 ${esc(d)}</span>${tag}</button>`;
    }).join("");
  }

  function renderSessions() {
    $("#sessions").innerHTML = state.sessions.map((s, i) => `
      <div class="sess">
        <div class="row"><span class="pill">${esc(s.id)}</span>
          <select data-s="${i}" data-k="agent" aria-label="Agent">${agents().map((a) => opt(a, a, s.agent)).join("")}</select>
          <button class="icon del" data-del-s="${i}" title="Remove session" aria-label="Remove session">✕</button></div>
        <div class="by">asked by <select data-s="${i}" data-k="requested_by">${opt("", "a human", s.requested_by || "")}
          ${state.sessions.filter((o) => o.id !== s.id).map((o) => opt(o.id, `${o.id} (${o.agent})`, s.requested_by)).join("")}</select></div>
        <textarea data-s="${i}" data-k="task" rows="3" placeholder="The task a human gave this agent" aria-label="Task">${esc(s.task)}</textarea>
      </div>`).join("") || '<p class="hint">No sessions: every step runs with no task behind it, like a stolen token.</p>';
  }

  function renderTokens() {
    const involved = [...new Set(state.steps.map(agentOf))].filter(Boolean);
    $("#tokens").innerHTML = involved.map((a) => {
      const granted = state.tokens[a] || [];
      if (state.tokEdit) return `<div class="tok"><div class="who">${esc(a)}</div><input data-tok="${esc(a)}" value="${esc(granted.join(", "))}" aria-label="Scopes for ${esc(a)}"></div>`;
      const now = state.live && state.live[a] ? new Set(state.live[a]) : null;
      return `<div class="tok"><div class="who">${esc(a)}</div><div class="chips">${granted.map((s) =>
        `<span class="scope${now && !now.has(s) ? " gone" : ""}">${esc(s)}</span>`).join("") || '<span class="hint">no scopes</span>'}</div></div>`;
    }).join("");
    $("#tok-edit").textContent = state.tokEdit ? "done" : "edit";
  }

  function renderSteps() {
    const tl = $("#steps");
    tl.classList.toggle("stale", state.stale);
    tl.innerHTML = state.steps.map(stepHTML).join("");
  }

  function stepHTML(st, i) {
    const r = state.results && state.results[i];
    const agent = agentOf(st);
    const sess = state.sessions.find((x) => x.id === st.session);
    const cls = ["step"];
    if (r) cls.push(r.error ? "err" : "a-" + r.action, STOPPED.includes(r.action) ? "bad" : "");
    else if (state.running) cls.push("pending");
    if (state.current === i) cls.push("current", "enter");
    const reads = st.doc ? `<span class="rd">reads 📄 ${esc(st.doc)}</span>` : st.text != null ? '<span class="rd">reads pasted text</span>' : "";
    const args = Object.keys(st.args || {}).length ? `<span>${esc(argsToText(st.args))}</span>` : "";
    const verdict = r && !r.error ? `<div class="verdict"><span class="chip">${r.action}</span><span class="score">${r.score}</span></div>` : "";
    return `<li class="${cls.join(" ")}" data-step="${i}">
      <span class="num">${i + 1}</span>
      <div class="box">
        <div class="head" role="button" tabindex="0" data-toggle="${i}" aria-expanded="${state.open.has(i)}">
          <div class="what">
            <div class="call"><b>${esc(st.tool || "?")}</b> <span>${esc(st.target || "")}</span></div>
            <div class="meta"><span>${sess ? esc(sess.id) + " · " : "no session · "}${esc(agent || "")}</span>${reads}${args}</div>
          </div>
          ${verdict}
          <span class="edit-hint">${state.open.has(i) ? "close" : "edit"}</span>
        </div>
        ${r ? detailHTML(r) : ""}
        ${state.open.has(i) ? formHTML(st, i) : ""}
      </div>
    </li>`;
  }

  function detailHTML(r) {
    if (r.error) return `<div class="detail"><p class="err">${esc(r.error)}</p></div>`;
    const pts = r.reasons.filter(([p]) => p > 0), info = r.reasons.filter(([p]) => p === 0);
    if (!pts.length && !info.length && r.action === "ALLOW") return "";
    const outcome = r.action === "ALLOW" ? "" : `<div class="outcome"><span class="act">→ ${esc(r.note)}</span>${
      r.iam ? '<span class="iam">Token check alone: <b>would have allowed it</b></span>' : ""}</div>`;
    return `<div class="detail">
      ${pts.length ? `<div class="meter"><i style="width:${r.score}%"></i></div>` : ""}
      ${pts.length ? `<ul class="reasons">${pts.map(([p, t]) => `<li><b>+${p}</b><span>${esc(t)}</span></li>`).join("")}</ul>` : ""}
      ${info.map(([, t]) => `<p class="info">⚠ ${esc(t)}</p>`).join("")}
      ${r.evidence.map((e) => `<div class="evidence"><b>Traced to ${e.hidden ? "hidden text in " : ""}${esc(e.source)}, page ${e.page}</b>${esc(e.text)}</div>`).join("")}
      ${outcome}
    </div>`;
  }

  function formHTML(st, i) {
    const sessOpts = state.sessions.map((s) => opt(s.id, s.id, st.session)).join("") + opt("", "none", st.session || "");
    const readSel = st.doc || (st.text != null ? "__text" : "");
    const readOpts = opt("", "nothing", readSel) + docs().map((d) => opt(d, "📄 " + d, readSel)).join("") + opt("__text", "pasted text", readSel);
    return `<div class="form">
      <label>session<select data-i="${i}" data-k="session">${sessOpts}</select></label>
      ${st.session ? `<label>tool<input list="tools" data-i="${i}" data-k="tool" value="${esc(st.tool)}"></label>`
                   : `<label>agent<select data-i="${i}" data-k="agent">${agents().map((a) => opt(a, a, st.agent)).join("")}</select></label>
                      <label class="full">tool<input list="tools" data-i="${i}" data-k="tool" value="${esc(st.tool)}"></label>`}
      <label${st.session ? "" : ' class="full"'}>target<input data-i="${i}" data-k="target" value="${esc(st.target || "")}"></label>
      <label class="w2">args<input data-i="${i}" data-k="args" value="${esc(argsToText(st.args))}" placeholder="key=value; key=value"></label>
      <label>content it reads<select data-i="${i}" data-k="reads">${readOpts}</select></label>
      ${readSel === "__text" ? `<label class="full">text the agent reads<textarea data-i="${i}" data-k="text" rows="3">${esc(st.text)}</textarea></label>` : ""}
      <div class="tools">
        <button class="ghost small" data-up="${i}" ${i === 0 ? "disabled" : ""}>↑ move up</button>
        <button class="ghost small" data-del="${i}">✕ remove</button>
        <button class="ghost small" data-toggle="${i}">done</button>
      </div>
    </div>`;
  }

  // ---------------------------------------------------------------- events
  document.addEventListener("input", (e) => {
    const t = e.target, d = t.dataset;
    if (d.i !== undefined && ["tool", "target", "args", "text"].includes(d.k)) {
      const st = state.steps[+d.i];
      if (d.k === "args") st.args = textToArgs(t.value); else st[d.k] = t.value;
      const call = t.closest(".box").querySelector(".call");
      call.innerHTML = `<b>${esc(st.tool || "?")}</b> <span>${esc(st.target || "")}</span>`;
      edited();
    } else if (d.s !== undefined && d.k === "task") { state.sessions[+d.s].task = t.value; edited(); }
    else if (d.tok) { state.tokens[d.tok] = t.value.split(",").map((x) => x.trim()).filter(Boolean); edited(); }
    else if (t.id === "card") { state.cards[state.cardSel] = t.value; edited(); }
  });
  document.addEventListener("change", (e) => {
    const t = e.target, d = t.dataset;
    if (d.i !== undefined && ["session", "reads", "agent"].includes(d.k)) {
      const st = state.steps[+d.i];
      if (d.k === "session") { st.session = t.value; if (!t.value) st.agent = st.agent || agents()[0]; }
      else if (d.k === "agent") st.agent = t.value;
      else { delete st.doc; delete st.text; if (t.value === "__text") st.text = ""; else if (t.value) st.doc = t.value; }
      edited(); render();
    } else if (d.s !== undefined && d.k !== "task") { state.sessions[+d.s][d.k] = t.value; edited(); render(); }
    else if (t.id === "card-sel") { state.cardSel = t.value; render(); }
  });
  document.addEventListener("click", (e) => {
    const b = e.target.closest("button, [data-toggle]");
    if (!b || state.running) return;
    const d = b.dataset;
    if (b.classList.contains("scen")) loadPreset(d.id);
    else if (d.toggle !== undefined) { const i = +d.toggle; state.open.has(i) ? state.open.delete(i) : state.open.add(i); renderSteps(); }
    else if (d.del !== undefined) { removeStep(+d.del); }
    else if (d.up !== undefined && +d.up > 0) { moveUp(+d.up); }
    else if (d.delS !== undefined) {
      const id = state.sessions[+d.delS].id;
      state.sessions.splice(+d.delS, 1);
      state.steps.forEach((st) => { if (st.session === id) { st.session = ""; st.agent = st.agent || agents()[0]; } });
      edited(); render();
    } else if (d.doc) showDoc(d.doc);
    else if (d.close !== undefined) $("#doc-dialog").close();
    else if (b.id === "add-step") {
      state.steps.push({ session: state.sessions[0] ? state.sessions[0].id : "", agent: agents()[0], tool: "read_file", target: "", args: {} });
      if (state.results) state.results.push(null);
      state.open.add(state.steps.length - 1);
      edited(); render();
      $(`[data-step="${state.steps.length - 1}"] input[data-k=tool]`).focus();
    } else if (b.id === "add-session") {
      const ids = new Set(state.sessions.map((s) => s.id));
      let n = 1; while (ids.has("s" + n)) n++;
      state.sessions.push({ id: "s" + n, agent: agents()[0], task: "" });
      edited(); render();
    } else if (b.id === "card-reset") { state.cards[state.cardSel] = CFG.cards[state.cardSel]; edited(); render(); }
    else if (b.id === "tok-edit") { state.tokEdit = !state.tokEdit; state.live = state.tokEdit ? null : state.live; renderTokens(); }
    else if (b.id === "run") run();
  });
  document.addEventListener("keydown", (e) => {
    if ((e.key === "Enter" || e.key === " ") && e.target.matches(".head[data-toggle]")) { e.preventDefault(); e.target.click(); }
  });
  function shiftOpen(fn) { state.open = new Set([...state.open].map(fn).filter((x) => x !== null)); }
  function removeStep(i) {
    state.steps.splice(i, 1);
    if (state.results) state.results.splice(i, 1);
    shiftOpen((x) => (x === i ? null : x > i ? x - 1 : x));
    edited(); render();
  }
  function moveUp(i) {
    [state.steps[i - 1], state.steps[i]] = [state.steps[i], state.steps[i - 1]];
    if (state.results) [state.results[i - 1], state.results[i]] = [state.results[i], state.results[i - 1]];
    shiftOpen((x) => (x === i ? i - 1 : x === i - 1 ? i : x));
    edited(); render();
  }

  $("#upload").addEventListener("change", async (e) => {
    let last;
    for (const f of e.target.files) {
      last = f.name.replace(/[^\w.-]+/g, "_").replace(/(\.pdf)?$/i, ".pdf");
      state.uploads[last] = new Uint8Array(await f.arrayBuffer());
      written.delete(last);
    }
    e.target.value = "";
    render();
    if (last) showDoc(last);
  });

  const dlg = $("#doc-dialog");
  dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close(); });

  // ---------------------------------------------------------------- document viewer
  async function showDoc(name) {
    $("#doc-title").textContent = name;
    const preview = CFG.samples.includes(name) ? `<img src="samples/${esc(name.replace(/\.pdf$/, ".png"))}" alt="${esc(name)} as a person sees it">` : "";
    const view = $("#doc-view");
    view.innerHTML = `${preview}<p class="muted">Reading it with the engine…</p>`;
    if (!dlg.open) dlg.showModal();
    try {
      const p = await py;
      await ensureDoc(p, name);
      const r = JSON.parse(p.pyimport("web").scan(name));
      view.innerHTML = `${preview}
        <div class="grid2">
          <div><h5>What a person sees</h5><div class="textbox">${r.visible.map(esc).join("<br>") || "<i>nothing</i>"}</div></div>
          <div><h5>Hidden from a person (white or tiny text)</h5><div class="textbox bad">${r.hidden.map(esc).join("<br>") || "<i>nothing hidden</i>"}</div></div>
        </div>
        <h5>Sentences written as commands to an AI</h5>
        ${r.injected.length ? r.injected.map((i) => `<div class="evidence"><b>page ${i.page}${i.hidden ? ", hidden" : ""} · command score ${i.score}</b>${esc(i.text)}</div>`).join("")
                            : '<p class="muted">None found. An agent reading this document is not being told to do anything.</p>'}`;
    } catch (err) {
      view.innerHTML += `<p class="err">Could not read this PDF: ${esc(err.message || err)}</p>`;
    }
  }

  // ---------------------------------------------------------------- run
  async function run() {
    const btn = $("#run");
    btn.disabled = true;
    btn.textContent = "Running…";
    $("#summary").hidden = true;
    try {
      const p = await py;
      for (const st of state.steps) if (st.doc) await ensureDoc(p, st.doc);
      const scenario = { sessions: state.sessions, steps: state.steps, tokens: state.tokens };
      const r = JSON.parse(p.pyimport("web").run(JSON.stringify(scenario), JSON.stringify(state.cards)));
      if (r.error) throw new Error(r.error);
      Object.assign(state, { stale: false, tokEdit: false, open: new Set(), live: clone(r.granted) });
      if ($("#slow").checked && !reduced) {
        state.running = true;
        state.results = [];
        for (let i = 0; i < r.rows.length; i++) {
          state.results[i] = r.rows[i];
          if (r.rows[i].token) state.live[r.rows[i].agent] = r.rows[i].token;
          state.current = i;
          renderSteps(); renderTokens();
          const el = $(`[data-step="${i}"]`);
          if (el) el.scrollIntoView({ block: "nearest", behavior: "smooth" });
          await sleep(STOPPED.includes(r.rows[i].action) || r.rows[i].action === "HOLD" ? 1100 : 450);
        }
      } else {
        state.results = r.rows;
        state.live = r.tokens;
      }
      state.running = false;
      state.current = null;
      renderSteps(); renderTokens();
      summarize(r);
    } catch (err) {
      state.running = false;
      const s = $("#summary");
      s.className = "summary bad";
      s.innerHTML = `<h4>Could not run this scenario</h4><p class="err">${esc(err.message || err)}</p>`;
      s.hidden = false;
    }
    btn.disabled = false;
    btn.textContent = "▶ Run again";
  }

  function summarize(r) {
    const rows = r.rows.filter((x) => !x.error), n = rows.length;
    const stopped = rows.filter((x) => STOPPED.includes(x.action)), held = rows.filter((x) => x.action === "HOLD");
    const flagged = [...stopped, ...held];
    const missedByIam = flagged.filter((x) => x.iam).length;
    const firstFlag = flagged.length ? Math.min(...flagged.map((x) => x.n)) : null;
    const keptWorking = rows.filter((x) => x.action === "ALLOW" && firstFlag && x.n > firstFlag).map((x) => x.n);
    const removed = Object.entries(r.granted).flatMap(([a, g]) => g.filter((s) => !(r.tokens[a] || []).includes(s)));
    const s = $("#summary");
    s.className = "summary " + (flagged.length ? "bad" : "ok");
    const title = !flagged.length ? "Nothing flagged. Every step traced back to the human's task."
      : [stopped.length && `ALIBI stopped ${stopped.length}`, held.length && `held ${held.length} for the owner`].filter(Boolean).join(" and ") + ` of ${n} steps.`;
    s.innerHTML = `<h4>${title}</h4>
      ${flagged.length ? `<div class="compare">
        <div><b>Token check only</b><span class="big bad-t">${missedByIam} of ${flagged.length}</span> flagged steps would have run: the token was valid for them.</div>
        <div><b>With ALIBI</b>${removed.length ? `Removed <span class="mono">${esc(removed.join(", "))}</span>. ` : ""}${
          keptWorking.length ? `<span class="ok-t">The agent kept working: step${keptWorking.length > 1 ? "s" : ""} ${keptWorking.join(", ")} still ran.</span>`
                             : r.rows.some((x) => x.action === "QUARANTINE") ? "The agent was quarantined: all scopes revoked." : ""}</div>
      </div>` : `<p class="muted" style="margin:0">All ${n} steps were allowed and the token is unchanged. Try editing a step to see what ALIBI catches.</p>`}`;
    s.hidden = false;
    if (!reduced) s.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  // ---------------------------------------------------------------- nav highlight
  const navLinks = [...document.querySelectorAll(".top .links a[href^='#']")];
  const io = new IntersectionObserver((entries) => {
    for (const en of entries) if (en.isIntersecting) navLinks.forEach((a) => a.classList.toggle("on", a.getAttribute("href") === "#" + en.target.id));
  }, { rootMargin: "-45% 0px -50% 0px" });
  navLinks.forEach((a) => { const sec = $(a.getAttribute("href")); if (sec) io.observe(sec); });

  // ---------------------------------------------------------------- start
  $("#presets").innerHTML = CFG.presets.map((p) =>
    `<button class="scen${p.benign ? " benign" : ""}" role="tab" data-id="${p.id}"><b>${esc(p.title)}</b><span>${esc(p.short || "")}</span></button>`).join("");
  document.body.insertAdjacentHTML("beforeend", `<datalist id="tools">${TOOLS.map((t) => `<option value="${t}">`).join("")}</datalist>`);
  loadPreset(CFG.presets[0].id);
})();
