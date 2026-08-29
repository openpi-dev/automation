const crypto = require("node:crypto");
const fs = require("node:fs");

const FIELD_LIMIT = 256;
const REVIEWER_LIMIT = 128;
const REVIEWERS_LIMIT = 512;
const CONTROL_OR_LINE_SEPARATOR = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
const BIDI_CONTROL = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
const GITHUB_REPOSITORY = /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/iu;

function truncateCodePoints(value, maxCodePoints) {
  const points = Array.from(value);
  if (points.length <= maxCodePoints) return value;
  if (maxCodePoints <= 1) return "…";
  return `${points.slice(0, maxCodePoints - 1).join("")}…`;
}

function isEncodedAngleBracket(value) {
  return /^&(?:lt;?|gt;?|#0*(?:60|62)(?:;|(?![0-9]))|#x0*(?:3c|3e)(?:;|(?![0-9a-f])))/iu.test(
    value,
  );
}

function sanitizeFeishuField(value, maxCodePoints = FIELD_LIMIT) {
  const points = Array.from(String(value ?? ""))
    .filter((point) => !BIDI_CONTROL.test(point))
    .map((point) => (CONTROL_OR_LINE_SEPARATOR.test(point) ? " " : point));
  const compatibility = points.map((point) => point.normalize("NFKC"));
  const safe = points.map((point, index) => {
    if (compatibility[index] === "<") return "‹";
    if (compatibility[index] === ">") return "›";
    if (
      compatibility[index] === "&" &&
      isEncodedAngleBracket(compatibility.slice(index).join(""))
    ) {
      return "⅋";
    }
    return point;
  });
  return truncateCodePoints(
    safe.join("").replace(/\s+/gu, " ").trim(),
    maxCodePoints,
  );
}

function validatePullRequestUrl(value, repository, number) {
  if (!GITHUB_REPOSITORY.test(repository)) {
    throw new Error(`Invalid GitHub repository: ${repository}`);
  }
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new Error(`Invalid pull request number: ${number}`);
  }

  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Pull request URL must be a valid URL.");
  }

  const expectedPath = `/${repository}/pull/${number}`;
  if (
    url.protocol !== "https:" ||
    url.hostname !== "github.com" ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== expectedPath ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error(
      `Pull request URL must be https://github.com${expectedPath}.`,
    );
  }
  return url.href;
}

function plainText(content) {
  return { tag: "plain_text", content };
}

function formatNotificationCard(event, repository) {
  const pr = event.pull_request;
  const url = validatePullRequestUrl(pr.html_url, repository, pr.number);
  const author = sanitizeFeishuField(pr.user?.login ?? "unknown");
  const reviewers = [
    ...(pr.requested_reviewers ?? []).map((reviewer) =>
      sanitizeFeishuField(reviewer.login, REVIEWER_LIMIT),
    ),
    ...(pr.requested_teams ?? []).map(
      (team) => `team/${sanitizeFeishuField(team.slug, REVIEWER_LIMIT)}`,
    ),
  ].filter(Boolean);
  const reviewerText =
    reviewers.length > 0
      ? sanitizeFeishuField(reviewers.join(", "), REVIEWERS_LIMIT)
      : "未指定";

  return {
    config: { wide_screen_mode: true },
    header: {
      template: "blue",
      title: plainText("New pull request"),
    },
    elements: [
      {
        tag: "div",
        text: plainText(
          `${sanitizeFeishuField(repository)} · PR #${pr.number}\n🟢 Open\n${sanitizeFeishuField(pr.title)}`,
        ),
      },
      { tag: "hr" },
      {
        tag: "div",
        fields: [
          { is_short: true, text: plainText(`Author\n${author}`) },
          {
            is_short: true,
            text: plainText(`Reviewers\n${reviewerText}`),
          },
          {
            is_short: false,
            text: plainText(
              `Branches\n${sanitizeFeishuField(pr.head.label)} → ${sanitizeFeishuField(pr.base.ref)}`,
            ),
          },
        ],
      },
      {
        tag: "action",
        actions: [
          {
            tag: "button",
            text: plainText("View pull request"),
            type: "primary",
            url,
          },
        ],
      },
    ],
  };
}

function isSuccessfulResponse(payload) {
  return (
    payload !== null &&
    typeof payload === "object" &&
    (payload.code === 0 || payload.StatusCode === 0)
  );
}

function resolveNotificationConfiguration(webhook, secret) {
  const hasWebhook = typeof webhook === "string" && webhook.length > 0;
  const hasSecret = typeof secret === "string" && secret.length > 0;

  if (!hasWebhook && !hasSecret) return { enabled: false };
  if (!hasWebhook || !hasSecret) {
    throw new Error(
      "Both FEISHU_PR_BOT_WEBHOOK and FEISHU_PR_BOT_SECRET must be configured.",
    );
  }
  return { enabled: true, webhook, secret };
}

async function sendNotification({
  event,
  repository,
  webhook,
  secret,
  now = Date.now,
}) {
  const timestamp = String(Math.floor(now() / 1_000));
  const stringToSign = `${timestamp}\n${secret}`;
  const sign = crypto
    .createHmac("sha256", stringToSign)
    .update("")
    .digest("base64");
  const response = await fetch(webhook, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      timestamp,
      sign,
      msg_type: "interactive",
      card: formatNotificationCard(event, repository),
    }),
  });
  const text = await response.text();

  if (!response.ok) {
    throw new Error(`Feishu webhook returned ${response.status}: ${text}`);
  }

  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`Feishu webhook returned an invalid JSON response: ${text}`);
  }

  if (!isSuccessfulResponse(payload)) {
    throw new Error(`Feishu webhook failed: ${text}`);
  }
}

async function main() {
  const configuration = resolveNotificationConfiguration(
    process.env.FEISHU_PR_BOT_WEBHOOK,
    process.env.FEISHU_PR_BOT_SECRET,
  );
  if (!configuration.enabled) {
    console.log("Feishu bot secrets are not configured; skipping notification.");
    return;
  }

  const event = JSON.parse(fs.readFileSync(process.env.EVENT_PATH, "utf8"));
  await sendNotification({
    event,
    repository: process.env.REPOSITORY,
    webhook: configuration.webhook,
    secret: configuration.secret,
  });
  console.log("Feishu PR notification sent.");
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = {
  formatNotificationCard,
  isSuccessfulResponse,
  resolveNotificationConfiguration,
  sanitizeFeishuField,
  sendNotification,
  validatePullRequestUrl,
};
