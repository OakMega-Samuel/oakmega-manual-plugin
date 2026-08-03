/** 三個 tool 的行為。用 fixture 當內容來源，不碰網路。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { callTool, FakeContentStore, INDEX } from './helpers.js';

// --- search_manual ----------------------------------------------------------

test('search_manual 回傳的每一筆都帶齊模型判斷所需的欄位', async () => {
  const { payload } = await callTool('search_manual', { query: '標籤' });

  assert.ok(payload.results.length > 0);
  for (const result of payload.results) {
    assert.ok(result.path, '缺 path，模型就沒辦法接著讀全文');
    assert.ok(result.title);
    assert.ok(result.breadcrumb.includes('›'), 'breadcrumb 要能看出這頁在手冊的哪個位置');
    assert.ok(result.snippet);
    assert.match(result.notion_url, /^https:\/\//, '要能引導使用者回頭看原文');
    assert.equal(typeof result.score, 'number');
  }
});

test('search_manual 的結果依分數遞減排序', async () => {
  const { payload } = await callTool('search_manual', { query: '推播 標籤 匯入', limit: 5 });
  const scores = payload.results.map((result) => result.score);

  assert.deepEqual(scores, [...scores].sort((a, b) => b - a));
});

test('limit 生效並被夾在合理範圍內', async () => {
  const two = await callTool('search_manual', { query: '標籤', limit: 2 });
  assert.equal(two.payload.results.length, 2);

  // 超過上限不該讓整份手冊被倒出來
  const huge = await callTool('search_manual', { query: '標籤', limit: 9999 });
  assert.ok(huge.payload.results.length <= 15);
});

test('空查詢被擋下並回報錯誤', async () => {
  const blank = await callTool('search_manual', { query: '   ' });
  assert.equal(blank.isError, true);
});

test('原文抓不到時退回摘要，不會讓整次搜尋失敗', async () => {
  const store = new FakeContentStore();
  store.getPage = async () => {
    throw new Error('raw.githubusercontent 暫時掛了');
  };

  const { payload, isError } = await callTool('search_manual', { query: '標籤' }, store);

  assert.equal(isError, false, '單一頁面抓不到不該讓搜尋整個失敗');
  assert.ok(payload.results.length > 0);
  assert.ok(payload.results[0].snippet, '應該退回用 INDEX 裡的摘要');
});

test('索引的斷詞版本與 Worker 不一致時明白警告', async () => {
  const store = new FakeContentStore();
  const original = await store.getSearchIndex();
  store.getSearchIndex = async () => ({ ...original, tokenizer_version: 999 });

  const { payload } = await callTool('search_manual', { query: '標籤' }, store);

  assert.match(payload.warning, /斷詞版本/);
});

// --- get_manual_page --------------------------------------------------------

test('get_manual_page 回傳去掉 front-matter 的正文與來源連結', async () => {
  const target = INDEX.pages.find((page) => page.path.includes('批次匯入標籤'));
  const { payload } = await callTool('get_manual_page', { path: target.path });

  assert.equal(payload.title, '批次匯入標籤');
  assert.match(payload.notion_url, /^https:\/\/www\.notion\.so\//);
  assert.match(payload.last_edited_time, /^\d{4}-\d{2}-\d{2}T/);
  assert.doesNotMatch(payload.content, /^---/, 'front-matter 不該混進正文');
  assert.match(payload.content, /10000/, '正文要是完整內容');
});

test('get_manual_page 拒絕不在索引裡的路徑 —— 否則等於開放任意 URL 抓取', async () => {
  const attempts = ['../../../etc/passwd', 'manual/不存在的頁-deadbeef.md', 'https://evil.example.com/x'];

  for (const path of attempts) {
    const { isError, text } = await callTool('get_manual_page', { path });
    assert.equal(isError, true, `「${path}」不該被接受`);
    assert.match(text, /沒有這個路徑|failed/);
  }
});

test('get_manual_page 空路徑回錯誤', async () => {
  const { isError } = await callTool('get_manual_page', { path: '' });
  assert.equal(isError, true);
});

// --- list_manual_sections ---------------------------------------------------

test('list_manual_sections 回傳完整目錄樹', async () => {
  const { payload } = await callTool('list_manual_sections');

  assert.equal(payload.page_count, INDEX.page_count);
  assert.match(payload.content_last_edited, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(payload.tree.length, 1);
  assert.equal(payload.tree[0].title, 'OakMega 使用手冊');

  // 巢狀結構要保留，模型才能理解主題的從屬關係
  const members = payload.tree[0].children.find((node) => node.title === '會員管理');
  assert.ok(members.children.some((node) => node.title === '會員標籤'));
});

test('目錄樹每個節點都有 path 與摘要，一次就夠模型決定要讀哪頁', async () => {
  const { payload } = await callTool('list_manual_sections');

  const walk = (nodes) => {
    for (const node of nodes) {
      assert.ok(node.path, `${node.title} 缺 path`);
      assert.equal(typeof node.summary, 'string');
      walk(node.children);
    }
  };

  walk(payload.tree);
});

// --- 串起來的流程 -----------------------------------------------------------

test('search → get 的完整流程走得通：搜到的 path 一定讀得到', async () => {
  const store = new FakeContentStore();
  const search = await callTool('search_manual', { query: 'API 速率限制' }, store);

  const topPath = search.payload.results[0].path;
  const page = await callTool('get_manual_page', { path: topPath }, store);

  assert.equal(page.isError, false);
  assert.match(page.payload.content, /429|速率/);
});
