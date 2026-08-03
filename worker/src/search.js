/**
 * BM25 打分與片段擷取。
 *
 * 打分在 server 端做完，回給模型的是「已經排序、已經截出相關段落」的少數幾筆，
 * 而不是一大包 markdown。這是整個方案精準度與 token 效率的來源——
 * 模型不必自己讀完手冊才知道哪一頁相關。
 */

import { tokenize, TOKENIZER_VERSION } from './tokenize.js';

/** 片段長度上限（字元）。夠讓模型判斷相關性，又不會灌爆 context。 */
const SNIPPET_LENGTH = 220;

/** 找片段時每個 token 最多取幾個出現位置，避免超長文件拖慢打分。 */
const MAX_POSITIONS_PER_TOKEN = 40;

/**
 * 以 BM25 對整份索引打分。
 *
 * @param {object} index search.json 的內容
 * @param {string} query
 * @param {number} limit
 * @returns {{results: {docIndex: number, score: number, doc: object}[], queryTokens: string[], warning?: string}}
 */
export function scoreQuery(index, query, limit) {
  const queryTokens = tokenize(query);

  const warning =
    index.tokenizer_version !== TOKENIZER_VERSION
      ? `索引的斷詞版本（${index.tokenizer_version}）與本服務（${TOKENIZER_VERSION}）不一致，搜尋結果可能不準。請重新產生索引或更新 Worker。`
      : undefined;

  if (!queryTokens.length) return { results: [], queryTokens, warning };

  const { k1 = 1.2, b = 0.75, doc_count: docCount, avg_doc_length: avgLength, docs, postings } = index;

  /** @type {Map<number, number>} docIndex → 累積分數 */
  const scores = new Map();

  // 查詢字串裡重複的 token 不重複計分——短查詢用不上 query term frequency。
  for (const token of new Set(queryTokens)) {
    const posting = postings[token];
    if (!posting) continue;

    const docFrequency = posting.length / 2;
    const idf = Math.log(1 + (docCount - docFrequency + 0.5) / (docFrequency + 0.5));

    for (let i = 0; i < posting.length; i += 2) {
      const docIndex = posting[i];
      const termFrequency = posting[i + 1];
      const docLength = docs[docIndex]?.len ?? avgLength;

      const denominator = termFrequency + k1 * (1 - b + (b * docLength) / (avgLength || 1));
      const contribution = (idf * (termFrequency * (k1 + 1))) / (denominator || 1);

      scores.set(docIndex, (scores.get(docIndex) ?? 0) + contribution);
    }
  }

  const results = [...scores.entries()]
    .sort((a, b2) => b2[1] - a[1] || a[0] - b2[0])
    .slice(0, limit)
    .map(([docIndex, score]) => ({ docIndex, score, doc: docs[docIndex] }));

  return { results, queryTokens, warning };
}

/**
 * 從一頁的 markdown 原文截出最能說明「為什麼命中」的一段。
 *
 * 作法是找出查詢 token 密度最高的位置：對每個 token 的每個出現位置，
 * 數一數附近有多少個**不同的** token，取最高分的那一段。
 * 只找單一 token 的話，會被「剛好出現一次但其實不相關」的位置騙走。
 *
 * @param {string} markdown 該頁原始內容（含 front-matter）
 * @param {string[]} queryTokens
 * @returns {string | null} 找不到任何命中就回 null，由呼叫端退回用摘要
 */
export function extractSnippet(markdown, queryTokens) {
  const text = toSearchableText(markdown);
  if (!text) return null;

  const haystack = text.toLowerCase();
  const distinctTokens = [...new Set(queryTokens)];

  /** @type {{position: number, token: string}[]} */
  const hits = [];

  for (const token of distinctTokens) {
    let from = 0;
    let count = 0;

    while (count < MAX_POSITIONS_PER_TOKEN) {
      const position = haystack.indexOf(token, from);
      if (position === -1) break;
      hits.push({ position, token });
      from = position + token.length;
      count += 1;
    }
  }

  if (!hits.length) return null;

  const halfWindow = Math.floor(SNIPPET_LENGTH / 2);

  let best = { position: hits[0].position, distinct: 0 };
  for (const hit of hits) {
    const nearby = new Set();
    for (const other of hits) {
      if (Math.abs(other.position - hit.position) <= halfWindow) nearby.add(other.token);
    }
    if (nearby.size > best.distinct) best = { position: hit.position, distinct: nearby.size };
  }

  const start = Math.max(0, best.position - Math.floor(halfWindow / 2));
  const end = Math.min(text.length, start + SNIPPET_LENGTH);

  let snippet = text.slice(start, end).trim();
  if (start > 0) snippet = `…${snippet}`;
  if (end < text.length) snippet = `${snippet}…`;

  return snippet;
}

/**
 * 把 markdown 化成適合擷取片段的純文字：
 * 去掉 front-matter 與各種記號，換行收成空白。
 * 片段是給模型讀的，留著 `##` `**` 只是雜訊。
 */
function toSearchableText(markdown) {
  return markdown
    .replace(/^---\n[\s\S]*?\n---\n/, '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/[*_~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
