/**
 * 请求 & 事件验证（纯 JS，无外部依赖）
 *
 * 与 worker-ingest/src/http/validation.js 行为对齐，但不依赖 zod。
 * 验证逻辑：
 *   1. 顶层结构：必须有 logs 数组且非空
 *   2. 每条事件：event_type 必填；extra 长度上限 10KB
 *   3. 字段兜底：缺失字段填充默认值
 */

const MAX_EXTRA_SIZE = 10000;

/** 字符串最大长度限制 */
const MAX_LEN = {
  event_type: 50,
  event_id: 100,
  user_id: 100,
  device_id: 100,
  session_id: 100,
  page_url: 4096,
  page_title: 1024,
  referrer: 4096,
  app_id: 100,
  sdk_version: 20,
  client_type: 20,
  fingerprint_id: 100,
};

/**
 * 验证顶层请求体结构
 * @param {unknown | object} body
 * @returns {{ valid: boolean, error?: string }}
 */
export function validateReportBody(body) {
  if (!body || typeof body !== 'object') {
    return { valid: false, error: 'body must be an object' };
  }
  if (!Array.isArray(body.logs)) {
    return { valid: false, error: 'logs must be an array' };
  }
  if (body.logs.length === 0) {
    return { valid: false, error: 'logs array must not be empty' };
  }
  return { valid: true };
}

/**
 * 从请求体中提取事件列表
 * @param {Object} body
 * @returns {Array<unknown>}
 */
export function extractEvents(body) {
  if (body && Array.isArray(body.logs)) return body.logs;
  return [];
}

/**
 * 验证并规范化单条事件
 *
 * @param {unknown} raw - SDK 上报的原始事件
 * @returns {{ valid: false, error: string } | { valid: true, data: Object }}
 */
export function validateEvent(raw) {
  if (!raw || typeof raw !== 'object') {
    return { valid: false, error: 'event must be an object' };
  }

  // event_type 必填
  if (typeof raw.event_type !== 'string' || raw.event_type.length < 1) {
    return { valid: false, error: 'event_type is required and must be a non-empty string' };
  }
  if (raw.event_type.length > MAX_LEN.event_type) {
    return { valid: false, error: `event_type exceeds ${MAX_LEN.event_type} characters` };
  }

  // 字符串字段长度检查
  for (const field of [
    'event_id',
    'user_id',
    'device_id',
    'session_id',
    'page_url',
    'page_title',
    'referrer',
    'app_id',
    'sdk_version',
    'client_type',
    'fingerprint_id',
  ]) {
    if (raw[field] !== undefined && raw[field] !== null && typeof raw[field] !== 'string') {
      return { valid: false, error: `${field} must be a string` };
    }
    if (typeof raw[field] === 'string' && raw[field].length > MAX_LEN[field]) {
      return { valid: false, error: `${field} exceeds ${MAX_LEN[field]} characters` };
    }
  }

  // timestamp 可以是 number 或 string
  if (
    raw.timestamp !== undefined &&
    raw.timestamp !== null &&
    typeof raw.timestamp !== 'number' &&
    typeof raw.timestamp !== 'string'
  ) {
    return { valid: false, error: 'timestamp must be a number or string' };
  }

  // extra 检查
  const extra = raw.extra;
  if (extra !== undefined && extra !== null) {
    const extraStr = typeof extra === 'string' ? extra : JSON.stringify(extra);
    if (extraStr.length > MAX_EXTRA_SIZE) {
      return { valid: false, error: `extra field exceeds ${MAX_EXTRA_SIZE} characters` };
    }
  }

  // 构造规范化事件
  const data = {
    event_type: raw.event_type,
    event_id: raw.event_id || '',
    timestamp: raw.timestamp ?? Date.now(),
    user_id: raw.user_id || '',
    device_id: raw.device_id || '',
    session_id: raw.session_id || '',
    page_url: raw.page_url || '',
    page_title: raw.page_title || '',
    referrer: raw.referrer || '',
    app_id: raw.app_id || '',
    sdk_version: raw.sdk_version || '',
    client_type: raw.client_type || 'Web',
    fingerprint_id: raw.fingerprint_id || '',
    extra: extra !== undefined ? extra : {},
  };

  // 保留额外字段（passthrough）
  for (const key of Object.keys(raw)) {
    if (!(key in data)) {
      data[key] = raw[key];
    }
  }

  return { valid: true, data };
}
