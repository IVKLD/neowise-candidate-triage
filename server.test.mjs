import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createAppServer } from "./server.mjs";

let server;
let baseUrl;

before(async () => {
  server = createAppServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

async function postRaw(rawBody) {
  const response = await fetch(`${baseUrl}/api/triage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: rawBody,
  });
  return {
    status: response.status,
    body: await response.json(),
  };
}

function postJson(payload) {
  return postRaw(JSON.stringify(payload));
}

describe("POST /api/triage", () => {
  it("returns ready with topic and non-empty draft for valid input", async () => {
    const delivery = await postJson({ text: "Когда будет доставка заказа?" });
    assert.equal(delivery.status, 200);
    assert.equal(delivery.body.status, "ready");
    assert.equal(delivery.body.topic, "delivery");
    assert.equal(typeof delivery.body.draft, "string");
    assert.ok(delivery.body.draft.trim().length > 0);

    const pricing = await postJson({ text: "Подскажите стоимость подписки" });
    assert.equal(pricing.status, 200);
    assert.equal(pricing.body.status, "ready");
    assert.equal(pricing.body.topic, "pricing");

    const other = await postJson({ text: "Здравствуйте, есть вопрос" });
    assert.equal(other.status, 200);
    assert.equal(other.body.status, "ready");
    assert.equal(other.body.topic, "other");
  });

  it("returns 400 invalid_input for empty, missing, non-string, or malformed JSON", async () => {
    const invalidPayloads = [
      JSON.stringify({ text: "" }),
      JSON.stringify({ text: "   \n\t " }),
      JSON.stringify({}),
      JSON.stringify({ text: 123 }),
      JSON.stringify({ text: null }),
      JSON.stringify({ text: ["заявка"] }),
      JSON.stringify(null),
      JSON.stringify("просто строка"),
      JSON.stringify([]),
      "{broken json",
      "",
    ];

    for (const payload of invalidPayloads) {
      const res = await postRaw(payload);
      assert.equal(res.status, 400, `Expected 400 for payload: ${payload}`);
      assert.deepEqual(res.body, { status: "invalid_input" });
    }
  });

  it("returns 200 manual_review on model timeout within 300ms limit", async () => {
    const startedAt = performance.now();
    const res = await postJson({ text: "Нужна доставка [timeout]" });
    const elapsedMs = performance.now() - startedAt;

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, {
      status: "manual_review",
      topic: null,
      draft: null,
    });
    assert.ok(
      elapsedMs < 600,
      `Expected timeout fallback well under 1200ms, got ${Math.round(elapsedMs)}ms`,
    );
  });

  it("returns 200 manual_review on model error, bad JSON, bad topic, and empty draft", async () => {
    const failureCases = [
      "Заявка [error]",
      "Заявка [bad-json]",
      "Заявка [bad-topic]",
      "Заявка [empty-draft]",
    ];

    for (const text of failureCases) {
      const res = await postJson({ text });
      assert.equal(res.status, 200, `Expected 200 for case: ${text}`);
      assert.deepEqual(res.body, {
        status: "manual_review",
        topic: null,
        draft: null,
      });
    }
  });
});

describe("HTTP routing", () => {
  it("serves index.html on GET / and returns 404 for unknown routes", async () => {
    const page = await fetch(`${baseUrl}/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type") ?? "", /text\/html/);
    const html = await page.text();
    assert.match(html, /Входящие заявки/);

    const missing = await fetch(`${baseUrl}/unknown`);
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), { status: "not_found" });
  });
});
