import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "http";
import crypto from "node:crypto";

// Import server internals for testing
import {
  app,
  loadKeys,
  setApiKeys,
  MODELS,
  MODEL_META,
  MODELS_ORIGIN,
  MODELS_LOADED_AT,
  useDefaults,
  applyClientVersion,
  validateGenParams,
  validateChatBody,
  validateAnthropicBody,
  isPlainObject,
  anthropicToOpenAI,
  openAIToAnthropic,
  anthropicToolChoiceToOpenAI,
  reasoningText,
  aggregateChatSSE,
  sseErrorPayload,
  coerceChatSyncBody,
  upstreamErrorPayload,
  parseUpstreamError,
  isQuotaError,
  isRetryableLimit,
  isHardQuotaWait,
  retryDelay,
  parseRetryAfterMs,
  RETRY_429_HARD_LIMIT_MS,
  RETRY_429_CAP_MS,
  freepiSessionId,
  getSession,
  loadFreepiJwt,
} from "../server.mjs";

// ── Mock upstream server ────────────────────────────────────────────
const MOCK_PORT = 16447;
const MOCK_BASE = `http://127.0.0.1:${MOCK_PORT}`;
let mockServer;
let mockModels = [
  { id: "deepseek/deepseek-v4-flash", name: "DeepSeek V4 Flash" },
  { id: "deepseek/deepseek-v4-pro", name: "DeepSeek V4 Pro" },
  { id: "qwen/qwen-2.5-72b", name: "Qwen 2.5 72B" },
];
let mockJwt = "mock-jwt-token";
let mockCallCount = 0;

function startMockServer() {
  return new Promise((resolve) => {
    mockServer = createServer(async (req, res) => {
      mockCallCount++;
      const url = new URL(req.url, MOCK_BASE);
      
      // CORS for browser tests
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, x-session-id, x-client-version");
      
      if (req.method === "OPTIONS") {
        res.writeHead(204);
        return res.end();
      }

      // /client-version
      if (url.pathname === "/client-version" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({
          min: "0.4.10",
          latest: "0.4.10",
          model: "deepseek/deepseek-v4-flash",
          models: mockModels,
          notice: "",
          fusion: { planner: "deepseek/deepseek-v4-pro", executor: "deepseek/deepseek-v4-flash" }
        }));
      }

      // /v1/chat/completions
      if (url.pathname === "/v1/chat/completions" && req.method === "POST") {
        let body = "";
        for await (const chunk of req) body += chunk;
        const parsed = JSON.parse(body || "{}");

        // Check auth
        const auth = req.headers.authorization || "";
        if (!auth.startsWith("Bearer ") || auth.slice(7) !== mockJwt) {
          res.writeHead(401, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ error: { message: "Invalid JWT", type: "authentication_error" } }));
        }

        // Check model
        if (!mockModels.some(m => m.id === parsed.model)) {
          res.writeHead(400, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ error: { message: `Unknown model: ${parsed.model}`, type: "invalid_request_error" } }));
        }

        // Simulate streaming response
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
        });

        const streamId = `chatcmpl-${Date.now()}`;
        const created = Math.floor(Date.now() / 1000);
        
        // First chunk with role
        res.write(`data: ${JSON.stringify({
          id: streamId,
          object: "chat.completion.chunk",
          created,
          model: parsed.model,
          choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }]
        })}\n\n`);

        // Content chunks
        const content = "Hello from mock upstream!";
        for (const char of content) {
          res.write(`data: ${JSON.stringify({
            id: streamId,
            object: "chat.completion.chunk",
            created,
            model: parsed.model,
            choices: [{ index: 0, delta: { content: char }, finish_reason: null }]
          })}\n\n`);
          await new Promise(r => setTimeout(r, 10));
        }

        // Final chunk with usage
        res.write(`data: ${JSON.stringify({
          id: streamId,
          object: "chat.completion.chunk",
          created,
          model: parsed.model,
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 }
        })}\n\n`);

        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }

      // /me (auth verification)
      if (url.pathname === "/me" && req.method === "GET") {
        const auth = req.headers.authorization || "";
        if (!auth.startsWith("Bearer ") || auth.slice(7) !== mockJwt) {
          res.writeHead(401, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ error: { message: "Invalid JWT", type: "authentication_error" } }));
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ remaining_usd_today: 10, lane: "free" }));
      }

      // 404
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Not found", type: "not_found_error" } }));
    });

    mockServer.listen(MOCK_PORT, () => {
      console.log(`[MOCK] Upstream server running on ${MOCK_BASE}`);
      resolve();
    });
  });
}

function stopMockServer() {
  return new Promise((resolve) => {
    if (mockServer) mockServer.close(resolve);
    else resolve();
  });
}

// ── Test helpers ────────────────────────────────────────────────────
const TEST_API_KEY = "fp-test-key-1234567890abcdef";

async function request(opts) {
  const url = new URL(opts.path, `http://127.0.0.1:${TEST_PORT}`);
  const headers = {
    "Content-Type": "application/json",
    ...(opts.headers || {}),
  };
  if (opts.apiKey) headers["Authorization"] = `Bearer ${opts.apiKey}`;

  const res = await fetch(url, {
    method: opts.method || "GET",
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });

  let data;
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) data = await res.json();
  else if (ct.includes("text/event-stream")) data = await res.text();
  else data = await res.text();

  return { status: res.status, data, headers: res.headers };
}

// ── Tests ────────────────────────────────────────────────────────────
let TEST_PORT = 16448;
let testServer;

describe("free-pi-cli-proxy", () => {
  before(async () => {
    // Start mock upstream
    await startMockServer();

    // Configure proxy to use mock upstream
    process.env.FREEPI_BASE_URL = MOCK_BASE;
    process.env.FREEPI_JWT = mockJwt;
    process.env.FREEPI_CLIENT_VERSION = "0.4.10";
    process.env.LOG_LEVEL = "silent";
    process.env.PROXY_PORT = String(TEST_PORT);
    process.env.SESSION_TTL_MS = "0"; // Disable session reuse for tests
    process.env.GRAVITY_DISABLE_PIXEL = "1"; // Keep tests offline

    // Load the mock JWT from the env vars set above (validates against /me)
    await loadFreepiJwt();

    // Generate test API key
    setApiKeys({ "test-user": TEST_API_KEY });

    // Load models from mock
    const { loadModels } = await import("../server.mjs");
    await loadModels();

    // Start proxy server
    testServer = app.listen(TEST_PORT);
    await new Promise(r => testServer.once("listening", r));
    console.log(`[TEST] Proxy server running on http://127.0.0.1:${TEST_PORT}`);
  });

  after(async () => {
    if (testServer) await new Promise(r => testServer.close(r));
    await stopMockServer();
  });

  describe("Internal utilities", () => {
    it("freepiSessionId generates valid UUIDs", () => {
      const id = freepiSessionId();
      assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    });

    it("local fpId generates unique ids", () => {
      function localFpId(prefix) {
        const ts = Date.now().toString(16);
        const rnd = crypto.randomBytes(12).toString("base64url").slice(0, 16);
        return `${prefix}_${ts}${rnd}`;
      }
      const a = localFpId("test");
      const b = localFpId("test");
      assert.notEqual(a, b);
      assert.match(a, /^test_[0-9a-f]+[A-Za-z0-9_-]+$/);
    });

    it("freepiSessionId generates valid UUIDs", () => {
      const id = freepiSessionId();
      assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    });

    it("getSession reuses session for same key+header", () => {
      const req1 = { headers: { "x-session-id": "conv-1" } };
      const req2 = { headers: { "x-session-id": "conv-1" } };
      const req3 = { headers: { "x-session-id": "conv-2" } };
      
      const s1 = getSession("user1", req1);
      const s2 = getSession("user1", req2);
      const s3 = getSession("user1", req3);
      
      assert.equal(s1, s2);
      assert.notEqual(s1, s3);
    });

    it("validateGenParams rejects invalid values", () => {
      assert.equal(validateGenParams({ max_tokens: 0 }), "max_tokens must be a positive integer");
      assert.equal(validateGenParams({ max_tokens: -1 }), "max_tokens must be a positive integer");
      assert.equal(validateGenParams({ max_tokens: 1.5 }), "max_tokens must be a positive integer");
      assert.equal(validateGenParams({ temperature: -0.1 }), "temperature must be a number in [0, 2]");
      assert.equal(validateGenParams({ temperature: 2.1 }), "temperature must be a number in [0, 2]");
      assert.equal(validateGenParams({ top_p: -0.1 }), "top_p must be a number in [0, 1]");
      assert.equal(validateGenParams({ top_p: 1.1 }), "top_p must be a number in [0, 1]");
      assert.equal(validateGenParams({ max_tokens: 100 }), null);
      assert.equal(validateGenParams({ temperature: 1.0, top_p: 0.9 }), null);
    });

    it("validateChatBody validates message structure", () => {
      assert.equal(validateChatBody({}), "messages must be a non-empty array");
      assert.equal(validateChatBody({ messages: [] }), "messages must be a non-empty array");
      assert.equal(validateChatBody({ messages: [{}] }), "messages[0].role must be a non-empty string");
      assert.equal(validateChatBody({ messages: [{ role: "invalid" }] }), "messages[0].role must be one of system, developer, user, assistant, tool");
      assert.equal(validateChatBody({ messages: [{ role: "user", content: 123 }] }), "messages[0].content must be a string or an array of content parts");
      assert.equal(validateChatBody({ messages: [{ role: "user", content: "hello" }] }), null);
      assert.equal(validateChatBody({ messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }] }), null);
    });

    it("validateAnthropicBody validates messages", () => {
      assert.equal(validateAnthropicBody(null), "request body must be a JSON object");
      assert.equal(validateAnthropicBody({}), "messages must be a non-empty array");
      assert.equal(validateAnthropicBody({ messages: [] }), "messages must be a non-empty array");
      assert.equal(validateAnthropicBody({ messages: [{ role: "user" }] }), "messages[0].content must be a string or an array of content blocks");
      assert.equal(validateAnthropicBody({ messages: [{ role: "user", content: "hello" }] }), null);
      assert.equal(validateAnthropicBody({ messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }] }), null);
      assert.ok(validateAnthropicBody({ messages: [{ role: "user", content: [{ type: "image", source: {} }] }] }).startsWith("Unsupported content block type(s): image"));
    });

    it("anthropicToOpenAI converts correctly", () => {
      const { messages, tools } = anthropicToOpenAI({
        system: "You are helpful",
        messages: [
          { role: "user", content: "Hello" },
          { role: "assistant", content: [{ type: "tool_use", id: "tu_1", name: "search", input: { q: "test" } }] },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_1", content: "result" }] },
        ],
        tools: [{ name: "search", description: "Search", input_schema: { type: "object", properties: { q: { type: "string" } } } }],
      });
      assert.equal(messages.length, 4); // system + user + assistant(tool_calls) + tool
      assert.equal(messages[0].role, "system");
      assert.equal(messages[1].role, "user");
      assert.equal(messages[2].role, "assistant");
      assert.equal(messages[2].tool_calls.length, 1);
      assert.equal(messages[3].role, "tool");
      assert(tools);
      assert.equal(tools.length, 1);
    });

    it("openAIToAnthropic converts correctly", () => {
      const ant = openAIToAnthropic({
        choices: [{
          message: { content: "Hello", tool_calls: [{ id: "tc_1", type: "function", function: { name: "search", arguments: '{"q":"test"}' } }] },
          finish_reason: "tool_calls"
        }],
        usage: { prompt_tokens: 10, completion_tokens: 20 }
      }, "test-model", 100);
      assert.equal(ant.type, "message");
      assert.equal(ant.content.length, 2); // text + tool_use
      assert.equal(ant.content[0].type, "text");
      assert.equal(ant.content[1].type, "tool_use");
      assert.equal(ant.stop_reason, "tool_use");
      assert.equal(ant.usage.input_tokens, 10);
    });

    it("anthropicToolChoiceToOpenAI maps correctly", () => {
      assert.equal(anthropicToolChoiceToOpenAI({ type: "auto" }), "auto");
      assert.equal(anthropicToolChoiceToOpenAI({ type: "any" }), "required");
      assert.equal(anthropicToolChoiceToOpenAI({ type: "none" }), "none");
      assert.deepEqual(anthropicToolChoiceToOpenAI({ type: "tool", name: "search" }), { type: "function", function: { name: "search" } });
      assert.equal(anthropicToolChoiceToOpenAI(null), undefined);
    });

    it("reasoningText extracts reasoning from various fields", () => {
      assert.equal(reasoningText({ reasoning_content: "think" }), "think");
      assert.equal(reasoningText({ reasoning: "think" }), "think");
      assert.equal(reasoningText({ reasoning_text: "think" }), "think");
      assert.equal(reasoningText({ content: "hello" }), "");
      assert.equal(reasoningText(null), "");
    });

    it("aggregateChatSSE aggregates streaming chunks", () => {
      const sse = `
data: {"id":"cmpl-1","created":123,"model":"test","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}

data: {"id":"cmpl-1","created":123,"model":"test","choices":[{"index":0,"delta":{"content":"Hel"},"finish_reason":null}]}

data: {"id":"cmpl-1","created":123,"model":"test","choices":[{"index":0,"delta":{"content":"lo"},"finish_reason":null}]}

data: {"id":"cmpl-1","created":123,"model":"test","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":10}}

data: [DONE]
`;
      const result = aggregateChatSSE(sse);
      assert.ok(result);
      assert.equal(result.id, "cmpl-1");
      assert.equal(result.model, "test");
      assert.equal(result.choices[0].message.content, "Hello");
      assert.equal(result.choices[0].finish_reason, "stop");
      assert.equal(result.usage.prompt_tokens, 5);
    });

    it("coerceChatSyncBody handles JSON and SSE", () => {
      // Direct JSON
      let r = coerceChatSyncBody('{"id":"cmpl-1","object":"chat.completion"}');
      assert.ok(r.json);
      assert.equal(r.json.id, "cmpl-1");

      // SSE (frames without choices are usage/cost-only and not aggregated)
      r = coerceChatSyncBody('data: {"id":"cmpl-2","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
      assert.ok(r.json);
      assert.equal(r.json.id, "cmpl-2");
      assert.equal(r.json.choices[0].message.content, "hi");

      // Error in SSE
      r = coerceChatSyncBody('data: {"error":{"message":"oops"}}\n\ndata: [DONE]\n\n');
      assert.ok(r.json);
      assert.equal(r.json.error.message, "oops");
    });

    it("parseUpstreamError parses error responses", () => {
      let p = parseUpstreamError('{"error":{"message":"Rate limit","type":"rate_limit_exceeded"}}');
      assert.equal(p.msg, "Rate limit");
      assert.equal(p.code, "rate_limit_exceeded");

      p = parseUpstreamError('{"message":"Auth failed","code":"authentication_error"}');
      assert.equal(p.msg, "Auth failed");
      assert.equal(p.code, "authentication_error");

      p = parseUpstreamError("plain text error");
      assert.equal(p.msg, "plain text error");
      assert.equal(p.code, "");
    });

    it("upstreamErrorPayload classifies errors correctly", () => {
      let r = upstreamErrorPayload(429, '{"error":{"message":"Rate limit","type":"rate_limit_exceeded"}}', new Headers());
      assert.equal(r.status, 429);
      assert.equal(r.error.type, "rate_limit_error");
      assert.equal(r.error.code, "rate_limit_exceeded");

      r = upstreamErrorPayload(401, '{"error":{"message":"Invalid key","type":"authentication_error"}}', new Headers());
      assert.equal(r.status, 401);
      assert.equal(r.error.type, "authentication_error");

      r = upstreamErrorPayload(500, '{"error":{"message":"Internal error"}}', new Headers());
      assert.equal(r.status, 500);
      assert.equal(r.error.type, "upstream_error");
    });

    it("isRetryableLimit identifies retryable 429s", () => {
      assert.ok(isRetryableLimit(429, '{"error":{"type":"rate_limit_exceeded"}}'));
      assert.ok(!isRetryableLimit(429, '{"error":{"type":"creditlimitexceeded"}}'));
      assert.ok(!isRetryableLimit(429, '{"error":{"type":"insufficient_quota"}}'));
      assert.ok(!isRetryableLimit(400, '{"error":{"type":"rate_limit_exceeded"}}'));
    });

    it("isHardQuotaWait detects long Retry-After", () => {
      assert.ok(isHardQuotaWait(300001)); // > 5 min
      assert.ok(!isHardQuotaWait(300000)); // = 5 min
      assert.ok(!isHardQuotaWait(60000)); // 1 min
      assert.ok(!isHardQuotaWait(undefined));
    });

    it("retryDelay calculates backoff", () => {
      const d1 = retryDelay(0, undefined);
      assert.ok(d1 >= 1500 && d1 <= 3000); // base 2000 * 0.75~1.5
      
      const d2 = retryDelay(1, undefined);
      assert.ok(d2 >= 3000 && d2 <= 6000); // base 4000 * 0.75~1.5

      const d3 = retryDelay(0, 5000); // explicit Retry-After
      assert.equal(d3, 5000);

      const d4 = retryDelay(0, 40000); // capped at RETRY_429_CAP_MS
      assert.equal(d4, RETRY_429_CAP_MS);
    });

    it("parseRetryAfterMs parses headers", () => {
      const h = new Headers({ "retry-after-ms": "5000" });
      assert.equal(parseRetryAfterMs(h), 5000);

      const h2 = new Headers({ "retry-after": "30" });
      assert.equal(parseRetryAfterMs(h2), 30000);

      const h3 = new Headers({ "retry-after": "Wed, 21 Oct 2026 07:28:00 GMT" });
      const parsed = parseRetryAfterMs(h3);
      assert.ok(typeof parsed === "number" && parsed >= 0);
    });
  });

  describe("GET /v1/models", () => {
    it("returns model list in OpenAI format", async () => {
      const { status, data } = await request({ path: "/v1/models", apiKey: TEST_API_KEY });
      assert.equal(status, 200);
      assert.equal(data.object, "list");
      assert.ok(Array.isArray(data.data));
      assert.ok(data.data.length >= 3);
      
      const model = data.data[0];
      assert.ok(model.id);
      assert.equal(model.object, "model");
      assert.ok(model.created);
      assert.equal(model.owned_by, "free-pi");
      assert.ok(model.name);
    });

    it("returns 401 without API key", async () => {
      const { status, data } = await request({ path: "/v1/models" });
      assert.equal(status, 401);
      assert.equal(data.error.message, "Invalid API key");
    });
  });

  describe("POST /v1/chat/completions", () => {
    it("returns 401 without API key", async () => {
      const { status, data } = await request({
        path: "/v1/chat/completions",
        method: "POST",
        body: { model: "deepseek/deepseek-v4-flash", messages: [{ role: "user", content: "Hi" }] },
      });
      assert.equal(status, 401);
    });

    it("returns 400 for unknown model", async () => {
      const { status, data } = await request({
        path: "/v1/chat/completions",
        method: "POST",
        apiKey: TEST_API_KEY,
        body: { model: "unknown-model", messages: [{ role: "user", content: "Hi" }] },
      });
      assert.equal(status, 400);
      assert.ok(data.error.message.includes("Unknown model"));
    });

    it("returns 400 for empty messages", async () => {
      const { status, data } = await request({
        path: "/v1/chat/completions",
        method: "POST",
        apiKey: TEST_API_KEY,
        body: { model: "deepseek/deepseek-v4-flash", messages: [] },
      });
      assert.equal(status, 400);
      assert.ok(data.error.message.includes("non-empty"));
    });

    it("returns 400 for invalid generation params", async () => {
      const { status, data } = await request({
        path: "/v1/chat/completions",
        method: "POST",
        apiKey: TEST_API_KEY,
        body: { model: "deepseek/deepseek-v4-flash", messages: [{ role: "user", content: "Hi" }], max_tokens: -1 },
      });
      assert.equal(status, 400);
      assert.ok(data.error.message.includes("positive integer"));
    });

    it("sync mode aggregates stream to single JSON", async () => {
      const { status, data } = await request({
        path: "/v1/chat/completions",
        method: "POST",
        apiKey: TEST_API_KEY,
        body: { model: "deepseek/deepseek-v4-flash", messages: [{ role: "user", content: "Hi" }], stream: false },
      });
      assert.equal(status, 200);
      assert.equal(data.object, "chat.completion");
      assert.ok(data.choices[0].message.content);
      assert.ok(data.usage);
    });

    it("stream mode returns SSE", async () => {
      const { status, data, headers } = await request({
        path: "/v1/chat/completions",
        method: "POST",
        apiKey: TEST_API_KEY,
        body: { model: "deepseek/deepseek-v4-flash", messages: [{ role: "user", content: "Hi" }], stream: true },
      });
      assert.equal(status, 200);
      assert.ok(headers.get("content-type")?.includes("text/event-stream"));
      assert.ok(data.includes("data:"));
      assert.ok(data.includes("[DONE]"));
      // The mock streams one character per frame, so join deltas before matching.
      const deltas = data
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trim())
        .filter((p) => p && p !== "[DONE]")
        .map((p) => JSON.parse(p))
        .map((p) => p.choices?.[0]?.delta?.content || "")
        .join("");
      assert.equal(deltas, "Hello from mock upstream!");
    });

    it("x-session-id reuses upstream session", async () => {
      const sessionId = "test-conv-" + Date.now();
      
      // First request
      const r1 = await request({
        path: "/v1/chat/completions",
        method: "POST",
        apiKey: TEST_API_KEY,
        headers: { "x-session-id": sessionId },
        body: { model: "deepseek/deepseek-v4-flash", messages: [{ role: "user", content: "First" }], stream: false },
      });
      assert.equal(r1.status, 200);

      // Second request with same session id
      const r2 = await request({
        path: "/v1/chat/completions",
        method: "POST",
        apiKey: TEST_API_KEY,
        headers: { "x-session-id": sessionId },
        body: { model: "deepseek/deepseek-v4-flash", messages: [{ role: "user", content: "First" }, { role: "assistant", content: "OK" }, { role: "user", content: "Second" }], stream: false },
      });
      assert.equal(r2.status, 200);
    });
  });

  describe("POST /v1/messages (Anthropic)", () => {
    it("returns 401 without API key", async () => {
      const { status, data } = await request({
        path: "/v1/messages",
        method: "POST",
        body: { model: "deepseek/deepseek-v4-flash", messages: [{ role: "user", content: "Hi" }], max_tokens: 100 },
      });
      assert.equal(status, 401);
      assert.equal(data.error.type, "authentication_error");
    });

    it("returns 400 for unknown model", async () => {
      const { status, data } = await request({
        path: "/v1/messages",
        method: "POST",
        apiKey: TEST_API_KEY,
        body: { model: "unknown-model", messages: [{ role: "user", content: "Hi" }], max_tokens: 100 },
      });
      assert.equal(status, 400);
      assert.ok(data.error.message.includes("Unknown model"));
    });

    it("sync mode returns Anthropic format", async () => {
      const { status, data } = await request({
        path: "/v1/messages",
        method: "POST",
        apiKey: TEST_API_KEY,
        body: { model: "deepseek/deepseek-v4-flash", messages: [{ role: "user", content: "Hi" }], max_tokens: 100 },
      });
      assert.equal(status, 200);
      assert.equal(data.type, "message");
      assert.ok(data.content[0].text);
      assert.equal(data.stop_reason, "end_turn");
      assert.ok(data.usage);
    });

    it("stream mode returns Anthropic SSE", async () => {
      const { status, data, headers } = await request({
        path: "/v1/messages",
        method: "POST",
        apiKey: TEST_API_KEY,
        body: { model: "deepseek/deepseek-v4-flash", messages: [{ role: "user", content: "Hi" }], max_tokens: 100, stream: true },
      });
      assert.equal(status, 200);
      assert.ok(headers.get("content-type")?.includes("text/event-stream"));
      assert.ok(data.includes('event: message_start'));
      assert.ok(data.includes('event: content_block_delta'));
      assert.ok(data.includes('event: message_stop'));
    });
  });

  describe("GET /health", () => {
    it("returns health status", async () => {
      const { status, data } = await request({ path: "/health" });
      assert.equal(status, 200);
      assert.equal(data.status, "ok");
      assert.ok(data.version);
      assert.ok(data.runtime);
      assert.ok(typeof data.models === "number");
      assert.ok(data.models_source);
      assert.ok(data.models_loaded_at);
      assert.ok(data.upstream_auth);
      assert.ok(data.endpoints.includes("/v1/chat/completions"));
      assert.ok(data.endpoints.includes("/v1/messages"));
      assert.ok(data.endpoints.includes("/v1/models"));
    });
  });
});