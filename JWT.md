# JWT 管理規範 — free-pi-cli 與 free-pi-cli-proxy

> 本文件定義 `free-pi-cli` 與 `free-pi-cli-proxy` 之間的 JWT (JSON Web Token) 管理規範，目的是消除不同程序讀寫不同位置造成的混亂，確保兩者共存時 JWT 狀態可預期、一致。

---

## 1. 背景與問題

目前 `free-pi-cli` 與 `free-pi-cli-proxy` 共用同一個憑證檔案：

```
~/.free-pi/agent/credentials.json
```

`free-pi-cli-proxy` 現已支援**多帳號 JWT 輪替**（Multi-account JWT Rotation），可在單一帳號達到 hourly limit 或 daily quota 時，自動切換到另一個 GitHub 帳號的 JWT 繼續服務。

兩者均可透過 GitHub device flow 取得新 JWT，並已實作**雙寫**機制（同時寫入 `credentials.json` 與 `.env`），避免讀寫位置不一致造成「明明登入了，proxy 卻沒生效」的情況。

| 程序 | 讀取來源（優先順序） | 寫入目標 | 備註 |
|------|---------------------|---------|------|
| `free-pi-cli` | `credentials.json` 僅此一處 | `credentials.json` (mode 0600) | 僅透過 GitHub device flow 取得新 JWT |
| `free-pi-cli-proxy` (`server.mjs`) | `FREEPI_JWT_LIST` > `FREEPI_JWT` > `.env` > `credentials.json` | 正常啟動不寫；降級讀取後自動回寫 `.env` | 支援多帳號輪替 |
| `free-pi-cli-proxy` (`deviceFlowLogin()`) | — | `credentials.json` **+ `.env`** | `FREEPI_WRITE_JWT_TO_ENV=1` 預設開啟 |
| `free-pi-cli-proxy` (`login.mjs`) | — | `credentials.json` **+ `.env`** | 已雙寫，與 `server.mjs` 行為一致 |

---

## 2. 單一事實來源 (Single Source of Truth)

對於 `free-pi-cli-proxy`，JWT 的讀取優先級如下：

```
讀取優先級（固定不變）：
1. FREEPI_JWT_LIST 環境變數（多個 JWT，逗號分隔，來自不同 GitHub 帳號；最高優先級）
2. FREEPI_JWT 環境變數（單一 JWT，可臨時覆寫）
3. .env 檔案中的 FREEPI_JWT_LIST / FREEPI_JWT（推薦日常使用，持久化）
4. ~/.free-pi/agent/credentials.json（相容備份，免安裝 free-pi-cli 時的 fallback，單一 JWT）
```

`credentials.json` 不再是 Proxy 的主要來源，僅作為與 `free-pi-cli` 相容的備份。

---

## 3. 多帳號輪替 (Multi-account JWT Rotation)

free-pi.ai 對每個 GitHub 帳號有每小時請求上限（hourly limit）與每日免費額度（daily quota）。為避免單一帳號額度用完導致 proxy 無法使用，支援多個 JWT 自動輪替。

### 配置方式

在 `.env` 中設定 `FREEPI_JWT_LIST`（逗號分隔，來自不同 GitHub 帳號）：

```env
FREEPI_JWT_LIST=eyJhbGci…JWT_A,eyJhbGci…JWT_B,eyJhbGci…JWT_C
```

或單一 JWT（向後相容）：

```env
FREEPI_JWT=eyJhbGci…單一JWT
```

### 帳號狀態

每個 JWT 對應一個帳號，狀態如下：

| 狀態 | 意思 | 自動恢復 |
|------|------|----------|
| `active` | 正常可用 | — |
| `rate_limited` | 達到每小時請求上限 | 預計在下一個整點恢復 |
| `exhausted` | 每日免費額度用完 | 預計在明日 00:00 恢復 |
| `invalid` | JWT 無效（401） | 不自動恢復，需重新登入 |

### 轉換邏輯

1. 啟動時驗證所有 JWT，抓取 `/me` 額度，選擇剩餘額度最高的 active 帳號
2. 收到 `429 rate_limit_exceeded` → 標記該帳號為 `rate_limited`，立即切換到下一個 active 帳號
3. 收到 `429 creditlimitexceeded` / `insufficient_quota` → 標記該帳號為 `exhausted`，切換到下一個 active 帳號
4. 所有帳號皆不可用時，才將 429 錯誤回傳給客戶端
5. `/health` 端點顯示所有帳號的狀態與剩餘額度

> ⚠️ 這需要 **不同的 GitHub 帳號** 各自登入取得 JWT。同一個 GitHub 帳號的多個 JWT 共享同一個額度與限制，無法透過多 JWT 繞過 hourly limit。

---

## 4. 雙寫原則 (Write-Both)

任何取得新 JWT 的程序，必須**同時寫入兩處**：

```
1. ~/.free-pi/agent/credentials.json  （mode 0600，供 CLI 與其他程式相容）
2. C:/work/free-pi-cli-proxy/.env     （FREEPI_JWT=... 或 FREEPI_JWT_LIST=...，供 Proxy 啟動直接讀取）
```

適用於所有登入入口：
- `login.mjs` —— 已實作雙寫（`saveJwt` 寫入 credentials.json，`writeJwtToEnvFile` 寫入 .env）
- `server.mjs` 的 `deviceFlowLogin()`（`FREEPI_AUTO_LOGIN=1`）—— 已實作，維持
- `free-pi-cli` 的登入流程 —— 若與 Proxy 共用環境，建議也同步寫入 Proxy 的 `.env`

---

## 5. 讀取降級與回寫 (Read-Fallback & Write-Back)

`server.mjs` 啟動時：

1. 優先讀取 `.env` 的 `FREEPI_JWT_LIST`（多帳號）
2. 若無，讀取 `.env` 的 `FREEPI_JWT`（單一）
3. 若無，fallback 至 `credentials.json`
4. **fallback 成功後，自動回寫到 `.env`**，使下次啟動走快速路徑

---

## 6. 失效清除 (Invalidate-Clear)

當 JWT 導致 `401 Unauthorized` 時：

- 清除該來源（`.env` 或 `credentials.json` 中的對應值）
- 提示使用者重新執行登入流程
- 不應自動嘗試舊 JWT

---

## 7. 推薦操作流程（使用者視角）

### 初次設定（單一帳號）

```powershell
# 在 C:/work/free-pi-cli-proxy/ 目錄下
bun login.mjs
# → Proxy 自動登入，同時雙寫 credentials.json 與 .env
```

### 初次設定（多帳號輪替）

```powershell
# 在 C:/work/free-pi-cli-proxy/ 目錄下
# 分別登入兩個 GitHub 帳號，取得兩個 JWT
$env:FREEPI_JWT_LIST="JWT_A,JWT_B"; bun server.mjs
# → Proxy 啟動時會驗證兩個 JWT，選擇剩餘額度較高者
# → 若一個帳號 hit hourly limit，自動切換到另一個
```

### 日常操作

| 情境 | 推薦做法 |
|------|---------|
| 啟動 Proxy（單一帳號） | `bun server.mjs`（讀取 `.env`，無需再登入） |
| 啟動 Proxy（多帳號） | 設定 `FREEPI_JWT_LIST`，再 `bun server.mjs` |
| 啟動 CLI | `npx free-pi-cli`（讀取 `credentials.json`） |
| JWT 過期需重登 | 編輯 `.env` 移除 `FREEPI_JWT` / `FREEPI_JWT_LIST`，再執行 `FREEPI_AUTO_LOGIN=1 bun server.mjs` |
| 僅想用 CLI | `bun login.mjs`（已自動雙寫到 `.env` 與 `credentials.json`，無須手動複製） |

---

## 8. 總結（規範陳述）

> **JWT 管理規範（CLI + Proxy 共存）**：
> 1. 以 `.env` 中的 `FREEPI_JWT_LIST`（多帳號）或 `FREEPI_JWT`（單一）為 `free-pi-cli-proxy` 的單一事實來源；
> 2. 所有登入程序取得新 JWT 後，必須**雙寫** `credentials.json` 與 `.env`；
> 3. `server.mjs` 啟動時優先讀 `.env`，若無則 fallback 至 `credentials.json` 並自動回寫 `.env`；
> 4. 支援多帳號輪替：單一帳號 hit hourly/daily limit 時自動切換到下一個可用帳號；
> 5. JWT 失效時清除對應來源，提示重新登入；
> 6. 避免兩程序同時自動登入，建議由 Proxy 統一負責 JWT 獲取與同步。

這樣定義後，無論 CLI 與 Proxy 哪個先執行、哪個先重新登入，JWT 的位置與生效版本都可預期，不會再產生「這個程式讀那個，那個程式寫這個」的混亂。

---

**文件維護**：本規範隨 `free-pi-cli-proxy` 專案維護，若 `login.mjs` 或 `server.mjs` 變更讀寫行為，請同步更新本文件。
