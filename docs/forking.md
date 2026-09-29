# Forking and upgrades

Max is a reference implementation. **Clones and forks are welcome.
Contributions (pull requests) are closed.**

Public repos (lockstep tags):

- [`maxwell-automations`](https://github.com/MIT-Consulting/maxwell-automations)
- [`maxwell-automations-skills`](https://github.com/MIT-Consulting/maxwell-automations-skills)

## Pin to a tag

Do not track `main`. Pin your fork to a release tag. Latest tag is
`v1.0.7` (2026-09-29). Upgrade deliberately with the changelog in hand.

```bash
git clone https://github.com/MIT-Consulting/maxwell-automations.git
cd maxwell-automations
git checkout v1.0.7
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
changelog before you pass `--apply`. `--dry-run` prints the plan and stops.

## Upgrade

1. Read `CHANGELOG.md` between your pin and the target tag.
2. Fetch tags on the public remotes (or re-export is not your problem — you fork
   public, you do not merge from the private factory).
3. Merge or rebase the new tag into your fork.
4. Prefer **extension seams** over core edits: YAML settings, role-model
   profiles, your own skills, extra packages. Every core edit is future merge
   pain.

Divergence is expected. There is no obligation to stay mergeable forever.
Tags keep upgrades *possible*.

## Skills

- Cursor: import `maxwell-automations-skills` as a plugin (GitHub-backed).
- CLI: `max skills install` from a Max checkout.
- Custom skills: fork `maxwell-automations-skills` and pin the same tag.
