"""Builds the static project page from what demo.py, evaluate.py and drift_sim.py just wrote to out/,
plus the live playground: the engine's Python files, role cards and sample PDFs, run in the browser by Pyodide.

Every number on the page comes from those files, so the page always matches the code.
Usage: python site/build.py   (after the three scripts)   -> _site/
"""
import datetime
import glob
import html
import json
import os
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT = os.path.join(ROOT, "out")
SITE = os.path.join(ROOT, "_site")
REPO = os.environ.get("GITHUB_REPOSITORY", "Saiesh0007/alibi")
SHA = os.environ.get("GITHUB_SHA", "local")[:7]
PYODIDE = "https://cdn.jsdelivr.net/pyodide/v0.27.5/full/"
PYPDF = "pypdf==5.4.0"   # PyMuPDF has no Pyodide build, so the browser reads PDFs with pypdf

sys.path[:0] = [ROOT, HERE]
from presets import PRESETS, SAMPLES, TOKENS  # noqa: E402

# score points used by alibi/engine.py
SIGNALS = [
    ("Key value appears only in a hidden or injected instruction", 40),
    ("Data outside the role card's allowed folders", 40),
    ("Sends data to a destination not in the role card", 45),
    ("Token used with no task behind it", 45),
    ("Asked for by another agent whose session already scored 40+", 30),
    ("Value appears nowhere in the task, role card or anything read", 20),
    ("Action matches the planted command more than the task (TF-IDF)", 20),
    ("More reads in one session than the role card allows", 15),
]


def esc(s):
    return html.escape(str(s))


def bar_chart(rows):
    """Attacks caught per type: role-card rules vs ALIBI."""
    label_w, bar_w, row_h, top = 250, 420, 44, 4
    h = top + row_h * len(rows)
    parts = [f'<svg viewBox="0 0 {label_w + bar_w + 60} {h}" role="img" aria-label="Attacks caught per type">']
    for i, r in enumerate(rows):
        y = top + i * row_h
        parts.append(f'<text x="0" y="{y + 18}" class="lbl">{esc(r["name"])}</text>')
        for j, (key, cls) in enumerate((("rules", "b-rules"), ("alibi", "b-alibi"))):
            by = y + 4 + j * 16
            w = bar_w * r[key] / r["n"]
            parts.append(f'<rect x="{label_w}" y="{by}" width="{bar_w}" height="12" rx="3" class="track"/>')
            if w:
                parts.append(f'<rect x="{label_w}" y="{by}" width="{w:.1f}" height="12" rx="3" class="{cls}"/>')
            parts.append(f'<text x="{label_w + bar_w + 8}" y="{by + 11}" class="val">{r[key]}/{r["n"]}</text>')
    parts.append("</svg>")
    return "".join(parts)


def drift_chart(d):
    """Daily Jensen-Shannon distance, frozen vs rolling baseline."""
    W, H, L, B, T, R = 900, 300, 44, 36, 14, 12
    n = len(d["js_frozen"])
    ymax = max(max(d["js_frozen"]), max(d["js_rolling"])) * 1.1
    x = lambda i: L + (W - L - R) * i / (n - 1)
    y = lambda v: T + (H - T - B) * (1 - v / ymax)
    line = lambda vals: " ".join(f"{x(i):.1f},{y(v):.1f}" for i, v in enumerate(vals))
    parts = [f'<svg viewBox="0 0 {W} {H}" role="img" aria-label="Slow drift: frozen vs rolling baseline">',
             f'<line x1="{L}" y1="{H - B}" x2="{W - R}" y2="{H - B}" class="grid"/>']
    for t in (0.05, 0.1, 0.15, 0.2):
        if t < ymax:
            parts.append(f'<line x1="{L}" y1="{y(t):.1f}" x2="{W - R}" y2="{y(t):.1f}" class="grid faint"/>'
                         f'<text x="{L - 6}" y="{y(t) + 4:.1f}" class="axis" text-anchor="end">{t:.2f}</text>')
    for i in range(0, n, 10):
        parts.append(f'<text x="{x(i):.1f}" y="{H - B + 18}" class="axis" text-anchor="middle">day {i}</text>')
    s = d["start"]
    parts.append(f'<line x1="{x(s):.1f}" y1="{T}" x2="{x(s):.1f}" y2="{H - B}" class="mark"/>'
                 f'<text x="{x(s) - 6:.1f}" y="{T + 12}" class="axis" text-anchor="end">drift starts</text>')
    parts.append(f'<polyline points="{line(d["js_rolling"])}" class="l-rolling"/>')
    parts.append(f'<polyline points="{line(d["js_frozen"])}" class="l-frozen"/>')
    a = d["alert_frozen"]
    if a is not None:
        parts.append(f'<line x1="{x(a):.1f}" y1="{T}" x2="{x(a):.1f}" y2="{H - B}" class="mark red"/>'
                     f'<circle cx="{x(a):.1f}" cy="{y(d["js_frozen"][a]):.1f}" r="5" class="alert"/>'
                     f'<text x="{x(a) + 6:.1f}" y="{T + 12}" class="lbl">ALIBI alert, day {a}</text>')
    parts.append("</svg>")
    return "".join(parts)


def results_table(rows):
    out = []
    for kind, title in (("benign", "False alarms on normal work"), ("attack", "Attacks caught")):
        out.append(f'<tr class="group"><td colspan="5">{title}</td></tr>')
        for r in (r for r in rows if r["kind"] == kind):
            good = (r["alibi"] == 0) if kind == "benign" else (r["alibi"] == r["n"])
            out.append(f'<tr><td>{esc(r["name"])}</td><td>{r["n"]}</td><td>0</td><td>{r["rules"]}</td>'
                       f'<td class="{"ok" if good else "miss"}">{r["alibi"]}</td></tr>')
    return "\n".join(out)


def main():
    results = json.load(open(os.path.join(OUT, "results.json")))
    drift = json.load(open(os.path.join(OUT, "drift.json")))
    hidden = open(os.path.join(OUT, "hidden_text.txt")).read()
    card = open(os.path.join(ROOT, "rolecards", "procurement-agent.yaml")).read()
    t, rows = results["totals"], results["rows"]
    attacks = [r for r in rows if r["kind"] == "attack"]
    a = drift["alert_frozen"]
    drift_line = (f"Drift starts on day {drift['start']}. ALIBI's frozen baseline raises an alert on day {a}, "
                  f"when finance files are only {drift['finance_share_at_alert'] * 100:.1f}% of the agent's reads. "
                  if a is not None else "The frozen baseline did not raise an alert in this run. ")
    drift_line += ("The rolling 7-day baseline never alerts: it learns the drift as normal."
                   if drift["alert_rolling"] is None else f"The rolling baseline alerts on day {drift['alert_rolling']}.")

    shutil.rmtree(SITE, ignore_errors=True)
    os.makedirs(SITE)
    values = dict(
        repo=REPO, sha=SHA, date=datetime.date.today().isoformat(),
        caught=t["alibi"], attacks=t["attacks"], rules=t["rules"], fp=t["fp_alibi"], benign=t["benign"],
        hidden=esc(hidden), card=esc(card), table=results_table(rows), bars=bar_chart(attacks),
        drift=drift_chart(drift), drift_line=esc(drift_line),
        signals="\n".join(f"<tr><td>{esc(s)}</td><td>+{p}</td></tr>" for s, p in SIGNALS),
        config=json.dumps(playground()).replace("</", "<\\/"),
    )
    page = open(os.path.join(HERE, "index.html"), encoding="utf-8").read()
    for k, v in values.items():
        page = page.replace("{{" + k + "}}", str(v))
    with open(os.path.join(SITE, "index.html"), "w", encoding="utf-8") as f:
        f.write(page)
    for name in ("demo_terminal.svg", "pdf_visible.png", "pdf_marked.png"):
        shutil.copy(os.path.join(OUT, name), SITE)
    for name in ("style.css", "app.js"):
        shutil.copy(os.path.join(HERE, name), SITE)
    with open(os.path.join(SITE, ".nojekyll"), "w"):
        pass
    print(f"wrote {SITE}")


def playground():
    """Copies what the browser needs into _site/ and returns the page's config."""
    import pymupdf
    from scenarios import quote_pdf

    py = os.path.join(SITE, "py")
    files = [os.path.relpath(p, ROOT).replace(os.sep, "/") for p in sorted(glob.glob(os.path.join(ROOT, "alibi", "*.py")))]
    files.append("scenarios.py")
    for f in files:
        os.makedirs(os.path.dirname(os.path.join(py, f)), exist_ok=True)
        shutil.copy(os.path.join(ROOT, f), os.path.join(py, f))
    shutil.copy(os.path.join(HERE, "web.py"), py)
    files.append("web.py")
    subprocess.run([sys.executable, "-m", "pip", "download", PYPDF, "--no-deps", "--only-binary=:all:", "-q", "-d", py],
                   check=True)
    wheel = os.path.basename(glob.glob(os.path.join(py, "pypdf-*.whl"))[0])

    samples = os.path.join(SITE, "samples")
    os.makedirs(samples)
    for name, (supplier, item, qty, price, hidden, note) in SAMPLES.items():
        path = shutil.move(quote_pdf(name, supplier, item, qty, price, hidden=hidden, note=note), samples)
        with pymupdf.open(path) as doc:
            doc[0].get_pixmap(dpi=110, clip=pymupdf.Rect(0, 0, 595, 380)).save(path[:-4] + ".png")

    cards = {os.path.basename(p): open(p, encoding="utf-8").read()
             for p in sorted(glob.glob(os.path.join(ROOT, "rolecards", "*.yaml")))}
    return {"pyodide": PYODIDE, "wheel": "py/" + wheel, "files": files, "samples": list(SAMPLES),
            "poisoned": [n for n, spec in SAMPLES.items() if spec[4]],
            "cards": cards, "tokens": TOKENS, "presets": PRESETS}


if __name__ == "__main__":
    main()
