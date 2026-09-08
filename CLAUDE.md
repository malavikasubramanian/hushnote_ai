# CLAUDE.md

Guidance for Claude Code when working in this repository.

## Git commits

Never add "Co-Authored-By: Claude" or "🤖 Generated with Claude Code" (or any similar AI attribution) to commit messages. Commit messages should read as if authored solely by the repo owner.

The commit author stays `Likhitha-Guntaka <guntakalikhitha@gmail.com>`.

When a change has not been run — most often because Node is not installed on the
machine it was written on — say so plainly in the commit message, and name which
paths went untested. Do not let unexecuted work read as verified.

## Branching and pull requests

Two remotes:

- `origin` — https://github.com/Likhithaa-Guntaka/hushnote_ai (the fork)
- `upstream` — https://github.com/malavikasubramanian/hushnote_ai (the team repo)

**One branch and one pull request per fix. Do not commit to `main`.** Upstream
receives changes only through reviewed pull requests — never a direct push — so
a teammate sees the work before it reaches the team's `main`. That review step
matters more than usual here, because changes are sometimes written on a machine
without Node and land unexecuted.

The cycle for each fix:

1. Cut a branch off `origin/main` before starting:
   `git fetch origin && git switch -c fix/<short-description> origin/main`
2. Do the work and commit on that branch.
3. `git push -u origin fix/<short-description>`
4. Hand over a PR title and description to open from that branch into
   `upstream/main`. There is no `gh` CLI or token on this machine, so the text
   gets pasted by hand — write it ready to use.
5. Once that PR is merged, bring `main` back up to date, then cut the next
   branch from it:
   `git switch main && git fetch upstream && git merge --ff-only upstream/main && git push origin main`

Use `fix/` for behaviour changes, `docs/` for documentation-only ones.

After each push, report where the branch points and how far `upstream/main` is
behind, so it is clear what is still awaiting review.

Three hard rules:

- **Never force-push to `upstream`.** If a push there is ever rejected as
  non-fast-forward, upstream has commits this checkout lacks. Stop and report it.
  A force-push destroys a teammate's work.
- **Fetch both remotes before assuming anything about sync state.** Upstream
  moves independently, and a merged pull request lands there as a merge commit
  this checkout will not have until it fetches. Git reporting the branches as
  "diverged" often just means the PR was merged and local is behind — inspect
  before acting on it.
- **Leave open pull requests alone.** Do not add commits to a branch that
  already has a PR under review unless asked to.

One caveat worth knowing while a PR is outstanding: a branch cut from
`origin/main` carries every commit `upstream/main` has not merged yet, so its PR
shows those too. Keep the queue short by getting the open PR merged before
starting the next fix. For a change that does not depend on the pending work,
cutting the branch from `upstream/main` instead yields a single-commit PR.
