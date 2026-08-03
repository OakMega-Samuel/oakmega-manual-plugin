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
gh repo create oakmega/oakmega-manual-plugin --public --source=. --push
```

## 4. 在 Claude Code 驗（快，先做這個）

```bash
claude mcp add --transport http oakmega-manual https://<你的子網域>.workers.dev/mcp
```

開一個新 session，問「列出 OakMega 手冊有哪些 tool 可用」。

## 5. 在 Cowork / claude.ai 驗（**這步才是真正的 gate**）

1. 開 Cowork → **Customize** → **Plugins**
2. **Personal plugins** 區塊按 `+` → **Add marketplace**
3. 填 `oakmega/oakmega-manual-plugin`
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
