/**
 * R2 对象 key 生成 & 批量写入
 *
 * 分区路径格式：
 *   <safe_app_id>/YYYY-MM-DD/HH/<uuid>.jsonl
 */

/**
 * 生成 R2 对象 key
 *
 * @param {string} uuid - UUID v7
 * @param {string} appId - 应用 ID
 * @param {Date} [now] - 时间基准，默认当前 UTC 时间
 * @returns {string} 分区 key
 */
export function generateKey(uuid, appId, now = new Date()) {
  const d = now.toISOString().slice(0, 10);
  const h = String(now.getUTCHours()).padStart(2, '0');
  const safeAppId = (appId || 'unknown').replace(/[^a-zA-Z0-9_.-]/g, '_');
  return `${safeAppId}/${d}/${h}/${uuid}.jsonl`;
}

/**
 * 将一批 JSON 对象转换为 JSONL 格式
 *
 * @param {Array<Object>} events
 * @returns {string} JSONL 字符串（末尾带换行）
 */
export function toJSONL(events) {
  return events.map((e) => JSON.stringify(e)).join('\n') + '\n';
}

/**
 * 按 app_id 分组
 *
 * @param {Array<Object>} events
 * @returns {Map<string, Array<Object>>}
 */
export function groupByAppId(events) {
  const groups = new Map();
  for (const e of events) {
    const appId = e.app_id || 'unknown';
    if (!groups.has(appId)) groups.set(appId, []);
    groups.get(appId).push(e);
  }
  return groups;
}
