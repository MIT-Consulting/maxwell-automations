# Forking and upgrades

Max is a reference implementation. **Clones and forks are welcome.
Contributions (pull requests) are closed.**

Public repos (lockstep tags):

- [`maxwell-automations`](https://github.com/MIT-Consulting/maxwell-automations)
- [`maxwell-automations-skills`](https://github.com/MIT-Consulting/maxwell-automations-skills)

## Pin to a tag

Do not track `main`. Pin your fork to a release tag. Latest tag is
`v1.1.2` (2026-10-05). Upgrade deliberately with the changelog in hand.

```bash
git clone https://github.com/MIT-Consulting/maxwell-automations.git
cd maxwell-automations
git checkout v1.1.2
```

Skills bundle: same tag on `maxwell-automations-skills`. Breaking skill changes
ride a major version with the daemon.

`max update check` and Settings → About compare the running build with the
approved release (`settings.update.repo`, default this public repo). They
report the gap.

`max update --apply` performs the fetch and pin move when HEAD is exactly the
current release tag, the worktree is clean, and no run is active. It runs
`npm ci`, `npm run build`, and checks `/health`. If the new version does not
come up, it resets to `refs/max/update-backup` and rebuilds. It does not run
on a factory checkout, and the dashboard has no apply button. Read the
changelog before you pass `--apply`.

Both `--apply` and `--dry-run` fetch the exact target tag into
`refs/max/update-target` first (network and auth may be required), read that
tag's `package.json` and `CHANGELOG.md`, print the target Node requirement and
a fixed **Upgrade actions** block, then decide whether mutation may proceed.
`--dry-run` never stops the daemon, moves HEAD, runs `npm ci`, or builds; it
only updates the private fetch ref and prints the plan. Apply does not install
Node — install a supported version locally when the target floor is unmet.

Apply runs the **installed** CLI's code, so a bug in the old version's apply
path cannot be fixed by the release it is installing. Known case: on Windows,
1.0.7 and earlier fail `--apply` with `spawnSync npm.cmd EINVAL` (rollback
leaves the checkout on the old tag with its build intact, daemon stopped).
Move that pin once by hand — `git checkout v1.1.2`, `npm ci`, `npm run build`,
`max skills install`, `max up` — and `--apply` works from then on.

Root `.npmrc` ships with **`engine-strict=true`** on public exports, so `npm ci`
refuses unsupported Node before dependencies install. Each release changelog
section includes **`### Upgrade actions`** (`none` or bullet steps) — read that
block between your pin and the target tag.

## Upgrade

1. Read `CHANGELOG.md` between your pin and the target tag (especially
   **Upgrade actions** and any `engines.node` change).
2. Fetch tags on the public remotes (or re-export is not your problem — you fork
   public, you do not merge from the private factory).
3. Merge or rebase the new tag into your fork.
4. Prefer **extension seams** over core edits: YAML settings, role-model
   profiles, your own skills, extra packages. Every core edit is future merge
   pain.

Divergence is expected. There is no obligation to stay mergeable forever.
Tags keep upgrades *possible*.

## Skills

Bundled skills: `implement-fully`, `plan-implement-fully`, and `max-setup`
(setup/register/adopt router). After `max update --apply`, rerun
`max skills install` when Upgrade actions say so — bare `max doctor` reports
drift via `max skills install --check`.

- Cursor: import `maxwell-automations-skills` as a plugin (GitHub-backed).
- CLI: `max skills install` from a Max checkout.
- Custom skills: fork `maxwell-automations-skills` and pin the same tag.
