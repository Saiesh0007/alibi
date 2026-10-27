// The live playground: loads Pyodide, copies the real alibi/ package into it, and runs scenarios through web.py.
(() => {
  const CFG = JSON.parse(document.getElementById("cfg").textContent);
  const TOOLS = ["search_suppliers", "read_file", "read_ticket", "create_purchase_request", "send_email",
                 "ask_agent", "http_post", "export_report", "track_shipment"];
  const $ = (s, el = document) => el.querySelector(s);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const clone = (o) => JSON.parse(JSON.stringify(o));

  const state = { preset: null, sessions: [], steps: [], tokens: clone(CFG.tokens), cards: clone(CFG.cards),
                  uploads: {}, cardSel: Object.keys(CFG.cards)[0] };
  const agents = () => Object.keys(CFG.tokens);
  const cardAgent = (text) => (text.match(/^agent:\s*(\S+)/m) || [])[1];
  const docs = () => [...CFG.samples, ...Object.keys(state.uploads)];

  // ---------------------------------------------------------------- Python
  const statusEl = $("#py-status");
  const setStatus = (t, cls = "") => { statusEl.textContent = t; statusEl.className = "status " + cls; };
  let written = new Set();
  const py = (async () => {
    setStatus("Loading Python in your browser (Pyodide)…");
    const p = await loadPyodide({ indexURL: CFG.pyodide });
    setStatus("Loading scikit-learn and PyYAML (about 30 MB the first time, cached after)…");
    await p.loadPackage(["pyyaml", "scikit-learn", "micropip"]);
    setStatus("Installing pypdf…");
    p.globals.set("WHEEL", new URL(CFG.wheel, location.href).href);
    await p.runPythonAsync("import micropip\nawait micropip.install(WHEEL)");
    setStatus("Loading the ALIBI engine…");
    for (const f of CFG.files) {
      const text = await (await fetch("py/" + f)).text();
      const dir = ("/work/" + f).split("/").slice(0, -1).join("/");
      p.FS.mkdirTree(dir);
      p.FS.writeFile("/work/" + f, text);
    }
    p.FS.mkdirTree("/work/docs");
    p.runPython("import sys, os\nsys.path.insert(0, '/work')\nos.chdir('/work')\nimport web");
    setStatus("Engine ready. This is the same Python code as the repo, running in your browser.", "ok");
    $("#run").disabled = false;
    return p;
  })().catch((e) => { setStatus("Could not load the engine: " + e, "err"); throw e; });

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
    state.preset = id;
    state.sessions = clone(pr.sessions);
    state.steps = clone(pr.steps);
    state.tokens = clone(CFG.tokens);
    $("#blurb").textContent = pr.blurb;
    const first = (state.sessions[0] || state.steps[0] || {}).agent;
    state.cardSel = Object.keys(state.cards).find((c) => cardAgent(state.cards[c]) === first) || state.cardSel;
    document.querySelectorAll("#presets button").forEach((b) => b.classList.toggle("on", b.dataset.id === id));
    $("#results").innerHTML = '<p class="muted">Press <b>Run through ALIBI</b> to score these steps.</p>';
    render();
  }

  // ---------------------------------------------------------------- editor
  const opt = (v, label, sel) => `<option value="${esc(v)}"${v === sel ? " selected" : ""}>${esc(label)}</option>`;

  function render() {
    $("#sessions").innerHTML = state.sessions.map((s, i) => `
      <div class="sess">
        <div class="row">
          <span class="pill">${esc(s.id)}</span>
          <select data-s="${i}" data-k="agent">${agents().map((a) => opt(a, a, s.agent)).join("")}</select>
          <label class="tiny">asked by
            <select data-s="${i}" data-k="requested_by">${opt("", "a human", s.requested_by || "")}
              ${state.sessions.filter((o) => o.id !== s.id).map((o) => opt(o.id, `${o.id} (${o.agent})`, s.requested_by)).join("")}
            </select></label>
          <button class="x" data-del-s="${i}" title="Remove session">✕</button>
        </div>
        <textarea data-s="${i}" data-k="task" rows="2" placeholder="The task a human gave this agent">${esc(s.task)}</textarea>
      </div>`).join("") || '<p class="muted tiny">No sessions: every step below runs with no task behind it.</p>';

    const sessOpts = (cur) => state.sessions.map((s) => opt(s.id, s.id, cur)).join("") + opt("", "none", cur || "");
    const readOpts = (st) => opt("", "nothing", st.doc ? "" : (st.text != null ? "__text" : "")) +
      docs().map((d) => opt(d, "📄 " + d, st.doc || "")).join("") + opt("__text", "pasted text", st.text != null && !st.doc ? "__text" : "");
    $("#steps").innerHTML = state.steps.map((st, i) => `
      <div class="step">
        <span class="num">${i + 1}</span>
        <div class="fields">
          <label>session<select data-i="${i}" data-k="session">${sessOpts(st.session)}</select></label>
          ${st.session ? "" : `<label>agent<select data-i="${i}" data-k="agent">${agents().map((a) => opt(a, a, st.agent)).join("")}</select></label>`}
          <label>tool<input list="tools" data-i="${i}" data-k="tool" value="${esc(st.tool)}"></label>
          <label class="w2">target<input data-i="${i}" data-k="target" value="${esc(st.target || "")}"></label>
          <label class="w2">args<input data-i="${i}" data-k="args" value="${esc(argsToText(st.args))}" placeholder="key=value; key=value"></label>
          <label class="w2">content it reads<select data-i="${i}" data-k="reads">${readOpts(st)}</select></label>
          ${st.text != null && !st.doc ? `<label class="full">text<textarea data-i="${i}" data-k="text" rows="2">${esc(st.text)}</textarea></label>` : ""}
        </div>
        <div class="ctl">
          <button class="x" data-up="${i}" title="Move up">↑</button>
          <button class="x" data-del="${i}" title="Remove step">✕</button>
        </div>
      </div>`).join("");

    $("#tokens").innerHTML = [...new Set(state.steps.map((st) => st.session ? (state.sessions.find((s) => s.id === st.session) || {}).agent : st.agent))]
      .filter(Boolean).map((a) => `<label class="full">${esc(a)}<input data-tok="${esc(a)}" value="${esc((state.tokens[a] || []).join(", "))}"></label>`).join("");

    $("#card-sel").innerHTML = Object.keys(state.cards).map((c) => opt(c, c, state.cardSel)).join("");
    $("#card").value = state.cards[state.cardSel];
    $("#docs").innerHTML = docs().map((d) => `<button class="doc" data-doc="${esc(d)}">📄 ${esc(d)}${state.uploads[d] ? ' <span class="tiny muted">(yours)</span>' : ""}</button>`).join("");
  }

  document.addEventListener("input", (e) => {
    const t = e.target, d = t.dataset;
    if (d.i !== undefined && d.k !== "reads" && d.k !== "session") {
      const st = state.steps[+d.i];
      if (d.k === "args") st.args = textToArgs(t.value); else st[d.k] = t.value;
    } else if (d.s !== undefined && d.k === "task") state.sessions[+d.s].task = t.value;
    else if (d.tok) state.tokens[d.tok] = t.value.split(",").map((x) => x.trim()).filter(Boolean);
    else if (t.id === "card") state.cards[state.cardSel] = t.value;
  });
  document.addEventListener("change", (e) => {
    const t = e.target, d = t.dataset;
    if (d.i !== undefined && d.k === "session") {
      const st = state.steps[+d.i];
      st.session = t.value;
      if (!t.value) st.agent = st.agent || agents()[0];
      render();
    } else if (d.i !== undefined && d.k === "reads") {
      const st = state.steps[+d.i];
      delete st.doc; delete st.text;
      if (t.value === "__text") st.text = ""; else if (t.value) st.doc = t.value;
      render();
    } else if (d.i !== undefined && d.k === "agent") state.steps[+d.i].agent = t.value;
    else if (d.s !== undefined && d.k !== "task") { state.sessions[+d.s][d.k] = t.value; render(); }
    else if (t.id === "card-sel") { state.cardSel = t.value; render(); }
  });
  document.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    const d = b.dataset;
    if (d.id) loadPreset(d.id);
    else if (d.del !== undefined) { state.steps.splice(+d.del, 1); render(); }
    else if (d.up !== undefined && +d.up > 0) { const i = +d.up; [state.steps[i - 1], state.steps[i]] = [state.steps[i], state.steps[i - 1]]; render(); }
    else if (d.delS !== undefined) {
      const id = state.sessions[+d.delS].id;
      state.sessions.splice(+d.delS, 1);
      state.steps.forEach((st) => { if (st.session === id) { st.session = ""; st.agent = st.agent || agents()[0]; } });
      render();
    } else if (d.doc) showDoc(d.doc);
    else if (b.id === "add-step") {
      state.steps.push({ session: state.sessions[0] ? state.sessions[0].id : "", agent: agents()[0], tool: "read_file", target: "", args: {} });
      render();
    } else if (b.id === "add-session") {
      const ids = new Set(state.sessions.map((s) => s.id));
      let n = 1; while (ids.has("s" + n)) n++;
      state.sessions.push({ id: "s" + n, agent: agents()[0], task: "" });
      render();
    } else if (b.id === "card-reset") { state.cards[state.cardSel] = CFG.cards[state.cardSel]; render(); }
    else if (b.id === "run") run();
  });

  $("#upload").addEventListener("change", async (e) => {
    for (const f of e.target.files) {
      const name = f.name.replace(/[^\w.-]+/g, "_").replace(/(\.pdf)?$/i, ".pdf");
      state.uploads[name] = new Uint8Array(await f.arrayBuffer());
      written.delete(name);
      render();
      showDoc(name);
    }
    e.target.value = "";
  });

  // ---------------------------------------------------------------- document viewer
  async function showDoc(name) {
    const box = $("#doc-view");
    box.hidden = false;
    const preview = CFG.samples.includes(name) ? `<img src="samples/${esc(name.replace(/\.pdf$/, ".png"))}" alt="${esc(name)} as a person sees it">` : "";
    box.innerHTML = `<h4>${esc(name)}</h4>${preview}<p class="muted">Reading it with the engine…</p>`;
    try {
      const p = await py;
      await ensureDoc(p, name);
      const r = JSON.parse(p.pyimport("web").scan(name));
      box.innerHTML = `<h4>${esc(name)}</h4>${preview}
        <div class="grid2 tight">
          <div><h5>What a person sees</h5><div class="textbox">${r.visible.map(esc).join("<br>") || "<i>nothing</i>"}</div></div>
          <div><h5>Hidden from a person (white or tiny text)</h5><div class="textbox bad">${r.hidden.map(esc).join("<br>") || "<i>nothing hidden</i>"}</div></div>
        </div>
        <h5>Sentences written as commands to an AI</h5>
        ${r.injected.length ? r.injected.map((i) => `<div class="evidence"><b>p.${i.page}${i.hidden ? ", hidden" : ""}, score ${i.score}</b> ${esc(i.text)}</div>`).join("")
                            : '<p class="muted">None found.</p>'}`;
    } catch (err) {
      box.innerHTML += `<p class="err">Could not read this PDF: ${esc(err.message || err)}</p>`;
    }
  }

  // ---------------------------------------------------------------- run
  async function run() {
    const out = $("#results");
    const btn = $("#run");
    btn.disabled = true;
    out.innerHTML = '<p class="muted">Running…</p>';
    await new Promise((r) => setTimeout(r, 30));
    try {
      const p = await py;
      for (const st of state.steps) if (st.doc) await ensureDoc(p, st.doc);
      const scenario = { sessions: state.sessions, steps: state.steps, tokens: state.tokens };
      const r = JSON.parse(p.pyimport("web").run(JSON.stringify(scenario), JSON.stringify(state.cards)));
      out.innerHTML = r.error ? `<p class="err">${esc(r.error)}</p>` : renderResults(r);
      out.scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (err) {
      out.innerHTML = `<p class="err">${esc(err.message || err)}</p>`;
    }
    btn.disabled = false;
  }

  function renderResults(r) {
    const flagged = r.rows.filter((x) => x.action && x.action !== "ALLOW").length;
    const tokens = Object.entries(r.granted).filter(([a]) => r.rows.some((x) => x.agent === a)).map(([a, g]) => {
      const now = new Set(r.tokens[a] || []);
      return `<div class="tok"><span class="tiny muted">${esc(a)} token now</span> ${g.map((s) => `<span class="scope${now.has(s) ? "" : " gone"}">${esc(s)}</span>`).join(" ")}</div>`;
    }).join("");
    const rows = r.rows.map((x) => {
      if (x.error) return `<div class="res err"><div class="res-head"><span class="num">${x.n}</span><span class="mono">${esc(x.tool)} ${esc(x.target)}</span></div><p>${esc(x.error)}</p></div>`;
      const info = x.reasons.filter(([p]) => p === 0), pts = x.reasons.filter(([p]) => p > 0);
      return `<div class="res a-${x.action}">
        <div class="res-head"><span class="num">${x.n}</span><span class="mono t">${esc(x.tool)} <span class="muted">${esc(x.target)}</span></span>
          <span class="chip">${x.action}</span><span class="score">${x.score}</span></div>
        <div class="meter"><i style="width:${x.score}%"></i></div>
        ${pts.length ? `<ul class="reasons">${pts.map(([p, t]) => `<li><b>+${p}</b> ${esc(t)}</li>`).join("")}</ul>` : ""}
        ${info.map(([, t]) => `<p class="info">⚠ ${esc(t)}</p>`).join("")}
        ${x.evidence.map((e) => `<div class="evidence"><b>Traced to ${e.hidden ? "hidden text in " : ""}${esc(e.source)}, p.${e.page}</b> ${esc(e.text)}</div>`).join("")}
        ${x.action !== "ALLOW" ? `<p class="note">→ ${esc(x.note)}</p>` : ""}
      </div>`;
    }).join("");
    return `<div class="summary"><b>${flagged}</b> of ${r.rows.length} steps stopped or held${tokens}</div>${rows}`;
  }

  // ---------------------------------------------------------------- start
  $("#presets").innerHTML = CFG.presets.map((p) => `<button data-id="${p.id}">${esc(p.title)}</button>`).join("");
  $("#tools").innerHTML = TOOLS.map((t) => `<option value="${t}">`).join("");
  loadPreset(CFG.presets[0].id);
})();
