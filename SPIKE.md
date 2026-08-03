# Phase 0 Spike 驗收步驟

**要證明的假設**：plugin 內建的**無認證** MCP server，能不能在 Cowork / claude.ai 掛上。

這是整個架構唯一會被推翻的地方。程式全部寫完、測試全綠，都還不算數——
這一步沒過，客戶就用不到，其他做得再好也是白費。**所以先做這個，再開始接 Notion。**

程式碼已就緒且本機驗過：`npm test` 30/30 通過，`wrangler dev` 上三個 tool 走真實 HTTP
抓內容都正常。剩下的都是需要你的帳號才能做的步驟。

---

## 1. 部署 Worker

```bash
cd worker && npx wrangler login
```

```bash
cd worker && npx wrangler deploy
```

部署完會印出網址，形如 `https://oakmega-manual-mcp.<你的子網域>.workers.dev`。

用瀏覽器打開該網址確認活著——會看到一段 JSON，裡面的 `mcp_endpoint` 就是下一步要填的。

> 此時內容 repo 還不存在，所以 `search_manual` 會失敗。**這不影響 spike**：
> 我們現在要驗的是「連得上、看得到 tool」，不是「查得到內容」。
> `tools/list` 有回東西就達標。

## 2. 把網址填進 plugin

編輯 `oakmega-manual/.mcp.json`，把 `REPLACE-ME` 換成實際子網域：

```bash
sed -i '' 's|https://REPLACE-ME.workers.dev/mcp|<貼上你的 mcp_endpoint>|' oakmega-manual/.mcp.json
```

## 3. 推上 GitHub（必須 public）

```bash
git init && git add -A && git commit -m "OakMega 手冊 plugin 與 MCP server"
```

```bash
gh repo create OakMega-Samuel/oakmega-manual-plugin --public --source=. --push
```

## 4. 在 Claude Code 驗（快，先做這個）

```bash
claude mcp add --transport http oakmega-manual https://oakmega-manual-mcp.samuel-jeng.workers.dev/mcp
```

開一個新 session，問「列出 OakMega 手冊有哪些 tool 可用」。

## 5. 在 Cowork / claude.ai 驗（**這步才是真正的 gate**）

1. 開 Cowork → **Customize** → **Plugins**
2. **Personal plugins** 區塊按 `+` → **Add marketplace**
3. 填 `OakMega-Samuel/oakmega-manual-plugin`
4. 安裝 `oakmega-manual`
5. 新開一個對話，確認三個 tool（`search_manual` / `get_manual_page` /
   `list_manual_sections`）出現且可呼叫

---

## 通過標準

- [ ] Claude Code 看得到三個 tool
- [ ] **Cowork / claude.ai 看得到三個 tool**
- [ ] **全程沒有跳出任何登入 / 授權 / OAuth 畫面**

三項都過 → 架構成立，接著去設定內容 repo（見 `oakmega-manual-content/README.md`）。

## 沒過的話

先確認失敗模式，不同症狀對應不同解法：

| 症狀 | 意義 | 對策 |
|---|---|---|
| 跳出 OAuth 授權畫面 | claude.ai 對無認證 server 仍強制走 OAuth（[#402](https://github.com/anthropics/claude-ai-mcp/issues/402)） | 備援 A：幫 Worker 加一層 auto-approve 的 OAuth 2.1 provider（Cloudflare 有官方 `workers-oauth-provider` 模板） |
| 連線逾時 / 500 | Worker 或設定問題，不是架構問題 | `npx wrangler tail` 看即時 log |
| plugin 裝得起來但 tool 沒出現 | `.mcp.json` 沒被讀到 | 確認 `REPLACE-ME` 有換掉、JSON 格式正確 |
| Cowork 找不到 marketplace | repo 不是 public，或 manifest 位置錯 | 確認 repo 公開、`.claude-plugin/marketplace.json` 在 repo 根目錄 |
| tool 出現但呼叫失敗 | 正常——內容 repo 還沒建 | 這步不算失敗，繼續往下做 |

備援 B（固定 bearer token 走 Request headers）**不能當 Plan A**：
該功能仍在 beta 且需向 Anthropic 申請早期存取。

---

## 目前狀態（2026-08-03）

- Worker 已部署：`https://oakmega-manual-mcp.samuel-jeng.workers.dev`
- Plugin repo 已推上：`OakMega-Samuel/oakmega-manual-plugin`（public）

> **repo 暫時掛在個人帳號下。** `OakMega-Samuel` 在 `oakmega` org 沒有建立 repo 的權限
> （在既有 repo 上是 push 而非 admin）。spike 驗過之後，請 org admin 把 repo transfer
> 到 `oakmega` —— GitHub 會保留舊網址的轉址，已安裝的客戶不會斷。轉完記得回頭更新
> 本檔與 README 裡的 marketplace 路徑。

### 已經查明的事（踩過的坑，別再踩一次）

**1. `.mcp.json` 不要寫 `"type": "http"`。**
`"type": "http"` 是 Claude Code 的寫法（官方 Notion / Figma plugin 都這樣寫），
但桌面 app 上實際能用的 plugin 全都是「不寫 type」或 `"sse"`。已改成不寫。

**2. `POST /mcp` 必須回 `text/event-stream`，不能回 `application/json`。**
Streamable HTTP 規格兩種都允許，但桌面 app 的 connector 流程只吃 SSE。
回純 JSON 時它**不報錯**——只是按鈕沒反應、連請求都不發，極難查。
已改成依 `Accept` 做內容協商，`worker/test/mcp.test.js` 有三條測試釘住。

比對方法：拿同一台機器上已知能用的 plugin 來對照。它們在
`~/Library/Application Support/Claude/local-agent-mode-sessions/*/*/rpm/plugin_*/.mcp.json`。

**3. Plugin 詳情頁 → Connectors 分頁的「Install」按鈕目前按了沒有作用。**
現象：不發任何網路請求、app log 無錯誤、Worker log 全空。
在設定與回應格式都已對齊已知可用的 connector 之後仍然如此，研判是 app 端問題。
**繞道**：改用側邊欄的 **Customize → Connectors → Add custom connector**，直接貼網址。

**4. Push 到 GitHub 後 plugin 不會自動更新。**
App log：`github_repo_not_accessible — Automatic sync on push requires the Claude
GitHub App to be installed on this repository.`
每次都要手動按 Update。要自動同步就去 https://github.com/apps/claude 把 App 裝到該 repo。

### 已排除的可能性

Server 本身沒問題，不用再往這個方向查：

- 官方 `@modelcontextprotocol/sdk` 客戶端連得上，`tools/list` 回傳三個 tool
- `initialize` / `tools/list` / `tools/call` 線上實測皆正常
- 回應的 Content-Type 已與已知可用的 connector 完全一致

### 還沒驗的

**直接加 custom connector**（側邊欄 Connectors，非 plugin 分頁）。
這才是原本定義的 gate，也是唯一還能驗證 #402 的路徑。
