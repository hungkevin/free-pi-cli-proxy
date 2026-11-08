import express from "express";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import readline from "readline";
import { exec } from "child_process";
import { fileURLToPath } from "url";
import { homedir } from "os";
import { gravityPixel, gravityContext } from "@gravity-ai/api";

// ── Load .env file (simple dotenv, no external dependency) ─────────
// Reads ./env or .env from the project root and sets process.env for any
// variable not already defined in the environment. Command-line args and
// existing env vars take precedence over .env values.
function loadDotEnv() {
  const envFiles = [".env", "./env"];
  for (const fname of envFiles) {
    const envPath = path.resolve(fname);
    try {
      const raw = fs.readFileSync(envPath, "utf8");
      for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eqIdx = trimmed.indexOf("=");
        if (eqIdx === -1) continue;
        const key = trimmed.slice(0, eqIdx).trim();
        let value = trimmed.slice(eqIdx + 1).trim();
        // Strip surrounding quotes
        if ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }
        if (key && (process.env[key] === undefined || process.env[key] === "")) {
          process.env[key] = value;
        }
      }
      break; // Only load the first existing .env file
    } catch {
      // File doesn't exist — silently continue
    }
  }
}

loadDotEnv();

const app = express();
app.use(express.json({ limit: "10mb" }));

const PORT = process.env.PROXY_PORT || 6447;
const HOST = process.env.PROXY_HOST || "0.0.0.0";
const PROXY_VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(new URL("./package.json", import.meta.url), "utf8")).version || "0.0.0";
  } catch {
    return "0.0.0";
  }
})();
const RUNTIME = globalThis.Bun ? "bun" : "node";

// Parse a positive/zero integer env var without letting an empty or malformed
// value turn into NaN (which silently disables caps or rotation).
function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

// ── Log levels ─────────────────────────────────────────────────────
// LOG_LEVEL=debug|info|warn|error|silent (default info). Runtime request
// chatter is info; degradation/abort notices are warn; upstream HTTP and
// socket failures are error. Boot banner always prints.
// Example: LOG_LEVEL=warn node server.mjs  → requests hidden, problems shown.
const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3, silent: 4 };
const LOG_LEVEL = LOG_LEVELS[String(process.env.LOG_LEVEL || "info").toLowerCase()] ?? 1;
function log(level, ...args) {
  if ((LOG_LEVELS[level] ?? 1) >= LOG_LEVEL) console.log(...args);
}
process.on("unhandledRejection", (e) => {
  log("error", "[UNHANDLED REJECTION]", e?.stack || e);
});

// ── API Keys ───────────────────────────────────────────────────────
const keysFile = process.env.KEYS_FILE || "./api-keys.json";
let apiKeys = {};

// Only "name": "non-empty token" pairs are accepted. Anything else is dropped
// rather than coerced: an empty value would make safeEqual("", "") match an
// unauthenticated request (no header → ""), silently disabling auth, and a
// top-level array/string turns Object.entries into index→char pairs so a
// single character authenticates. Malformed entries are reported, not
// silently ignored, so the operator can see the mistake.
function normalizeKeys(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out = {};
  for (const [name, key] of Object.entries(raw)) {
    if (typeof key === "string" && key.length > 0) out[name] = key;
    else log("warn", `[KEYS] Dropping "${name}": value must be a non-empty string`);
  }
  return out;
}

function loadKeys() {
  let parsed = null;
  try { parsed = JSON.parse(fs.readFileSync(keysFile, "utf8")); } catch {}
  if (!parsed) {
    // Missing file = first run (generate). Unreadable/invalid JSON is NOT
    // silently replaced, or a typo in an edited keys file would rotate every
    // key and lock out all clients without a word.
    if (fs.existsSync(keysFile)) {
      console.error(`[KEYS] ${keysFile} exists but is not valid JSON - refusing to overwrite it.`);
      console.error("[KEYS] Fix the file, or delete it to regenerate new keys.");
      process.exit(1);
    }
  }
  const normalized = parsed ? normalizeKeys(parsed) : null;
  if (!normalized || Object.keys(normalized).length === 0) {
    if (parsed) log("warn", `[KEYS] ${keysFile} has no usable key - regenerating`);
    apiKeys = {
      admin: "fp-" + crypto.randomBytes(20).toString("hex"),
      "user-default": "fp-" + crypto.randomBytes(20).toString("hex"),
    };
    fs.writeFileSync(keysFile, JSON.stringify(apiKeys, null, 2));
    console.log("[INIT] Generated new API keys →", keysFile);
    return;
  }
  apiKeys = normalized;
}

function setApiKeys(keys) {
  apiKeys = normalizeKeys(keys) || {};
}

// P2.3: constant-time comparison (length check first to avoid throw).
function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function auth(req) {
  const hdr = req.headers.authorization || req.headers["x-api-key"] || "";
  const tok = hdr.startsWith("Bearer ") ? hdr.slice(7) : hdr;
  for (const [name, key] of Object.entries(apiKeys)) {
    if (safeEqual(tok, key)) return name;
  }
  return null;
}

// Keys print in full by default (the banner targets the operator's own
// terminal); set MASK_KEYS=1 when stdout is redirected into a persistent log
// you don't want holding credentials.
const MASK_KEYS = /^(1|true)$/i.test(String(process.env.MASK_KEYS || "").trim());
function maskKey(key) {
  const s = String(key);
  return s.length > 12 ? `${s.slice(0, 7)}…${s.slice(-4)}` : "…";
}

// ── Helpers ────────────────────────────────────────────────────────
function fpId(prefix) {
  const ts = Date.now().toString(16);
  const rnd = crypto.randomBytes(12).toString("base64url").slice(0, 16);
  return `${prefix}_${ts}${rnd}`;
}

// ── free-pi upstream configuration ─────────────────────────────────
// Base URL: default https://api.freepi.ai, overridable via FREEPI_BASE_URL
const FREEPI_BASE_URL = process.env.FREEPI_BASE_URL || "https://api.freepi.ai";
function freepiUrl(pathname) {
  const base = FREEPI_BASE_URL.endsWith("/") ? FREEPI_BASE_URL : `${FREEPI_BASE_URL}/`;
  return new URL(String(pathname).replace(/^\//, ""), base).toString();
}

// Client version header (server enforces minCliVersion gate)
// Priority: CLI param --client-version > env FREEPI_CLIENT_VERSION (from .env) > default 0.4.10
let FREEPI_CLIENT_VERSION = "0.4.10";

function parseClientVersionArg(argv) {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--client-version" || a === "-cv") {
      const v = argv[i + 1];
      if (v && !v.startsWith("--")) return v.trim();
    } else if (a.startsWith("--client-version=")) {
      return a.slice("--client-version=".length).trim();
    } else if (a.startsWith("-cv=")) {
      return a.slice("-cv=".length).trim();
    }
  }
  return null;
}

function resolveClientVersion(argv) {
  // 1. CLI parameter
  const fromArg = parseClientVersionArg(argv);
  if (fromArg) return fromArg;

  // 2. Environment variable (loaded from .env at startup)
  if (process.env.FREEPI_CLIENT_VERSION && process.env.FREEPI_CLIENT_VERSION.trim()) {
    return process.env.FREEPI_CLIENT_VERSION.trim();
  }

  // 3. Default
  return "0.4.10";
}

// Session id in the upstream format: random uuid per conversation (reused)
function freepiSessionId() {
  return crypto.randomUUID();
}

// ── Gravity pixel (廣告追蹤，與 free-pi-cli 相同機制) ────────────────
// 初始化 Gravity pixel 建立 session，讓上游知道該帳號「已看廣告」，
// 避免 403 "Ads aren't showing for this account" 錯誤。
// 不顯示廣告卡片，只在背景建立 Gravity session。
const GRAVITY_PIXEL_ID = "6cd74804-0541-4d9b-899d-d7fceb465b6f";
let gravityPixelInstance = null;
let gravityContextGetter = null;

function userIdFromJwt(jwt) {
  try {
    const payload = JSON.parse(Buffer.from(jwt.split(".")[1] ?? "", "base64url").toString("utf8"));
    return typeof payload.sub === "string" ? payload.sub : undefined;
  } catch {
    return undefined;
  }
}

// 初始化 Gravity pixel（啟動時調用一次）
async function initGravityPixel(jwt) {
  try {
    const userId = userIdFromJwt(jwt);
    if (!userId) {
      log("warn", "[GRAVITY] Cannot extract userId from JWT, skipping pixel init");
      return;
    }
    const userHash = crypto.createHash("sha256").update(userId).digest("hex");
    const storageDir = path.join(homedir(), ".free-pi", "gravity");

    const pixel = gravityPixel({
      pixelId: GRAVITY_PIXEL_ID,
      appName: "free-pi",
      storageDir,
    });
    await pixel.start();
    gravityPixelInstance = pixel;

    gravityContextGetter = () => {
      const sessionId = pixel.getSessionId();
      if (!sessionId) return undefined;
      return gravityContext({
        sessionId,
        user: {
          userId: userHash,
          gruid: pixel.getVisitorId(),
          grclid: pixel.getClickId(),
          graid: pixel.getGraid(),
        },
      });
    };

    log("info", "[GRAVITY] Pixel initialized — session established with Gravity ad network");
  } catch (e) {
    log("warn", "[GRAVITY] Pixel init failed (non-fatal):", e?.message || e);
  }
}

// 取得 gravity context（供 freepiHeaders 使用）
function getGravityContextHeader() {
  if (!gravityContextGetter) return undefined;
  try {
    const ctx = gravityContextGetter();
    if (!ctx) return undefined;
    return Buffer.from(JSON.stringify(ctx)).toString("base64url");
  } catch {
    return undefined;
  }
}

// ── Gravity 廣告展示（完全自動化，免執行 npx free-pi-cli@latest）────────
// 實作 free-pi-cli src/vendor/pi-ads/ 的三個步驟：
//   1. GET /ads/next?slot=banner  → 取得廣告（含 imp_url, ad_id, click_token）
//   2. GET ad.imp_url            → 發送 Gravity 展示像素（fire-and-forget）
//   3. POST /ads/impression       → 上報廣告已展示（ad_id, click_token, imp_fired:true）
//
// 上游伺服器檢查「廣告展示記錄」而不只是「有 gravity session」，
// 所以必須實作完整的展示流程，才能完全免執行 npx free-pi-cli@latest。

let currentAd = null; // 當前廣告資訊 { ad_id, click_token, imp_url, creative, click_url }

// 廣告間隔：每 10 分鐘刷新一次（與 free-pi-cli banner 刷新頻率一致）
const AD_REFRESH_MS = envInt("AD_REFRESH_MS", 600000);

// ── 廣告請求 headers（與 freepiHeaders 類似，但針對 /ads/* 端點）──
function adHeaders() {
  const headers = {
    "Authorization": `Bearer ${freepiJwt}`,
    "Content-Type": "application/json",
  };
  const gravityCtx = getGravityContextHeader();
  if (gravityCtx) {
    headers["x-gravity-context"] = gravityCtx;
  }
  return headers;
}

// ── 1. GET /ads/next?slot=banner ────────────────────────────────────
async function fetchAdNext() {
  if (!freepiJwt) return null;
  try {
    const res = await fetch(freepiUrl(`/ads/next?slot=banner`), {
      method: "GET",
      headers: adHeaders(),
      signal: AbortSignal.timeout(5000),
    });
    if (res.status === 204 || !res.ok) return null;
    const ad = await res.json();
    if (!ad || !ad.ad_id) return null;
    currentAd = {
      ad_id: ad.ad_id,
      click_token: ad.click_token,
      imp_url: ad.imp_url,
      creative: ad.creative,
      click_url: ad.click_url,
      source: ad.source,
      fetched_at: Date.now(),
    };
    log("info", `[AD] Fetched ad: ${ad.ad_id} (source: ${ad.source || "unknown"})`);
    return currentAd;
  } catch (e) {
    log("warn", `[AD] fetchAdNext failed: ${e?.message || e}`);
    return null;
  }
}

// ── 2. GET ad.imp_url（Gravity 展示像素，fire-and-forget）──────────
async function fireGravityImpression(ad) {
  if (!ad || !ad.imp_url) return false;
  try {
    const u = new URL(ad.imp_url);
    if (u.protocol !== "https:" || !/(^|\.)trygravity\.(ai|com)$/.test(u.hostname)) return false;
    // fire-and-forget：不 await，失敗吞掉
    void fetch(ad.imp_url, { method: "GET", signal: AbortSignal.timeout(3000) }).catch(() => {});
    return true;
  } catch {
    return false;
  }
}

// ── 3. POST /ads/impression ──
async function postImpression(ad) {
  if (!ad || !ad.ad_id || !ad.click_token) return false;
  try {
    const res = await fetch(freepiUrl("/ads/impression"), {
      method: "POST",
      headers: adHeaders(),
      body: JSON.stringify({
        ad_id: ad.ad_id,
        click_token: ad.click_token,
        imp_fired: true,
      }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      log("warn", `[AD] postImpression HTTP ${res.status}`);
      return false;
    }
    log("info", `[AD] Impression posted: ad_id=${ad.ad_id}`);
    return true;
  } catch (e) {
    log("warn", `[AD] postImpression failed: ${e?.message || e}`);
    return false;
  }
}

// ── 完整廣告展示流程（1. 獲取 2. 顯示像素 3. 上報）──────────────────
async function showAd() {
  if (!freepiJwt) return;
  const ad = await fetchAdNext();
  if (!ad) return;
  // 並行發送展示像素與上報（兩者都是 fire-and-forget 性質）
  await Promise.all([fireGravityImpression(ad), postImpression(ad)]);
}

// 背景定時刷新廣告
setInterval(async () => {
  if (freepiJwt) await showAd();
}, AD_REFRESH_MS).unref?.();

// 初始化廣告（在 JWT 載入後調用）
async function initAds() {
  if (!freepiJwt || process.env.GRAVITY_DISABLE_PIXEL === "1") return;
  await showAd();
}

// ── Load free-pi JWT ───────────────────────────────────────────────
// Priority: FREEPI_JWT env var > credentials file (~/.free-pi/agent/credentials.json)
let freepiJwt = null;
let freepiJwtSource = "none";

function getFreePiCredentialsPath() {
  // From C:\work\free-pi-cli\src\paths.ts
  // const FREE_PI_DIR_NAME = ".free-pi";
  // getFreePiAgentDir() = join(homedir(), ".free-pi", "agent")
  // getCredentialsPath() = join(agentDir, "credentials.json")
  return path.join(homedir(), ".free-pi", "agent", "credentials.json");
}

// 驗證 JWT 是否有效（GET /me）
async function verifyFreepiJwt(jwt) {
  try {
    const res = await fetch(freepiUrl("/me"), {
      method: "GET",
      headers: { "Authorization": `Bearer ${jwt}` },
    });
    if (res.status === 401) return false;
    if (!res.ok) return true; // 其他錯誤（如網路問題）不視為 JWT 無效
    return true;
  } catch {
    return true; // 網路錯誤不視為 JWT 無效
  }
}

// 將 JWT 寫入 credentials.json 與 .env
function saveFreepiJwt(jwt) {
  // 寫入 credentials.json
  const credPath = getFreePiCredentialsPath();
  try {
    fs.mkdirSync(path.dirname(credPath), { recursive: true });
    fs.writeFileSync(credPath, JSON.stringify({ token: jwt }), { mode: 0o600 });
    try { fs.chmodSync(credPath, 0o600); } catch {}
    log("info", `[AUTH] JWT 已寫入 ${credPath}`);
  } catch (e) {
    log("warn", `[AUTH] 無法寫入 ${credPath}：${e.message}`);
  }
  // 寫入 .env
  writeJwtToEnvFile(jwt);
}

async function loadFreepiJwt() {
  // 1. Try env var first
  if (process.env.FREEPI_JWT && process.env.FREEPI_JWT.trim()) {
    freepiJwt = process.env.FREEPI_JWT.trim();
    freepiJwtSource = "env";
    log("info", "[AUTH] Using JWT from FREEPI_JWT environment variable");
    const valid = await verifyFreepiJwt(freepiJwt);
    if (!valid) {
      log("warn", "[AUTH] FREEPI_JWT 無效，將嘗試重新登入");
      freepiJwt = null;
    } else {
      await initGravityPixel(freepiJwt);
      await initAds();
      await releaseSessionAtStartup();
      return;
    }
  }

  // 2. Try credentials file
  const credPath = getFreePiCredentialsPath();
  try {
    const raw = await fs.promises.readFile(credPath, "utf8");
    const parsed = JSON.parse(raw);
    if (typeof parsed.token === "string" && parsed.token.length > 0) {
      freepiJwt = parsed.token;
      freepiJwtSource = "file";
      log("info", `[AUTH] Loaded JWT from ${credPath}`);
      const valid = await verifyFreepiJwt(freepiJwt);
      if (!valid) {
        log("warn", `[AUTH] 儲存的 JWT 無效，將嘗試重新登入`);
        freepiJwt = null;
      } else {
        await initGravityPixel(freepiJwt);
        await initAds();
        await releaseSessionAtStartup();
        return;
      }
    }
  } catch (e) {
    // File doesn't exist or invalid JSON
  }

  // 3. 可選：proxy 自行走 GitHub device flow 取得 JWT（等同 login.mjs）
  //    FREEPI_AUTO_LOGIN=1 開啟；需要互動式 TTY 才能顯示同意條款並等待授權。
  if (ENV_AUTO_LOGIN) {
    if (!process.stdin.isTTY) {
      console.error("[AUTH] FREEPI_AUTO_LOGIN=1 需要互動式終端機（stdin 非 TTY）。");
      console.error("[AUTH] 請先於終端機執行 `bun login.mjs`，或改用 FREEPI_JWT 環境變數。");
    } else {
      try {
        log("info", "[AUTH] 找不到 JWT，開始 GitHub device flow 登入…");
        freepiJwt = await deviceFlowLogin();
        freepiJwtSource = "device-flow";
        log("info", "[AUTH] GitHub 登入成功，JWT 已寫入 " + getFreePiCredentialsPath() + " 與 .env");
        await initGravityPixel(freepiJwt);
        await initAds();
        await releaseSessionAtStartup();
        return;
      } catch (e) {
        console.error("[AUTH] device flow 登入失敗：" + (e?.message || e));
      }
    }
  }

  // 4. Not found - fail with clear guidance
  console.error("[FATAL] free-pi JWT not found. Provide one of:");
  console.error("  1. Set FREEPI_JWT environment variable (export FREEPI_JWT=...)");
  console.error("  2. Run this project's own login:  bun login.mjs");
  console.error("     (同一個 GitHub device flow，免安裝 free-pi-cli)");
  console.error("  3. Or start with FREEPI_AUTO_LOGIN=1 to log in from this process");
  console.error("     (JWT will be saved to both credentials.json and .env)");
  console.error("  4. Or run `npx free-pi-cli@latest` once to log in via GitHub device flow");
  console.error("     (this creates ~/.free-pi/agent/credentials.json)");
  process.exit(1);
}

// ── Device-flow login（移植自 free-pi-cli src/auth-flow.ts / run.ts）────
// 讓 proxy 本身就能取得 JWT，無須安裝 free-pi-cli，也無須執行 npx。
const ENV_AUTO_LOGIN = /^(1|true|yes)$/i.test(String(process.env.FREEPI_AUTO_LOGIN || "").trim());
const ENV_WRITE_JWT_TO_ENV = /^(1|true|yes)$/i.test(String(process.env.FREEPI_WRITE_JWT_TO_ENV || "1").trim());
const CONSENT_VERSION = process.env.FREEPI_CONSENT_VERSION || "4";
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
const ENV_FILE_PATH = path.resolve(".env");

// 將 JWT 寫入 .env 檔案（若 FREEPI_JWT 尚未在 .env 中設定）
function writeJwtToEnvFile(token) {
  if (!ENV_WRITE_JWT_TO_ENV) return;
  try {
    let envContent = "";
    try {
      envContent = fs.readFileSync(ENV_FILE_PATH, "utf8");
    } catch {
      // 檔案不存在，從頭建立
    }
    const lines = envContent.split(/\r?\n/);
    const jwtLine = `FREEPI_JWT=${token}`;
    let replaced = false;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith("FREEPI_JWT=")) {
        lines[i] = jwtLine;
        replaced = true;
        break;
      }
    }
    if (!replaced) {
      if (lines.length > 0 && lines[lines.length - 1].trim() !== "") {
        lines.push("");
      }
      lines.push(jwtLine);
    }
    fs.writeFileSync(ENV_FILE_PATH, lines.join("\n") + "\n");
    log("info", `[AUTH] JWT 已自動寫入 ${ENV_FILE_PATH}`);
  } catch (e) {
    log("warn", `[AUTH] 無法寫入 .env 檔案：${e.message}`);
  }
}

// 同意條款全文（與 free-pi-cli src/consent.ts 一致；版本 4）
const CONSENT_TEXT = `free-pi — before you start

  * Inference is free. Ads pay for it, and so does training.
  * Ad cards render in the terminal UI. Some ads come from a third-party ad
    provider (Gravity), which receives excerpts of your recent conversation
    to pick a relevant ad.
  * Gravity also keeps a session and visitor ID on your machine (in
    ~/.free-pi) and receives usage events from free-pi to measure and
    attribute ads.
  * Your coding sessions (prompts, code, files, and model responses) are saved
    as traces and used to train models. We may share or sell that data to
    third parties. Once you accept, there is no opt-out, except where the law
    gives you one.
  * We do our best to remove personal information from traces before we store
    them. We cannot promise it is perfectly clean.
  * free-pi is in alpha and testing. There are no warranties or guarantees,
    expressed or implied, and no guarantee of uptime.
  * If GitHub email capture is enabled, we collect your GitHub email and may
    use it to contact you about the service or product.
  * free-pi-cli auto-updates itself when a new version is available. Disable
    with FREEPI_NO_AUTO_UPDATE or {"autoUpdate":false} in ~/.free-pi/config.json.

By accepting you agree to the Terms of Service (https://freepi.ai/terms)
and the Privacy Policy (https://freepi.ai/privacy).

Decline and nothing is sent to the free-pi server.`;

async function authPostJson(pathname, body, attempts = 4) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fetch(freepiUrl(pathname), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (e) {
      lastErr = e;
      if (i >= attempts) break;
      log("warn", `[AUTH] 網路失敗，${1500 * i}ms 後重試（${i}/${attempts}）`);
      await sleepMs(1500 * i);
    }
  }
  throw new Error(`網路不可達（${attempts} 次）：${lastErr?.message || lastErr}`);
}

function askConsentTty() {
  return new Promise((resolve) => {
    console.log("");
    console.log(CONSENT_TEXT);
    console.log("");
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question("Accept? [y/N] ", (answer) => {
      rl.close();
      resolve(/^\s*y(es)?\s*$/i.test(answer));
    });
  });
}

function openBrowserBestEffort(url) {
  if (process.env.FREEPI_NO_BROWSER === "1") return;
  const cmd = process.platform === "win32"
    ? `start "" "${url}"`
    : process.platform === "darwin" ? `open "${url}"` : `xdg-open "${url}"`;
  // 開瀏覽器只是便利功能：沙箱/無 GUI 環境下 spawn 可能失敗，不可影響登入。
  try {
    exec(cmd, () => {});
  } catch {}
}

// 完整 device flow：device code → 同意 → 輪詢 token → 驗證 → 寫入檔案
async function deviceFlowLogin() {
  // 1. 取得 device code
  const startRes = await authPostJson("/auth/github/device", {});
  if (!startRes.ok) throw new Error(`device flow 啟動失敗：HTTP ${startRes.status}`);
  const device = await startRes.json();
  if (!device?.session_id || !device?.user_code) throw new Error("device flow 回應格式不正確");

  console.log("");
  console.log(`  授權網址：${device.verification_uri}`);
  console.log(`  驗證碼：  ${device.user_code}`);
  console.log("");
  openBrowserBestEffort(device.verification_uri);

  // 2. 同意（非互動 TTY 無法同意；FREEPI_NO_AUTO_CONSENT=1 可拒絕）
  let accepted;
  if (process.stdin.isTTY) {
    accepted = await askConsentTty();
  } else if (process.env.FREEPI_NO_AUTO_CONSENT === "1") {
    accepted = false;
  } else {
    log("warn", "[AUTH] stdin 非 TTY，直接以程式化同意提交（consent_version=" + CONSENT_VERSION + "）");
    accepted = true;
  }
  if (!accepted) throw new Error("使用者拒絕同意條款");

  const consentRes = await authPostJson("/auth/consent", {
    session_id: device.session_id,
    consent_version: CONSENT_VERSION,
  });
  if (!consentRes.ok) throw new Error(`同意提交失敗：HTTP ${consentRes.status}`);

  console.log("  同意已提交，等待 GitHub 授權完成…");

  // 3. 輪詢 token
  const intervalSec = Number.isFinite(device.interval) ? device.interval : 5;
  let netFails = 0;
  let token = null;
  for (;;) {
    let res;
    try {
      res = await authPostJson("/auth/token", { session_id: device.session_id }, 1);
      netFails = 0;
    } catch (e) {
      if (++netFails >= 6) throw new Error(`token 輪詢網路持續失敗：${e.message}`);
      await sleepMs(Math.max(intervalSec, 5) * 1000);
      continue;
    }
    if (res.status === 403) {
      const body = await res.json().catch(() => undefined);
      if (body?.code === "consent_required") throw new Error("consent_required：伺服端未記錄同意");
      throw new Error("token 輪詢失敗：HTTP 403");
    }
    if (!res.ok) throw new Error(`token 輪詢失敗：HTTP ${res.status}`);
    const parsed = await res.json();
    if (parsed?.token) { token = parsed.token; break; }
    if (parsed?.code === "consent_required") throw new Error("consent_required：伺服端未記錄同意");
    const retryAfter = typeof parsed?.retry_after === "number" ? parsed.retry_after : 0;
    process.stdout.write(".");
    await sleepMs(Math.max(intervalSec, retryAfter) * 1000);
  }
  if (!token) throw new Error("未取得 token");
  process.stdout.write("\n");

  // 4. 寫入 credentials.json（0600）
  const credPath = getFreePiCredentialsPath();
  fs.mkdirSync(path.dirname(credPath), { recursive: true });
  fs.writeFileSync(credPath, JSON.stringify({ token }), { mode: 0o600 });
  try { fs.chmodSync(credPath, 0o600); } catch {}

  // 5. 也寫入 .env 檔案（讓下次啟動可直接從 .env 讀取 JWT）
  writeJwtToEnvFile(token);

  return token;
}

// ── Upstream headers ───────────────────────────────────────────────
function freepiHeaders(sessionId, body, model) {
  const headers = {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
    "Authorization": `Bearer ${freepiJwt}`,
    "x-session-id": sessionId,
    "x-client-version": FREEPI_CLIENT_VERSION,
  };
  const gravityCtx = getGravityContextHeader();
  if (gravityCtx) {
    headers["x-gravity-context"] = gravityCtx;
    log("debug", `[GRAVITY] Request with ad context (session established)`);
  } else {
    log("debug", `[GRAVITY] Request without ad context (pixel session may have expired)`);
  }
  return headers;
}

// ── Session 重置（釋放過期 session，避免 409 錯誤）────────────────────
// 調用 POST {baseUrl}/session/reset 釋放殘留的 CLI session lease。
// free-pi.ai 限制每個帳號最多 4 個並行 session，超過會回 409。
// 本函數在啟動時及遇到 409 錯誤時自動調用，避免手動執行 /close-other-session。
async function releaseSession() {
  if (!freepiJwt) return false;
  try {
    const res = await fetch(freepiUrl("/session/reset"), {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${freepiJwt}`,
        "Content-Type": "application/json",
      },
    });
    if (!res.ok) {
      log("warn", `[SESSION RESET] HTTP ${res.status} — could not release session`);
      return false;
    }
    const parsed = await res.json().catch(() => ({}));
    const released = parsed.released === true;
    if (released) {
      log("info", "[SESSION RESET] Cleared stuck session — slot freed");
    } else {
      log("info", "[SESSION RESET] No other session was running");
    }
    return true;
  } catch (e) {
    log("warn", `[SESSION RESET] Failed: ${e?.message || e}`);
    return false;
  }
}

// 啟動時嘗試釋放殘留 session（在 JWT 載入後調用）
async function releaseSessionAtStartup() {
  if (!freepiJwt) return;
  await releaseSession();
}

// ── Upstream transport (native fetch) ──────────────────────────────
const FREEPI_IDLE_TIMEOUT_MS = 120000; // max silence for headers and between body chunks

// One upstream request → web Response (res.status / res.body).
// Timeout semantics: no total-duration limit on the body — only a header deadline
// plus an inter-chunk idle deadline, so long answers are never cut off mid-stream.
async function freepiFetchRaw(opts, body, controller) {
  const url = freepiUrl(opts.path);
  const headerTimer = setTimeout(
    () => abortUpstream(controller, "upstream headers timeout"),
    opts.timeout || FREEPI_IDLE_TIMEOUT_MS,
  );
  try {
    return await fetch(url, {
      method: opts.method || "POST",
      headers: opts.headers,
      body: body === undefined || opts.method === "GET" ? undefined : body,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(headerTimer);
  }
}

function abortUpstream(controller, why) {
  if (!controller.signal.aborted) controller.abort(new Error(why));
}

// ── 429 retry (empirically-derived) ──
// free-pi.ai may return 429 for rate limits. Retry with backoff up to 4 times,
// but if Retry-After is very long (>5 minutes = daily quota exhausted), fail fast.
const RETRY_429_MAX = envInt("RETRY_429_MAX", 4);
const RETRY_429_BASE_MS = envInt("RETRY_429_BASE_MS", 2000);
const RETRY_429_CAP_MS = envInt("RETRY_429_CAP_MS", 30000);
const RETRY_429_HARD_LIMIT_MS = envInt("RETRY_429_HARD_LIMIT_MS", 300000); // 5 minutes
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function retryDelay(attempt, retryAfterMs) {
  if (Number.isFinite(retryAfterMs) && retryAfterMs > 0) return Math.min(retryAfterMs, RETRY_429_CAP_MS);
  const base = Math.min(RETRY_429_BASE_MS * 2 ** attempt, RETRY_429_CAP_MS);
  const jittered = base * (0.75 + Math.random() * 0.5);
  return Math.round(Math.min(jittered, RETRY_429_CAP_MS));
}

function isHardQuotaWait(retryAfterMs) {
  return Number.isFinite(retryAfterMs) && retryAfterMs > RETRY_429_HARD_LIMIT_MS;
}

function parseRetryAfterMs(headers) {
  const rawMs = headers?.get?.("retry-after-ms");
  if (rawMs !== null && rawMs !== undefined && String(rawMs).trim() !== "") {
    const ms = Number(rawMs);
    if (Number.isFinite(ms) && ms >= 0) return ms;
  }
  const v = headers?.get?.("retry-after");
  if (!v) return undefined;
  const sec = Number(v);
  if (Number.isFinite(sec)) return sec * 1000;
  const date = Date.parse(v);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

function isRetryableLimit(status, raw) {
  if (status !== 429) return false;
  const p = parseUpstreamError(raw);
  // 402-style caps arrive as 429 with credit/budget codes — never retry those.
  if (/^(creditlimitexceeded|insufficient_quota|billing_error|budgetlimiterror|gousagelimiterror)$/.test(p.code)) {
    return false;
  }
  return true;
}

let freepiFetchImpl = freepiFetchRaw; // test seam: injectable upstream fetch
function setFreepiFetchImpl(fn) {
  freepiFetchImpl = fn;
}

async function freepiFetchWithRetry(opts, body, controller) {
  let lastRes = null;
  let sessionResetTried = false;
  for (let attempt = 0; ; attempt++) {
    const res = await freepiFetchImpl(opts, body, controller);
    lastRes = res;
    // 409 Too Many Sessions → 釋放殘留 session 並重試一次
    if (res.status === 409 && !sessionResetTried) {
      sessionResetTried = true;
      log("warn", `[FREEPI 409 ${opts._tag || "??"}] session limit reached — releasing stale session`);
      await releaseSession();
      // 重新獲取 JWT（可能已失效）並重試
      if (freepiJwt) {
        await sleep(1000);
        continue;
      }
      return res;
    }
    if (res.status !== 429 || attempt >= RETRY_429_MAX) {
      return res;
    }
    let raw = "";
    try {
      raw = await res.clone().text();
    } catch {
      return res;
    }
    if (!isRetryableLimit(res.status, raw)) return res;
    const retryAfterMs = parseRetryAfterMs(res.headers);
    if (isHardQuotaWait(retryAfterMs)) {
      const mins = Math.round(retryAfterMs / 60000);
      log("error", `[FREEPI 429 DAILY QUOTA] free quota exhausted; resets in ~${mins} min — not retrying`);
      return res;
    }
    const wait = retryDelay(attempt, retryAfterMs);
    log("warn", `[FREEPI 429 RETRY ${attempt + 1}/${RETRY_429_MAX}] upstream rate limit, waiting ${wait}ms`);
    try { await res.arrayBuffer(); } catch {}
    await sleep(wait);
    if (controller.signal.aborted) return res;
  }
}

function bindClientAbort(controller, clientSignal) {
  if (!clientSignal) return;
  const onAbort = () => abortUpstream(controller, "client disconnected");
  if (clientSignal.aborted) onAbort();
  else clientSignal.addEventListener("abort", onAbort, { once: true });
}

function isClientDisconnect(controller) {
  if (!controller?.signal?.aborted) return false;
  const reason = controller.signal.reason;
  return /client disconnected/i.test(String(reason?.message || reason || ""));
}

function clientAbortSignal(req, res) {
  const controller = new AbortController();
  const abort = () => abortUpstream(controller, "client disconnected");
  req.once("aborted", abort);
  res.once("close", () => {
    if (!res.writableEnded) abort();
  });
  return controller.signal;
}

// Read the whole upstream body (error pages / sync aggregation).
async function collectFreepiBody(zenRes, controller, onChunk) {
  const chunks = [];
  let idle = setTimeout(() => abortUpstream(controller, "upstream idle timeout"), FREEPI_IDLE_TIMEOUT_MS);
  try {
    for await (const c of zenRes.body) {
      clearTimeout(idle);
      idle = setTimeout(() => abortUpstream(controller, "upstream idle timeout"), FREEPI_IDLE_TIMEOUT_MS);
      if (onChunk) onChunk(c);
      chunks.push(c);
    }
    clearTimeout(idle);
  } catch (e) {
    clearTimeout(idle);
    throw e;
  }
  return Buffer.concat(chunks).toString();
}

// Feed an SSE stream chunk-by-chunk with the same idle deadline.
async function pumpFreepiStream(zenRes, controller, onData) {
  let idle = setTimeout(() => abortUpstream(controller, "upstream idle timeout"), FREEPI_IDLE_TIMEOUT_MS);
  try {
    for await (const chunk of zenRes.body) {
      clearTimeout(idle);
      idle = setTimeout(() => abortUpstream(controller, "upstream idle timeout"), FREEPI_IDLE_TIMEOUT_MS);
      onData(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
    }
    // Some upstreams close the stream with the final SSE frame NOT terminated
    // by a newline. Every consumer below is line-oriented, so feed one
    // trailing newline to flush that last frame.
    onData(Buffer.from("\n"));
    clearTimeout(idle);
  } catch (e) {
    clearTimeout(idle);
    throw e;
  }
}

// Unified upstream failure log + client error.
function reportFreepiFailure(e, controller, res, tag, t0, rxBytes, shape, selfStopped) {
  if (res.writableEnded || res.destroyed || selfStopped || isClientDisconnect(controller)) return;
  const reasonMsg = String(controller.signal?.reason?.message || "");
  const timedOut = controller.signal.aborted && /timeout/i.test(reasonMsg);
  const anthropic = shape === "anthropic";
  if (timedOut) {
    log("error", `[FREEPI TIMEOUT ${tag} +${Date.now() - t0}ms rx=${rxBytes}B]`, "上游 120 秒無回應（免費模型尖峰排隊常見，稍後重試）");
    if (!res.headersSent) {
      res.status(504).json(anthropic
        ? { type: "error", error: { type: "timeout_error", message: "Upstream timeout" } }
        : { error: { message: "Upstream timeout", type: "timeout_error" } });
    }
    return;
  }
  log("error", `[FREEPI ERROR ${tag} +${Date.now() - t0}ms rx=${rxBytes}B]`, netCause(e));
  if (!res.headersSent) {
    res.status(502).json(anthropic
      ? { type: "error", error: { type: "upstream_error", message: e.message } }
      : { error: { message: "Upstream error: " + e.message, type: "upstream_error" } });
  }
}

// Connection diagnostics: translate Node socket errors into an actionable cause.
function netCause(e) {
  const msg = (e && e.message) || String(e);
  if (/socket hang up/i.test(msg)) return `${msg}（上游掛斷連線：多為上游超載/限流斷流，稍後重試）`;
  const hint = {
    ECONNREFUSED: "連線被拒（上游服務 down 或位址/埠錯誤）",
    ENOTFOUND: "DNS 解析失敗（hostname 錯誤或本機斷網）",
    EAI_AGAIN: "DNS 暫時失敗（重試即可）",
    ETIMEDOUT: "連線逾時（上游無回應或網路壅塞）",
    ECONNRESET: "連線被上游重設（傳輸中途斷開）",
    EPIPE: "寫入已關閉的連線",
  }[e && e.code];
  return hint ? `${msg}（${hint}）` : msg;
}

// Upstream HTTP-error diagnostics.
function upstreamCause(status, msg) {
  const m = String(msg || "");
  if (status === 429 || /rate limit|quota/i.test(m)) return "免費額度限流，稍後重試或換模型";
  if (/temporarily overloaded|overloaded/i.test(m)) return "上游原廠過載（容量不足），稍後重試";
  if (/Endpoint is unavailable|unavailable/i.test(m)) return "上游端點暫時下線，換模型";
  if (status === 503) return "上游服務不可用，稍後重試或換模型";
  if (status === 502) return "上游閘道錯誤，重試即可";
  if (status === 500) return "上游內部錯誤，重試或換模型";
  if (status === 504) return "上游閘道逾時（模型回太慢），縮小 max_tokens 或重試";
  if (status === 400) return "請求被上游拒絕（參數/格式問題），檢查翻譯層";
  if (status === 401 || status === 403) return "上游認證失敗，檢查 JWT";
  if (status === 404) return "上游無此端點/模型，路由錯誤";
  return "";
}

function withCause(status, msg) {
  const text = String(msg ?? "").slice(0, 200);
  const cause = upstreamCause(status, msg);
  return cause ? `${text}（${cause}）` : text;
}

// ── Shared upstream error classification ───────────────────────────
const QUOTA_ERROR_CODES = new Set([
  "rate_limit_exceeded", "quota_exceeded", "insufficient_quota",
  "creditlimitexceeded", "billing_error", "budgetlimiterror",
]);

const AUTH_ERROR_CODES = new Set([
  "authentication_error", "permission_error", "permission_denied",
  "api_key_invalid", "invalid_token", "token_expired",
]);

function parseUpstreamError(raw) {
  let msg = "";
  let code = "";
  try {
    const p = JSON.parse(raw);
    msg = p?.error?.message || p?.message || "";
    code = String(p?.error?.type || p?.error?.code || p?.type || p?.code || "");
  } catch {}
  if (!msg) msg = String(raw || "").trim().slice(0, 300);
  return { msg: msg || "Upstream error", code: code.toLowerCase() };
}

function isQuotaError(status, raw, parsed) {
  const p = parsed || parseUpstreamError(raw);
  if (QUOTA_ERROR_CODES.has(p.code)) return true;
  if (/\brate limit\b|quota/i.test(p.msg)) return true;
  if (status === 402) return true;
  return false;
}

function upstreamErrorPayload(status, raw, headers) {
  const p = parseUpstreamError(raw);
  const quota = isQuotaError(status, raw, p);
  const limited = quota || status === 429 || /\brate limit\b|quota/i.test(p.msg);
  let type = "upstream_error";
  let outStatus = status >= 400 ? status : 502;

  if (quota) {
    type = "rate_limit_error";
    outStatus = 429;
  } else if (status === 401 || status === 403 || AUTH_ERROR_CODES.has(p.code)) {
    type = "authentication_error";
  } else if (status === 429) type = "rate_limit_error";
  else if (status === 404) type = "not_found_error";
  else if (status === 400) type = "invalid_request_error";

  const message = limited ? `${p.msg} (free model rate limit)` : p.msg;
  const error = {
    message,
    type,
    code: limited ? "rate_limit_exceeded" : "upstream_error",
  };

  // Retry-After is a SECONDS-valued header (RFC 7231). Only emit when upstream
  // supplied none — and then convert ms → seconds.
  const raMs = headers?.get?.("retry-after-ms");
  const raSec = headers?.get?.("retry-after");
  let retryAfter = "";
  if (!raSec && raMs !== null && raMs !== undefined && String(raMs).trim() !== "") {
    const ms = Number(raMs);
    if (Number.isFinite(ms) && ms >= 0) retryAfter = String(Math.ceil(ms / 1000));
  }
  return { status: outStatus, error, retryAfter };
}

function sendUpstreamError(res, status, raw, zenHeaders, shape = "openai") {
  const { status: outStatus, error, retryAfter } = upstreamErrorPayload(status, raw, zenHeaders);
  if (!res.headersSent) {
    if (retryAfter) res.setHeader("Retry-After", retryAfter);
  }
  if (res.headersSent) return;
  const body = shape === "anthropic"
    ? { type: "error", error: { type: error.type, message: error.message } }
    : { error };
  res.status(outStatus).json(body);
}

// ── Models (from /client-version) ──────────────────────────────────
let MODELS = [];
let MODEL_META = {};
let MODELS_ORIGIN = "unknown";
let MODELS_LOADED_AT = null;

// Built-in fallback (from free-pi-cli provider.ts MODEL_ID)
const DEFAULT_MODELS = [
  { id: "deepseek/deepseek-v4-flash", name: "DeepSeek V4 Flash", reasoning: false, toolCall: false, contextLimit: 1048576, outputLimit: 8192, releaseDate: "2026-09-10" },
];

function useDefaults(reason) {
  MODELS = [];
  MODEL_META = {};
  MODELS_ORIGIN = "fallback";
  MODELS_LOADED_AT = new Date().toISOString();
  for (const m of DEFAULT_MODELS) {
    MODELS.push(m.id);
    MODEL_META[m.id] = {
      name: m.name,
      status: "active",
      reasoning: !!m.reasoning,
      toolCall: !!m.toolCall,
      contextLimit: m.contextLimit || 0,
      outputLimit: m.outputLimit || 0,
      releaseDate: m.releaseDate || "-",
      free: true,
    };
  }
  log("info", `[MODELS] ${reason} - using ${MODELS.length} built-in default(s)`);
}

function applyClientVersion(data) {
  // data shape: { min, latest, model, models: [{id, name}, ...], notice, fusion }
  const entries = Array.isArray(data?.models) && data.models.length > 0
    ? data.models
    : data?.model ? [{ id: data.model, name: data.model }] : [];

  if (!entries.length) return false;

  MODELS = [];
  MODEL_META = {};
  for (const m of entries) {
    const id = m?.id;
    const name = m?.name || id;
    if (!id || typeof id !== "string") continue;
    MODELS.push(id);
    MODEL_META[id] = {
      name,
      status: "active",
      reasoning: false, // free-pi models currently don't advertise reasoning
      toolCall: false,
      contextLimit: 1048576,
      outputLimit: 8192,
      releaseDate: "-",
      free: true,
    };
  }

  log("info", `[MODELS] Loaded ${MODELS.length} model(s) from /client-version`);
  MODELS_ORIGIN = "live";
  MODELS_LOADED_AT = new Date().toISOString();
  return true;
}

async function loadModels() {
  const url = freepiUrl("/client-version");
  return new Promise((resolve) => {
    let settled = false;
    const finish = (reason) => {
      if (settled) return;
      settled = true;
      if (reason) useDefaults(reason);
      resolve();
    };

    // 10 second timeout
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    fetch(url, {
      method: "GET",
      headers: { "Accept": "application/json", "User-Agent": `free-pi-cli-proxy/${PROXY_VERSION}` },
      signal: controller.signal,
    })
      .then(async (res) => {
        clearTimeout(timeout);
        if (!res.ok) return finish(`HTTP ${res.status}`);
        try {
          const json = await res.json();
          if (!applyClientVersion(json)) {
            finish("No models in response");
          } else {
            finish(); // Success!
          }
        } catch (e) {
          finish("Failed to parse response: " + e.message);
        }
      })
      .catch((e) => {
        clearTimeout(timeout);
        finish(e.name === "AbortError" ? "Fetch timeout" : "Fetch error: " + e.message);
      });
  });
}

// Background refresh every 30 minutes
setInterval(async () => {
  try {
    await loadModels();
    log("info", `[MODELS] Background refresh: ${MODELS.length} model(s), source=${MODELS_ORIGIN}`);
  } catch (e) {
    log("warn", "[MODELS] Background refresh failed:", e.message);
  }
}, 30 * 60 * 1000).unref?.();

// ── Session mapping (reuse upstream session id per conversation) ───
// Same pattern as opencode-free-proxy: keyed by API key + optional x-session-id header
const SESSION_TTL_MS = envInt("SESSION_TTL_MS", 1800000); // 30 minutes
const SESSION_JITTER_MS = 15 * 60 * 1000;
const SESSION_MAX_ENTRIES = 4096;
const userSessions = {};

function conversationHeader(req) {
  const h = req?.headers || {};
  for (const key of ["x-session-id", "x-conversation-id"]) {
    const v = h[key];
    const s = Array.isArray(v) ? v[0] : v;
    if (typeof s === "string" && s.trim()) return s.trim().slice(0, 256);
  }
  return "";
}

function getSession(user, req) {
  const now = Date.now();
  const header = conversationHeader(req);
  const keyUser = header
    ? `${user}:${crypto.createHash("sha256").update(header).digest("hex")}`
    : `user:${user}`;
  const s = userSessions[keyUser];
  if (!s || SESSION_TTL_MS <= 0 || now - s.ts > s.ttl) {
    if (!s) {
      // Evict expired entries first, then (if still at cap) the oldest ones.
      const keys = Object.keys(userSessions);
      if (keys.length >= SESSION_MAX_ENTRIES) {
        const expired = keys.filter((k) => now - userSessions[k].ts > (userSessions[k].ttl || SESSION_TTL_MS));
        const pool = expired.length ? expired : keys;
        pool.sort((a, b) => userSessions[a].ts - userSessions[b].ts);
        for (const k of pool.slice(0, Math.max(1, keys.length - SESSION_MAX_ENTRIES + 1))) delete userSessions[k];
      }
    }
    const ttl = SESSION_TTL_MS + Math.floor(Math.random() * (SESSION_JITTER_MS + 1));
    userSessions[keyUser] = { id: freepiSessionId(), ts: now, ttl };
  }
  return userSessions[keyUser].id;
}

// Sweep entries dead for >2× their TTL
setInterval(() => {
  const now = Date.now();
  for (const [user, s] of Object.entries(userSessions)) {
    if (now - s.ts > (s.ttl || SESSION_TTL_MS) * 2) delete userSessions[user];
  }
}, 10 * 60 * 1000).unref?.();

// ── Upstream request building ─────────────────────────────────────
function freepiRequest(model, messages, tools, sessionId, extra = {}) {
  // Pass through client parameters (whitelist)
  const FORWARDED_PARAMS = [
    "temperature", "top_p", "frequency_penalty", "presence_penalty",
    "max_tokens", "max_completion_tokens", "stop", "seed",
    "response_format", "tools", "tool_choice",
  ];

  const body = {
    model,
    messages,
    stream: true,
  };

  // Forward whitelisted params
  for (const key of FORWARDED_PARAMS) {
    if (extra[key] !== undefined && extra[key] !== null) {
      body[key] = extra[key];
    }
  }

  // Default max_tokens if not provided
  if (body.max_tokens === undefined && body.max_completion_tokens === undefined) {
    body.max_tokens = 8192;
  }

  const bodyStr = JSON.stringify(body);
  return {
    body: bodyStr,
    options: {
      path: "/v1/chat/completions",
      method: "POST",
      headers: freepiHeaders(sessionId, bodyStr, model),
      timeout: 120000,
    },
  };
}

// ── SSE → JSON aggregation (sync clients, stream:true upstream) ───
function reasoningText(delta) {
  if (!delta || typeof delta !== "object") return "";
  if (typeof delta.reasoning_content === "string") return delta.reasoning_content;
  if (typeof delta.reasoning === "string") return delta.reasoning;
  if (typeof delta.reasoning_text === "string") return delta.reasoning_text;
  return "";
}

// Accumulate an OpenAI chat SSE transcript into one chat.completion object.
function aggregateChatSSE(raw) {
  let id = "", created = 0, model = "", finish = null, usage = null;
  let content = "", reasoning = "";
  const toolCalls = new Map();
  let sawChoices = false;
  for (const line of String(raw || "").split("\n")) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    let p;
    try { p = JSON.parse(payload); } catch { continue; }
    if (p.id && !id) id = p.id;
    if (p.created && !created) created = p.created;
    if (p.model && !model) model = p.model;
    if (p.usage) usage = p.usage;
    if (!Array.isArray(p.choices) || !p.choices.length) continue; // usage/cost chunks
    sawChoices = true;
    for (const ch of p.choices) {
      if (!ch || typeof ch !== "object") continue;
      if (ch.finish_reason) finish = ch.finish_reason;
      const d = ch.delta || {};
      if (typeof d.content === "string") content += d.content;
      reasoning += reasoningText(d);
      if (!Array.isArray(d.tool_calls)) continue;
      for (const tc of d.tool_calls) {
        if (!tc || typeof tc !== "object") continue;
        const idx = Number.isInteger(tc.index) ? tc.index : toolCalls.size;
        if (!toolCalls.has(idx)) toolCalls.set(idx, { id: "", type: "", name: "", args: "" });
        const cur = toolCalls.get(idx);
        if (tc.id) cur.id = tc.id;
        if (tc.type) cur.type = tc.type;
        if (tc.function?.name) cur.name = tc.function.name;
        if (typeof tc.function?.arguments === "string") cur.args += tc.function.arguments;
      }
    }
  }
  if (!sawChoices) return null;
  const message = { role: "assistant", content };
  if (reasoning) message.reasoning_content = reasoning;
  if (toolCalls.size) {
    message.tool_calls = [...toolCalls.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, t]) => ({
        id: t.id || fpId("toolu"),
        type: t.type || "function",
        function: { name: t.name, arguments: t.args },
      }));
  }
  const out = {
    id: id || fpId("chatcmpl"),
    object: "chat.completion",
    created: created || Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: finish || (toolCalls.size ? "tool_calls" : "stop") }],
  };
  if (usage) out.usage = usage;
  return out;
}

// First error-shaped payload inside an SSE transcript (200-with-inline-error).
function sseErrorPayload(raw) {
  for (const line of String(raw || "").split("\n")) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    let p;
    try { p = JSON.parse(payload); } catch { continue; }
    if (p.error || p.type === "error") return p;
  }
  return null;
}

// Buffer → { json } (chat.completion / error object) | {} when unusable.
function coerceChatSyncBody(raw) {
  const t = String(raw || "").trim();
  if (!t) return {};
  if (t.startsWith("{")) {
    try { return { json: JSON.parse(raw) }; } catch { return {}; }
  }
  // An inline error frame can appear AFTER a few normal choice frames
  const err = sseErrorPayload(raw);
  if (err) return { json: err };
  const data = aggregateChatSSE(raw);
  if (data) return { json: data };
  return {};
}

// ── Pipe free-pi response to client (OpenAI format) ────────────────
async function pipeFreepiResponse(opts, body, stream, res, model, clientSignal) {
  const TAG = opts._tag || "??";
  const t0 = Date.now();
  let rxBytes = 0;
  const controller = new AbortController();
  bindClientAbort(controller, clientSignal);

  let zenRes;
  try {
    zenRes = await freepiFetchWithRetry(opts, body, controller);
  } catch (e) {
    reportFreepiFailure(e, controller, res, TAG, t0, rxBytes, "openai", false);
    return;
  }

  // Upstream non-200 → buffer full body, return mapped error with the real status
  if (zenRes.status !== 200) {
    let raw = "";
    try {
      raw = await collectFreepiBody(zenRes, controller);
    } catch (e) {
      reportFreepiFailure(e, controller, res, TAG, t0, rxBytes, "openai", false);
      return;
    }
    log("error", `[FREEPI UPSTREAM ${zenRes.status} ${TAG}]`, withCause(zenRes.status, parseUpstreamError(raw).msg));
    sendUpstreamError(res, zenRes.status, raw, zenRes.headers, "openai");
    return;
  }

  // Gravity 廣告偵測：上游回應中若有廣告相關 header，於 log 提示
  const gravityAdHeader = zenRes.headers.get("x-gravity-ad") || zenRes.headers.get("x-gravity-ads") || zenRes.headers.get("x-gravity");
  if (gravityAdHeader) {
    log("warn", `[GRAVITY AD] ${TAG} — ad received from upstream`);
  }

  // Sync client + stream:true upstream: buffer the whole SSE transcript
  if (!stream) {
    let raw = "";
    try {
      raw = await collectFreepiBody(zenRes, controller, (c) => { rxBytes += c.length; });
    } catch (e) {
      reportFreepiFailure(e, controller, res, TAG, t0, rxBytes, "openai", false);
      return;
    }
    const { json } = coerceChatSyncBody(raw);
    if (json && (json.error || json.type === "error")) {
      const { status, error } = upstreamErrorPayload(200, raw, zenRes.headers);
      log("error", `[FREEPI UPSTREAM ${status} ${TAG}]`, withCause(status, error.message));
      sendUpstreamError(res, 200, raw, zenRes.headers, "openai");
      return;
    }
    if (!json) {
      const frag = raw.slice(0, 200);
      log("error", `[FREEPI SYNC ${TAG} +${Date.now() - t0}ms rx=${rxBytes}B]`, withCause(502, frag || "Invalid upstream response"));
      if (!res.headersSent) {
        res.status(502).json({ error: { message: frag ? `Invalid upstream response: ${frag}` : "Invalid upstream response", type: "upstream_error" } });
      }
      return;
    }
    if (model) json.model = model;
    log("info", `[REQ DONE ${TAG} +${Date.now() - t0}ms rx=${rxBytes}B sync]`);
    res.json(json);
    return;
  }

  // ── stream: SSE passthrough (no tool renaming needed for free-pi) ──
  let headersSent = false;
  let lineBuf = "";
  let rawAccum = "";
  let firstChunkChecked = false;
  let reasoningTokens = 0;
  let contentStarted = false;
  let toolStarted = false;
  let stopped = false;
  let finishSeen = false;

  function writeSSE(payload) {
    if (res.writableEnded || res.destroyed) return;
    if (!headersSent) {
      headersSent = true;
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
        "Transfer-Encoding": "chunked",
      });
      res.flushHeaders();
    }
    res.write(payload === "[DONE]" ? "data: [DONE]\n\n" : `data: ${payload}\n\n`);
    if (res.flush) res.flush();
  }

  function stopForReasoningCap() {
    if (stopped) return;
    stopped = true;
    log("warn", `[FREEPI REASONING CAP] ${reasoningTokens} reasoning tokens, no content → force stop`);
    abortUpstream(controller, "reasoning cap force stop");
    if (headersSent && !res.writableEnded) {
      writeSSE(JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "length" }] }));
      writeSSE("[DONE]");
      res.end();
    } else if (!res.headersSent) {
      res.status(502).json({ error: { message: "Upstream reasoning timeout", type: "timeout_error" } });
    }
  }

  function synthesizeEnding() {
    if (res.writableEnded || res.destroyed) return;
    log("warn", `[FREEPI ABORT ${TAG} +${Date.now() - t0}ms rx=${rxBytes}B] upstream closed mid-stream — synthesized ending`);
    writeSSE(JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "length" }] }));
    writeSSE("[DONE]");
  }

  function onData(chunk) {
    rxBytes += chunk.length;
    const rawStr = chunk.toString();
    lineBuf += rawStr;
    rawAccum = rawAccum.length >= 16384 ? rawAccum.slice(-8192) + rawStr : rawAccum + rawStr;

    // First raw chunk may be an inline error JSON (200-with-error)
    if (!firstChunkChecked) {
      firstChunkChecked = true;
      const str = lineBuf.trim();
      if (str.startsWith("{") && (str.includes('"error"') || str.includes('"type":"error"') || str.includes('"type": "error"'))) {
        try {
          const parsed = JSON.parse(str);
          if (parsed.error || parsed.type === "error") {
            const { status, error } = upstreamErrorPayload(200, str, null);
            log("error", `[FREEPI INLINE ERROR ${status}]`, withCause(status, error.message));
            if (!res.headersSent) res.status(status).json({ error });
            abortUpstream(controller, "inline error, stop reading");
            stopped = true;
            return;
          }
        } catch {}
      }
    }
    if (stopped) return;

    const lines = lineBuf.split("\n");
    lineBuf = lines.pop() || "";
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      const payload = t.slice(5).trim();
      if (!payload) continue;

      // Reasoning sniffer
      if (payload === "[DONE]") {
        finishSeen = true;
      } else {
        let p;
        try { p = JSON.parse(payload); } catch { p = null; }
        if (p) {
          const ch0 = p.choices?.[0];
          if (ch0?.finish_reason) finishSeen = true;
          const delta = ch0?.delta || {};
          if (delta.content) contentStarted = true;
          if (Array.isArray(delta.tool_calls) && delta.tool_calls.length) toolStarted = true;
          const rt = reasoningText(delta);
          if (rt) reasoningTokens += Math.ceil(rt.length / 4);
        }
      }
      if (!contentStarted && !toolStarted && reasoningTokens > 65536) {
        stopForReasoningCap();
        return;
      }

      // Forward (passthrough - no rewriting needed for free-pi)
      writeSSE(payload);
    }
  }

  try {
    await pumpFreepiStream(zenRes, controller, onData);
    if (stopped || isClientDisconnect(controller)) return;
    if (!headersSent) {
      let inline = null;
      if (rawAccum.trim().startsWith("{")) {
        try { inline = JSON.parse(rawAccum.trim()); } catch {}
      }
      if (!inline) inline = sseErrorPayload(rawAccum);
      if (inline) {
        const { status, error } = upstreamErrorPayload(200, rawAccum, zenRes.headers);
        log("error", `[FREEPI UPSTREAM ${status} ${TAG}]`, withCause(status, error.message));
        sendUpstreamError(res, 200, rawAccum, zenRes.headers, "openai");
        return;
      }
      log("warn", "[FREEPI EMPTY] No response from upstream");
      if (!res.headersSent) {
        res.status(502).json({ error: { message: "Empty response from upstream", type: "upstream_error" } });
      }
      return;
    }
    if (!finishSeen && !res.writableEnded) synthesizeEnding();
    log("info", `[REQ DONE ${TAG} +${Date.now() - t0}ms rx=${rxBytes}B stream]`);
    if (!res.writableEnded) res.end();
  } catch (e) {
    if (stopped || isClientDisconnect(controller)) return;
    reportFreepiFailure(e, controller, res, TAG, t0, rxBytes, "openai", false);
    if (headersSent && !res.writableEnded) {
      if (!finishSeen) synthesizeEnding();
      res.end();
    }
  }
}

// Collect full free-pi response (non-streaming client) and return parsed JSON.
async function freepiRequestFull(opts, body, clientSignal) {
  const controller = new AbortController();
  bindClientAbort(controller, clientSignal);
  const zenRes = await freepiFetchWithRetry(opts, body, controller);
  const raw = await collectFreepiBody(zenRes, controller);
  const { json } = coerceChatSyncBody(raw);
  return { status: zenRes.status, data: json ?? null, raw };
}

// ── Anthropic Messages → OpenAI conversion ─────────────────────────
const SUPPORTED_ANTHROPIC_BLOCKS = new Set(["text", "tool_use", "tool_result"]);

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function validateAnthropicBody(body) {
  if (!isPlainObject(body)) return "request body must be a JSON object";
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return "messages must be a non-empty array";
  }
  if (body.system !== undefined) {
    if (typeof body.system === "string") {
      // ok
    } else if (Array.isArray(body.system)) {
      for (const [i, b] of body.system.entries()) {
        if (!isPlainObject(b) || typeof b.text !== "string") {
          return `system[${i}] must be an object with a string text field`;
        }
      }
    } else {
      return "system must be a string or an array of text blocks";
    }
  }
  for (const [i, msg] of body.messages.entries()) {
    if (!isPlainObject(msg)) return `messages[${i}] must be an object`;
    if (typeof msg.role !== "string" || !msg.role) {
      return `messages[${i}].role must be a non-empty string`;
    }
    if (typeof msg.content === "string") continue;
    if (!Array.isArray(msg.content)) {
      return `messages[${i}].content must be a string or an array of content blocks`;
    }
    for (const [j, b] of msg.content.entries()) {
      if (!isPlainObject(b)) return `messages[${i}].content[${j}] must be an object`;
      if (!SUPPORTED_ANTHROPIC_BLOCKS.has(b.type)) {
        return `Unsupported content block type(s): ${b.type}. This proxy currently supports text, tool_use and tool_result.`;
      }
      if (b.type === "text" && typeof b.text !== "string") {
        return `messages[${i}].content[${j}].text must be a string`;
      }
      if (b.type === "tool_use") {
        if (typeof b.id !== "string" || !b.id) return `messages[${i}].content[${j}].id must be a string`;
        if (typeof b.name !== "string" || !b.name) return `messages[${i}].content[${j}].name must be a string`;
        if (b.input !== undefined && !isPlainObject(b.input)) {
          return `messages[${i}].content[${j}].input must be an object`;
        }
      }
      if (b.type === "tool_result" && (typeof b.tool_use_id !== "string" || !b.tool_use_id)) {
        return `messages[${i}].content[${j}].tool_use_id must be a string`;
      }
    }
  }
  if (body.tools !== undefined) {
    if (!Array.isArray(body.tools)) return "tools must be an array";
    for (const [i, t] of body.tools.entries()) {
      if (!isPlainObject(t) || typeof t.name !== "string" || !t.name) {
        return `tools[${i}].name must be a non-empty string`;
      }
      if (t.input_schema !== undefined && !isPlainObject(t.input_schema)) {
        return `tools[${i}].input_schema must be an object`;
      }
    }
  }
  if (body.tool_choice !== undefined && !isPlainObject(body.tool_choice)) {
    return "tool_choice must be an object";
  }
  return null;
}

function anthropicToOpenAI(body) {
  const invalid = validateAnthropicBody(body);
  if (invalid) return { error: invalid };
  const messages = [];
  if (body.system) {
    const sys = typeof body.system === "string" ? body.system
      : Array.isArray(body.system) ? body.system.map(b => b.text || "").join("\n") : "";
    if (sys) messages.push({ role: "system", content: sys });
  }
  for (const msg of body.messages || []) {
    if (typeof msg.content === "string") {
      messages.push({ role: msg.role, content: msg.content });
    } else if (Array.isArray(msg.content)) {
      const text = msg.content
        .filter(b => b.type === "text")
        .map(b => b.text)
        .join("\n");
      // tool_use blocks → assistant tool_calls
      const toolUses = msg.content.filter(b => b.type === "tool_use");
      if (toolUses.length && msg.role === "assistant") {
        messages.push({
          role: "assistant",
          content: text || null,
          tool_calls: toolUses.map(t => ({
            id: t.id,
            type: "function",
            function: { name: t.name, arguments: JSON.stringify(t.input || {}) },
          })),
        });
      } else if (msg.content.some(b => b.type === "tool_result")) {
        for (const b of msg.content.filter(b => b.type === "tool_result")) {
          const resultText = typeof b.content === "string" ? b.content
            : Array.isArray(b.content) ? b.content.map(c => c.text || "").join("\n") : "";
          messages.push({ role: "tool", tool_call_id: b.tool_use_id, content: resultText });
        }
        // A user message may mix tool_result blocks with sibling text
        if (text) messages.push({ role: "user", content: text });
      } else {
        messages.push({ role: msg.role, content: text });
      }
    }
  }

  const tools = (body.tools || []).map(t => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description || "",
      parameters: t.input_schema || {},
    },
  }));

  return { messages, tools: tools.length ? tools : undefined };
}

// OpenAI response → Anthropic Messages format
function openAIToAnthropic(oaiResp, model, inputTokens) {
  const choice = oaiResp.choices?.[0];
  if (!choice) {
    return {
      id: fpId("msg"),
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "" }],
      model,
      stop_reason: "end_turn",
      usage: { input_tokens: inputTokens || 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    };
  }

  const content = [];
  if (choice.message?.content) {
    const c = choice.message.content;
    const text = Array.isArray(c)
      ? c.map(p => (typeof p === "string" ? p : (p?.text || ""))).join("\n")
      : c;
    content.push({ type: "text", text });
  }
  if (choice.message?.tool_calls) {
    for (const tc of choice.message.tool_calls) {
      let input = {};
      try { input = JSON.parse(tc.function.arguments); } catch {}
      content.push({
        type: "tool_use",
        id: tc.id || fpId("toolu"),
        name: tc.function.name,
        input,
      });
    }
  }
  if (!content.length) content.push({ type: "text", text: "" });

  let stopReason = "end_turn";
  if (choice.finish_reason === "tool_calls") stopReason = "tool_use";
  else if (choice.finish_reason === "length") stopReason = "max_tokens";
  else if (choice.finish_reason === "stop") stopReason = "end_turn";

  return {
    id: fpId("msg"),
    type: "message",
    role: "assistant",
    content,
    model,
    stop_reason: stopReason,
    usage: {
      input_tokens: oaiResp.usage?.prompt_tokens || inputTokens || 0,
      output_tokens: oaiResp.usage?.completion_tokens || 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  };
}

// Anthropic tool_choice → OpenAI tool_choice mapping
function anthropicToolChoiceToOpenAI(tc) {
  if (!tc) return undefined;
  if (tc.type === "auto") return "auto";
  if (tc.type === "any") return "required";
  if (tc.type === "none") return "none";
  if (tc.type === "tool" && tc.name) {
    return { type: "function", function: { name: tc.name } };
  }
  log("warn", "[ANT] Unknown tool_choice type, dropping:", JSON.stringify(tc));
  return undefined;
}

// Stream OpenAI SSE → Anthropic SSE
async function pipeFreepiAsAnthropic(opts, body, model, res, inputTokens, clientSignal) {
  const msgId = fpId("msg");
  const TAG = opts._tag || "??";
  const t0 = Date.now();
  let rxBytes = 0;
  const controller = new AbortController();
  bindClientAbort(controller, clientSignal);

  let zenRes;
  try {
    zenRes = await freepiFetchWithRetry(opts, body, controller);
  } catch (e) {
    reportFreepiFailure(e, controller, res, TAG, t0, rxBytes, "anthropic", false);
    return;
  }

  if (zenRes.status !== 200) {
    let raw = "";
    try {
      raw = await collectFreepiBody(zenRes, controller);
    } catch (e) {
      reportFreepiFailure(e, controller, res, TAG, t0, rxBytes, "anthropic", false);
      return;
    }
    let msg = "Upstream error";
    try {
      const p = JSON.parse(raw);
      msg = p.error?.message || p.message || msg;
    } catch {}
    const errType = ({
      400: "invalid_request_error",
      401: "authentication_error",
      403: "authentication_error",
      404: "not_found_error",
      429: "rate_limit_error",
    })[zenRes.status] || "api_error";
    log("error", `[FREEPI UPSTREAM ${zenRes.status} ${TAG}]`, withCause(zenRes.status, msg));
    if (!res.headersSent) {
      res.status(zenRes.status).json({ type: "error", error: { type: errType, message: msg } });
    }
    return;
  }

  // Gravity 廣告偵測：上游回應中若有廣告相關 header，於 log 提示
  const gravityAdHeader = zenRes.headers.get("x-gravity-ad") || zenRes.headers.get("x-gravity-ads") || zenRes.headers.get("x-gravity");
  if (gravityAdHeader) {
    log("warn", `[GRAVITY AD] ${TAG} — ad received from upstream`);
  }

  let headersSent = false;
  let buffer = "";
  let outputTokens = 0;
  let reasoningTokens = 0;
  let nextBlock = 0;
  let textIndex = -1;
  let textOpen = false;
  const openBlocks = [];
  const toolBlocks = new Map();
  let anyKeptTool = false;
  let sawToolDelta = false;
  let firstChunkHandled = false;
  let rawAccum = "";
  let finishHandled = false;
  let selfStopped = false;

  function sendSSE(event, data) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    if (res.flush) res.flush();
  }

  function sendHeaders() {
    if (headersSent) return;
    headersSent = true;
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders();

    sendSSE("message_start", {
      type: "message_start",
      message: {
        id: msgId, type: "message", role: "assistant", content: [],
        model, stop_reason: null,
        usage: { input_tokens: inputTokens || 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
    });
  }

  function closeBlock(index) {
    sendSSE("content_block_stop", { type: "content_block_stop", index });
    const i = openBlocks.indexOf(index);
    if (i >= 0) openBlocks.splice(i, 1);
  }

  function finishUp(stopReason, outTok) {
    if (res.writableEnded) return;
    sendHeaders();
    for (const idx of [...openBlocks]) closeBlock(idx);
    sendSSE("message_delta", {
      type: "message_delta",
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: outTok },
    });
    sendSSE("message_stop", { type: "message_stop" });
    res.end();
  }

  function onData(chunk) {
    rxBytes += chunk.length;
    const str = chunk.toString();
    rawAccum = rawAccum.length >= 16384 ? rawAccum.slice(-8192) + str : rawAccum + str;

    // Check for errors on first chunk
    if (!firstChunkHandled) {
      firstChunkHandled = true;
      const trimmed = str.trim();
      if (trimmed.startsWith("{") && (trimmed.includes('"error"') || trimmed.includes('"type":"error"') || trimmed.includes('"type": "error"'))) {
        try {
          const parsed = JSON.parse(trimmed);
          if (parsed.error || parsed.type === "error") {
            const { status, error } = upstreamErrorPayload(200, trimmed, null);
            if (!res.headersSent) {
              res.writeHead(status, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ type: "error", error: { type: error.type, message: error.message } }));
            }
            abortUpstream(controller, "inline error, stop reading");
            selfStopped = true;
            return;
          }
        } catch {}
      }
    }

    buffer += str;
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") continue;

      let parsed;
      try { parsed = JSON.parse(payload); } catch { continue; }
      const ch0 = parsed.choices?.[0];
      if (!ch0?.delta && ch0?.finish_reason && !finishHandled) {
        finishHandled = true;
        const fr = ch0.finish_reason;
        let stopReason = "end_turn";
        if (fr === "tool_calls") stopReason = anyKeptTool ? "tool_use" : "end_turn";
        else if (fr === "length") stopReason = "max_tokens";
        finishUp(stopReason, outputTokens);
        log("info", `[REQ DONE ${TAG} +${Date.now() - t0}ms rx=${rxBytes}B stream]`);
        continue;
      }
      const delta = ch0?.delta;
      if (!delta) continue;

      const hasProgressThisFrame = Boolean(delta.content) ||
        (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0);
      if (Array.isArray(delta.tool_calls) && delta.tool_calls.length) sawToolDelta = true;

      const rt = reasoningText(delta);
      if (rt) {
        reasoningTokens += Math.ceil(rt.length / 4);
        if (reasoningTokens > 65536 && !hasProgressThisFrame && !textOpen && !anyKeptTool && !sawToolDelta) {
          log("warn", `[FREEPI REASONING CAP] ${reasoningTokens} reasoning tokens, no content → force stop`);
          abortUpstream(controller, "reasoning cap force stop");
          selfStopped = true;
          finishUp("max_tokens", outputTokens + reasoningTokens);
          return;
        }
      }

      sendHeaders();

      // Text content
      if (delta.content) {
        if (!textOpen) {
          textIndex = nextBlock++;
          textOpen = true;
          openBlocks.push(textIndex);
          sendSSE("content_block_start", { type: "content_block_start", index: textIndex, content_block: { type: "text", text: "" } });
        }
        sendSSE("content_block_delta", {
          type: "content_block_delta", index: textIndex,
          delta: { type: "text_delta", text: delta.content },
        });
        outputTokens += Math.ceil(delta.content.length / 4);
      }

      // Tool calls
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          if (!tc || typeof tc !== "object") continue;
          const idx = tc.index ?? 0;
          let st = toolBlocks.get(idx);
          if (!st) {
            st = { blockIdx: -1, keep: true, opened: false, pendingArgs: "" };
            toolBlocks.set(idx, st);
          }
          if (!st.opened) {
            if (typeof tc.function?.arguments === "string") {
              const room = 1 << 20;
              if (st.pendingArgs.length < room) {
                st.pendingArgs += tc.function.arguments.slice(0, room - st.pendingArgs.length);
              }
            }
            const upName = tc.function?.name || "";
            if (!upName) continue;
            st.opened = true;
            if (st.keep) {
              if (textOpen) {
                closeBlock(textIndex);
                textOpen = false;
              }
              st.blockIdx = nextBlock++;
              openBlocks.push(st.blockIdx);
              anyKeptTool = true;
              sendSSE("content_block_start", {
                type: "content_block_start", index: st.blockIdx,
                content_block: { type: "tool_use", id: tc.id || fpId("toolu"), name: upName, input: {} },
              });
              if (st.pendingArgs) {
                sendSSE("content_block_delta", {
                  type: "content_block_delta", index: st.blockIdx,
                  delta: { type: "input_json_delta", partial_json: st.pendingArgs },
                });
                outputTokens += Math.ceil(st.pendingArgs.length / 4);
                st.pendingArgs = "";
              }
            } else {
              st.pendingArgs = "";
            }
            continue;
          }
          if (!st.keep) continue;
          if (tc.function?.arguments) {
            sendSSE("content_block_delta", {
              type: "content_block_delta", index: st.blockIdx,
              delta: { type: "input_json_delta", partial_json: tc.function.arguments },
            });
            outputTokens += Math.ceil(tc.function.arguments.length / 4);
          }
        }
      }

      // Finish
      if (parsed.choices?.[0]?.finish_reason && !finishHandled) {
        finishHandled = true;
        const fr = parsed.choices[0].finish_reason;

        let stopReason = "end_turn";
        if (fr === "tool_calls") stopReason = anyKeptTool ? "tool_use" : "end_turn";
        else if (fr === "length") stopReason = "max_tokens";

        finishUp(stopReason, outputTokens);
        log("info", `[REQ DONE ${TAG} +${Date.now() - t0}ms rx=${rxBytes}B stream]`);
      }
    }
  }

  try {
    await pumpFreepiStream(zenRes, controller, onData);
    if (selfStopped) return;
    if (!headersSent) {
      let inline = null;
      if (rawAccum.trim().startsWith("{")) {
        try { inline = JSON.parse(rawAccum.trim()); } catch {}
      }
      if (!inline) inline = sseErrorPayload(rawAccum);
      if (inline) {
        const { status, error } = upstreamErrorPayload(200, rawAccum, zenRes.headers);
        log("error", `[FREEPI UPSTREAM ${status} ${TAG}]`, withCause(status, error.message));
        sendUpstreamError(res, 200, rawAccum, zenRes.headers, "anthropic");
        return;
      }
      if (!res.headersSent) {
        res.status(502).json({ type: "error", error: { type: "upstream_error", message: "Empty response" } });
      }
      return;
    }
    if (!finishHandled && !res.writableEnded) {
      log("warn", `[FREEPI ABORT ${TAG} +${Date.now() - t0}ms rx=${rxBytes}B] upstream closed without finish_reason — synthesized ending`);
      finishUp(anyKeptTool ? "tool_use" : "end_turn", outputTokens);
    }
  } catch (e) {
    if (selfStopped) return;
    reportFreepiFailure(e, controller, res, TAG, t0, rxBytes, "anthropic", false);
    if (headersSent && !res.writableEnded && !finishHandled) {
      finishUp(anyKeptTool ? "tool_use" : "end_turn", outputTokens);
    }
  }
}

// ── Validation helpers ────────────────────────────────────────────
function validateGenParams(b) {
  if (!isPlainObject(b)) return "request body must be a JSON object";
  if (b.max_tokens !== undefined && (!Number.isInteger(b.max_tokens) || b.max_tokens <= 0)) {
    return "max_tokens must be a positive integer";
  }
  if (b.max_completion_tokens !== undefined && (!Number.isInteger(b.max_completion_tokens) || b.max_completion_tokens <= 0)) {
    return "max_completion_tokens must be a positive integer";
  }
  if (b.temperature !== undefined && (typeof b.temperature !== "number" || b.temperature < 0 || b.temperature > 2)) {
    return "temperature must be a number in [0, 2]";
  }
  if (b.top_p !== undefined && (typeof b.top_p !== "number" || b.top_p < 0 || b.top_p > 1)) {
    return "top_p must be a number in [0, 1]";
  }
  return null;
}

const CHAT_ROLES = new Set(["system", "developer", "user", "assistant", "tool"]);
const CHAT_TEXT_PART_TYPES = new Set(["text", "input_text", "output_text"]);

function validateChatBody(body) {
  if (!isPlainObject(body)) return "request body must be a JSON object";
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return "messages must be a non-empty array";
  }
  for (const [i, msg] of body.messages.entries()) {
    if (!isPlainObject(msg)) return `messages[${i}] must be an object`;
    if (typeof msg.role !== "string" || !msg.role) {
      return `messages[${i}].role must be a non-empty string`;
    }
    if (!CHAT_ROLES.has(msg.role)) return `messages[${i}].role must be one of ${[...CHAT_ROLES].join(", ")}`;
    const c = msg.content;
    if (c !== undefined && c !== null) {
      if (typeof c === "string") {
        // ok
      } else if (Array.isArray(c)) {
        for (const [j, p] of c.entries()) {
          if (!isPlainObject(p)) return `messages[${i}].content[${j}] must be an object`;
          if (typeof p.type !== "string" || !p.type) {
            return `messages[${i}].content[${j}].type must be a non-empty string`;
          }
          if (CHAT_TEXT_PART_TYPES.has(p.type) && typeof p.text !== "string") {
            return `messages[${i}].content[${j}].text must be a string`;
          }
        }
      } else {
        return `messages[${i}].content must be a string or an array of content parts`;
      }
    }
    if (msg.tool_calls !== undefined) {
      if (!Array.isArray(msg.tool_calls)) return `messages[${i}].tool_calls must be an array`;
      for (const [j, tc] of msg.tool_calls.entries()) {
        if (!isPlainObject(tc)) return `messages[${i}].tool_calls[${j}] must be an object`;
        if (typeof tc.id !== "string" || !tc.id) {
          return `messages[${i}].tool_calls[${j}].id must be a non-empty string`;
        }
        if (!isPlainObject(tc.function) || typeof tc.function.name !== "string" || !tc.function.name) {
          return `messages[${i}].tool_calls[${j}].function.name must be a non-empty string`;
        }
        const args = tc.function.arguments;
        if (args !== undefined && typeof args !== "string" && !isPlainObject(args)) {
          return `messages[${i}].tool_calls[${j}].function.arguments must be a string or object`;
        }
      }
    }
    if (msg.role === "tool" && (typeof msg.tool_call_id !== "string" || !msg.tool_call_id)) {
      return `messages[${i}].tool_call_id must be a non-empty string`;
    }
  }
  if (body.tools !== undefined) {
    if (!Array.isArray(body.tools)) return "tools must be an array";
    for (const [i, t] of body.tools.entries()) {
      const fn = isPlainObject(t) ? t.function || t : null;
      if (!fn || typeof fn.name !== "string" || !fn.name) {
        return `tools[${i}].function.name must be a non-empty string`;
      }
    }
  }
  return null;
}

function sendRouteError(res, e, anthropicShape = false) {
  log("error", "[ROUTE ERROR]", e?.stack || e?.message || e);
  if (res.headersSent || res.writableEnded) {
    try { res.end(); } catch {}
    return;
  }
  const status = Number.isInteger(e?.statusCode) && e.statusCode >= 400 ? e.statusCode : 502;
  const message = e?.message || "Internal proxy error";
  if (anthropicShape) {
    return res.status(status).json({ type: "error", error: { type: "api_error", message } });
  }
  return res.status(status).json({ error: { message, type: "proxy_error" } });
}

// ── Routes: OpenAI format ──────────────────────────────────────────
app.get("/v1/models", (_req, res) => {
  res.json({
    object: "list",
    data: MODELS.map((id) => {
      const meta = MODEL_META[id] || {};
      return {
        id,
        object: "model",
        created: 1779000000,
        owned_by: "free-pi",
        name: meta.name,
        status: meta.status,
        reasoning: meta.reasoning,
        tool_call: meta.toolCall,
        limit: { context: meta.contextLimit || undefined, output: meta.outputLimit || undefined },
      };
    }),
  });
});

app.post("/v1/chat/completions", async (req, res) => {
  try {
    const user = auth(req);
    if (!user) return res.status(401).json({ error: { message: "Invalid API key" } });
    if (!isPlainObject(req.body)) {
      return res.status(400).json({ error: { message: "request body must be a JSON object", type: "invalid_request_error" } });
    }
    const clientSignal = clientAbortSignal(req, res);

    const { model, messages, stream, tools, tool_choice } = req.body;
    if (!MODELS.includes(model)) {
      return res.status(400).json({ error: { message: `Unknown model: ${model}. Available: ${MODELS.join(", ")}` } });
    }
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: { message: "messages must be a non-empty array", type: "invalid_request_error" } });
    }
    // Generation-param validation
    {
      const perr = validateGenParams(req.body);
      if (perr) return res.status(400).json({ error: { message: perr, type: "invalid_request_error" } });
    }
    // Medium message-structure validation
    {
      const cerr = validateChatBody(req.body);
      if (cerr) return res.status(400).json({ error: { message: cerr, type: "invalid_request_error" } });
    }

    const sessionId = getSession(user, req);
    const msgSummary = (messages || []).map(m => ({ role: m.role, len: (typeof m.content === "string" ? m.content : JSON.stringify(m.content || "")).length }));

    log("info", "[OAI]", new Date().toISOString(), user, model, stream ? "stream" : "sync", "msgs:", JSON.stringify(msgSummary));

    const { body, options } = freepiRequest(model, messages, tools, sessionId, req.body);
    options._tag = `OAI ${user} ${model}`;
    return await pipeFreepiResponse(options, body, !!stream, res, model, clientSignal);
  } catch (e) {
    return sendRouteError(res, e, false);
  }
});

// ── Routes: Anthropic Messages format ──────────────────────────────
app.post("/v1/messages", async (req, res) => {
  try {
    const user = auth(req);
    if (!user) {
      return res.status(401).json({ type: "error", error: { type: "authentication_error", message: "Invalid API key" } });
    }
    if (!isPlainObject(req.body)) {
      return res.status(400).json({
        type: "error",
        error: { type: "invalid_request_error", message: "request body must be a JSON object" },
      });
    }
    const clientSignal = clientAbortSignal(req, res);

    const { model, stream, tool_choice } = req.body;
    if (!MODELS.includes(model)) {
      return res.status(400).json({
        type: "error",
        error: { type: "invalid_request_error", message: `Unknown model: ${model}. Available: ${MODELS.join(", ")}` },
      });
    }
    const sessionId = getSession(user, req);
    const { messages, tools, error } = anthropicToOpenAI(req.body);
    if (error) {
      return res.status(400).json({
        type: "error",
        error: { type: "invalid_request_error", message: error },
      });
    }
    if (!messages.length) {
      return res.status(400).json({
        type: "error",
        error: { type: "invalid_request_error", message: "messages must be a non-empty array" },
      });
    }
    // Generation-param validation
    {
      const perr = validateGenParams(req.body);
      if (perr) {
        return res.status(400).json({
          type: "error",
          error: { type: "invalid_request_error", message: perr },
        });
      }
    }
    const inputTokens = JSON.stringify(messages).length / 4 | 0;

    // Forward mapped tool_choice (guard: only when tools are present)
    const mappedChoice = tools?.length ? anthropicToolChoiceToOpenAI(tool_choice) : undefined;

    log("info", "[ANT]", new Date().toISOString(), user, model, stream ? "stream" : "sync", "msgs:", messages.length);

    const extra = { ...req.body };
    if (mappedChoice) extra.tool_choice = mappedChoice;
    const { body, options } = freepiRequest(model, messages, tools, sessionId, extra);
    options._tag = `ANT ${user} ${model}`;

    if (stream) {
      return await pipeFreepiAsAnthropic(options, body, model, res, inputTokens, clientSignal);
    } else {
      try {
        const t0 = Date.now();
        const TAG = options._tag || "??";
        const zenResp = await freepiRequestFull(options, body, clientSignal);
        const rxLen = typeof zenResp.raw === "string" ? zenResp.raw.length : 0;
        if (zenResp.status === 429) {
          const errMsg = zenResp.data?.error?.message || "Rate limit exceeded";
          log("error", `[FREEPI UPSTREAM 429 ${TAG} +${Date.now() - t0}ms rx=${rxLen}B]`, withCause(429, errMsg));
          return res.status(429).json({
            type: "error", error: { type: "rate_limit_error", message: errMsg + " (free model rate limit)" },
          });
        }
        if (zenResp.data?.error) {
          const errType = ({
            400: "invalid_request_error",
            401: "authentication_error",
            403: "authentication_error",
            404: "not_found_error",
          })[zenResp.status] || "api_error";
          log("error", `[FREEPI UPSTREAM ${zenResp.status} ${TAG} +${Date.now() - t0}ms rx=${rxLen}B]`, withCause(zenResp.status, zenResp.data.error?.message));
          return res.status(zenResp.status >= 400 ? zenResp.status : 502).json({
            type: "error", error: { type: errType, message: zenResp.data.error?.message || "Upstream error" },
          });
        }
        if (!zenResp.data?.choices) {
          const rawFrag = typeof zenResp.raw === "string" ? zenResp.raw.slice(0, 200) : "";
          log("error", `[FREEPI UPSTREAM ${zenResp.status} ${TAG} +${Date.now() - t0}ms rx=${rxLen}B]`, withCause(zenResp.status, rawFrag || "Invalid upstream response"));
          return res.status(502).json({
            type: "error", error: { type: "upstream_error", message: rawFrag ? `Invalid upstream response: ${rawFrag}` : "Invalid upstream response" },
          });
        }
        log("info", `[REQ DONE ${TAG} +${Date.now() - t0}ms rx=${rxLen}B sync]`);
        res.json(openAIToAnthropic(zenResp.data, model, inputTokens));
      } catch (e) {
        log("error", "[FREEPI ERROR]", netCause(e));
        res.status(502).json({ type: "error", error: { type: "upstream_error", message: e.message } });
      }
    }
  } catch (e) {
    return sendRouteError(res, e, true);
  }
});

// ── Health ──────────────────────────────────────────────────────────
app.get("/health", (_req, res) => res.json({
  status: "ok",
  version: `v${PROXY_VERSION}`,
  runtime: RUNTIME,
  models: MODELS.length,
  models_source: MODELS_ORIGIN,
  models_loaded_at: MODELS_LOADED_AT,
  upstream_auth: freepiJwtSource,
  client_version: FREEPI_CLIENT_VERSION,
  session_ttl_ms: SESSION_TTL_MS,
  endpoints: ["/v1/chat/completions", "/v1/messages", "/v1/models"],
}));

// Body-parser errors → JSON in the client's shape
app.use((err, req, res, _next) => {
  const parseFailed = err?.type === "entity.parse.failed" || (err instanceof SyntaxError && "body" in err);
  const tooLarge = err?.type === "entity.too.large";
  if (!parseFailed && !tooLarge) return _next(err);
  const status = tooLarge ? 413 : 400;
  const message = tooLarge ? "Request body too large" : "Invalid JSON body";
  if (req.path === "/v1/messages" || req.path.startsWith("/v1/messages/")) {
    return res.status(status).json({ type: "error", error: { type: "invalid_request_error", message } });
  }
  return res.status(status).json({ error: { message, type: "invalid_request_error" } });
});

// ── Startup model report ────────────────────────────────────────────
function fmtTokens(n) {
  if (!n) return "-";
  if (n >= 1000000) return `${String(n / 1000000).replace(/\.0+$/, "")}M`;
  if (n >= 1000) return `${String(n / 1000).replace(/\.0+$/, "")}K`;
  return String(n);
}

function printModels() {
  const line = "-".repeat(123);
  console.log("");
  console.log(`  Free models (free-pi.ai): ${MODELS.length}`);
  console.log(`  ${line}`);
  console.log(
    `  ${"MODEL ID".padEnd(34)}${"NAME".padEnd(32)}${"CONTEXT".padEnd(10)}${"OUTPUT".padEnd(10)}${"REASON".padEnd(8)}${"TOOLS".padEnd(7)}RELEASE`,
  );
  for (const id of MODELS) {
    const m = MODEL_META[id] || {};
    console.log(
      `  ${id.padEnd(34)}${(m.name || "-").padEnd(32)}${fmtTokens(m.contextLimit).padEnd(10)}${fmtTokens(m.outputLimit).padEnd(10)}${(m.reasoning ? "yes" : "no").padEnd(8)}${(m.toolCall ? "yes" : "no").padEnd(7)}${m.releaseDate || "-"}`,
    );
  }
  console.log(`  ${line}`);
}

// ── Start ──────────────────────────────────────────────────────────
function isMainModule() {
  try {
    const entry = process.argv[1];
    return Boolean(entry) && path.resolve(entry) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

async function main() {
  // Resolve client version: CLI param > env (.env) > default
  FREEPI_CLIENT_VERSION = resolveClientVersion(process.argv.slice(2));
  loadKeys();
  await loadFreepiJwt();
  await loadModels();
  if (LOG_LEVEL !== "silent") {
    console.log(`[AUTH] Client version set to: ${FREEPI_CLIENT_VERSION}`);
    printModels();
  }
  const server = app.listen(PORT, HOST, () => {
    if (LOG_LEVEL !== "silent") {
      console.log(`free-pi-cli-proxy v${PROXY_VERSION} on http://${HOST}:${PORT} (runtime: ${RUNTIME})`);
      console.log("  OpenAI:    POST /v1/chat/completions");
      console.log("  Anthropic: POST /v1/messages");
      console.log("  Models:    GET  /v1/models");
      console.log("  Health:    GET  /health");
      for (const [name, key] of Object.entries(apiKeys)) {
        console.log(`  ${name.padEnd(15)} ${MASK_KEYS ? maskKey(key) : key}`);
      }
    }
  });
  server.on("error", (e) => {
    if (e.code === "EADDRINUSE") {
      console.error(
        `[FATAL] Port ${PORT} is already in use. Stop the other instance or set PROXY_PORT to a free port.`,
      );
    } else {
      console.error("[FATAL] Server error:", e.message);
    }
    process.exit(1);
  });
  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[SHUTDOWN] ${signal} received — closing server`);
    server.closeIdleConnections?.();
    const force = setTimeout(() => {
      console.error("[SHUTDOWN] forced after 10s (active stream did not drain)");
      server.closeAllConnections?.();
      process.exit(0);
    }, 10000);
    force.unref?.();
    server.close(() => {
      clearTimeout(force);
      process.exit(0);
    });
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  return server;
}

if (isMainModule()) {
  main().catch((e) => {
    console.error("[FATAL] Startup failed:", e?.stack || e?.message || e);
    process.exit(1);
  });
}

export {
  app,
  main,
  PORT,
  MODELS,
  MODEL_META,
  MODELS_ORIGIN,
  MODELS_LOADED_AT,
  SESSION_TTL_MS,
  loadKeys,
  setApiKeys,
  loadFreepiJwt,
  deviceFlowLogin,
  getFreePiCredentialsPath,
  ENV_AUTO_LOGIN,
  CONSENT_VERSION,
  freepiJwt,
  freepiJwtSource,
  freepiUrl,
  freepiHeaders,
  freepiSessionId,
  freepiFetchRaw,
  getSession,
  freepiRequest,
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
  pipeFreepiResponse,
  pipeFreepiAsAnthropic,
  freepiRequestFull,
  freepiFetchWithRetry,
  setFreepiFetchImpl,
  upstreamErrorPayload,
  parseUpstreamError,
  isQuotaError,
  sendUpstreamError,
  isRetryableLimit,
  isHardQuotaWait,
  RETRY_429_HARD_LIMIT_MS,
  retryDelay,
  parseRetryAfterMs,
  RETRY_429_CAP_MS,
  printModels,
  useDefaults,
  applyClientVersion,
  loadModels,
  FREEPI_CLIENT_VERSION,
  resolveClientVersion,
  writeJwtToEnvFile,
};