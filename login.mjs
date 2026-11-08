#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────
// free-pi-cli-proxy — JWT 取得工具（login.mjs）
// 直接對 api.freepi.ai 走 GitHub device flow，取得 JWT 並寫入
// ~/.free-pi/agent/credentials.json（與 free-pi-cli 相同的格式與路徑），
// 完全不需要安裝或執行 npx free-pi-cli。
//
// 流程（依 free-pi-cli src/auth-flow.ts / run.ts / consent.ts 移植）：
//   1. POST /auth/github/device → {session_id, user_code, verification_uri, interval}
//   2. 開瀏覽器讓使用者輸入 user_code 授權 GitHub
//   3. POST /auth/consent  {session_id, consent_version:"4"}
//   4. POST /auth/token   輪詢直到 {token}
//   5. GET /me 驗證 JWT
//   6. 寫入 credentials.json（0600）
// ─────────────────────────────────────────────────────────────────────
import fs from "fs";
import path from "path";
import os from "os";
import readline from "readline";
import { exec } from "child_process";

const BASE_URL = (process.env.FREEPI_BASE_URL || "https://api.freepi.ai").replace(/\/+$/, "");
const CONSENT_VERSION = process.env.FREEPI_CONSENT_VERSION || "4";
const CREDENTIALS_PATH = process.env.FREEPI_CREDENTIALS_PATH
  || path.join(os.homedir(), ".free-pi", "agent", "credentials.json");

// 與 free-pi-cli src/consent.ts 的同意內容一致（條款全文）。
const CONSENT_TEXT = `
free-pi — before you start

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

Decline and nothing is sent to the free-pi server.
`.trim();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);

function maskJwt(jwt) {
  const s = String(jwt);
  return s.length > 16 ? `${s.slice(0, 8)}…${s.slice(-6)}` : "…";
}

// ── HTTP（網路失敗重試，HTTP 結果原樣回傳）─────────────────────────
async function postJson(pathname, body, attempts = 4) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fetch(new URL(pathname, BASE_URL), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (e) {
      lastErr = e;
      if (i >= attempts) break;
      log(`  [retry ${i}/${attempts}] 網路失敗，${1500 * i}ms 後重試…`);
      await sleep(1500 * i);
    }
  }
  throw new Error(`網路不可達（${attempts} 次嘗試失敗）：${lastErr?.message || lastErr}`);
}

// ── 1. 啟動 device flow ──────────────────────────────────────────
async function startDeviceFlow() {
  const res = await postJson("/auth/github/device", {});
  if (!res.ok) throw new Error(`device flow 啟動失敗：HTTP ${res.status}`);
  const d = await res.json();
  if (!d?.session_id || !d?.user_code) throw new Error("device flow 回應格式不正確");
  return d;
}

// ── 2. 使用者同意（與 free-pi-cli 相同的 consent 流程）──────────────
function askConsent() {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) {
      log("");
      log("[跳過互動同意] stdin 非 TTY，直接以程式化同意提交（consent_version=" + CONSENT_VERSION + "）。");
      log("若不同意上述條款，請立即按 Ctrl+C 中止，或設定 FREEPI_NO_AUTO_CONSENT=1 停用此行為。");
      if (process.env.FREEPI_NO_AUTO_CONSENT === "1") return resolve(false);
      return resolve(true);
    }
    log("");
    log(CONSENT_TEXT);
    log("");
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question("Accept? [y/N] ", (answer) => {
      rl.close();
      resolve(/^\s*y(es)?\s*$/i.test(answer));
    });
  });
}

async function submitConsent(sessionId) {
  const res = await postJson("/auth/consent", {
    session_id: sessionId,
    consent_version: CONSENT_VERSION,
  });
  if (!res.ok) throw new Error(`同意提交失敗：HTTP ${res.status}`);
}

// ── 3. 開瀏覽器 ─────────────────────────────────────────────────
function openBrowser(url) {
  if (process.env.FREEPI_NO_BROWSER === "1") return;
  const cmd = process.platform === "win32"
    ? `start "" "${url}"`
    : process.platform === "darwin" ? `open "${url}"` : `xdg-open "${url}"`;
  // 開瀏覽器純屬便利功能：沙箱/無 GUI 環境下 spawn 會失敗，絕不影響登入流程。
  try {
    exec(cmd, () => {});
  } catch {
    log("  （無法自動開啟瀏覽器，請手動複製上方網址）");
  }
}

// ── 4. 輪詢 token ───────────────────────────────────────────────
async function pollForToken(sessionId, intervalSec) {
  let netFails = 0;
  for (;;) {
    let res;
    try {
      res = await postJson("/auth/token", { session_id: sessionId }, 1);
      netFails = 0;
    } catch (e) {
      netFails++;
      if (netFails >= 6) throw new Error(`token 輪詢網路持續失敗：${e.message}`);
      await sleep(Math.max(intervalSec, 5) * 1000);
      continue;
    }
    if (res.status === 403) {
      const body = await res.json().catch(() => undefined);
      if (body?.code === "consent_required") {
        throw new Error("consent_required：伺服端未記錄同意，請重新執行 login");
      }
      throw new Error(`token 輪詢失敗：HTTP 403`);
    }
    if (!res.ok) throw new Error(`token 輪詢失敗：HTTP ${res.status}`);

    const parsed = await res.json();
    if (parsed?.token) return parsed.token;
    if (parsed?.code === "consent_required") {
      throw new Error("consent_required：伺服端未記錄同意，請重新執行 login");
    }
    // GitHub 回 slow_down 時伺服端會帶 retry_after
    const retryAfter = typeof parsed?.retry_after === "number" ? parsed.retry_after : 0;
    process.stdout.write(".");
    await sleep(Math.max(intervalSec, retryAfter) * 1000);
  }
}

// ── 5. 驗證 JWT ────────────────────────────────────────────────
async function verifyToken(jwt) {
  const res = await fetch(new URL("/me", BASE_URL), {
    headers: { authorization: `Bearer ${jwt}` },
  });
  if (res.status === 401) throw new Error("JWT 驗證失敗（401）：token 無效");
  if (!res.ok) return null; // 舊伺服器/暫時錯誤：不當成失敗
  return res.json().catch(() => null);
}

// ── 6. 寫入 credentials ────────────────────────────────────────
function saveJwt(jwt) {
  fs.mkdirSync(path.dirname(CREDENTIALS_PATH), { recursive: true });
  fs.writeFileSync(CREDENTIALS_PATH, JSON.stringify({ token: jwt }), { mode: 0o600 });
  try { fs.chmodSync(CREDENTIALS_PATH, 0o600); } catch {}
}

// 將 JWT 寫入 .env 檔案（更新或新增 FREEPI_JWT 行）
function writeJwtToEnvFile(token) {
  const ENV_FILE_PATH = path.resolve(".env");
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
    log("  JWT 已自動寫入 .env");
  } catch (e) {
    log("  [WARN] 無法寫入 .env 檔案：" + e.message);
  }
}

// ── main ───────────────────────────────────────────────────────
async function main() {
  log("");
  log("free-pi-cli-proxy · GitHub 登入");
  log(`  上游：${BASE_URL}`);
  log(`  JWT 將寫入：${CREDENTIALS_PATH}`);
  log("");

  const device = await startDeviceFlow();
  log(`  授權網址：${device.verification_uri}`);
  log(`  驗證碼：  ${device.user_code}`);
  log("");
  openBrowser(device.verification_uri);

  const accepted = await askConsent();
  if (!accepted) {
    log("");
    log("已拒絕。未對 free-pi 伺服器送出任何同意。");
    process.exit(1);
  }

  await submitConsent(device.session_id);
  log("");
  log("同意已提交，等待 GitHub 授權完成（請在瀏覽器貼上驗證碼）…");

  const token = await pollForToken(device.session_id, device.interval || 5);
  log("");

  const me = await verifyToken(token);
  saveJwt(token);
  writeJwtToEnvFile(token);

  log("");
  log("✓ 登入成功");
  log(`  JWT：${maskJwt(token)}`);
  if (me && typeof me === "object") {
    if (me.remaining_usd_today !== undefined) log(`  今日剩餘額度：$${me.remaining_usd_today}`);
    if (me.lane) log(`  Lane：${me.lane}`);
    if (me.consent_version) log(`  同意版本：${me.consent_version}`);
  }
  log(`  已寫入 ${CREDENTIALS_PATH}`);
  log(`  已寫入 .env (FREEPI_JWT)`);
  log("");
  log("現在可直接啟動 proxy：bun server.mjs");
  log("");
}

main().catch((e) => {
  console.error("");
  console.error("[FATAL] 登入失敗：", e?.message || e);
  process.exit(1);
});