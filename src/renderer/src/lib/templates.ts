/**
 * Tiny shell-style template expander for prompt templates.
 * Supports `${name}` lookups against a flat key/value map; missing
 * keys render as empty string (not "undefined").
 *
 * Used by handleSpawnFromTicket to build the first user message
 * from the user-editable "start ticket" template in Preferences.
 */
export function expandTemplate(tmpl: string, vars: Record<string, unknown>): string {
  return tmpl.replace(/\$\{\s*(\w+)\s*\}/g, (_full, name: string) => {
    const v = vars[name];
    if (v == null) return '';
    return String(v);
  });
}

/** Macros available in the start-ticket template, with one-line docs.
 *  Rendered above the textarea in Preferences so users know what to type. */
export const TICKET_TEMPLATE_VARS = [
  { name: 'ticketid',    desc: 'e.g. ENG-204' },
  { name: 'tickettitle', desc: 'Linear issue title' },
  { name: 'description', desc: 'Markdown description from Linear' },
  { name: 'markdown',    desc: 'Alias for description (Linear stores it as markdown)' },
  { name: 'ticketurl',   desc: 'Direct link to the issue' },
  { name: 'priority',    desc: 'urgent / high / med / low' },
  { name: 'project',     desc: 'Linear project name' },
  { name: 'branch',      desc: 'Branch checked out in this slot' },
  { name: 'slot',        desc: 'Workspace slot number' },
] as const;

/** Macros for the start-code-review template. */
export const CODE_REVIEW_TEMPLATE_VARS = [
  { name: 'prnum',   desc: 'PR number' },
  { name: 'prtitle', desc: 'PR title' },
  { name: 'branch',  desc: 'Branch checked out in this slot' },
  { name: 'slot',    desc: 'Workspace slot number' },
] as const;

export const DEFAULT_START_TICKET_TEMPLATE = `Please review and, if possible, directly fix the issue described in Linear ticket **\${ticketid}: \${tickettitle}**.

## Ticket
\${markdown}

## Workspace
- Branch: \`\${branch}\`
- Slot: \${slot}
- Linear: \${ticketurl}

## How to proceed
1. Read whatever files you need to understand the scope.
2. If you can fix the issue, go ahead — make the changes, run the relevant tests, and commit.
3. If you can't (ambiguous spec, missing context, risky tradeoff), ask your questions here. The engineer will be notified and respond.
4. When the fix is complete, notify the engineer that it's ready to test and describe the full fix — what changed, why, and how to verify.`;

export const DEFAULT_START_CODE_REVIEW_TEMPLATE = `Please review pull request **#\${prnum}: \${prtitle}** (branch \`\${branch}\`).

**Make sure you use the \`review-pr\` skill when reviewing this code.** Out-of-spec reviews happen when the skill isn't picked up — engage it explicitly before doing anything else.

This is a read-only review chat — inspect the change, flag issues, post the review on GitHub, and tell me about anything red-flag in this chat. Do NOT modify code, rebase, or merge.

## How to review
**Presume there ARE issues — your job is to find them.** A "looks good" pass is rarely correct on the first read. Be skeptical. Trust nothing about the change until you've verified it against the surrounding code.

For every meaningful diff hunk:
1. Open the files being modified and **read the surrounding code**, not just the diff. The diff alone hides callers, helpers, conventions, and invariants the change has to respect.
2. Trace the systems involved — what calls into this code, what does this code call into, what state does it touch, what assumptions does it make about that state.
3. Check that the change is consistent with the existing patterns in those systems (naming, error handling, data flow, threading model, persistence layer, etc.). Inconsistent code is usually buggy code.
4. Look hard for: correctness bugs, missed edge cases, race conditions, security/permission gaps, perf hotspots, missing or weak tests, breaking changes for callers, leaks, regressions in adjacent features.

## What to do with what you find
- **Pull the PR + diff:** \`gh pr view \${prnum} --json title,body,author,additions,deletions,changedFiles,baseRefName,headRefName\` and \`gh pr diff \${prnum}\`.
- **Post inline comments on specific lines** as you go:
  \`gh api repos/{owner}/{repo}/pulls/\${prnum}/comments -f body="…" -f commit_id="…" -f path="…" -f line=N -f side="RIGHT"\`
  (Use the head commit_id from the PR view.)
- **Submit the review on GitHub when done:**
  - Requesting changes (anything blocking): \`gh pr review \${prnum} --request-changes --body "…"\`
  - Just commenting (non-blocking thoughts): \`gh pr review \${prnum} --comment --body "…"\`
  - Approving (only when you're genuinely confident): \`gh pr review \${prnum} --approve --body "…"\`

## Tell me directly
Before / alongside posting, **call out red flags in this chat** — anything I should personally look at, anything risky, anything that surprised you, anything that suggests the author misunderstood the system. I want to hear about those even if you also wrote them up on GitHub.

## Scope
- Repository is read-only for this chat — no \`git checkout\`, no edits, no commits, no merges.
- If something is genuinely ambiguous, ask me here instead of guessing.

When done, reply with a one-line verdict + the top 1-3 red flags (or "none" if there really aren't any).`;

export const DEFAULT_RE_REVIEW_TEMPLATE = `The author pushed fixes to PR **#\${prnum}: \${prtitle}** (branch \`\${branch}\`) and re-requested your review.

**Use the \`review-pr\` skill again, this time scoped to the new commits since your previous review.** Don't re-review the whole PR — focus on what changed.

## How to re-review
1. Pull the PR head + commit list:
   \`gh pr view \${prnum} --json title,body,author,headRefName,headRefOid,baseRefName,additions,deletions,changedFiles\`
   \`gh api repos/{owner}/{repo}/pulls/\${prnum}/commits\` — identify the new commits since your last review.
2. Pull your previous review comments + the resolution state of each thread:
   \`gh api repos/{owner}/{repo}/pulls/\${prnum}/comments\` — verify each was actually addressed in the new commits, not just acknowledged.
3. Read the diff of just the new commits + any files they touch with the same skepticism as the first pass.

## What to do
- Resolve threads the author actually addressed; reply to ones that aren't fully addressed yet (don't just approve over weak fixes).
- Submit the review on GitHub:
  - Approve (genuinely confident the blockers are resolved): \`gh pr review \${prnum} --approve --body "…"\`
  - Request changes (anything still blocking): \`gh pr review \${prnum} --request-changes --body "…"\`
  - Comment (non-blocking thoughts): \`gh pr review \${prnum} --comment --body "…"\`

## Tell me directly
- One-line verdict (approve / request-changes / still has concerns)
- What's actually different in this round vs the last
- Anything new that surprised you

## Scope
Read-only review chat — no \`git checkout\`, no edits, no commits.`;

/* ===== Git-action templates (used by the GitPanel action button) ===== */

export const GIT_ACTION_TEMPLATE_VARS = [
  { name: 'branch',     desc: 'Chat branch in this slot' },
  { name: 'baseBranch', desc: 'PR target / fork-point branch (develop, rc-1.x)' },
  { name: 'ticket',     desc: 'Linear ticket id (may be empty)' },
  { name: 'slot',       desc: 'Workspace slot number' },
  { name: 'prnum',      desc: 'PR number (set for ADDRESS CR / MAKE READY)' },
  { name: 'prurl',      desc: 'PR URL (set when a PR exists)' },
] as const;

export const GIT_REBASE_TEMPLATE_VARS = [
  ...GIT_ACTION_TEMPLATE_VARS,
  { name: 'oldBase', desc: 'Previous base branch this work was on' },
] as const;

export const DEFAULT_COMMIT_AI_TEMPLATE = `Please commit any uncommitted work in this slot's worktree.

Steps:
1. Review the uncommitted changes (\`git status\`, \`git diff\`).
2. Stage all the relevant changes (\`git add -A\`).
3. Commit with a clear message describing what changed and why.

Do NOT push or open a PR — those are separate steps.`;

export const DEFAULT_PUSH_PR_TEMPLATE = `Please commit any uncommitted work in this slot's worktree and open a PR.

Steps:
1. Review the uncommitted changes (\`git status\`, \`git diff\`).
2. Stage all the relevant changes (\`git add -A\`).
3. Commit with a clear message describing what changed and why.
4. Push branch \`\${branch}\` to origin.
5. Create a pull request against \`\${baseBranch}\` using \`gh pr create --base \${baseBranch} --head \${branch}\`. Title and body should describe the change. Reference Linear ticket \${ticket} when applicable.

Do NOT merge the PR — merging is always done manually via the PR web page.
When done, reply with the PR URL.`;

export const DEFAULT_PUSH_DRAFT_PR_TEMPLATE = `Please commit any uncommitted work in this slot's worktree and open a DRAFT PR for early feedback.

Steps:
1. Review the uncommitted changes (\`git status\`, \`git diff\`).
2. Stage all the relevant changes (\`git add -A\`).
3. Commit with a clear message describing what changed and why.
4. Push branch \`\${branch}\` to origin.
5. Create a draft pull request against \`\${baseBranch}\` using \`gh pr create --draft --base \${baseBranch} --head \${branch}\`. Reference Linear ticket \${ticket} when applicable.

Do NOT merge or mark ready for review — those are manual steps.
When done, reply with the draft PR URL.`;

export const DEFAULT_MAKE_PR_READY_TEMPLATE = `PR #\${prnum} is currently a draft. Please mark it ready for review.

Steps:
1. Verify the changes are complete (\`git status\`; commit + push anything outstanding first).
2. Mark the PR ready: \`gh pr ready \${prnum}\`.

Do NOT merge — merging is always done manually via the PR web page.`;

export const DEFAULT_ADDRESS_CR_TEMPLATE = `PR #\${prnum} (\${prurl}) has code review feedback. Please address it.

Steps:
1. Read the open review comments and inline comments:
   \`gh pr view \${prnum} --json reviews,comments\`
   \`gh api "repos/{owner}/{repo}/pulls/\${prnum}/comments"\`
2. Address each actionable comment with code changes.
3. Stage, commit, and push the fixes to \`\${branch}\` (force-push only if you rebased).
4. Reply to the comments you addressed (\`gh pr comment\`); resolve threads when appropriate.

Do NOT merge — merging is always done manually via the PR web page.`;

export const DEFAULT_REBASE_BASE_TEMPLATE = `The base branch for this work has changed from \`\${oldBase}\` to \`\${baseBranch}\`. Please move our changes onto the new base.

Recommended approach:
1. Inspect the current diff vs the old base: \`git log \${oldBase}..HEAD\`.
2. Decide between rebase and cherry-pick — cherry-pick onto a fresh branch is usually safer. If you cherry-pick, suggest a new branch name (e.g. \`\${branch}-on-\${baseBranch}\`) and create it.
3. Apply our commits onto \`\${baseBranch}\`.
4. Resolve conflicts as you go; stop and ask if anything ambiguous comes up.
5. Push the resulting branch.

Do NOT merge — merging is always done manually via the PR web page.
When done, confirm the final branch name.`;
