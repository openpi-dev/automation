# openpi-dev automation

Reusable GitHub Actions workflows and actions for repositories in the
`openpi-dev` organization.

This repository is an isolated definition store. It does not run workflows for
its own pushes or pull requests; consumers explicitly invoke its reusable
workflows.

Callers should pin reusable workflows to a full commit SHA. Repository event
triggers, secrets, environments, and least-privilege `GITHUB_TOKEN` permissions
remain in each caller repository.

## Reusable workflows

- `openpi-release.yml` — validates an existing OpenPI version tag, builds the
  package artifact, and publishes it through npm trusted publishing.
- `openpi-feishu-pr-notification.yml` — sends a bounded, sanitized interactive
  PR card with structured metadata and a validated GitHub link for trusted
  `pull_request_target` events.

## Validation

```sh
npm test
```

The suite exercises Feishu metadata sanitization, injection resistance, Unicode
bounds, secret-pair handling, HMAC payloads, and response failures. It also
executes release event/tag/package-version validation and locks the reusable
workflow boundaries for draft suppression, OIDC, ancestry, and single-artifact
publication.
