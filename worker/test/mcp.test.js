/** MCP 協定層。跟手冊內容無關，只驗「這台 server 講不講標準的 MCP」。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';

const MCP_URL = 'https://example.workers.dev/mcp';

// tools/list 與 initialize 不會碰到內容，但 fetch handler 會先建 ContentStore，
// 所以 env 還是要給一個合法的 base url。
const ENV = { CONTENT_BASE_URL: 'https://raw.githubusercontent.com/oakmega/oakmega-manual-content/main' };

/** 解析回應，SSE 與純 JSON 兩種格式都吃。 */
function parseBody(contentType, text) {
  if (!text) return null;
  if (contentType?.includes('text/event-stream')) {
    const dataLine = text.split('\n').find((line) => line.startsWith('data: '));
    return JSON.parse(dataLine.slice(6));
  }
  return JSON.parse(text);
}

async function rpc(message, accept = 'application/json, text/event-stream') {
  const res = await worker.fetch(
    new Request(MCP_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: accept },
      body: JSON.stringify(message),
    }),
    ENV,
    {},
  );
  const text = await res.text();
  return {
    status: res.status,
    headers: res.headers,
    contentType: res.headers.get('Content-Type'),
    body: parseBody(res.headers.get('Content-Type'), text),
  };
}

test('initialize 回傳協定版本、tools capability 與 instructions', async () => {
  const { status, body } = await rpc({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
  });

  assert.equal(status, 200);
  assert.equal(body.result.protocolVersion, '2025-06-18');
  assert.ok(body.result.capabilities.tools);
  assert.equal(body.result.serverInfo.name, 'oakmega-manual');
  assert.match(body.result.instructions, /先查手冊/, 'instructions 要告訴模型別憑記憶回答');
});

test('不認得的協定版本回退到支援的最新版', async () => {
  const { body } = await rpc({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '1999-01-01', capabilities: {} },
  });
  assert.equal(body.result.protocolVersion, '2025-06-18');
});

test('tools/list 剛好列出三個 tool，且 schema 完整', async () => {
  const { body } = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const { tools } = body.result;

  assert.deepEqual(
    tools.map((tool) => tool.name).sort(),
    ['get_manual_page', 'list_manual_sections', 'search_manual'],
  );

  for (const tool of tools) {
    assert.equal(tool.inputSchema.type, 'object', `${tool.name} 的 schema 型別不對`);
    assert.ok(tool.description.length > 20, `${tool.name} 的說明太短，模型會挑錯 tool`);
  }

  const search = tools.find((tool) => tool.name === 'search_manual');
  assert.deepEqual(search.inputSchema.required, ['query']);
});

test('tools/call 對未知 tool 回 JSON-RPC error', async () => {
  const { body } = await rpc({
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: { name: 'does_not_exist', arguments: {} },
  });
  assert.equal(body.error.code, -32602);
});

test('通知（無 id）回 202 且不帶 body', async () => {
  const res = await worker.fetch(
    new Request(MCP_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    }),
    ENV,
    {},
  );

  assert.equal(res.status, 202);
  assert.equal(await res.text(), '');
});

test('未知 method 回 -32601', async () => {
  const { body } = await rpc({ jsonrpc: '2.0', id: 5, method: 'resources/list' });
  assert.equal(body.error.code, -32601);
});

test('壞掉的 JSON 回 -32700', async () => {
  const res = await worker.fetch(
    new Request(MCP_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{oops' }),
    ENV,
    {},
  );
  assert.equal((await res.json()).error.code, -32700);
});

test('GET /mcp 回 405（我們沒有 server-initiated SSE）', async () => {
  const res = await worker.fetch(new Request(MCP_URL, { method: 'GET' }), ENV, {});
  assert.equal(res.status, 405);
  assert.equal(res.headers.get('Allow'), 'POST, OPTIONS');
});

test('OPTIONS preflight 回 204 帶 CORS', async () => {
  const res = await worker.fetch(new Request(MCP_URL, { method: 'OPTIONS' }), ENV, {});
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), '*');
});

test('batch 請求逐一處理並回陣列', async () => {
  const { body } = await rpc([
    { jsonrpc: '2.0', id: 1, method: 'ping' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
  ]);

  assert.ok(Array.isArray(body));
  assert.equal(body.length, 2);
  assert.equal(body[1].result.tools.length, 3);
});

test('健康檢查端點顯示內容來源，方便確認接的是哪個 repo', async () => {
  const res = await worker.fetch(new Request('https://example.workers.dev/health'), ENV, {});
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.match(body.mcp_endpoint, /\/mcp$/);
  assert.equal(body.content_source, ENV.CONTENT_BASE_URL);
});

test('缺少 CONTENT_BASE_URL 時給出明確錯誤，而不是每個 tool 神秘失敗', async () => {
  const res = await worker.fetch(
    new Request(MCP_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }),
    {},
    {},
  );

  assert.equal(res.status, 500);
  assert.match((await res.json()).error, /CONTENT_BASE_URL/);
});

// --- 內容協商（曾經害 Claude 桌面 app 的 connector 裝不起來）------------------

test('Accept 含 text/event-stream 時回 SSE 包裝', async () => {
  // Claude 桌面 app 的 connector 安裝流程要 SSE。回純 JSON 的話它不報錯，
  // 只是 Install 按鈕按下去毫無反應——連請求都不會發出來，極難查。
  const res = await worker.fetch(
    new Request(MCP_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    }),
    ENV,
    {},
  );

  assert.match(res.headers.get('Content-Type'), /text\/event-stream/);
  assert.equal(res.headers.get('Cache-Control'), 'no-cache');

  const text = await res.text();
  assert.match(text, /^event: message\n/, 'SSE 事件必須有 event 行');
  assert.match(text, /\n\n$/, 'SSE 事件必須以空行結尾');

  const payload = JSON.parse(text.split('\n').find((l) => l.startsWith('data: ')).slice(6));
  assert.equal(payload.result.tools.length, 3);
});

test('Accept 只有 application/json 時回純 JSON', async () => {
  const { contentType, body } = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, 'application/json');

  assert.match(contentType, /application\/json/);
  assert.equal(body.result.tools.length, 3);
});

test('沒帶 Accept 時退回純 JSON，不會讓陽春客戶端拿到看不懂的東西', async () => {
  const res = await worker.fetch(
    new Request(MCP_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    }),
    ENV,
    {},
  );

  assert.match(res.headers.get('Content-Type'), /application\/json/);
});
