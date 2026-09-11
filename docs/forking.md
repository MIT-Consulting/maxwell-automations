# Forking and upgrades

Max is a reference implementation. **Clones and forks are welcome.
Contributions (pull requests) are closed.**

Public repos (lockstep tags):

- [`maxwell-automations`](https://github.com/MIT-Consulting/maxwell-automations)
- [`maxwell-automations-skills`](https://github.com/MIT-Consulting/maxwell-automations-skills)

## Pin to a tag

Do not track `main`. Pin your fork to a release tag (`v1.0.0`, …) and upgrade
deliberately with the changelog in hand.

```bash
git clone https://github.com/MIT-Consulting/maxwell-automations.git
cd maxwell-automations
git checkout v1.0.0
```

Skills bundle: same tag on `maxwell-automations-skills`. Breaking skill changes
ride a major version with the daemon.

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
