import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { classify } from "./mock-ai.mjs";

const html = await readFile(new URL("./index.html", import.meta.url));

const ALLOWED_TOPICS = new Set(["delivery", "pricing", "other"]);
const AI_TIMEOUT_MS = 300;
const MANUAL_REVIEW_RESPONSE = Object.freeze({
  status: "manual_review",
  topic: null,
  draft: null,
});

function json(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

async function readValidText(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);

  let parsed;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  if (typeof parsed.text !== "string" || parsed.text.trim().length === 0) {
    return null;
  }

  return parsed.text;
}

function parseModelOutput(raw) {
  if (typeof raw !== "string") return null;

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  if (typeof parsed.topic !== "string" || !ALLOWED_TOPICS.has(parsed.topic)) {
    return null;
  }
  if (typeof parsed.draft !== "string" || parsed.draft.trim().length === 0) {
    return null;
  }

  return {
    topic: parsed.topic,
    draft: parsed.draft.trim(),
  };
}

async function classifyWithTimeout(text, classifyFn, timeoutMs) {
  const controller = new AbortController();
  const aiPromise = Promise.resolve().then(() =>
    classifyFn(text, { signal: controller.signal }),
  );
  aiPromise.catch(() => {});

  let timer;
  try {
    return await Promise.race([
      aiPromise,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error("AI timeout"));
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function handleTriage(request, response, { classifyFn, timeoutMs }) {
  const text = await readValidText(request);
  if (text === null) {
    return json(response, 400, { status: "invalid_input" });
  }

  let rawOutput;
  try {
    rawOutput = await classifyWithTimeout(text, classifyFn, timeoutMs);
  } catch {
    return json(response, 200, MANUAL_REVIEW_RESPONSE);
  }

  const result = parseModelOutput(rawOutput);
  if (!result) {
    return json(response, 200, MANUAL_REVIEW_RESPONSE);
  }

  return json(response, 200, {
    status: "ready",
    topic: result.topic,
    draft: result.draft,
  });
}

export function createAppServer({ classifyFn = classify, timeoutMs = AI_TIMEOUT_MS } = {}) {
  return createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(html);
      return;
    }
    if (request.method !== "POST" || request.url !== "/api/triage") {
      return json(response, 404, { status: "not_found" });
    }
    try {
      await handleTriage(request, response, { classifyFn, timeoutMs });
    } catch {
      json(response, 500, { status: "server_error" });
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  createAppServer().listen(Number(process.env.PORT || 3000), "127.0.0.1");
}
