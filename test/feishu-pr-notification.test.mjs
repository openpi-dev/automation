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
});

test("untrusted metadata cannot inject Feishu tags or message fields", () => {
  const text = notification.formatNotificationText(
    event({
      title:
        '<at user_id="all">所有人</at> &lt;at&gt; &#60;at&gt; ＆ｌｔ；at\r\n作者：伪造\u202e\u2066',
      user: { login: "evil\n审阅人：伪造" },
      requested_reviewers: [{ login: "reviewer\u2028PR 链接：伪造" }],
      head: { label: "fork\u2029作者：伪造" },
    }),
    "openpi-dev/openpi",
  );
  const lines = text.split("\n");

  assert.equal(lines.length, 6);
  assert.equal(lines.filter((line) => line.startsWith("作者：")).length, 1);
  assert.doesNotMatch(text, /<|&|[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u);
  assert.doesNotMatch(text.normalize("NFKC"), /<at/u);
});

test("field bounds count Unicode code points without splitting emoji", () => {
  assert.equal(notification.sanitizeFeishuField("🙂".repeat(10), 4), "🙂🙂🙂…");
});

test("current and legacy Feishu success responses remain accepted", () => {
  assert.equal(notification.isSuccessfulResponse({ code: 0 }), true);
  assert.equal(notification.isSuccessfulResponse({ StatusCode: 0 }), true);
  assert.equal(notification.isSuccessfulResponse({ code: 19021 }), false);
  assert.equal(notification.isSuccessfulResponse(null), false);
});

test("the HTTP payload uses sanitized text and the expected signature", async (t) => {
  let requestBody = "";
  const server = createServer((request, response) => {
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      requestBody += chunk;
    });
    request.on("end", () => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ code: 0 }));
    });
  });
  t.after(() => server.close());
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  const now = 1_700_000_000_000;
  const secret = "test-secret";
  await notification.sendNotification({
    event: event({ title: '<at user_id="all">所有人</at> &lt;at&gt;' }),
    repository: "openpi-dev/openpi",
    webhook: `http://127.0.0.1:${address.port}`,
    secret,
    now: () => now,
  });

  const payload = JSON.parse(requestBody);
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
