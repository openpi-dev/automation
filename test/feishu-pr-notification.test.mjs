import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const notification = require("../actions/feishu-pr-notification/index.cjs");

function event(overrides = {}) {
  return {
    pull_request: {
      number: 270,
      title: "feat(ci): notify Feishu for new pull requests",
      user: { login: "contributor" },
      requested_reviewers: [{ login: "reviewer" }],
      requested_teams: [{ slug: "release-managers" }],
      head: { label: "contributor:feature" },
      base: { ref: "main" },
      html_url: "https://github.com/openpi-dev/openpi/pull/270",
      ...overrides,
    },
  };
}

async function withServer(response, run) {
  let requestBody = "";
  const server = createServer((request, result) => {
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      requestBody += chunk;
    });
    request.on("end", () => {
      result.writeHead(response.status, { "content-type": "application/json" });
      result.end(response.body);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    return await run(`http://127.0.0.1:${address.port}`, () => requestBody);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function textContents(value) {
  if (Array.isArray(value)) return value.flatMap(textContents);
  if (value === null || typeof value !== "object") return [];
  const content =
    value.tag === "plain_text" && typeof value.content === "string"
      ? [value.content]
      : [];
  return [
    ...content,
    ...Object.values(value).flatMap((child) => textContents(child)),
  ];
}

test("benign pull request metadata produces the intended interactive card", () => {
  const card = notification.formatNotificationCard(
    event(),
    "openpi-dev/openpi",
  );

  assert.deepEqual(card.header, {
    template: "blue",
    title: { tag: "plain_text", content: "New pull request" },
  });
  assert.deepEqual(textContents(card), [
    "New pull request",
    "openpi-dev/openpi · PR #270\n🟢 Open\nfeat(ci): notify Feishu for new pull requests",
    "Author\ncontributor",
    "Reviewers\nreviewer, team/release-managers",
    "Branches\ncontributor:feature → main",
    "View pull request",
  ]);
  assert.deepEqual(card.elements.at(-1), {
    tag: "action",
    actions: [
      {
        tag: "button",
        text: { tag: "plain_text", content: "View pull request" },
        type: "primary",
        url: "https://github.com/openpi-dev/openpi/pull/270",
      },
    ],
  });
  assert.equal(
    notification.sanitizeFeishuField(
      "fix A & B, AT&T · 支持①号 ﬃ ligature &#600; &#620; &#x3ca; &#x3e0;",
    ),
    "fix A & B, AT&T · 支持①号 ﬃ ligature &#600; &#620; &#x3ca; &#x3e0;",
  );
});

test("untrusted metadata cannot inject Feishu tags or message fields", () => {
  const card = notification.formatNotificationCard(
    event({
      title:
        '<at user_id="all">所有人</at> &lt;at&gt; &ltat&gt; &LT/at&gt; &#60;at&gt; &#60/at&gt; &#x3c;at&gt; ＆ｌｔ；at\r\n作者：伪造\u202e\u2066',
      user: { login: "evil\n审阅人：伪造" },
      requested_reviewers: [{ login: "reviewer\u2028PR 链接：伪造" }],
      head: { label: "fork\u2029作者：伪造" },
    }),
    "openpi-dev/openpi",
  );
  const contents = textContents(card);
  const serialized = JSON.stringify(card);

  assert.doesNotMatch(
    serialized,
    /<|&|[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u,
  );
  assert.match(contents[1], /‹at user_id="all"›所有人‹\/at›/u);
  assert.doesNotMatch(serialized.normalize("NFKC"), /<at/u);
  assert.equal(
    card.elements.filter((element) => element.tag === "action").length,
    1,
  );
  assert.equal(card.elements.at(-1).actions.length, 1);
});

test("field and reviewer bounds count code points without splitting Unicode", () => {
  assert.equal(notification.sanitizeFeishuField("🙂".repeat(10), 4), "🙂🙂🙂…");

  const card = notification.formatNotificationCard(
    event({
      requested_reviewers: Array.from({ length: 100 }, (_, index) => ({
        login: `reviewer-${index}-${"🙂".repeat(20)}`,
      })),
      requested_teams: [],
    }),
    "openpi-dev/openpi",
  );
  const reviewers = card.elements[2].fields[1].text.content.slice(
    "Reviewers\n".length,
  );
  assert.ok(Array.from(reviewers).length <= 512);
  assert.ok(reviewers.endsWith("…"));
});

test("missing PR metadata keeps bounded fallback fields", () => {
  const card = notification.formatNotificationCard(
    event({ user: undefined, requested_reviewers: [], requested_teams: [] }),
    "openpi-dev/openpi",
  );
  assert.equal(card.elements[2].fields[0].text.content, "Author\nunknown");
  assert.equal(card.elements[2].fields[1].text.content, "Reviewers\n未指定");
});

test("the card button accepts only the exact GitHub pull request URL", () => {
  assert.equal(
    notification.validatePullRequestUrl(
      "https://github.com/openpi-dev/openpi/pull/270",
      "openpi-dev/openpi",
      270,
    ),
    "https://github.com/openpi-dev/openpi/pull/270",
  );
  for (const url of [
    "http://github.com/openpi-dev/openpi/pull/270",
    "https://evil.example/openpi-dev/openpi/pull/270",
    "https://github.com/openpi-dev/openpi/pull/271",
    "https://github.com/openpi-dev/openpi/pull/270?diff=split",
    "not-a-url",
  ]) {
    assert.throws(
      () =>
        notification.validatePullRequestUrl(
          url,
          "openpi-dev/openpi",
          270,
        ),
      /Pull request URL/u,
    );
  }
  assert.throws(
    () =>
      notification.validatePullRequestUrl(
        "https://github.com/openpi-dev/openpi/pull/270",
        "openpi-dev/openpi/extra",
        270,
      ),
    /Invalid GitHub repository/u,
  );
  assert.throws(
    () =>
      notification.validatePullRequestUrl(
        "https://github.com/openpi-dev/openpi/pull/270",
        "openpi-dev/openpi",
        -1,
      ),
    /Invalid pull request number/u,
  );
});

test("the action reads the pull request from GitHub's standard event path", () => {
  const directory = mkdtempSync(join(tmpdir(), "openpi-event-"));
  const eventPath = join(directory, "event.json");
  try {
    writeFileSync(eventPath, JSON.stringify(event()));
    assert.deepEqual(notification.readPullRequestEvent(eventPath), event());
    assert.throws(
      () => notification.readPullRequestEvent(""),
      /GITHUB_EVENT_PATH is required/u,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the two Feishu secrets are optional only as a pair", () => {
  assert.deepEqual(notification.resolveNotificationConfiguration("", ""), {
    enabled: false,
  });
  assert.deepEqual(
    notification.resolveNotificationConfiguration("webhook", "secret"),
    { enabled: true, webhook: "webhook", secret: "secret" },
  );
  assert.throws(
    () => notification.resolveNotificationConfiguration("webhook", ""),
    /Both FEISHU_PR_BOT_WEBHOOK and FEISHU_PR_BOT_SECRET/u,
  );
  assert.throws(
    () => notification.resolveNotificationConfiguration("", "secret"),
    /Both FEISHU_PR_BOT_WEBHOOK and FEISHU_PR_BOT_SECRET/u,
  );
});

test("current and legacy Feishu success responses remain accepted", () => {
  assert.equal(notification.isSuccessfulResponse({ code: 0 }), true);
  assert.equal(notification.isSuccessfulResponse({ StatusCode: 0 }), true);
  assert.equal(notification.isSuccessfulResponse({ code: 19021 }), false);
  assert.equal(notification.isSuccessfulResponse(null), false);
});

test("the HTTP payload uses a sanitized card and the expected signature", async () => {
  await withServer({ status: 200, body: '{"code":0}' }, async (webhook, body) => {
    const now = 1_700_000_000_000;
    const secret = "test-secret";
    await notification.sendNotification({
      event: event({ title: '<at user_id="all">所有人</at> &lt;at&gt;' }),
      repository: "openpi-dev/openpi",
      webhook,
      secret,
      now: () => now,
    });

    const payload = JSON.parse(body());
    const timestamp = String(now / 1_000);
    const expectedSign = createHmac("sha256", `${timestamp}\n${secret}`)
      .update("")
      .digest("base64");

    assert.equal(payload.timestamp, timestamp);
    assert.equal(payload.sign, expectedSign);
    assert.equal(payload.msg_type, "interactive");
    assert.doesNotMatch(JSON.stringify(payload.card).normalize("NFKC"), /<at/u);
    assert.equal(payload.card.header.template, "blue");
    assert.equal(payload.card.elements.at(-1).actions[0].type, "primary");
    assert.equal(
      payload.card.elements.at(-1).actions[0].url,
      "https://github.com/openpi-dev/openpi/pull/270",
    );
  });
});

test("HTTP, JSON, and Feishu response failures are explicit", async () => {
  await withServer({ status: 500, body: '{"code":0}' }, async (webhook) => {
    await assert.rejects(
      notification.sendNotification({
        event: event(),
        repository: "openpi-dev/openpi",
        webhook,
        secret: "secret",
      }),
      /Feishu webhook returned 500/u,
    );
  });
  await withServer({ status: 200, body: "not-json" }, async (webhook) => {
    await assert.rejects(
      notification.sendNotification({
        event: event(),
        repository: "openpi-dev/openpi",
        webhook,
        secret: "secret",
      }),
      /invalid JSON response/u,
    );
  });
  await withServer({ status: 200, body: '{"code":19021}' }, async (webhook) => {
    await assert.rejects(
      notification.sendNotification({
        event: event(),
        repository: "openpi-dev/openpi",
        webhook,
        secret: "secret",
      }),
      /Feishu webhook failed/u,
    );
  });
});
