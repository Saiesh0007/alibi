# ALIBI prototype

Every action an AI agent takes has to trace back to a job a human gave it.

**Live page:** https://saiesh0007.github.io/alibi/ (rebuilt by GitHub Actions on every push to `main`,
from a fresh run of the three scripts below)

ALIBI sits in front of an agent's tools and scores each tool call (0 to 100) with three checks:

1. **Role card** (`rolecards/*.yaml`): what the agent is for, which tools, data folders and destinations it may use.
2. **Alibi trace** (`alibi/provenance.py`): where did the key values in this action come from? The human's task,
   the role card and ordinary data are fine. A path, URL or supplier name that only appears in a command hidden
   inside a PDF, email or another agent's request has no alibi.
3. **Baits**: fake files and keys no real job needs. Touching one quarantines the agent.

On an alert it removes only the misused scopes from the agent's token (`alibi/respond.py`).

## Run

```
pip install -r requirements.txt
python demo.py        # the attack from the problem statement, end to end
python evaluate.py    # 102 test sessions: IAM vs role-card rules vs ALIBI
python drift_sim.py   # slow drift: frozen vs rolling baseline
```

## Current results (`python evaluate.py`)

| | IAM only | Role-card rules | ALIBI |
|---|---|---|---|
| Attacks caught (43) | 0 | 16 | 39 |
| False alarms on normal work (59) | 0 | 0 | 0 |

The scenarios are our own, built with real PDF files (`data/`). The 4 misses are attackers who spell values out
("Z-e-n-i-t-h Traders"), which exact-match tracing cannot see yet.

## Layout

```
alibi/engine.py      scoring, sessions, delegation chains, baits
alibi/provenance.py  hidden-text PDF reader, command detector, value tracing, TF-IDF fallback
alibi/rolecard.py    role cards; versions above 1 need a signed change record
alibi/respond.py     verdict -> smaller token
alibi/drift.py       daily action mix, Jensen-Shannon distance, CUSUM
rolecards/changes/   signed role-card updates
site/build.py        builds the GitHub Pages site from out/
scenarios.py         normal work and attacks
```
