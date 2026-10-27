"""Role cards: a short YAML file that says what an agent is for.

This is the agent's baseline from day 0, so we don't need any history to start judging it.
"""
import fnmatch
import glob
import os

import yaml


class RoleCard:
    def __init__(self, raw, path):
        self.raw, self.path = raw, path
        self.agent = raw["agent"]
        self.version = raw.get("version", 1)
        self.purpose = raw.get("purpose", "")
        self.tools = set(raw.get("tools", []))
        self.data_allow = raw.get("data", {}).get("allow", [])
        self.egress_allow = raw.get("egress", {}).get("allow", [])
        self.limits = raw.get("limits", {})
        self.change = raw.get("change")

    @property
    def text(self):
        return yaml.safe_dump(self.raw)

    def allows_path(self, path):
        return any(fnmatch.fnmatch(path, pat) for pat in self.data_allow)

    def allows_host(self, host):
        return any(fnmatch.fnmatch(host, pat) for pat in self.egress_allow)


def load_rolecards(*folders):
    """Latest *signed* version per agent. A version > 1 without an approved change record is skipped."""
    cards = {}
    paths = sorted(p for folder in folders for p in glob.glob(os.path.join(folder, "*.yaml")))
    for path in paths:
        with open(path, encoding="utf-8") as f:
            card = RoleCard(yaml.safe_load(f), path)
        if card.version > 1 and not (card.change and card.change.get("approved_by")):
            continue
        if card.agent not in cards or card.version > cards[card.agent].version:
            cards[card.agent] = card
    return cards
