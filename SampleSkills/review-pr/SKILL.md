---
name: review-pr
description: >-
  Review a GitHub pull request thoroughly and post the review on GitHub. Use
  this whenever you are asked to review, code-review, or re-review a PR — the
  agent finds correctness bugs, edge cases, and regressions, posts inline
  comments, and submits an approve / request-changes / comment verdict via the
  gh CLI. Read-only for the code under review (no edits, no merges).
metadata:
  short-description: Review a GitHub pull request
---

# review-pr

> **This is a SAMPLE skill shipped with PopBot.** Every shop reviews differently —
> copy it into `~/.claude/skills/review-pr/` (Claude) and/or `~/.codex/skills/review-pr/`
> (Codex), then tailor the standards, required checks, and house style to your team.
> The same `SKILL.md` works unchanged for both Claude and Codex.

Your job is to review a pull request and leave a real, actionable review on GitHub.
This is a **read-only** review: inspect the change, flag issues, post the review —
do **not** modify code, rebase, or merge.

## Mindset

**Presume there ARE issues — your job is to find them.** A "looks good" pass is
rarely correct on the first read. Be skeptical. Trust nothing about the change
until you've verified it against the surrounding code.

## Procedure

1. **Pull the PR and its diff.**
   ```bash
   gh pr view <PR> --json title,body,author,additions,deletions,changedFiles,baseRefName,headRefName,headRefOid
   gh pr diff <PR>
   ```
2. **For every meaningful diff hunk, read the surrounding code — not just the diff.**
   The diff alone hides callers, helpers, conventions, and invariants the change
   must respect. Open the changed files and read the functions around each hunk.
3. **Trace the systems involved:** what calls into this code, what it calls into,
   what state it touches, what it assumes about that state.
4. **Check consistency** with existing patterns (naming, error handling, data flow,
   threading model, persistence layer). Inconsistent code is usually buggy code.
5. **Hunt specifically for:** correctness bugs, missed edge cases, race conditions,
   security/permission gaps, perf hotspots, missing or weak tests, breaking changes
   for callers, resource leaks, and regressions in adjacent features.

## Posting the review

- **Inline comments on specific lines**, as you go:
  ```bash
  gh api repos/{owner}/{repo}/pulls/<PR>/comments \
    -f body="…" -f commit_id="<headRefOid>" -f path="<file>" -F line=<N> -f side="RIGHT"
  ```
- **Submit the review when done:**
  - Blocking issues → `gh pr review <PR> --request-changes --body "…"`
  - Non-blocking thoughts → `gh pr review <PR> --comment --body "…"`
  - Genuinely confident → `gh pr review <PR> --approve --body "…"`

## Re-review (author pushed fixes)

Scope to the **new commits since your last review** — don't re-review the whole PR.
Pull the commit list (`gh api repos/{owner}/{repo}/pulls/<PR>/commits`) and your prior
comments (`gh api repos/{owner}/{repo}/pulls/<PR>/comments`); verify each was actually
addressed in the new commits, not just acknowledged. Resolve threads that are truly
fixed; reply to ones that aren't.

## Report back

Finish with a one-line verdict (approve / request-changes / concerns) plus the top
1–3 red flags — anything risky, surprising, or suggesting the author misunderstood
the system — even if you also wrote them on GitHub. If there genuinely aren't any,
say "none".

## Scope guardrails

- The repo is read-only for this review: no `git checkout`, no edits, no commits, no merges.
- If something is genuinely ambiguous, ask instead of guessing.
