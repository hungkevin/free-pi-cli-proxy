# 開發提示詞：free-pi-cli-proxy

> 將本檔內容貼給工作區 `C:\work\free-pi-cli-proxy\` 中的 AI 會話即可繼續開發。
> 本檔記錄專案目前實際狀態與所有已實作功能，供後續會話參考。

─────────────────────────────────────────────────────────────────────────────
# 專案概覽

**免費 AI 模型本地代理伺服器**（free-pi-cli-proxy），將 free-pi-cli（https://github.com/dennisonbertram/free-pi-cli）背後的免費 AI 模型透過 OpenAI/Anthropic 相容 API 暴露出來，讓任何 OpenAI/Anthropic 相容客戶端都能直接使用。

參考專案：`C:\work\opencode-free-proxy\server.mjs`（約 4184 行，Express + Bun）。本專案為 free-pi 上游協定的更簡單實作（無 TLS 指紋、無請求形狀檢查、純透傳設計）。

## 已完成項目（全部）

| 項目 | 狀態 | 說明 |
|------|------|------|
| `server.mjs` | ✅ 完成 | 單一 ESM 檔案，無建置步驟，約 2600 行 |
| `login.mjs` | ✅ 完成 | 內建 GitHub device flow 登入工具（取代 `npx free-pi-cli`） |
| `start.bat` | ✅ 完成 | Windows 常駐啟動腳本（log 輪替 10MB） |
| `kill-6447.ps1` | ✅ 完成 | 關閉 proxy 並釋放 port 6447 |
| `.env` | ✅ 完成 | 環境變數設定檔（所有設定皆在此） |
| `.env.example` | ✅ 完成 | 環境變數範本（詳細說明） |
| `README.md` | ✅ 完成 | 完整使用說明（繁體中文） |
| `package.json` | ✅ 完成 | 含 `start` / `dev` / `login` / `test` 腳本 |
| `test/mock_server.mjs` | ✅ 完成 | 假上游伺服器（測試用） |
| `test/test_all.mjs` | ✅ 完成 | 測試套件（/v1/models、chat sync/stream、Anthropic 等） |
| `node_modules/` | ✅ 已安裝 | express + @gravity-ai/api |

─────────────────────────────────────────────────────────────────────────────
# 已實作功能（server.mjs）

## 1. API Key 認證
- `api-keys.json`：不存在則自動生成 `{ "admin": "fp-<hex>", "user-default": "fp-<hex>" }`
- 無效 JSON 存在則拒絕啟動
- `safeEqual`（timingSafeEqual）驗證 `Authorization: Bearer <key>` 或 `x-api-key`
- `MASK_KEYS=1` 可遮罩啟動時印出的 key

## 2. JWT 認證（上游 free-pi.ai）
支援單一與多帳號 JWT 輪替（Multi-account Rotation）：

取得方式（優先順序：命令列參數 > 環境變數/.env > credentials 檔）：
1. `FREEPI_JWT_LIST` 環境變數（多個 JWT，逗號或換行分隔，來自不同 GitHub 帳號；支援自動輪替）
2. `FREEPI_JWT` 環境變數（單一 JWT，推薦部署/容器）
3. `~/.free-pi/agent/credentials.json`（free-pi-cli 登入產生）
4. `bun login.mjs`（本專案內建 GitHub device flow，免安裝 free-pi-cli）

`FREEPI_AUTO_LOGIN=1`：啟動時若找不到 JWT，自動走 GitHub device flow 登入（需互動式 TTY）
`FREEPI_WRITE_JWT_TO_ENV=1`：登入成功後自動將 JWT 寫回 `.env`（預設開啟）

多帳號輪替行為：
- 啟動時驗證所有 JWT，選擇剩餘額度最高的 active 帳號
- 收到 429 rate_limit_exceeded（每小時限制）時，標記該帳號並立即切換到下一個 active 帳號
- 收到 429 creditlimitexceeded / insufficient_quota（每日額度用完）時，標記該帳號並切換到下一個帳號
- `/health` 端點顯示所有帳號狀態與剩餘額度

## 3. Gravity 廣告機制（完全自動化，免執行 npx free-pi-cli@latest）

### 廣告機制的三個層次（從 free-pi-cli 原始碼分析）

| 層次 | 檔案 | 作用 | Proxy 是否實作 |
|------|------|------|---------------|
| **Gravity Pixel** | `src/gravity-pixel.ts` | 建立與 Gravity 廣告網路的 session，獲取 sessionId | ✅ 已實作 |
| **廣告獲取** | `src/vendor/pi-ads/api.ts` | `GET /ads/next?slot=banner` 獲取廣告 | ✅ 已實作 |
| **廣告展示上報** | `src/vendor/pi-ads/banner.ts` | 觸發 Gravity 展示像素 URL，POST /ads/impression 上報 | ✅ 已實作 |

### 廣告流程（完全自動化）

1. **啟動時**：自動調用 `GET /ads/next?slot=banner` 獲取廣告
2. **展示像素**：`GET ad.imp_url`（fire-and-forget，觸發 Gravity 像素）
3. **上報展示**：`POST /ads/impression`（`{ ad_id, click_token, imp_fired: true }`）
4. **背景刷新**：每 `AD_REFRESH_MS` 毫秒（預設 600,000ms = 10 分鐘）重複上述流程

上游伺服器檢查「廣告展示記錄」，而不只是「有 gravity session」。實作完整展示流程後，proxy 可以完全免執行 `npx free-pi-cli@latest`。

### 環境變數
- `GRAVITY_PIXEL_ID`：Gravity 像素 ID（預設 `6cd74804-0541-4d9b-899d-d7fceb465b6f`，與 free-pi-cli 相同）
- `GRAVITY_STORAGE_DIR`：Gravity 儲存目錄（預設 `~/.free-pi/gravity`）
- `GRAVITY_DISABLE_PIXEL=1`：停用 Gravity pixel（可能導致 403 廣告錯誤）
- `AD_REFRESH_MS`：廣告刷新間隔（預設 600000ms = 10 分鐘）

─────────────────────────────────────────────────────────────────────────────

## 4. 模型清單（從 /client-version）
- 啟動時 `GET {FREEPI_BASE_URL}/client-version`（10s 超時，失敗 fail-open 到內建 DEFAULT_MODELS）
- 每 30 分鐘背景刷新
- `GET /v1/models`：OpenAI list 格式（`object:"list"`, data[]：id/object:"model"/created/owned_by:"free-pi"/name）

## 5. 聊天完成（OpenAI 相容）
- `POST /v1/chat/completions`：驗證 API key → 驗證 model → 驗證 messages → 透傳上游
- 支援 `stream=true`（SSE 逐行透傳，含 [DONE]）與 `stream=false`（聚合成單一 chat.completion JSON）
- 上游非 200 → 讀 body、分類錯誤（quota/429/401/其他）→ OpenAI error 形狀回傳真實狀態碼
- 429 依 Retry-After 退避重試最多 4 次；Retry-After > 5 分鐘（日額度用盡）時快速失敗不重試
- 生成參數白名單直達上游（temperature/top_p/max_tokens 等）

## 6. Anthropic Messages 相容
- `POST /v1/messages`：Anthropic ↔ OpenAI 雙向轉譯
- 支援 `stream=true`（SSE 格式）與 `stream=false`（JSON）
- tool_use / tool_result 區塊轉換

## 7. 健康檢查
- `GET /health`：status、version、runtime、models 數、models_source、models_loaded_at、upstream_auth、client_version、session_ttl_ms、**currentAccount**、**currentAccountLabel**、**quota**（當前帳號）、**accounts**（所有帳號狀態與額度）、endpoints 清單

## 8. Session 映射
- 依 API key + 可選 `x-session-id` header 復用上游 session id
- TTL 30 分鐘（可調 `SESSION_TTL_MS`），上限 4096 條，過期自動清除

## 9. 日誌與關閉
- `LOG_LEVEL`：debug\|info\|warn\|error\|silent（預設 info；常駐建議 warn）
- `envInt` 防呆解析環境變數
- `SIGINT`/`SIGTERM` 優雅關閉（10s 強制超時）
- 檔尾 `export {...}` 匯出內部函數供 `test/` 使用，`isMainModule()` 保護 main

─────────────────────────────────────────────────────────────────────────────
# 環境變數（全部在 .env 設定，無需手動 export）

| 變數 | 預設 | 說明 |
|------|------|------|
| `FREEPI_JWT` | - | 單一 free-pi JWT（向後相容） |
| `FREEPI_JWT_LIST` | - | 多個 JWT（逗號或換行分隔，來自不同 GitHub 帳號，支援自動輪替） |
| `FREEPI_AUTO_LOGIN` | `0` | `1` = 啟動時找不到 JWT 就自動走 GitHub device flow（需 TTY） |
| `FREEPI_WRITE_JWT_TO_ENV` | `1` | `1` = 登入後自動寫回 `.env` |
| `FREEPI_BASE_URL` | `https://api.freepi.ai` | 上游 Base URL |
| `FREEPI_CLIENT_VERSION` | `0.4.10` | CLI 版本字串（上游有 minCliVersion 閘門，建議 `0.6.14`） |
| `PROXY_PORT` | `6447` | 監聽埠（避開 opencode-free-proxy 的 6446） |
| `PROXY_HOST` | `0.0.0.0` | 監聽介面 |
| `LOG_LEVEL` | `info` | `debug\|info\|warn\|error\|silent` |
| `SESSION_TTL_MS` | `1800000` | Session 存活時間（毫秒），0 = 不復用 |
| `KEYS_FILE` | `./api-keys.json` | API Keys 檔案路徑 |
| `MASK_KEYS` | `0` | `1` = 啟動時遮罩印出的 keys |
| `GRAVITY_PIXEL_ID` | `6cd74804-0541-4d9b-899d-d7fceb465b6f` | Gravity 像素 ID（與 free-pi-cli 相同） |
| `GRAVITY_STORAGE_DIR` | `~/.free-pi/gravity` | Gravity 儲存目錄 |
| `GRAVITY_DISABLE_PIXEL` | `0` | `1` = 停用 Gravity pixel（可能導致 403 廣告錯誤） |
| `RETRY_429_MAX` | `4` | 最大 429 重試次數 |
| `RETRY_429_BASE_MS` | `2000` | 基礎退避時間（毫秒） |
| `RETRY_429_CAP_MS` | `30000` | 單次退避上限（毫秒） |
| `RETRY_429_HARD_LIMIT_MS` | `300000` | 超過此值（5 分鐘）視為日額度用盡，快速失敗 |
| `AD_REFRESH_MS` | `600000` | 廣告刷新間隔（毫秒），預設 600000ms = 10 分鐘 |

─────────────────────────────────────────────────────────────────────────────
## Session 自動重置（避免 409 session 限制錯誤）
- 啟動時自動調用 `POST {FREEPI_BASE_URL}/session/reset` 釋放殘留的 CLI session lease
- 上游限制每個帳號最多 4 個並行 session，超過會回 409 Too Many Sessions
- 若請求收到 409 錯誤，proxy 會自動重置 session 並重試一次（最多重試 1 次）
- log 會顯示 `[SESSION RESET] Cleared stuck session — slot freed`
- 無需手動執行 `/close-other-session` 或 `npx free-pi-cli@latest`

─────────────────────────────────────────────────────────────────────────────
# 啟動與關閉

## 啟動（從 .env 自動讀取所有設定）
```powershell
cd C:\work\free-pi-cli-proxy
bun server.mjs
```

## 首次登入（若無 JWT）
```powershell
cd C:\work\free-pi-cli-proxy
bun login.mjs          # 或 npm run login
# 在瀏覽器輸入顯示的 GitHub device flow 驗證碼
```

## 常駐啟動（Windows，自動重啟、log 輪替）
```powershell
start.bat
```

## 關閉 proxy（釋放 port 6447）
```powershell
Get-Process -Name "bun" | Stop-Process -Force
# 或
.\kill-6447.ps1
```

## 客戶端範例（OpenAI SDK）
```python
from openai import OpenAI
client = OpenAI(base_url="http://127.0.0.1:6447/v1", api_key="fp-你的key")
resp = client.chat.completions.create(
    model="deepseek-v4-flash",
    messages=[{"role": "user", "content": "你好"}],
)
print(resp.choices[0].message.content)
```

─────────────────────────────────────────────────────────────────────────────
# 測試

```powershell
cd C:\work\free-pi-cli-proxy
bun test             # 執行 test/test_all.mjs（內建 mock 上游，自動啟動與關閉，不需先開 proxy）
node test/mock_server.mjs   # 僅需在要手動實測時另開終端機啟動假上游
```

─────────────────────────────────────────────────────────────────────────────
# 硬性要求

- 語言：程式碼註解與 README 用繁體中文可，識別字用英文；回覆用戶用繁體中文。
- 不要修改 `C:\work\free-pi-cli\`（唯讀參考）與 `C:\work\opencode-free-proxy\`（唯讀參考）。
- 不要把 JWT 寫進 log（遮罩）。
- 上游 host 只有 api.freepi.ai 一個來源，不要引入第三方中轉。
- 廣告處理：proxy 自動初始化 Gravity pixel 並自動獲取/展示廣告，不顯示廣告卡片，**不需要**執行 `npx free-pi-cli@latest`。

─────────────────────────────────────────────────────────────────────────────
# 已知限制

- 上游每個帳號最多 4 個並行 CLI session。proxy 啟動時會自動呼叫 `POST /session/reset` 釋放殘留 session；若請求時收到 409，proxy 會自動重置並重試一次，無需手動操作。
- 若上游回 `Ads aren't showing for this account`，表示廣告展示未成功，請確認 Gravity pixel 未被停用（`GRAVITY_DISABLE_PIXEL` 不應為 1），或稍後重試。

─────────────────────────────────────────────────────────────────────────────
# 目錄結構

```
free-pi-cli-proxy/
├── server.mjs          # 主程式（單一檔案、無建置步驟、ESM）
├── login.mjs           # GitHub device flow 登入工具（取代 npx free-pi-cli）
├── start.bat           # Windows 常駐啟動腳本
├── kill-6447.ps1       # 關閉 proxy 並釋放 port 6447
├── .env                # 環境變數設定（所有設定皆在此）
├── .env.example        # 環境變數範本（詳細說明）
├── package.json
├── api-keys.json       # 自動生成（首次啟動）
├── logs/
│   └── proxy.log       # 執行 log（10MB 輪替）
└── test/
    ├── mock_server.mjs # 假上游（測試用）
    └── test_all.mjs    # 測試套件
```

─────────────────────────────────────────────────────────────────────────────
# 端點摘要

| 端點 | 方法 | 說明 |
|------|------|------|
| `/v1/chat/completions` | POST | OpenAI Chat Completions（支援 stream/sync） |
| `/v1/messages` | POST | Anthropic Messages（支援 stream/sync） |
| `/v1/models` | GET | 列出可用模型（OpenAI 格式） |
| `/health` | GET | 健康檢查與狀態資訊 |

─────────────────────────────────────────────────────────────────────────────
# 請求 Header

| Header | 必填 | 說明 |
|--------|------|------|
| `Authorization: Bearer <key>` | 是 | Proxy API Key（來自 `api-keys.json`） |
| `x-api-key: <key>` | 否 | 替代 Authorization header |
| `x-session-id: <id>` | 否 | 對話 ID，用於上游 session 復用 |

─────────────────────────────────────────────────────────────────────────────
# 結束
─────────────────────────────────────────────────────────────────────────────