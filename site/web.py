"""The playground's bridge to the engine. Runs inside the browser (Pyodide), and locally for testing.

run() takes a scenario and the role cards as JSON, feeds every step through the real ALIBI engine and
applies alibi.respond to the agent's token, like demo.py does.
"""
import json
import os
import shutil

from alibi import ALLOW, Alibi, respond
from alibi.provenance import read_pdf, scan_content
from alibi.respond import scope_for
from scenarios import BAITS

WORK = os.path.dirname(os.path.abspath(__file__))
DOCS = os.path.join(WORK, "docs")


def _cards_dir(cards):
    d = os.path.join(WORK, "_cards")
    shutil.rmtree(d, ignore_errors=True)
    os.makedirs(d)
    for name, text in cards.items():
        with open(os.path.join(d, os.path.basename(name)), "w", encoding="utf-8") as f:
            f.write(text)
    return d


def run(scenario_json, cards_json):
    sc, cards = json.loads(scenario_json), json.loads(cards_json)
    try:
        eng = Alibi(_cards_dir(cards), baits=BAITS)
    except Exception as e:
        return json.dumps({"error": f"Could not read a role card: {e}"})
    sessions = {s["id"]: s for s in sc["sessions"]}
    for s in sc["sessions"]:
        eng.start_session(s["id"], s["agent"], s["task"], s.get("requested_by") or None)
    granted = {a: list(t) for a, t in sc["tokens"].items()}
    tokens = {a: list(t) for a, t in granted.items()}

    rows = []
    for n, st in enumerate(sc["steps"], 1):
        sess = sessions.get(st.get("session"))
        agent = sess["agent"] if sess else st.get("agent", "")
        ev = {"agent": agent, "session": sess["id"] if sess else None, "tool": st["tool"],
              "target": st.get("target", ""), "args": st.get("args") or {}}
        if st.get("doc"):
            ev.update(content_path=os.path.join(DOCS, st["doc"]), trust="untrusted")
        elif st.get("text"):
            ev.update(content=st["text"], trust="untrusted")
        row = {"n": n, "agent": agent, "tool": ev["tool"], "target": ev["target"]}
        if agent not in eng.cards:
            rows.append({**row, "error": f"no role card for agent '{agent}'"})
            continue
        try:
            v = eng.observe(ev)
        except Exception as e:
            rows.append({**row, "error": f"{type(e).__name__}: {e}"})
            continue
        token = tokens.setdefault(agent, [])
        scope = scope_for(ev)
        if scope in granted.get(agent, []) and scope not in token:
            # an earlier alert already took this permission away, so the call fails at the token check
            note, action = f"{scope} was already removed from the token", "BLOCKED"
        else:
            action, note = v.action, "allowed"
            if v.action != ALLOW:
                token, note = respond(token, v, ev)
                tokens[agent] = token
        rows.append({**row, "score": v.score, "action": action, "note": note, "token": list(token),
                     "reasons": [[p, t] for p, t in v.reasons],
                     "evidence": [{"source": os.path.basename(e["source"]), "page": e["page"],
                                   "hidden": e["hidden"], "text": e["text"]} for e in v.evidence]})
    return json.dumps({"rows": rows, "tokens": tokens, "granted": granted})


def scan(name):
    """What a person sees in a document vs what an AI agent reads, and which sentences are commands."""
    path = os.path.join(DOCS, name)
    visible, hidden = read_pdf(path)
    _, injected = scan_content(name, path=path)
    return json.dumps({"visible": [t for _, t in visible], "hidden": [t for _, t in hidden],
                       "injected": [{"page": i["page"], "hidden": i["hidden"], "text": i["text"], "score": i["score"]}
                                    for i in injected]})
