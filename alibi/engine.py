"""The ALIBI engine: sees every tool call an agent makes and asks "why is it doing this?"."""
from dataclasses import dataclass, field
from urllib.parse import urlparse

from .provenance import scan_content, similarity, trace_value
from .rolecard import load_rolecards

READ_TOOLS = {"read_file", "read_ticket", "search_suppliers", "export_report"}
KEY_ARGS = {"url", "to", "supplier", "qty", "path", "target", "account"}
SOURCE_ARGS = {"url", "supplier", "account"}

ALLOW, HOLD, RESTRICT, QUARANTINE = "ALLOW", "HOLD", "RESTRICT", "QUARANTINE"


@dataclass
class Verdict:
    score: int
    action: str
    reasons: list = field(default_factory=list)   # (points, text)
    evidence: list = field(default_factory=list)  # injected commands the action was traced to


@dataclass
class Session:
    id: str
    agent: str
    task: str
    requested_by: str = None          # session id of the agent that delegated this work
    data_texts: list = field(default_factory=list)
    injected: list = field(default_factory=list)
    reads: int = 0
    max_score: int = 0


def host_of(target):
    return urlparse(target).hostname or target.split("@")[-1]


class Alibi:
    def __init__(self, *rolecard_dirs, baits=()):
        self.cards = load_rolecards(*rolecard_dirs)
        self.baits = set(baits)
        self.sessions = {}

    def start_session(self, sid, agent, task, requested_by=None):
        self.sessions[sid] = Session(sid, agent, task, requested_by)
        return self.sessions[sid]

    # ------------------------------------------------------------------ rules from the role card
    def _role_checks(self, card, ev):
        out = []
        tool, target = ev["tool"], ev.get("target", "")
        if tool not in card.tools:
            out.append((25, f"tool '{tool}' is not in the role card"))
        if tool in READ_TOOLS and "/" in target and not card.allows_path(target):
            allowed = ", ".join(a.rstrip("/*") for a in card.data_allow)
            out.append((40, f"{target.rsplit('/', 1)[0]}/ is outside its role (allowed: {allowed})"))
        if tool in ("http_post", "send_email", "track_shipment"):
            host = host_of(target)
            if not card.allows_host(host):
                out.append((45, f"sends data to {host}, not an allowed destination"))
        return out

    # ------------------------------------------------------------------ the alibi check
    def _chain(self, s):
        """Sessions from s up to the human who started the work."""
        chain = [s]
        while chain[-1].requested_by in self.sessions:
            chain.append(self.sessions[chain[-1].requested_by])
        return chain

    def _alibi_checks(self, card, s, ev):
        out, evidence = [], []
        chain = self._chain(s)
        # authority comes from the human task at the root; a delegated message is only data
        task = chain[-1].task
        injected = [i for c in chain for i in c.injected]
        data_texts = [t for c in chain for t in c.data_texts] + ([s.task] if len(chain) > 1 else [])
        unsourced = []
        values = {k: v for k, v in ev.get("args", {}).items() if k in KEY_ARGS}
        values["target"] = ev.get("target", "")
        for key, value in values.items():
            if value in ("", None) or (isinstance(value, (int, float)) and value < 100):
                continue
            where, hits = trace_value(value, task, card.text, data_texts, injected)
            if "injected" in where and not ({"task", "role card"} & set(where)):
                h = hits[0]
                place = f"hidden text in {h['source'].split('/')[-1]}, p.{h['page']}" if h["hidden"] else h["source"]
                out.append((40, f"'{value}' appears only in {place}"))
                evidence.append(h)
                break
            if not where and key in SOURCE_ARGS:
                unsourced.append(value)
        if not out and unsourced:
            out.append((20, f"'{unsourced[0]}' does not appear in the task, the role card or anything the agent read"))
        if not out and injected:
            action_text = f"{ev['tool']} {ev.get('target', '')} " + " ".join(map(str, ev.get("args", {}).values()))
            sim_task, sim_inj = similarity(action_text, task, [i["text"] for i in injected])
            if sim_inj > 0.15 and sim_inj > sim_task + 0.05:
                out.append((20, f"action matches the planted command ({sim_inj:.2f}) more than the task ({sim_task:.2f})"))
                evidence.append(max(injected, key=lambda i: i["score"]))
        return out, evidence

    def observe(self, ev):
        card = self.cards[ev["agent"]]
        s = self.sessions.get(ev.get("session"))
        reasons, evidence = [], []

        if ev.get("target") in self.baits or any(v in self.baits for v in ev.get("args", {}).values()):
            v = Verdict(100, QUARANTINE, [(100, f"touched bait '{ev.get('target')}', no real job ever needs it")])
            if s:
                s.max_score = 100
            return v

        reasons += self._role_checks(card, ev)
        if s is None:
            reasons.append((45, "no task behind this call: the token was used outside any session"))
        else:
            alibi, evidence = self._alibi_checks(card, s, ev)
            reasons += alibi
            parent = self.sessions.get(s.requested_by)
            if parent and parent.max_score >= 40:
                reasons.append((30, f"asked for by {parent.agent}, whose session scored {parent.max_score}"))
            if ev["tool"] in READ_TOOLS:
                s.reads += 1
                if s.reads > card.limits.get("reads_per_session", 10 ** 6):
                    reasons.append((15, f"{s.reads} reads in one session, limit is {card.limits['reads_per_session']}"))

        score = min(100, sum(p for p, _ in reasons))
        action = ALLOW if score < 40 else HOLD if score < 70 else RESTRICT
        if s:
            s.max_score = max(s.max_score, score)
            # what the agent just read becomes context for judging its next actions
            if ev.get("trust") == "untrusted" and action == ALLOW:
                data, injected = scan_content(ev.get("target"), ev.get("content"), ev.get("content_path"))
                s.data_texts.append(data)
                s.injected += injected
                if injected:
                    reasons.append((0, f"{len(injected)} hidden command(s) aimed at an AI found inside"))
            elif ev.get("content") and action == ALLOW:
                s.data_texts.append(ev["content"])
        return Verdict(score, action, sorted(reasons, key=lambda r: -r[0]), evidence)
