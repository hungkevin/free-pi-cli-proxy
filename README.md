# free-pi-cli-proxy

> OpenAI 相容的本地代理伺服器，將 free-pi-cli（https://github.com/dennisonbertram/free-pi-cli）背後的免費 AI 模型提取出來，讓任何 OpenAI/Anthropic 相容客戶端都能直接使用。

## 功能特色

- **OpenAI 相容**：`POST /v1/chat/completions`、`GET /v1/models`
- **Anthropic 相容**：`POST /v1/messages`（自動雙向轉換）
- **健康檢查**：`GET /health`
- **API Key 認證**：`Authorization: Bearer <key>` 或 `x-api-key` header
- **Session 親和性**：依 API Key + 可選 `x-session-id` header 復用上游 session
- **429 退避重試**：最多 4 次，日額度用盡（Retry-After > 5 分鐘）快速失敗
- **優雅關閉**：SIGINT/SIGTERM 等待進行中串流完成（最多 10 秒）
- **模型自動刷新**：啟動時並每 30 分鐘從 `/client-version` 更新模型清單

## 快速開始

### 1. 安裝依賴

```bash
# 推薦：使用 Bun（效能最佳）
bun install

# 或使用 npm
npm install
```

### 2. 取得 free-pi JWT（三選一）

### 2. 取得 free-pi JWT（三選一）

#### 方式 A：用本專案內建登入（推薦，免安裝 free-pi-cli）

```bash
bun login.mjs          # 或 npm run login
```

會直接在終端顯示 GitHub device flow 的驗證碼並自動開啟瀏覽器：

```
free-pi-cli-proxy · GitHub 登入
  上游：https://api.freepi.ai
  JWT 將寫入：C:\Users\<你>\.free-pi\agent\credentials.json

  授權網址：https://github.com/login/device
  驗證碼：  ABCD-1234

<同意條款全文>

Accept? [y/N] y

✓ 登入成功
  已寫入 ~/.free-pi/agent/credentials.json
  JWT 已自動寫入 .env
```

不需要 `npm install -g free-pi-cli`，也不需要 `npx free-pi-cli`。

#### 方式 B：環境變數直接給（推薦部署/容器用）

```powershell
$env:FREEPI_JWT="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
```

#### 方式 C：讓 proxy 啟動時自動登入（需互動式終端機）

```powershell
$env:FREEPI_AUTO_LOGIN="1"; bun server.mjs
```

登入成功後，JWT 會同時寫入 `~/.free-pi/agent/credentials.json` 與 `.env` 檔案。下次啟動即可直接從 `.env` 讀取 `FREEPI_JWT`，無需再次登入。

#### 方式 B：環境變數直接給（推薦部署/容器用）

```bash
export FREEPI_JWT="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
```

#### 方式 C：從 free-pi-cli 登入取得（本機開發用）

```bash
npx free-pi-cli    # 完成 GitHub device flow
# 產生 ~/.free-pi/agent/credentials.json，proxy 啟動時自動讀取
```

**注意：不需要執行 `npx free-pi-cli@latest` 來「看廣告」。** proxy 啟動時會自動初始化 Gravity pixel 建立廣告 session，讓上游知道帳號「已看廣告」，避免 403 錯誤。

### 3. 啟動 Proxy

```bash
# 前景執行（開發/除錯）
bun server.mjs

# 或用常駐腳本（自動重啟、log 輪替、僅顯示 warn 以上）
# Windows: 在自己的命令列視窗執行（關閉視窗即停止），崩潰後 5 秒自動重啟
start.bat

# Linux/macOS:
LOG_LEVEL=warn bun server.mjs >> logs/proxy.log 2>&1 &
```

啟動成功會印出：
```
free-pi-cli-proxy v0.1.0 on http://0.0.0.0:6447 (runtime: bun)
  OpenAI:    POST /v1/chat/completions
  Anthropic: POST /v1/messages
  Models:    GET  /v1/models
  Health:    GET  /health
  admin                fp-a1b2c3d4e5f6g7h8i9j0
  user-default         fp-k1l2m3n4o5p6q7r8s9t0
```

### 4. 客戶端使用範例

#### OpenAI SDK（Python / Node.js / curl）

```python
# Python
from openai import OpenAI
client = OpenAI(
    base_url="http://127.0.0.1:6447/v1",
    api_key="fp-a1b2c3d4e5f6g7h8i9j0"  # 從啟動輸出或 api-keys.json 取得
)
resp = client.chat.completions.create(
    model="deepseek/deepseek-v4-flash",
    messages=[{"role": "user", "content": "你好"}],
    stream=True
)
for chunk in resp:
    print(chunk.choices[0].delta.content or "", end="")
```

```bash
# curl（同步）
curl -X POST http://127.0.0.1:6447/v1/chat/completions \
  -H "Authorization: Bearer fp-a1b2c3d4e5f6g7h8i9j0" \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek/deepseek-v4-flash","messages":[{"role":"user","content":"你好"}]}'

# curl（串流）
curl -N -X POST http://127.0.0.1:6447/v1/chat/completions \
  -H "Authorization: Bearer fp-a1b2c3d4e5f6g7h8i9j0" \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek/deepseek-v4-flash","messages":[{"role":"user","content":"你好"}],"stream":true}'
```

#### Anthropic SDK

```python
# Python
import anthropic
client = anthropic.Anthropic(
    base_url="http://127.0.0.1:6447/v1",
    api_key="fp-a1b2c3d4e5f6g7h8i9j0"
)
resp = client.messages.create(
    model="deepseek/deepseek-v4-flash",
    max_tokens=1024,
    messages=[{"role": "user", "content": "你好"}],
    stream=True
)
for chunk in resp:
    if chunk.type == "content_block_delta":
        print(chunk.delta.text, end="")
```

#### 多輪對話（Session 親和性）

```bash
# 帶上 x-session-id 讓同一個「對話」復用上游 session
curl -N -X POST http://127.0.0.1:6447/v1/chat/completions \
  -H "Authorization: Bearer fp-xxx" \
  -H "x-session-id: my-conversation-123" \
  -d '{"model":"deepseek/deepseek-v4-flash","messages":[{"role":"user","content":"第一輪"}],"stream":true}'

# 後續請求帶同樣的 x-session-id
curl -N -X POST http://127.0.0.1:6447/v1/chat/completions \
  -H "Authorization: Bearer fp-xxx" \
  -H "x-session-id: my-conversation-123" \
  -d '{"model":"deepseek/deepseek-v4-flash","messages":[{"role":"user","content":"第一輪"},{"role":"assistant","content":"..."},{"role":"user","content":"第二輪"}],"stream":true}'
```

## 端點文件

| 端點 | 方法 | 說明 |
|------|------|------|
| `/v1/chat/completions` | POST | OpenAI Chat Completions（支援 stream/sync） |
| `/v1/messages` | POST | Anthropic Messages（支援 stream/sync） |
| `/v1/models` | GET | 列出可用模型（OpenAI 格式） |
| `/health` | GET | 健康檢查與狀態資訊 |

### 請求 Header

| Header | 必填 | 說明 |
|--------|------|------|
| `Authorization: Bearer <key>` | 是 | Proxy API Key（來自 `api-keys.json`） |
| `x-api-key: <key>` | 否 | 替代 Authorization header |
| `x-session-id: <id>` | 否 | 對話 ID，用於上游 session 復用 |

### 回應格式

完全相容 OpenAI `/v1/chat/completions` 與 Anthropic `/v1/messages` 規範。

## 環境變數

見 `.env.example`，重點說明：

| 變數 | 預設 | 說明 |
|------|------|------|
| `FREEPI_JWT` | - | free-pi JWT，直接提供 |
| `FREEPI_AUTO_LOGIN` | `0` | `1` = 啟動時找不到 JWT 就自動走 GitHub device flow 登入（需 TTY）。登入成功後，JWT 會同時寫入 `~/.free-pi/agent/credentials.json` 與 `.env` |
| `FREEPI_WRITE_JWT_TO_ENV` | `1` | `1` = 從 device flow 取得 JWT 後，自動寫入 `.env` 檔案；`0` = 僅寫入 credentials.json |
| `FREEPI_BASE_URL` | `https://api.freepi.ai` | 上游 Base URL |
| `FREEPI_CLIENT_VERSION` | `0.4.10` | CLI 版本字串（上游有強制更新閘門）。設定方式（優先順序：命令列參數 > 環境變數/.env > 預設值）：<br>1. `bun server.mjs --client-version 0.6.14`<br>2. `FREEPI_CLIENT_VERSION=0.6.14`（或在 `.env` 中設定） |
| `PROXY_PORT` | `6447` | 監聽埠 |
| `LOG_LEVEL` | `info` | `debug\|info\|warn\|error\|silent`，見下表详细說明 |
| `AD_REFRESH_MS` | `600000` | 廣告刷新間隔（毫秒），預設 600000ms = 10 分鐘 |
| `SESSION_TTL_MS` | `1800000` | Session 存活時間（毫秒），0 = 不復用 |

### LOG_LEVEL 行為表

| LOG_LEVEL | 啟動 banner | 模型列表 | 每個請求 `[GRAVITY]` 有廣告 | 每個請求 `[GRAVITY]` 無廣告 | 錯誤訊息 |
|-----------|------------|----------|---------------------------|---------------------------|----------|
| `debug` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `info` | ✅ | ✅ | ✅ | ❌ | ✅ |
| `warn` | ✅ | ✅ | ✅ | ❌ | ✅ + 警告 |
| `error` | ✅ | ✅ | ❌ | ❌ | 只顯示錯誤 |
| `silent` | ❌ | ❌ | ❌ | ❌ | ❌（完全靜默） |
| `KEYS_FILE` | `./api-keys.json` | API Keys 檔案路徑 |
| `MASK_KEYS` | `0` | `1` = 啟動時遮罩印出的 keys |
| `GRAVITY_PIXEL_ID` | `6cd74804-0541-4d9b-899d-d7fceb465b6f` | Gravity 像素 ID，與 free-pi-cli 相同，一般無需修改 |
| `GRAVITY_STORAGE_DIR` | `~/.free-pi/gravity` | Gravity 儲存目錄 |
| `GRAVITY_DISABLE_PIXEL` | `0` | `1` = 停用 Gravity pixel（但可能導致 403 廣告錯誤） |
| `AD_REFRESH_MS` | `600000` | 廣告刷新間隔（毫秒），預設 600000ms = 10 分鐘 |

> ⚠️ **廣告展示**：proxy 會自動初始化 Gravity pixel 並自動獲取/展示廣告（GET /ads/next + GET imp_url + POST /ads/impression）。
> **不需要執行 `npx free-pi-cli@latest` 來看廣告。** proxy 會在背景處理廣告追蹤，不顯示廣告卡片。

> ⚠️ **版本閘門**：上游目前要求 `x-client-version` ≥ `0.6.2`。
> 若遇到 `your free-pi-cli is below the required minimum`，請透過任一方式設定版本為 `0.6.14`（或 npm 上最新版）後重啟 proxy：
> ```powershell
> # 方式 1：命令列參數（推薦，臨時）
> bun server.mjs --client-version 0.6.14
>
> # 方式 2：環境變數（或編輯 .env 檔案）
> $env:FREEPI_CLIENT_VERSION="0.6.14"; bun server.mjs
> ```

> ⚠️ **Session 自動重置**：上游限制每個帳號最多 4 個並行 CLI session。
> 若收到 `You've already got 4 free-pi CLI sessions running`，proxy 會在啟動時自動調用 `POST /session/reset` 釋放殘留 session。
> 若請求時收到 409 錯誤，proxy 會自動重置並重試一次。
> 無需手動執行 `/close-other-session` 或 `npx free-pi-cli@latest`。

## 專案結構

```
free-pi-cli-proxy/
├── server.mjs          # 主程式（單一檔案、無建置步驟、ESM）
├── login.mjs           # GitHub device flow 登入工具（取得 JWT，取代 npx free-pi-cli）
├── start.bat           # Windows 常駐啟動腳本
├── .env.example        # 環境變數範例
├── package.json
├── api-keys.json       # 自動生成（首次啟動）
├── logs/
│   └── proxy.log       # 執行 log（10MB 輪替）
└── test/
    ├── mock_server.mjs # 假上游（測試用）
    └── test_all.mjs    # 測試套件
```

## 架構說明

本專案參考 `C:\work\opencode-free-proxy\server.mjs` 風格實作，但因 free-pi.ai 上游**無 TLS 指紋閘門、無請求形狀檢查**，實作大幅簡化：

- **無需**仿冒官方 system prompt、工具表、digest 改名
- **純透傳**設計：client body 白名單參數直達上游
- 上游認證：`Authorization: Bearer <JWT>` + `x-session-id` + `x-client-version`
- 模型清單：`GET /client-version` → `models[].id` 即為 request model 值

## 開發/測試

```bash
# 安裝依賴
bun install

# 執行測試（內建 mock 上游，會自動啟動與關閉，不需先開 proxy）
bun run test
# 或
node test/test_all.mjs

# 或直接啟動實測
bun server.mjs
# 另開終端機：
curl http://127.0.0.1:6447/health
curl http://127.0.0.1:6447/v1/models -H "Authorization: Bearer fp-xxx"
```

## 多帳號輪流使用（備註）

free-pi.ai 上游限制每個帳號每日免費額度。如果您有多個 GitHub 帳號（每個都有免費額度），可以通過以下方式輪流使用：

1. **準備多個 JWT**：分別登入多個免-pi-cli 帳號，取得各自的 JWT。
2. **輪流切換**：在 `.env` 中切換 `FREEPI_JWT` 環境變數，重啟 proxy 即可切換帳號。
3. **自動化輪流（建議）**：可編寫簡單腳本，當一個帳號額度用盡（收到 429 或額度為 0）時，自動切換到下一個帳號的 JWT 並重啟 proxy。

> 注意：目前版本尚未實作全自動輪流，需要手動切換 `.env` 中的 `FREEPI_JWT` 並重啟 proxy。

## 授權

MIT License