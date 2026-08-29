const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

function requireNonempty(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} is required.`);
  }
  return value.trim();
}

function checkReleaseRef(tag) {
  const result = spawnSync("git", ["check-ref-format", `refs/tags/${tag}`], {
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Invalid release tag: ${tag}`);
}

function validateReleaseTag(tag, checkRef = checkReleaseRef) {
  const normalized = requireNonempty(tag, "release_tag");
  checkRef(normalized);
  if (!/^v[^/]*\.[^/]*\.[^/]*$/u.test(normalized)) {
    throw new Error(`Release tag must match v*.*.*: ${normalized}`);
  }
  return normalized;
}

function resolveReleaseSource({ eventName, ref, releaseTag, checkRef }) {
  const tag = validateReleaseTag(releaseTag, checkRef);
  const event = requireNonempty(eventName, "event_name");
  const sourceRef = requireNonempty(ref, "ref");

  if (event === "workflow_dispatch") {
    if (sourceRef !== "refs/heads/main") {
      throw new Error("Manual releases must be dispatched from main.");
    }
  } else if (event === "push") {
    if (sourceRef !== `refs/tags/${tag}`) {
      throw new Error("A release push must match the selected version tag.");
    }
  } else {
    throw new Error(`Unsupported release event: ${event}`);
  }

  return tag;
}

function readPackageVersion(workspace) {
  const packagePath = path.join(workspace, "package.json");
  const parsed = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  return requireNonempty(parsed.version, "package.json version");
}

function verifyPackageVersion({ releaseTag, workspace, checkRef }) {
  const tag = validateReleaseTag(releaseTag, checkRef);
  const version = readPackageVersion(requireNonempty(workspace, "GITHUB_WORKSPACE"));
  if (tag !== `v${version}`) {
    throw new Error(`Release tag ${tag} does not match package version ${version}.`);
  }
  return tag;
}

function appendOutput(name, value, outputPath) {
  fs.appendFileSync(outputPath, `${name}=${value}\n`, "utf8");
}

function input(name) {
  return process.env[`INPUT_${name.toUpperCase()}`] ?? "";
}

function main() {
  const mode = requireNonempty(input("mode"), "mode");
  const releaseTag = input("release_tag");
  let tag;

  if (mode === "resolve") {
    tag = resolveReleaseSource({
      eventName: input("event_name"),
      ref: input("ref"),
      releaseTag,
    });
  } else if (mode === "verify-package") {
    tag = verifyPackageVersion({
      releaseTag,
      workspace: process.env.GITHUB_WORKSPACE,
    });
  } else {
    throw new Error(`Unsupported validation mode: ${mode}`);
  }

  appendOutput(
    "tag",
    tag,
    requireNonempty(process.env.GITHUB_OUTPUT, "GITHUB_OUTPUT"),
  );
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}

module.exports = {
  readPackageVersion,
  resolveReleaseSource,
  validateReleaseTag,
  verifyPackageVersion,
};
