# openpi-dev automation

Reusable GitHub Actions workflows and actions for repositories in the
`openpi-dev` organization.

Callers should pin reusable workflows to a full commit SHA. Repository event
triggers, secrets, environments, and least-privilege `GITHUB_TOKEN` permissions
remain in each caller repository.

## Reusable workflows

- `openpi-ci.yml` — OpenPI checks, tests, packaging smoke tests, and Windows
  background-terminal coverage.
- `openpi-release.yml` — validates an existing OpenPI version tag, builds the
  package artifact, and publishes it through npm trusted publishing.
- `openpi-feishu-pr-notification.yml` — sends a bounded, sanitized notification
  for trusted `pull_request_target` events.

## Validation

```sh
npm test
```
