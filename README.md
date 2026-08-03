# OakMega 手冊 Plugin

在 Claude 裡直接問 OakMega 產品說明手冊。**不需登入、不需 API key。**

手冊內容以 Notion 為唯一來源，每小時自動同步，所以你問到的永遠是最新版。

---

## 安裝

### Claude（claude.ai / Cowork / 桌面 app）

1. **Customize** → **Plugins**
2. **Personal plugins** 按 `+` → **Add marketplace**
3. 填入 `OakMega-Samuel/oakmega-manual-plugin`
4. 找到 **oakmega-manual**，按 **Install**

就這樣。**不需要加 connector、不需要登入、不需要管理員審核。**
手冊放在公開的 GitHub repo，Claude 直接用網頁抓取讀它。

### Claude Code

```bash
claude plugin marketplace add OakMega-Samuel/oakmega-manual-plugin
```

```bash
claude plugin install oakmega-manual@oakmega-manual
```

### 進階：接 MCP server（選用，檢索品質較好）

內部使用 Claude Code 的同事可以額外接上 MCP server。它在 server 端跑 BM25 排序，
只回相關片段，比讓模型自己看目錄挑更準、也更省 context：

```bash
claude mcp add --transport http oakmega-manual https://oakmega-manual-mcp.samuel-jeng.workers.dev/mcp
```

客戶不需要這個——Team 方案要加 custom connector 得過 owner 審核，
對推廣手冊來說門檻太高，所以客戶路徑走的是公開 repo 直接抓取。

---

## 怎麼用

裝好之後直接問就好，不需要特別的指令：

- 「會員標籤最多可以貼幾個？」
- 「怎麼綁定 LINE 官方帳號？」
- 「API 的速率限制是多少？」
- 「推播沒送達通常是什麼原因？」

Claude 會自己查手冊、引用內容，並附上 Notion 原文連結讓你能回頭確認。

---

## 這個 plugin 裡有什麼

| 元件 | 說明 |
|---|---|
| `oakmega-manual/skills/manual-lookup/` | **客戶路徑的全部**。教 Claude 從公開 repo 抓手冊、以及不要憑記憶回答 |
| `oakmega-manual/.mcp.json` | 宣告 MCP server。只在 Claude Code / Cowork 生效，claude.ai 用不到 |
| `worker/` | MCP server 本體（Cloudflare Worker），選用路徑 |

內容取用方式（skill 驅動）：先抓 `INDEX.md` 這份目錄，它會依手冊大小告訴模型
要直接抓 `MANUAL.md` 全文、還是挑單頁抓。所有網址都是完整的，模型不用自己拼。

MCP server 的三個 tool（選用路徑）：

| Tool | 用途 |
|---|---|
| `search_manual` | 全文搜尋，回傳最相關頁面與命中片段 |
| `get_manual_page` | 讀取某一頁全文 |
| `list_manual_sections` | 列出完整目錄樹 |

---

## 開發

```bash
cd worker && npm install && npm test
```

```bash
cd worker && npx wrangler dev
```

部署：

```bash
cd worker && npx wrangler deploy
```

內容來源在 `worker/wrangler.toml` 的 `CONTENT_BASE_URL` 設定，指向
[oakmega-manual-content](https://github.com/oakmega/oakmega-manual-content) repo。

### 改動搜尋邏輯時

`worker/src/tokenize.js` 在內容 repo 有一份完全相同的副本。
**兩邊必須逐字一致**，否則索引與查詢的斷詞會對不上，搜尋會靜默失效。
改動時兩邊一起改，並把 `TOKENIZER_VERSION` 加一。

改完務必跑搜尋品質測試：

```bash
cd worker && node --test test/search-quality.test.js
```

那份測試用 15 題真實客戶問句驗證排序，比任何單元測試都更貼近實際體感。
