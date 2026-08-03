/**
 * 從內容 repo 讀 INDEX.json / search.json / 各頁 markdown。
 *
 * 兩層快取：
 *   1. Cloudflare Cache API —— 跨 isolate 共用，避免每次請求都打 GitHub
 *   2. isolate 內的記憶體 —— 避免同一個 isolate 反覆 JSON.parse 幾 MB 的索引
 *
 * TTL 只有 60 秒。上游 cron 是每小時跑，所以這個新鮮度綽綽有餘，
 * 而且短 TTL 讓「手動觸發同步後想立刻看到效果」不必等。
 *
 * 刻意**不**把手冊打包進 Worker：那會讓每次內容更新都要重新部署，
 * 把「內容」跟「程式」的生命週期又綁回一起，正是這個架構要避免的事。
 */

const CACHE_TTL_SECONDS = 60;

/** isolate 內的記憶體快取，key → { value, expiresAt }。 */
const memo = new Map();

export class ContentError extends Error {
  constructor(message, { status } = {}) {
    super(message);
    this.name = 'ContentError';
    this.status = status;
  }
}

export class ContentStore {
  /**
   * @param {string} baseUrl 例如 https://raw.githubusercontent.com/oakmega/oakmega-manual-content/main
   * @param {ExecutionContext} [ctx]
   */
  constructor(baseUrl, ctx) {
    if (!baseUrl) throw new ContentError('缺少 CONTENT_BASE_URL 設定');
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.ctx = ctx;
  }

  /**
   * 路徑每一段都要 encodeURIComponent——手冊檔名保留中文，
   * 不編碼的話 raw.githubusercontent 會 404。
   */
  #urlFor(repoPath) {
    const encoded = repoPath.split('/').map(encodeURIComponent).join('/');
    return `${this.baseUrl}/${encoded}`;
  }

  async #fetchText(repoPath) {
    const url = this.#urlFor(repoPath);
    const cache = globalThis.caches?.default;
    const cacheKey = new Request(url, { method: 'GET' });

    if (cache) {
      const hit = await cache.match(cacheKey);
      if (hit) return hit.text();
    }

    const res = await fetch(url, { cf: { cacheTtl: CACHE_TTL_SECONDS, cacheEverything: true } });

    if (!res.ok) {
      throw new ContentError(
        res.status === 404
          ? `內容檔不存在：${repoPath}`
          : `讀取 ${repoPath} 失敗（HTTP ${res.status}）`,
        { status: res.status },
      );
    }

    const text = await res.text();

    if (cache) {
      const toCache = new Response(text, {
        headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': `max-age=${CACHE_TTL_SECONDS}` },
      });
      // waitUntil 讓寫快取不擋住回應。
      const write = cache.put(cacheKey, toCache);
      if (this.ctx?.waitUntil) this.ctx.waitUntil(write);
      else await write;
    }

    return text;
  }

  /** 讀 JSON 並在 isolate 內記憶，省下重複 parse 大檔的成本。 */
  async #fetchJson(repoPath) {
    const cached = memo.get(repoPath);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    const value = JSON.parse(await this.#fetchText(repoPath));
    memo.set(repoPath, { value, expiresAt: Date.now() + CACHE_TTL_SECONDS * 1000 });
    return value;
  }

  /** 目錄與摘要。 */
  async getIndex() {
    return this.#fetchJson('INDEX.json');
  }

  /** BM25 倒排索引。 */
  async getSearchIndex() {
    return this.#fetchJson('search.json');
  }

  /**
   * 讀某一頁的 markdown 原文。
   *
   * `repoPath` 來自模型，**一定要**比對索引裡的已知路徑後才去抓，
   * 否則等於讓任何人透過這個 tool 對 raw.githubusercontent 發任意請求。
   */
  async getPage(repoPath) {
    const index = await this.getIndex();
    const known = index.pages?.some((page) => page.path === repoPath);

    if (!known) {
      throw new ContentError(
        `手冊裡沒有這個路徑：${repoPath}。請先用 search_manual 或 list_manual_sections 取得正確路徑。`,
        { status: 404 },
      );
    }

    return this.#fetchText(repoPath);
  }
}
