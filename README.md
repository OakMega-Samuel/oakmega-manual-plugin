# OakMega 手冊 Plugin

在 Claude 裡直接問 OakMega 產品說明手冊。**不需登入、不需 API key。**

手冊內容以 Notion 為唯一來源，每小時自動同步，所以你問到的永遠是最新版。

---

## 安裝

### Claude（Cowork / claude.ai / 桌面 app）

需要兩步。**兩步都要做**——只裝 plugin 的話 Claude 知道該查手冊卻沒有工具可用。

**第一步：加 connector（拿到三個 tool）**

1. **Customize** → **Connectors** → **Add custom connector**
2. 貼上 `https://oakmega-manual-mcp.samuel-jeng.workers.dev/mcp`

> 走側邊欄的 **Connectors**，不要走 plugin 詳情頁裡的 Connectors 分頁——
> 那個分頁的 Install 按鈕目前按了沒反應（詳見 SPIKE.md）。

**第二步：裝 plugin（拿到 manual-lookup skill）**

1. **Customize** → **Plugins**
2. **Personal plugins** 按 `+` → **Add marketplace**
3. 填入 `OakMega-Samuel/oakmega-manual-plugin`
4. 找到 **oakmega-manual**，按 **Install**

skill 的作用是告訴 Claude 何時該查手冊、以及不要憑記憶編造產品細節。

### Claude Code

```bash
claude plugin marketplace add OakMega-Samuel/oakmega-manual-plugin
```

```bash
claude plugin install oakmega-manual@oakmega-manual
```

### 只想接 MCP、不裝 plugin

```bash
claude mcp add --transport http oakmega-manual https://oakmega-manual-mcp.samuel-jeng.workers.dev/mcp
```

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
| `oakmega-manual/.mcp.json` | 宣告手冊 MCP server，裝 plugin 時自動接上 |
| `oakmega-manual/skills/manual-lookup/` | 教 Claude 何時該查手冊、以及不要憑記憶回答 |
| `worker/` | MCP server 本體（Cloudflare Worker），提供三個 tool |

三個 tool：

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
