"""Slow drift: compare each day's mix of actions with the agent's first weeks (frozen, not rolling).

A rolling baseline slowly learns whatever the attacker teaches it. A frozen baseline that only
changes through a signed role-card update does not.
"""
import math
from collections import Counter


def mix(actions):
    c = Counter(actions)
    n = sum(c.values()) or 1
    return {k: v / n for k, v in c.items()}


def js_divergence(p, q):
    keys = set(p) | set(q)
    m = {k: (p.get(k, 0) + q.get(k, 0)) / 2 for k in keys}

    def kl(a):
        return sum(a[k] * math.log2(a[k] / m[k]) for k in keys if a.get(k, 0) > 0)

    return (kl(p) + kl(q)) / 2


def cusum(values, target, slack, limit):
    """Index where the cumulative excess over target+slack first crosses limit, else None."""
    total = 0.0
    for i, v in enumerate(values):
        total = max(0.0, total + v - target - slack)
        if total > limit:
            return i
    return None
