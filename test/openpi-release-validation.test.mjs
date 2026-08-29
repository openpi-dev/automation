import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import test from "node:test";

const require = createRequire(import.meta.url);
const validation = require("../actions/openpi-release-validation/index.cjs");
const actionPath = join(
  process.cwd(),
  "actions/openpi-release-validation/index.cjs",
);

function withWorkspace(packageJson, run) {
  const workspace = mkdtempSync(join(tmpdir(), "openpi-release-"));
  try {
    writeFileSync(join(workspace, "package.json"), JSON.stringify(packageJson));
    return run(workspace);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

test("release source accepts only a matching tag push or main dispatch", () => {
  assert.equal(
    validation.resolveReleaseSource({
      eventName: "push",
      ref: "refs/tags/v0.5.0",
      releaseTag: "v0.5.0",
    }),
    "v0.5.0",
  );
  assert.equal(
    validation.resolveReleaseSource({
      eventName: "workflow_dispatch",
      ref: "refs/heads/main",
      releaseTag: "v0.5.0",
    }),
    "v0.5.0",
  );
});

test("release source rejects wrong refs, events, and malformed tags", () => {
  assert.throws(
    () =>
      validation.resolveReleaseSource({
        eventName: "push",
        ref: "refs/tags/v0.5.1",
        releaseTag: "v0.5.0",
      }),
    /must match the selected version tag/u,
  );
  assert.throws(
    () =>
      validation.resolveReleaseSource({
        eventName: "workflow_dispatch",
        ref: "refs/heads/release",
        releaseTag: "v0.5.0",
      }),
    /dispatched from main/u,
  );
  assert.throws(
    () =>
      validation.resolveReleaseSource({
        eventName: "pull_request",
        ref: "refs/heads/main",
        releaseTag: "v0.5.0",
      }),
    /Unsupported release event/u,
  );
  for (const tag of ["0.5.0", "v0.5", "v..", "v0/5/0", ""]) {
    assert.throws(() => validation.validateReleaseTag(tag));
  }
});

test("the release tag must match the checked-out package version", () => {
  withWorkspace({ version: "0.5.0" }, (workspace) => {
    assert.equal(
      validation.verifyPackageVersion({ releaseTag: "v0.5.0", workspace }),
      "v0.5.0",
    );
    assert.throws(
      () =>
        validation.verifyPackageVersion({
          releaseTag: "v0.5.1",
          workspace,
        }),
      /does not match package version/u,
    );
  });
});

test("the action entry point writes the resolved tag and fails closed", () => {
  const outputDirectory = mkdtempSync(join(tmpdir(), "openpi-output-"));
  const outputPath = join(outputDirectory, "output");
  try {
    const success = spawnSync(process.execPath, [actionPath], {
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_OUTPUT: outputPath,
        INPUT_MODE: "resolve",
        INPUT_RELEASE_TAG: "v0.5.0",
        INPUT_EVENT_NAME: "workflow_dispatch",
        INPUT_REF: "refs/heads/main",
      },
    });
    assert.equal(success.status, 0, success.stderr);
    assert.equal(readFileSync(outputPath, "utf8"), "tag=v0.5.0\n");

    const failure = spawnSync(process.execPath, [actionPath], {
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_OUTPUT: outputPath,
        INPUT_MODE: "resolve",
        INPUT_RELEASE_TAG: "v0.5.0",
        INPUT_EVENT_NAME: "workflow_dispatch",
        INPUT_REF: "refs/heads/not-main",
      },
    });
    assert.notEqual(failure.status, 0);
    assert.match(failure.stderr, /dispatched from main/u);
  } finally {
    rmSync(outputDirectory, { recursive: true, force: true });
  }
});
