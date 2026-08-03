/**
 * 搜尋品質驗收。
 *
 * 這份測試不驗程式對不對，驗的是**客戶問問題時會不會拿到對的頁面**。
 * 改斷詞、改權重、改 BM25 參數之後，這裡全綠才算沒有退步。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { callTool } from './helpers.js';

const { questions } = JSON.parse(
  readFileSync(fileURLToPath(new URL('./fixtures/questions.json', import.meta.url)), 'utf8'),
);

/** 期望頁面要出現在前幾名。放寬到 3 是因為手冊主題本來就會互相重疊。 */
const TOP_N = 3;

test(`${questions.length} 題真實問句，期望頁面都要進 top ${TOP_N}`, async () => {
  const failures = [];

  for (const { q, expect } of questions) {
    const { payload } = await callTool('search_manual', { query: q, limit: TOP_N });
    const paths = payload.results.map((result) => result.path);
    const rank = paths.findIndex((path) => path.includes(expect));

    if (rank === -1) {
      failures.push(`「${q}」→ 期望含「${expect}」，實際 top${TOP_N}：\n      ${paths.join('\n      ') || '(無結果)'}`);
    }
  }

  assert.equal(
    failures.length,
    0,
    `\n  ${failures.length}/${questions.length} 題沒命中：\n\n  - ${failures.join('\n\n  - ')}\n`,
  );
});

test('第一名的命中率要夠高，不能只是勉強擠進 top 3', async () => {
  let topOne = 0;

  for (const { q, expect } of questions) {
    const { payload } = await callTool('search_manual', { query: q, limit: 1 });
    if (payload.results[0]?.path.includes(expect)) topOne += 1;
  }

  const ratio = topOne / questions.length;
  assert.ok(
    ratio >= 0.7,
    `第一名命中率只有 ${(ratio * 100).toFixed(0)}%（${topOne}/${questions.length}），低於 70% 的門檻`,
  );
});

test('純中文查詢查得到東西 —— 沒有 bigram 斷詞的話這題必掛', async () => {
  const { payload } = await callTool('search_manual', { query: '標籤上限' });

  assert.ok(payload.results.length > 0, '純中文查詢不該是零結果');
  assert.ok(
    payload.results.some((result) => result.path.includes('標籤')),
    '「標籤上限」應該命中標籤相關頁面',
  );
});

test('回傳的片段是命中位置附近的內容，不是每次都給開頭', async () => {
  const { payload } = await callTool('search_manual', { query: '單次匯入上限 10000 筆' });
  const hit = payload.results.find((result) => result.path.includes('批次匯入標籤'));

  assert.ok(hit, '應該命中批次匯入那頁');
  assert.match(hit.snippet, /10000/, '片段應該包含實際命中的數字，而不是該頁開場白');
});

test('查不到時給的是可行的下一步，不是空陣列了事', async () => {
  // 用純亂碼而非「不存在的東西」之類的中文——後者的 bigram 很容易意外命中語料，
  // 讓這條測試隨手冊內容變動而時好時壞。
  const { payload } = await callTool('search_manual', { query: 'xyzzy plugh frobnicate' });

  assert.deepEqual(payload.results, []);
  assert.match(payload.hint, /list_manual_sections/);
});
