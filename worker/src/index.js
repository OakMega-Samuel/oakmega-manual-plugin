/**
 * OakMega 手冊 MCP server。
 *
 * 內容來自 oakmega-manual-content repo（由 Notion 每小時同步而來），
 * 這裡只負責「搜尋 + 取頁」，本身不存任何內容。
 *
 * 刻意只給三個 tool。給多了模型會挑錯——而且這三個已經涵蓋完整的查閱流程：
 * 先 search_manual 找，找不到方向就 list_manual_sections 瀏覽，鎖定後 get_manual_page 讀全文。
 *
 * 不做認證：手冊本來就是公開的，加認證只會讓客戶端多一道設定。
 * 濫用防護交給 Cloudflare 的 rate limiting。
 */
import { createMcpHandler, textResult, errorResult } from './mcp.js';
import { ContentStore, ContentError } from './content.js';
import { scoreQuery, extractSnippet } from './search.js';

const VERSION = '1.0.0';
const DEFAULT_SEARCH_LIMIT = 5;
const MAX_SEARCH_LIMIT = 15;

const INSTRUCTIONS = `
OakMega 產品說明手冊的唯一查詢管道。內容以 Notion 為來源，每小時自動同步。

回答任何 OakMega 產品的操作、設定、規格、限制問題時，一律先查手冊，不要憑記憶回答。
典型流程：search_manual 找到候選頁 → get_manual_page 讀全文 → 回答時附上該頁的 notion_url。
`.trim();

/** 從 markdown 的 front-matter 撈欄位，讓 get_manual_page 能一併回傳來源連結。 */
function readFrontMatter(markdown) {
  const match = markdown.match(/^---\n([\s\S]*?)\n---\n/);
  if (!match) return {};

  const fields = {};
  for (const line of match[1].split('\n')) {
    const kv = line.match(/^([a-z_]+):\s*(.*)$/);
    if (!kv) continue;
    fields[kv[1]] = kv[2].replace(/^"(.*)"$/, '$1');
  }
  return fields;
}

/** 匯出給測試用：可以直接餵假的 store 呼叫 handler，不必起整個 Worker。 */
export const tools = [
  {
    name: 'search_manual',
    title: 'Search OakMega Manual',
    description:
      '在 OakMega 產品說明手冊中全文搜尋，回傳最相關的頁面與命中片段。' +
      '任何關於 OakMega 功能怎麼用、設定在哪、規格與限制的問題，都先用這個查。' +
      '查詢用自然語言或關鍵字皆可，中英文都支援。' +
      '拿到結果後若片段不足以回答，再用 get_manual_page 讀該頁全文。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '要查的關鍵字或問題，例如「會員標籤怎麼批次匯入」。' },
        limit: {
          type: 'integer',
          description: `回傳幾筆，預設 ${DEFAULT_SEARCH_LIMIT}，上限 ${MAX_SEARCH_LIMIT}。`,
          minimum: 1,
          maximum: MAX_SEARCH_LIMIT,
        },
      },
      required: ['query'],
    },
    async handler({ query, limit }, { store }) {
      if (!query || typeof query !== 'string' || !query.trim()) {
        return errorResult('query 不可為空。');
      }

      const index = await store.getSearchIndex();
      const take = Math.min(Math.max(Number(limit) || DEFAULT_SEARCH_LIMIT, 1), MAX_SEARCH_LIMIT);
      const { results, queryTokens, warning } = scoreQuery(index, query, take);

      if (!results.length) {
        return textResult({
          query,
          results: [],
          hint: '手冊裡查無相符內容。可以換個說法再查一次，或用 list_manual_sections 看看有哪些主題。',
          ...(warning ? { warning } : {}),
        });
      }

      // 為前幾筆抓原文截片段。並行 + 有快取，成本不高，
      // 但讓模型看得到「命中在講什麼」，比只給開頭摘要準得多。
      const withSnippets = await Promise.all(
        results.map(async ({ doc, score }) => {
          let snippet = null;
          try {
            const markdown = await store.getPage(doc.path);
            snippet = extractSnippet(markdown, queryTokens);
          } catch {
            // 抓不到原文就退回摘要，不要讓整次搜尋失敗。
          }

          return {
            path: doc.path,
            title: doc.title,
            breadcrumb: doc.breadcrumb.join(' › '),
            snippet: snippet ?? doc.summary,
            notion_url: doc.notion_url,
            score: Number(score.toFixed(3)),
          };
        }),
      );

      return textResult({
        query,
        results: withSnippets,
        next_step: '需要完整內容時，用 get_manual_page 帶上面的 path。',
        ...(warning ? { warning } : {}),
      });
    },
  },

  {
    name: 'get_manual_page',
    title: 'Read OakMega Manual Page',
    description:
      '讀取手冊某一頁的完整內容。path 必須來自 search_manual 或 list_manual_sections 的回傳，不要自己拼。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '頁面路徑，例如 manual/會員標籤管理-1a2b3c4d.md' },
      },
      required: ['path'],
    },
    async handler({ path }, { store }) {
      if (!path || typeof path !== 'string') return errorResult('path 不可為空。');

      const markdown = await store.getPage(path);
      const frontMatter = readFrontMatter(markdown);
      const body = markdown.replace(/^---\n[\s\S]*?\n---\n/, '').trim();

      return textResult({
        path,
        title: frontMatter.title ?? '',
        notion_url: frontMatter.notion_url ?? '',
        last_edited_time: frontMatter.last_edited_time ?? '',
        content: body,
        note: '回答使用者時請附上 notion_url，方便他們回頭看原文。',
      });
    },
  },

  {
    name: 'list_manual_sections',
    title: 'Browse OakMega Manual',
    description:
      '列出手冊的完整目錄樹（標題、路徑、一句摘要）。' +
      '當使用者的問題太籠統、或 search_manual 找不到東西而需要知道手冊涵蓋哪些主題時使用。',
    inputSchema: { type: 'object', properties: {}, required: [] },
    async handler(_args, { store }) {
      const index = await store.getIndex();

      return textResult({
        page_count: index.page_count,
        content_last_edited: index.content_last_edited,
        tree: index.tree,
      });
    },
  },
];

/**
 * 匯出給測試用：測試可以自己餵一個假的 store 進 ctx，
 * 走的仍是正式的派送路徑（含 tools/call 的錯誤包裝），不會漏測協定層行為。
 */
export const handleMcp = createMcpHandler({
  serverInfo: { name: 'oakmega-manual', version: VERSION },
  instructions: INSTRUCTIONS,
  tools,
});

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/' || url.pathname === '/health') {
      return Response.json({
        service: 'oakmega-manual-mcp',
        version: VERSION,
        mcp_endpoint: new URL('/mcp', url.origin).toString(),
        content_source: env.CONTENT_BASE_URL,
      });
    }

    if (url.pathname !== '/mcp') return new Response('Not found', { status: 404 });

    let store;
    try {
      store = new ContentStore(env.CONTENT_BASE_URL, ctx);
    } catch (err) {
      // 設定錯誤要講清楚，不要讓它變成每個 tool 都失敗的謎樣錯誤。
      return Response.json(
        { error: err instanceof ContentError ? err.message : String(err) },
        { status: 500 },
      );
    }

    return handleMcp(request, { env, ctx, store });
  },
};
