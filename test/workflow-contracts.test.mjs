import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const FEISHU_ACTION_SHA = "a5aacc1548cd48b7939f1a391926344237f501d3";
const RELEASE_ACTION_SHA = "df7b1ee59baae8a48b6930bbb0cc21f9571a8280";

function workflow(name) {
  return readFileSync(`.github/workflows/${name}.yml`, "utf8");
}

test("Feishu suppresses drafts and passes only the optional secret pair", () => {
  const source = workflow("openpi-feishu-pr-notification");

  assert.match(
    source,
    /if: \$\{\{ github\.event_name == 'pull_request_target' && !github\.event\.pull_request\.draft \}\}/u,
  );
  assert.match(source, /FEISHU_PR_BOT_WEBHOOK:\n\s+required: false/u);
  assert.match(source, /FEISHU_PR_BOT_SECRET:\n\s+required: false/u);
  assert.match(
    source,
    new RegExp(
      `uses: openpi-dev/automation/actions/feishu-pr-notification@${FEISHU_ACTION_SHA}`,
    ),
  );
  assert.match(
    source,
    /FEISHU_PR_BOT_WEBHOOK: \$\{\{ secrets\.FEISHU_PR_BOT_WEBHOOK \}\}/u,
  );
  assert.match(
    source,
    /FEISHU_PR_BOT_SECRET: \$\{\{ secrets\.FEISHU_PR_BOT_SECRET \}\}/u,
  );
  assert.doesNotMatch(
    source,
    /actions\/checkout|pull_request\.head|github\.head_ref|EVENT_PATH|github\.event_path/u,
  );
});

test("release resolves and verifies the exact tag through tested actions", () => {
  const source = workflow("openpi-release");
  const validationCalls = source.match(
    /uses: openpi-dev\/automation\/actions\/openpi-release-validation@[0-9a-f]{40}/gu,
  );

  assert.equal(validationCalls?.length, 2);
  for (const call of validationCalls ?? []) {
    assert.match(call, new RegExp(RELEASE_ACTION_SHA));
  }
  assert.match(source, /mode: resolve/u);
  assert.match(source, /release_tag: \$\{\{ inputs\.tag \}\}/u);
  assert.match(source, /event_name: \$\{\{ github\.event_name \}\}/u);
  assert.match(source, /ref: \$\{\{ github\.ref \}\}/u);
  assert.match(source, /ref: \$\{\{ steps\.source\.outputs\.tag \}\}/u);
  assert.match(source, /mode: verify-package/u);
  assert.match(
    source,
    /release_tag: \$\{\{ steps\.source\.outputs\.tag \}\}/u,
  );
  assert.match(source, /git merge-base --is-ancestor HEAD origin\/main/u);
});

test("release validates and transfers one package artifact before publishing", () => {
  const source = workflow("openpi-release");
  const publish = source.slice(source.indexOf("  publish:"));

  assert.match(source, /bun install --frozen-lockfile/u);
  assert.match(source, /bun run check/u);
  assert.match(source, /bun run test/u);
  assert.match(source, /npm pack --dry-run --ignore-scripts/u);
  assert.match(
    source,
    /npm pack --ignore-scripts --pack-destination release-artifact/u,
  );
  assert.match(source, /actions\/upload-artifact@[0-9a-f]{40}/u);
  assert.match(source, /if-no-files-found: error/u);

  assert.match(publish, /needs: validate/u);
  assert.match(publish, /environment: npm/u);
  assert.match(publish, /id-token: write/u);
  assert.match(publish, /actions\/download-artifact@[0-9a-f]{40}/u);
  assert.match(publish, /test "\$\{#packages\[@\]\}" -eq 1/u);
  assert.match(
    publish,
    /npm publish "\$\{packages\[0\]\}" --ignore-scripts --access public/u,
  );
  assert.doesNotMatch(publish, /actions\/checkout|bun install|npm pack --dry-run/u);
});

test("every external action reference is pinned to a full commit SHA", () => {
  for (const name of [
    "openpi-feishu-pr-notification",
    "openpi-release",
  ]) {
    const source = workflow(name);
    for (const line of source.match(/^\s*-?\s*uses:\s+.+$/gmu) ?? []) {
      assert.match(line, /@[0-9a-f]{40}(?:\s+#.*)?$/u);
    }
  }
});
