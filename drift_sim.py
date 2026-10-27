"""Slow drift: a reporting agent with a loose role card (shared/*) is pushed a little further into
finance files every day. Every single read is allowed, so only the trend can give it away.

Compares a rolling 7-day baseline with ALIBI's frozen baseline (first 14 days, changed only by a
signed role-card update). Writes out/drift.json.
"""
import json
import os
import random

from alibi.drift import cusum, js_divergence, mix

HERE = os.path.dirname(os.path.abspath(__file__))
DAYS, START, READS = 60, 20, 60
NORMAL = {"shared/sales": 0.55, "shared/marketing": 0.30, "shared/procurement": 0.15}


def day_actions(rng, day):
    w = dict(NORMAL)
    if day >= START:
        w["shared/finance"] = min(0.6, 0.012 * (day - START + 1))   # +1.2% of reads per day
    total = sum(w.values())
    return rng.choices(list(w), weights=[v / total for v in w.values()], k=READS)


def main(seed=11):
    rng = random.Random(seed)
    days = [day_actions(rng, d) for d in range(DAYS)]
    frozen = mix([a for d in days[:14] for a in d])
    js_frozen, js_rolling = [], []
    for d in range(DAYS):
        today = mix(days[d])
        js_frozen.append(js_divergence(today, frozen))
        prev = days[max(0, d - 7):d] or days[:1]
        js_rolling.append(js_divergence(today, mix([a for x in prev for a in x])))
    noise = sum(js_frozen[:14]) / 14
    hit_frozen = cusum(js_frozen, noise, 0.01, 0.15)
    hit_rolling = cusum(js_rolling, sum(js_rolling[:14]) / 14, 0.01, 0.15)
    out = {"js_frozen": js_frozen, "js_rolling": js_rolling, "start": START,
           "alert_frozen": hit_frozen, "alert_rolling": hit_rolling,
           "finance_share_at_alert": None if hit_frozen is None else round(0.012 * (hit_frozen - START + 1), 3)}
    os.makedirs(os.path.join(HERE, "out"), exist_ok=True)
    with open(os.path.join(HERE, "out", "drift.json"), "w") as f:
        json.dump(out, f, indent=1)
    print(f"attack starts day {START}; frozen baseline alerts day {hit_frozen}; rolling baseline alerts day {hit_rolling}")
    print(f"finance share of reads when ALIBI alerts: {out['finance_share_at_alert']}")


if __name__ == "__main__":
    main()
