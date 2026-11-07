import http from "http";

const MOCK_PORT = 16447;
const MOCK_JWT = "mock-jwt";

const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, x-session-id, x-client-version");
  
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  const url = new URL(req.url, `http://127.0.0.1:${MOCK_PORT}`);
  console.log(`[MOCK] ${req.method} ${url.pathname}`);

  // /client-version
  if (url.pathname === "/client-version" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({
      min: "0.4.10",
      latest: "0.4.10",
      model: "deepseek/deepseek-v4-flash",
      models: [
        { id: "deepseek/deepseek-v4-flash", name: "DeepSeek V4 Flash" },
        { id: "deepseek/deepseek-v4-pro", name: "DeepSeek V4 Pro" },
      ],
      notice: "",
      fusion: { planner: "deepseek/deepseek-v4-pro", executor: "deepseek/deepseek-v4-flash" }
    }));
  }

  // /v1/chat/completions
  if (url.pathname === "/v1/chat/completions" && req.method === "POST") {
    let body = "";
    for await (const chunk of req) body += chunk;
    const parsed = JSON.parse(body || "{}");
    console.log(`[MOCK] Request model: ${parsed.model}, stream: ${parsed.stream}`);

    // Check auth
    const auth = req.headers.authorization || "";
    if (!auth.startsWith("Bearer ") || auth.slice(7) !== MOCK_JWT) {
      res.writeHead(401, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: { message: "Invalid JWT", type: "authentication_error" } }));
    }

    // Check model
    const validModels = ["deepseek/deepseek-v4-flash", "deepseek/deepseek-v4-pro"];
    if (!validModels.includes(parsed.model)) {
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
      await new Promise(r => setTimeout(r, 5));
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

  // 404
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: { message: "Not found", type: "not_found_error" } }));
});

server.listen(MOCK_PORT, () => {
  console.log(`[MOCK] Upstream server running on http://127.0.0.1:${MOCK_PORT}`);
});

// Keep process alive
process.stdin.resume();