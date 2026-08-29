import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import { createRequire } from "node:module";
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

test("benign pull request metadata keeps the existing notification", () => {
  assert.equal(
    notification.formatNotificationText(event(), "openpi-dev/openpi"),
    [
      "openpi-dev/openpi 有新的 PR",
      "#270 feat(ci): notify Feishu for new pull requests",
      "作者：contributor",
      "审阅人：reviewer, team/release-managers",
      "分支：contributor:feature -> main",
      "PR 链接：https://github.com/openpi-dev/openpi/pull/270",
    ].join("\n"),
  );
  assert.equal(
    notification.sanitizeFeishuField(
      "fix A & B, AT&T · 支持①号 ﬃ ligature &#600; &#620; &#x3ca; &#x3e0;",
    ),
    "fix A & B, AT&T · 支持①号 ﬃ ligature &#600; &#620; &#x3ca; &#x3e0;",
  );
});

test("untrusted metadata cannot inject Feishu tags or message fields", () => {
  const text = notification.formatNotificationText(
    event({
      title:
        '<at user_id="all">所有人</at> &lt;at&gt; &ltat&gt; &LT/at&gt; &#60;at&gt; &#60/at&gt; &#x3c;at&gt; ＆ｌｔ；at\r\n作者：伪造\u202e\u2066',
      user: { login: "evil\n审阅人：伪造" },
      requested_reviewers: [{ login: "reviewer\u2028PR 链接：伪造" }],
      head: { label: "fork\u2029作者：伪造" },
    }),
    "openpi-dev/openpi",
  );
  const lines = text.split("\n");

  assert.equal(lines.length, 6);
  assert.equal(lines.filter((line) => line.startsWith("作者：")).length, 1);
  assert.doesNotMatch(
    text,
    /<|&|[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u,
  );
  assert.match(lines[1], /‹at user_id="all"›所有人‹\/at›/u);
  assert.doesNotMatch(text.normalize("NFKC"), /<at/u);
});

test("field and reviewer bounds count code points without splitting Unicode", () => {
  assert.equal(notification.sanitizeFeishuField("🙂".repeat(10), 4), "🙂🙂🙂…");

  const reviewers = notification
    .formatNotificationText(
      event({
        requested_reviewers: Array.from({ length: 100 }, (_, index) => ({
          login: `reviewer-${index}-${"🙂".repeat(20)}`,
        })),
        requested_teams: [],
      }),
      "openpi-dev/openpi",
    )
    .split("\n")[3];
  assert.ok(Array.from(reviewers.slice("审阅人：".length)).length <= 512);
  assert.ok(reviewers.endsWith("…"));
});

test("missing PR metadata keeps bounded fallback fields", () => {
  const text = notification.formatNotificationText(
    event({ user: undefined, requested_reviewers: [], requested_teams: [] }),
    "openpi-dev/openpi",
  );
  assert.match(text, /^作者：unknown$/mu);
  assert.match(text, /^审阅人：未指定$/mu);
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

test("the HTTP payload uses sanitized text and the expected signature", async () => {
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
    assert.equal(payload.msg_type, "text");
    assert.doesNotMatch(payload.content.text.normalize("NFKC"), /<at/u);
    assert.equal(payload.content.text.split("\n").length, 6);
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
