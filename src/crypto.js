/**
 * PII 脱敏工具（Web Crypto API，Workers 原生，无外部依赖）
 *
 * 与 worker-ingest/src/lib/crypto.js 行为对齐，但提供更简洁的批量入口：
 *   sanitizeEvent(event, clientIP, hmacKey)     —— 单条
 *   sanitizeEvents(events, clientIP, hmacKey)   —— 批量并行
 *
 * 脱敏规则：
 *   - user_id → HMAC-SHA256（有 salt/key）或 SHA256（无 salt 降级）
 *   - device_id → HMAC-SHA256（同 user_id；持久跨会话标识，UV 命根子）
 *   - session_id → SHA256
 *   - clientIP → 截断后写入 _client_ip
 *
 * 性能要点（相对逐条串行 await 的优化）：
 *   - HMAC key 请求级 import 一次（importHmacKey），供该请求所有事件复用，
 *     避免逐条重复 importKey —— Web Crypto 的 importKey 开销≈一次 sign。
 *   - 批量脱敏用 Promise.all 并发执行，替代逐条串行 await。
 */

const encoder = new TextEncoder();

/** Uint8Array → hex 字符串 */
function toHex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * 请求级 import HMAC key（同一 salt 全请求复用一次）
 * @param {string} salt - HMAC salt（env.PII_HMAC_SALT）
 * @returns {Promise<CryptoKey|null>} salt 为空返回 null（调用方走 SHA256 降级）
 */
export async function importHmacKey(salt) {
  if (!salt) return null;
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(String(salt)),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
}

/** 用预算好的 HMAC key 签名 → hex（空输入返回空串） */
async function hmacSignWithKey(key, input) {
  if (!input) return '';
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(String(input)));
  return toHex(sig);
}

/** SHA256 哈希，空输入返回空串 */
export async function sha256(input) {
  if (!input) return '';
  const buf = await crypto.subtle.digest('SHA-256', encoder.encode(String(input)));
  return toHex(buf);
}

/**
 * HMAC-SHA256（单次场景：内部 importKey）
 * 批量场景请用 importHmacKey + sanitizeEvents 复用 key，避免重复 import。
 * 空输入或空 salt 返回空串。
 */
export async function hmacSha256(input, salt) {
  if (!input || !salt) return '';
  const key = await importHmacKey(salt);
  return hmacSignWithKey(key, input);
}

/** IPv4 保留 /24，IPv6 保留 /48 */
export function truncateIP(ip) {
  if (!ip) return '';
  if (ip.includes('.')) {
    const parts = ip.split('.');
    if (parts.length === 4) return `${parts[0]}.${parts[1]}.${parts[2]}.0`;
  }
  if (ip.includes(':')) {
    const parts = ip.split(':');
    return parts.slice(0, 3).join(':') + '::';
  }
  return ip;
}

/**
 * 对单条事件做 PII 脱敏（写入 R2 前调用）
 *
 * @param {Object} event - 已验证的原始事件
 * @param {string} clientIP - 客户端 IP（cf-connecting-ip）
 * @param {CryptoKey|null} [hmacKey=null] - 请求级预算 key（importHmacKey 得到）；
 *                                          null 则 user_id 降级为 SHA256
 * @returns {Object} 脱敏后的事件副本
 */
export async function sanitizeEvent(event, clientIP, hmacKey = null) {
  const sanitized = { ...event };
  if (sanitized.user_id) {
    sanitized.user_id = hmacKey
      ? await hmacSignWithKey(hmacKey, sanitized.user_id)
      : await sha256(sanitized.user_id);
  }
  if (sanitized.device_id) {
    // device_id 是持久跨会话标识（UV 命根子），与 user_id 同级保护：HMAC 优先，无 salt 降级 SHA256
    sanitized.device_id = hmacKey
      ? await hmacSignWithKey(hmacKey, sanitized.device_id)
      : await sha256(sanitized.device_id);
  }
  if (sanitized.session_id) {
    sanitized.session_id = await sha256(sanitized.session_id);
  }
  if (clientIP) {
    sanitized._client_ip = truncateIP(clientIP);
  }
  return sanitized;
}

/**
 * 批量并行 PII 脱敏（替代逐条串行 await 的性能优化入口）
 *
 * N 条事件通过 Promise.all 并发执行 Web Crypto，落盘结果与逐条调用
 * sanitizeEvent 逐字段等价（哈希为确定值，并发仅改变调度顺序、不改结果）。
 * 注：sanitizeEvent 对任意输入均有兜底（falsy→''、真值 String() 化），不会 reject。
 *
 * @param {Array<Object>} events - 已验证事件
 * @param {string} clientIP
 * @param {CryptoKey|null} [hmacKey=null]
 * @returns {Promise<Array<Object>>} 脱敏后事件（保持输入顺序）
 */
export async function sanitizeEvents(events, clientIP, hmacKey = null) {
  return Promise.all(events.map((event) => sanitizeEvent(event, clientIP, hmacKey)));
}
