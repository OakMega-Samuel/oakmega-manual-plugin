/**
 * 斷詞。索引端與查詢端必須用同一份，否則查得到才有鬼。
 *
 * !! 這個檔在兩個 repo 各存一份，必須逐字一致：
 *      oakmega-manual-content/scripts/lib/tokenize.js   建索引時用
 *      oakmega-manual-plugin/worker/src/tokenize.js     查詢時用
 *    兩邊只要斷法不同，索引裡的 token 就對不上查詢的 token，
 *    搜尋會「不報錯但什麼都找不到」——最難查的那種壞法。
 *    改動時兩邊一起改，並把 TOKENIZER_VERSION 加一：
 *    版本會寫進 search.json，Worker 發現對不上會在回應裡明講。
 *
 * 中文走 bigram：「會員標籤」→ 會員 / 員標 / 標籤。
 * 這是整份搜尋能不能用的關鍵。一般 tokenizer 以空白斷詞，一整句中文會變成單一 token，
 * 查「標籤」永遠命中不了「會員標籤管理」，搜尋直接報廢。
 *
 * 沒有用 jieba 之類的詞庫斷詞器，因為：
 *   - 多一個相依套件（且多半體積不小），Worker 端還得再塞一份
 *   - 詞庫沒有的專有名詞（產品名、功能名）反而會被切錯
 *   - bigram 不需要詞庫，對未知詞天生免疫，這個規模下召回率也夠
 *
 * 「員標」這種跨詞邊界的假 token 是 bigram 的已知代價，
 * 但它們在語料裡本來就罕見，BM25 的 IDF 會自然壓低它們的份量。
 */

/** 改動斷詞規則時務必加一。 */
export const TOKENIZER_VERSION = 1;

// 需要 bigram 化的文字：中日韓。
const CJK_CHAR = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

// 其餘視為「詞」的字元：拉丁字母、數字等。
const WORD_CHAR = /[\p{Letter}\p{Number}]/u;

/**
 * 把文字切成 token 陣列。
 * @param {string} text
 * @returns {string[]}
 */
export function tokenize(text) {
  if (typeof text !== 'string' || !text) return [];

  const tokens = [];
  let buffer = '';
  let bufferIsCjk = false;

  const flush = () => {
    if (!buffer) return;

    if (bufferIsCjk) {
      if (buffer.length === 1) {
        // 單字成句（例如「讚」）沒有 bigram 可組，原樣收下。
        tokens.push(buffer);
      } else {
        for (let i = 0; i < buffer.length - 1; i += 1) {
          tokens.push(buffer.slice(i, i + 2));
        }
      }
    } else {
      tokens.push(buffer);
    }

    buffer = '';
  };

  for (const char of text.toLowerCase()) {
    const isCjk = CJK_CHAR.test(char);
    const isWord = isCjk || WORD_CHAR.test(char);

    if (!isWord) {
      flush();
      continue;
    }

    // 中英交界處要斷開，否則「LINE官方帳號」會被當成同一段。
    if (buffer && isCjk !== bufferIsCjk) flush();

    bufferIsCjk = isCjk;
    buffer += char;
  }

  flush();
  return tokens;
}

/**
 * 統計 token 出現次數，可加權。
 * 加權的實作就是「這段文字的每個 token 都算 weight 次」——
 * 標題命中應該比內文命中更有份量。
 *
 * @param {Map<string, number>} target 累加進這個 Map
 * @param {string} text
 * @param {number} weight
 * @returns {number} 這段文字貢獻的加權 token 總數（BM25 算文件長度要用）
 */
export function accumulate(target, text, weight = 1) {
  let total = 0;

  for (const token of tokenize(text)) {
    target.set(token, (target.get(token) ?? 0) + weight);
    total += weight;
  }

  return total;
}
