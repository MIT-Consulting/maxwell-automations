# Changelog

All notable public releases of Max are recorded here. The public git history
is snapshot-based (one commit per export), so this file is the human changelog.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and version numbers follow [SemVer](https://semver.org/).

## [Unreleased]

### Fixed

- Public Gitleaks workflow now actually loads `gitleaks.toml` (the action only
  auto-discovers the dotted filename, so the custom personal-info rules were
  silently unused) and supports manual full-history runs via `workflow_dispatch`.

## [1.0.3] - 2026-09-11

### Fixed

- Replace a real Tailscale address that leaked into a test fixture with a
  documentation-range placeholder; add a gitleaks rule for the 100.64.0.0/10
  range so the export scan catches this class going forward.

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
