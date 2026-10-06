# Forking and upgrades

Max is a reference implementation. **Clones and forks are welcome.
Contributions (pull requests) are closed.**

Public repos (lockstep tags):

- [`maxwell-automations`](https://github.com/MIT-Consulting/maxwell-automations)
- [`maxwell-automations-skills`](https://github.com/MIT-Consulting/maxwell-automations-skills)

## Pin to a tag

Do not track `main`. Pin your fork to a release tag. Latest tag is
`v1.1.4` (2026-10-05). Upgrade deliberately with the changelog in hand.

```bash
git clone https://github.com/MIT-Consulting/maxwell-automations.git
cd maxwell-automations
git checkout v1.1.4
```

Skills bundle: same tag on `maxwell-automations-skills`. Breaking skill changes
ride a major version with the daemon.

`max update check` and Settings → About compare the running build with the
approved release (`settings.update.repo`, default this public repo). They
report the gap.

`max update --apply` performs the fetch and pin move when HEAD is the published
release tag (a local tag, or that tag on the remote when the local one was
never written), the worktree is clean, and no run is active. It runs `npm ci`
and `npm run build`, then requires the daemon, CLI, and dashboard stamps to
match the new version and to have been built against the same shared dist. It
installs bundled skills, checks `/health`, and records the local release tag.
If any of that fails, it resets to `refs/max/update-backup`, rebuilds, and
restores skills. It does not run on a factory checkout, and the dashboard has
no apply button. Read the changelog before you pass `--apply`.

`max update --from <file>` installs a test bundle on a public clone sitting on
the release that bundle was cut from. The first departure saves that commit at
`refs/max/stable`; the tip is recorded at `refs/max/test-build`.
`max update --stable` returns to the saved release through the same rebuild.
`max update check` continues to report approved tags only. About names the
test build and the return command, and it still has no apply button.

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
Move that pin once by hand — `git checkout v1.1.4`, `npm ci`, `npm run build`,
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
(setup/register/adopt router). `max update --apply` installs them for the
version it lands on. Bare `max doctor` still reports drift, and
`max skills install` repairs it.

- Cursor: import `maxwell-automations-skills` as a plugin (GitHub-backed).
- CLI: `max skills install` from a Max checkout.
- Custom skills: fork `maxwell-automations-skills` and pin the same tag.
