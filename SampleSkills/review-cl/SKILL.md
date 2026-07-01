---
name: review-cl
description: >-
  Review a Perforce changelist via Helix Swarm (aka P4 Code Review). Use this
  whenever you are asked to create, review, or re-review a Swarm review for a
  pending/shelved changelist, or to check a review's open comments before
  submitting. Creates/updates the review through the p4d Swarm extension
  (#review in the changelist description + p4 shelve) and reads/manages it
  through the Swarm REST API. The Perforce analog of the review-pr skill.
metadata:
  short-description: Review a Perforce changelist via Helix Swarm
---

# review-cl

> **This is a SAMPLE skill shipped with PopBot.** Swarm setups differ per shop
> (server URL, review vs. commit mode, required votes, triggers). Copy it into
> `~/.claude/skills/review-cl/` (Claude) and/or `~/.codex/skills/review-cl/`
> (Codex), then fill in your Swarm URL and house rules. The same `SKILL.md`
> works unchanged for both Claude and Codex.
>
> **Set your Swarm base URL here:** `SWARM_URL` = `http://YOUR-SWARM-HOST`
> (the server's `P4.Swarm.URL` property — see `p4 property -l -n P4.Swarm.URL`).

Helix Swarm is Perforce's code-review system (the changelist analog of a GitHub
PR). There is **no general `swarm` CLI binary** — you drive it two ways:

- **Write path — plain `p4`:** create/update a review via the p4d Swarm extension.
- **Read/manage path — Swarm REST API** over HTTP.

## Authentication (REST API)

HTTP Basic auth using your **Perforce user + a p4 login *ticket*** (the raw
password is rejected). Get a ticket from the login you already have:

```bash
TICKET=$(p4 login -p | tail -1)          # 32-char ticket; reuses existing auth
AUTH="-u $P4USER:$TICKET"
```

Discover the API version first: `curl -s $SWARM_URL/api/version` (returns e.g.
`{"apiVersions":[9,10,11], ...}`). Use the highest supported `vN` below.

## Create or update a review (write path)

1. Review the pending change first: `p4 opened -c <cl>`, `p4 diff`.
2. Give the changelist a clear description of what changed and why.
3. Shelve so Swarm can see the files: `p4 shelve -c <cl>` (`-f` to re-shelve when updating).
4. Attach it to a review via the changelist **description**:
   - **New review:** add a line `#review` to the description, then shelve. The p4d
     extension opens a new review and reports its id.
   - **Update an existing review:** use `#review-<id>` in the description and re-shelve.
5. **Do NOT `p4 submit`** — the change goes through review first.

## Read and manage a review (REST API)

```bash
# List recent reviews (optionally filter by author/state):
curl -s $AUTH "$SWARM_URL/api/v11/reviews?max=20"
# A single review — state, votes, participants, associated changelists:
curl -s $AUTH "$SWARM_URL/api/v11/reviews/<id>"
# Open comments / issues on the review (this is what you must address before submit):
curl -s $AUTH "$SWARM_URL/api/v11/comments?topic=reviews/<id>"
# Reply to / add a comment:
curl -s $AUTH -X POST "$SWARM_URL/api/v11/comments" \
  -F topic="reviews/<id>" -F body="…"
# Vote (approve / needs review) and change state via PATCH .../reviews/<id>.
```

## Reviewing the code itself

Apply the same rigor as reviewing a PR: **presume there are issues.** For each
diff hunk, open the file and read the surrounding code — not just the diff — trace
callers and touched state, check consistency with existing patterns, and hunt for
correctness bugs, edge cases, races, security/permission gaps, perf, weak tests,
and regressions. Post findings as review comments (see above).

## Pre-submit check (before `p4 submit`)

1. Final read of the pending change (`p4 opened -c <cl>`, `p4 diff`) — watch for
   debug/print leftovers, secrets, commented-out code, anything that shouldn't ship.
2. Pull the review's open comments (`.../comments?topic=reviews/<id>`) and make sure
   **every** open comment/issue is resolved. Do **not** submit over unresolved feedback.
3. Write a proper changelist description (a real submit message, not a placeholder).
4. Submit: `p4 submit -c <cl>`.

## Report back

One-line verdict + the review URL (`$SWARM_URL/reviews/<id>`) and the top 1–3 red
flags (or "none").

## Scope guardrails

- Creating/reading a review is non-destructive; **submitting is not** — if anything
  looks risky or ambiguous, stop and ask instead of submitting.
