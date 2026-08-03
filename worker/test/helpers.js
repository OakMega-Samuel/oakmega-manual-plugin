import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { handleMcp } from '../src/index.js';

const fixture = (name) =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8'));

export const INDEX = fixture('INDEX.json');
export const SEARCH_INDEX = fixture('search.json');
export const PAGES = fixture('pages.json');

/**
 * 假的 ContentStore，介面與 src/content.js 相同但直接讀 fixture。
 * 保留「路徑必須在索引裡」的檢查——那是安全機制，測試裡也要照走。
 */
export class FakeContentStore {
  constructor() {
    this.pageReads = [];
  }

  async getIndex() {
    return INDEX;
  }

  async getSearchIndex() {
    return SEARCH_INDEX;
  }

  async getPage(path) {
    this.pageReads.push(path);
    if (!INDEX.pages.some((page) => page.path === path)) {
      const err = new Error(`手冊裡沒有這個路徑：${path}`);
      err.status = 404;
      throw err;
    }
    return PAGES[path];
  }
}

let nextRequestId = 1;

/**
 * 發一次真正的 tools/call JSON-RPC 請求。
 *
 * 刻意**不**直接呼叫 tool.handler——handler 拋出的例外是由協定層轉成 isError 的，
 * 繞過協定層就測不到那段，錯誤處理會出現測試蓋不到的破口。
 */
export async function callTool(name, args = {}, store = new FakeContentStore()) {
  const res = await handleMcp(
    new Request('https://test.local/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: nextRequestId++,
        method: 'tools/call',
        params: { name, arguments: args },
      }),
    }),
    { store },
  );

  const body = await res.json();
  if (body.error) throw new Error(`JSON-RPC error ${body.error.code}: ${body.error.message}`);

  const text = body.result.content[0].text;
  return { isError: body.result.isError ?? false, text, payload: safeParse(text) };
}

function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
