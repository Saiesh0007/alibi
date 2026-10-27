"""Runs every scenario through three checkers and prints what each one caught.

  IAM only        : token valid and scope granted -> always allowed (what most setups do today)
  Role-card rules : only the static checks from the role card
  ALIBI           : role card + alibi tracing + baits + chain + session checks
Usage: python evaluate.py
"""
import json
import os
import random

from alibi import ALLOW, Alibi
from scenarios import ATTACKS, BAITS, BENIGN

HERE = os.path.dirname(os.path.abspath(__file__))
CARDS = os.path.join(HERE, "rolecards")
CHANGES = os.path.join(CARDS, "changes")   # signed role-card updates (procurement v2 adds shipment tracking)


def run(steps):
    eng = Alibi(CARDS, CHANGES, baits=BAITS)
    flagged_bad = flagged_good = rules_bad = rules_good = False
    for step in steps:
        if step[0] == "session":
            eng.start_session(*step[1:])
            continue
        ev = step[1]
        v = eng.observe(ev)
        rule_hit = bool(eng._role_checks(eng.cards[ev["agent"]], ev))
        if ev.get("bad"):
            flagged_bad |= v.action != ALLOW
            rules_bad |= rule_hit
        else:
            flagged_good |= v.action != ALLOW
            rules_good |= rule_hit
    return flagged_bad, flagged_good, rules_bad, rules_good


def main(seed=2026):
    rng = random.Random(seed)
    rows, totals = [], {"benign": 0, "fp_alibi": 0, "fp_rules": 0, "attacks": 0, "alibi": 0, "rules": 0}
    for name, fn, n in BENIGN:
        fp_a = fp_r = 0
        for i in range(n):
            _, good, _, rgood = run(fn(rng, i))
            fp_a += good
            fp_r += rgood
        rows.append({"kind": "benign", "name": name, "n": n, "alibi": fp_a, "rules": fp_r})
        totals["benign"] += n
        totals["fp_alibi"] += fp_a
        totals["fp_rules"] += fp_r
    for name, fn, n in ATTACKS:
        hit_a = hit_r = 0
        for i in range(n):
            bad, _, rbad, _ = run(fn(rng, i))
            hit_a += bad
            hit_r += rbad
        rows.append({"kind": "attack", "name": name, "n": n, "alibi": hit_a, "rules": hit_r})
        totals["attacks"] += n
        totals["alibi"] += hit_a
        totals["rules"] += hit_r

    print(f"{'scenario':42} {'runs':>5} {'IAM':>5} {'rules':>6} {'ALIBI':>6}")
    for kind, label in (("benign", "false alarms on normal work"), ("attack", "attacks caught")):
        print(f"-- {label}")
        for r in (r for r in rows if r["kind"] == kind):
            print(f"{r['name']:42} {r['n']:>5} {0:>5} {r['rules']:>6} {r['alibi']:>6}")
    print(f"\nattacks caught: IAM 0/{totals['attacks']}, rules {totals['rules']}/{totals['attacks']}, "
          f"ALIBI {totals['alibi']}/{totals['attacks']}")
    print(f"false alarms:   rules {totals['fp_rules']}/{totals['benign']}, ALIBI {totals['fp_alibi']}/{totals['benign']}")
    os.makedirs(os.path.join(HERE, "out"), exist_ok=True)
    with open(os.path.join(HERE, "out", "results.json"), "w") as f:
        json.dump({"rows": rows, "totals": totals, "seed": seed}, f, indent=2)


if __name__ == "__main__":
    main()
