# JWT 管理規範 — free-pi-cli 與 free-pi-cli-proxy

> 本文件定義 `free-pi-cli` 與 `free-pi-cli-proxy` 之間的 JWT (JSON Web Token) 管理規範，目的是消除不同程序讀寫不同位置造成的混亂，確保兩者共存時 JWT 狀態可預期、一致。

---

## 1. 背景與問題

目前 `free-pi-cli` 與 `free-pi-cli-proxy` 共用同一個憑證檔案：

```
~/.free-pi/agent/credentials.json
```

兩者均可透過 GitHub device flow 取得新 JWT，並已實作**雙寫**機制（同時寫入 `credentials.json` 與 `.env`），避免讀寫位置不一致造成「明明登入了，proxy 卻沒生效」的情況。

| 程序 | 讀取來源（優先順序） | 寫入目標 | 備註 |
|------|---------------------|---------|------|
| `free-pi-cli` | `credentials.json` 僅此一處 | `credentials.json` (mode 0600) | 僅透過 GitHub device flow 取得新 JWT |
| `free-pi-cli-proxy` (`server.mjs`) | `FREEPI_JWT` env > `.env` > `credentials.json` | 正常啟動不寫；降級讀取後自動回寫 `.env` | 若三者皆無，可觸發 device flow 自動登入 |
| `free-pi-cli-proxy` (`deviceFlowLogin()`) | — | `credentials.json` **+ `.env`** | `FREEPI_WRITE_JWT_TO_ENV=1` 預設開啟 |
| `free-pi-cli-proxy` (`login.mjs`) | — | `credentials.json` **+ `.env`** | 已雙寫，與 `server.mjs` 行為一致 |

---

## 2. 單一事實來源 (Single Source of Truth)

對於 `free-pi-cli-proxy`，**以 `.env` 中的 `FREEPI_JWT` 作為執行時的 JWT 唯一生效來源**。

```
讀取優先級（固定不變）：
1. FREEPI_JWT 環境變數（最高，可臨時覆寫）
2. .env 檔案中的 FREEPI_JWT（推薦日常使用，持久化）
3. ~/.free-pi/agent/credentials.json（相容備份，免安裝 free-pi-cli 時的 fallback）
```

`credentials.json` 不再是 Proxy 的主要來源，僅作為與 `free-pi-cli` 相容的備份。

---

## 3. 雙寫原則 (Write-Both)

任何取得新 JWT 的程序，必須**同時寫入兩處**：

```
1. ~/.free-pi/agent/credentials.json  （mode 0600，供 CLI 與其他程式相容）
2. C:/work/free-pi-cli-proxy/.env     （FREEPI_JWT=...，供 Proxy 啟動直接讀取）
```

適用於所有登入入口：
- `login.mjs` —— 已實作雙寫（`saveJwt` 寫入 credentials.json，`writeJwtToEnvFile` 寫入 .env）
- `server.mjs` 的 `deviceFlowLogin()`（`FREEPI_AUTO_LOGIN=1`）—— 已實作，維持
- `free-pi-cli` 的登入流程 —— 若與 Proxy 共用環境，建議也同步寫入 Proxy 的 `.env`

---

## 4. 讀取降級與回寫 (Read-Fallback & Write-Back)

`server.mjs` 啟動時：

1. 優先讀取 `.env` 的 `FREEPI_JWT`
2. 若 `.env` 為空，fallback 至 `credentials.json`
3. **fallback 成功後，自動回寫到 `.env`**，使下次啟動走快速路徑，避免再次 fallback

---

## 5. 失效清除 (Invalidate-Clear)

當 JWT 導致 `401 Unauthorized` 時：

- 清除該來源（`.env` 或 `credentials.json` 中的對應值）
- 提示使用者重新執行登入流程
- 不應自動嘗試舊 JWT

---

## 6. 場景思想實驗（七個常見執行順序）

### 場景 A：乾淨環境，先執行 `login.mjs`，再啟動 `server.mjs`

```
1. bun login.mjs
   → 從上游取得 JWT_A
   → 雙寫：credentials.json 與 .env 都有 FREEPI_JWT=JWT_A

2. bun server.mjs
   → .env 優先，讀到 JWT_A
   → 啟動成功
```

**結果**：可運作。兩處都有 JWT_A，一致，無混亂。

---

### 場景 B：乾淨環境，直接啟動 `server.mjs`（`FREEPI_AUTO_LOGIN=1`）

```
1. FREEPI_AUTO_LOGIN=1 bun server.mjs
   → 三者皆無，觸發 deviceFlowLogin()
   → 取得 JWT_B
   → 雙寫：credentials.json 與 .env 都有 JWT_B
   → 啟動成功
```

**結果**：兩處都有 JWT_B，一致，無混亂。

---

### 場景 C：先 `login.mjs`（JWT_A），再啟動 `server.mjs`（`FREEPI_AUTO_LOGIN=1`）

```
1. bun login.mjs
   → 雙寫：credentials.json 與 .env 都有 JWT_A

2. FREEPI_AUTO_LOGIN=1 bun server.mjs
   → .env 非空（有 JWT_A），不觸發自動登入，直接使用 JWT_A
   → 啟動成功
```

**結果**：可運作，使用 JWT_A。

---

### 場景 D：先 `login.mjs`（JWT_A），再手動編輯 `.env` 加入 `FREEPI_JWT=JWT_X`，再啟動 `server.mjs`

```
1. bun login.mjs
   → 雙寫：credentials.json 與 .env 都有 JWT_A

2. 使用者手動編輯 .env，設 FREEPI_JWT=JWT_X（JWT_X ≠ JWT_A）

3. bun server.mjs
   → .env 優先，讀到 JWT_X
   → credentials.json 中的 JWT_A 被忽略
```

**結果**：server 使用 JWT_X，credentials.json 是孤立的 JWT_A。若日後再執行 `login.mjs`，會雙寫新 JWT，兩處重新一致。

---

### 場景 E：先啟動 `server.mjs`（自動登入，JWT_B 寫入兩處），再執行 `free-pi-cli`

```
1. FREEPI_AUTO_LOGIN=1 bun server.mjs
   → 取得 JWT_B
   → 雙寫：credentials.json 與 .env 都有 JWT_B

2. 執行 free-pi-cli
   → 讀取 credentials.json，得到 JWT_B
   → 與上游通訊，使用 JWT_B
```

**結果**：兩程序共用 JWT_B，一致。

---

### 場景 F：先啟動 `server.mjs`（JWT_B 在兩處），再執行 `bun login.mjs`（重新登入，JWT_C）

```
1. FREEPI_AUTO_LOGIN=1 bun server.mjs
   → 雙寫：credentials.json 與 .env 都有 JWT_B

2. bun login.mjs
   → 取得 JWT_C
   → 雙寫：credentials.json 與 .env 都更新為 JWT_C

3. 重新啟動 bun server.mjs
   → .env 優先，得到 JWT_C（最新的！）
   → 與 credentials.json 一致
```

**結果**：一致。因為 `login.mjs` 也會寫入 `.env`，所以不再出現舊的「場景 F」不一致問題。

---

### 場景 G：兩程序同時自動登入（競態條件）

```
1. 環境乾淨，credentials.json 不存在，.env 亦無 FREEPI_JWT

2. 幾乎同時：
   - 執行 free-pi-cli → 取得 JWT_D，寫入 credentials.json（僅單寫）
   - FREEPI_AUTO_LOGIN=1 bun server.mjs → 取得 JWT_E，雙寫 credentials.json 與 .env

3. 後寫入者覆寫先前者，credentials.json 最終內容取決於執行順序
```

**結果**：競態條件，可能丟失其中一個程序的 JWT。建議由 Proxy 統一負責 JWT 獲取與同步，避免兩程序同時自動登入。

---

## 7. 推薦操作流程（使用者視角）

### 初次設定（兩程序都要用）

```powershell
# 在 C:/work/free-pi-cli-proxy/ 目錄下
$env:FREEPI_AUTO_LOGIN="1"; $env:FREEPI_WRITE_JWT_TO_ENV="1"; bun server.mjs
# → Proxy 自動登入，同時雙寫 credentials.json 與 .env

# 接著在另一個終端執行 free-pi-cli
npx free-pi-cli
# → 讀取 credentials.json，取得相同的 JWT，可正常運作
```

### 日常操作

| 情境 | 推薦做法 |
|------|---------|
| 啟動 Proxy | `bun server.mjs`（讀取 `.env`，無需再登入） |
| 啟動 CLI | `npx free-pi-cli`（讀取 `credentials.json`） |
| JWT 過期需重登 | 編輯 `.env` 移除 `FREEPI_JWT`，再執行 `FREEPI_AUTO_LOGIN=1 bun server.mjs`（自動雙寫） |
| 僅想用 CLI | `bun login.mjs`（已自動雙寫到 `.env` 與 `credentials.json`，無須手動複製） |

---

## 8. 總結（規範陳述）

> **JWT 管理規範（CLI + Proxy 共存）**：
> 1. 以 `.env` 中的 `FREEPI_JWT` 為 `free-pi-cli-proxy` 的單一事實來源；
> 2. 所有登入程序取得新 JWT 後，必須**雙寫** `credentials.json` 與 `.env`；
> 3. `server.mjs` 啟動時優先讀 `.env`，若無則 fallback 至 `credentials.json` 並自動回寫 `.env`；
> 4. JWT 失效時清除對應來源，提示重新登入；
> 5. 避免兩程序同時自動登入，建議由 Proxy 統一負責 JWT 獲取與同步。

這樣定義後，無論 CLI 與 Proxy 哪個先執行、哪個先重新登入，JWT 的位置與生效版本都可預期，不會再產生「這個程式讀那個，那個程式寫這個」的混亂。

---

**文件維護**：本規範隨 `free-pi-cli-proxy` 專案維護，若 `login.mjs` 或 `server.mjs` 變更讀寫行為，請同步更新本文件。
