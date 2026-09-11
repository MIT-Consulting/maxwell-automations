# Changelog

All notable public releases of Max are recorded here. The public git history
is snapshot-based (one commit per export), so this file is the human changelog.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and version numbers follow [SemVer](https://semver.org/).

## [Unreleased]

## [1.0.2] - 2026-09-10

### Fixed

- Bump `actions/checkout` and `actions/setup-node` to v5 (silence Node 20
  action-runtime deprecation annotations).

## [1.0.1] - 2026-09-10

### Fixed

- Public CI: Node 22 (undici 8 on Node 20 crashed three test suites), stale
  model-label and Files-nav seam tests, export of `.cursor/rules/`.

## [1.0.0] - 2026-09-10

First public snapshot of Max (Maxwell) as a local agent factory.

### Added

- Daemon, dashboard, and `max` CLI (`lca` alias) for local Cursor-agent automations.
- Implement-fully pipeline, serial feature queue, workspace chats, and Files view.
- Apache-2.0 license and personal-time provenance NOTICE.
- `max skills install` and `max roadmap init`.
- Public skill bundle companion repo `maxwell-automations-skills` (lockstep tags).
