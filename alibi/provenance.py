"""Where did an instruction, or a value inside an action, come from?

Two ideas:
1. Data may inform an action, only the human's task may command one. So we look for text in
   untrusted content (PDFs, emails, web pages) that is written as a command to an AI.
2. Every important value in an action (a URL, an email address, a supplier, a quantity, a path)
   should be traceable to the task, the role card or ordinary data. If it only exists inside a
   hidden command, the action has no alibi.
"""
import os
import re

import pymupdf
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.metrics.pairwise import cosine_similarity

AI_ADDRESS = re.compile(r"\b(ai|assistant|ai agent|automated agent|language model|llm|bot)\b", re.I)
OVERRIDE = re.compile(r"\b(ignore (all|any|previous|prior)|disregard|new instructions?|system (note|override|message)"
                      r"|admin (note|instruction))\b", re.I)
SECRECY = re.compile(r"\b(do not (mention|tell|inform|log|report)|don't (mention|tell)|without (notifying|telling)"
                     r"|silently|quietly)\b", re.I)
IMPERATIVE = re.compile(r"^(please\s+)?(send|forward|upload|export|post|email|read|open|create|raise|transfer|copy"
                        r"|attach|share|download|change|update|mark)\b", re.I)
INJECTED_AT = 3


def sentences(text):
    return [s.strip() for s in re.split(r"(?<=[.!?])\s+|\n+", text) if len(s.strip()) > 3]


def instruction_score(sentence, hidden=False):
    score = 2 if hidden else 0
    score += 2 if AI_ADDRESS.search(sentence) else 0
    score += 2 if OVERRIDE.search(sentence) else 0
    score += 1 if SECRECY.search(sentence) else 0
    clauses = re.split(r"[:;,]\s*", sentence)
    score += 1 if any(IMPERATIVE.search(c) for c in clauses) else 0
    return score


def read_pdf(path):
    """Text of a PDF plus the spans a human can't see (white or tiny text)."""
    visible, hidden = [], []
    with pymupdf.open(path) as doc:
        for pno, page in enumerate(doc, 1):
            for block in page.get_text("dict")["blocks"]:
                for line in block.get("lines", []):
                    for span in line["spans"]:
                        txt = span["text"].strip()
                        if not txt:
                            continue
                        is_hidden = span["size"] < 3 or span["color"] in (0xFFFFFF, 0xFEFEFE)
                        (hidden if is_hidden else visible).append((pno, txt))
    return visible, hidden


def scan_content(source, text=None, path=None):
    """Split untrusted content into plain data and injected commands."""
    chunks = []
    if path and path.lower().endswith(".pdf"):
        visible, hidden = read_pdf(path)
        chunks += [(p, t, False) for p, t in visible]
        chunks += [(p, " ".join(t for _, t in hidden), True) for p in sorted({p for p, _ in hidden})]
    else:
        chunks.append((1, text or "", False))
    data, injected = [], []
    for page, chunk, hidden in chunks:
        for s in sentences(chunk):
            score = instruction_score(s, hidden)
            if score >= INJECTED_AT:
                injected.append({"source": source, "page": page, "hidden": hidden, "text": s, "score": score})
            else:
                data.append(s)
    return " ".join(data), injected


def _found(value, text):
    value, text = str(value).lower(), text.lower()
    if value in text:
        return True
    return "/" in value and os.path.dirname(value) in text


def trace_value(value, task, rolecard, data_texts, injected):
    """Labels of every source a value can be traced to."""
    where = []
    if _found(value, task):
        where.append("task")
    if _found(value, rolecard):
        where.append("role card")
    if any(_found(value, t) for t in data_texts):
        where.append("data")
    hits = [i for i in injected if _found(value, i["text"])]
    if hits:
        where.append("injected")
    return where, hits


def similarity(action_text, task, injected_texts):
    """TF-IDF cosine of the action against the task and against each injected command."""
    if not injected_texts:
        return 0.0, 0.0
    vec = TfidfVectorizer(token_pattern=r"[A-Za-z0-9@._/-]{2,}").fit([action_text, task, *injected_texts])
    m = vec.transform([action_text, task, *injected_texts])
    sims = cosine_similarity(m[0], m[1:])[0]
    return float(sims[0]), float(max(sims[1:]))
