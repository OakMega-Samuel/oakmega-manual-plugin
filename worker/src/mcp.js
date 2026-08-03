/**
 * 最小的 MCP Streamable HTTP server（stateless）。
 *
 * 只實作唯讀 server 需要的部分：initialize / tools/list / tools/call / ping。
 * 不做 session、不做 server-initiated SSE——這台永遠只是「收到 POST 就回一包 JSON」。
 * 因此 GET /mcp 一律 405，客戶端不會誤以為可以掛長連線。
 */

// 我們認得的協定版本，新到舊。initialize 時若客戶端要的版本在這裡面就照它的回，
// 否則回我們最新的（規格允許，客戶端自己決定要不要接受）。
const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

const JSONRPC_PARSE_ERROR = -32700;
const JSONRPC_INVALID_REQUEST = -32600;
const JSONRPC_METHOD_NOT_FOUND = -32601;
const JSONRPC_INVALID_PARAMS = -32602;
const JSONRPC_INTERNAL_ERROR = -32603;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Accept, Mcp-Session-Id, MCP-Protocol-Version, Authorization',
  'Access-Control-Expose-Headers': 'Mcp-Session-Id, MCP-Protocol-Version',
  'Access-Control-Max-Age': '86400',
};

function json(body, init = {}) {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS, ...(init.headers || {}) },
  });
}

/**
 * 把單一 JSON-RPC 回應包成 SSE 事件。
 *
 * Streamable HTTP 規格允許 server 用 `application/json` 或 `text/event-stream` 回應，
 * 但實務上不是每個客戶端都兩種都吃——Claude 桌面 app 的 connector 安裝流程要 SSE，
 * 回純 JSON 的話它不會報錯，只是安裝按鈕按下去沒反應（連請求都不發）。
 *
 * 所以這裡做內容協商：客戶端 Accept 有 text/event-stream 就回 SSE，否則回純 JSON。
 * 官方 SDK 兩種都接受，curl 之類的簡單客戶端則會拿到好讀的 JSON。
 */
function sse(body, init = {}) {
  const payload = `event: message\ndata: ${JSON.stringify(body)}\n\n`;
  return new Response(payload, {
    ...init,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      ...CORS_HEADERS,
      ...(init.headers || {}),
    },
  });
}

function acceptsEventStream(request) {
  return (request.headers.get('Accept') ?? '').includes('text/event-stream');
}

function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id: id ?? null, error };
}

/** 把任意值包成 MCP tool result 的 content 陣列。 */
export function textResult(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: 'text', text }] };
}

export function errorResult(message) {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/**
 * @param {object} opts
 * @param {{name: string, version: string}} opts.serverInfo
 * @param {string} [opts.instructions] 給模型看的 server 層級說明
 * @param {Array<{name, title?, description, inputSchema, handler}>} opts.tools
 */
export function createMcpHandler({ serverInfo, instructions, tools }) {
  const toolsByName = new Map(tools.map((t) => [t.name, t]));

  const toolDescriptors = tools.map(({ name, title, description, inputSchema }) => ({
    name,
    ...(title ? { title } : {}),
    description,
    inputSchema,
  }));

  async function dispatch(message, ctx) {
    const { id, method, params } = message;

    // 通知（沒有 id）不需要回應。initialized / cancelled 之類的一律吞掉。
    const isNotification = id === undefined || id === null;

    switch (method) {
      case 'initialize': {
        const requested = params?.protocolVersion;
        const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
          ? requested
          : SUPPORTED_PROTOCOL_VERSIONS[0];
        return rpcResult(id, {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo,
          ...(instructions ? { instructions } : {}),
        });
      }

      case 'ping':
        return rpcResult(id, {});

      case 'tools/list':
        return rpcResult(id, { tools: toolDescriptors });

      case 'tools/call': {
        const name = params?.name;
        const tool = toolsByName.get(name);
        if (!tool) {
          return rpcError(id, JSONRPC_INVALID_PARAMS, `Unknown tool: ${name}`);
        }
        try {
          const result = await tool.handler(params?.arguments ?? {}, ctx);
          return rpcResult(id, result);
        } catch (err) {
          // Tool 執行失敗回 isError 而非 JSON-RPC error——這樣模型看得到錯誤訊息並能自己重試。
          return rpcResult(id, errorResult(`Tool "${name}" failed: ${err?.message ?? String(err)}`));
        }
      }

      default:
        if (isNotification) return null;
        return rpcError(id, JSONRPC_METHOD_NOT_FOUND, `Method not found: ${method}`);
    }
  }

  return async function handleMcpRequest(request, ctx) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // 我們沒有 server-initiated stream，明確拒絕比讓客戶端掛在那裡好。
    if (request.method === 'GET' || request.method === 'DELETE') {
      return new Response(null, {
        status: 405,
        headers: { Allow: 'POST, OPTIONS', ...CORS_HEADERS },
      });
    }

    if (request.method !== 'POST') {
      return json(rpcError(null, JSONRPC_INVALID_REQUEST, 'Only POST is supported'), { status: 405 });
    }

    let payload;
    try {
      payload = await request.json();
    } catch {
      return json(rpcError(null, JSONRPC_PARSE_ERROR, 'Invalid JSON'), { status: 400 });
    }

    // 2025-06-18 拿掉了 batch，但舊客戶端還會送陣列，順手支援。
    const isBatch = Array.isArray(payload);
    const messages = isBatch ? payload : [payload];

    if (isBatch && messages.length === 0) {
      return json(rpcError(null, JSONRPC_INVALID_REQUEST, 'Empty batch'), { status: 400 });
    }

    const responses = [];
    for (const message of messages) {
      if (!message || typeof message !== 'object' || message.jsonrpc !== '2.0') {
        responses.push(rpcError(message?.id, JSONRPC_INVALID_REQUEST, 'Not a JSON-RPC 2.0 message'));
        continue;
      }
      try {
        const response = await dispatch(message, ctx);
        if (response) responses.push(response);
      } catch (err) {
        responses.push(rpcError(message.id, JSONRPC_INTERNAL_ERROR, err?.message ?? String(err)));
      }
    }

    // 全部都是通知 → 規格要求回 202 且不帶 body。
    if (responses.length === 0) {
      return new Response(null, { status: 202, headers: CORS_HEADERS });
    }

    const body = isBatch ? responses : responses[0];
    return acceptsEventStream(request) ? sse(body) : json(body);
  };
}
