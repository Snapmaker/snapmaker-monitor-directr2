/**
 * UUID v7 生成（时间排序 + 全局唯一）
 *
 * 与 worker-ingest/src/lib/uuid.js 行为一致，标准 8-4-4-4-12 格式，版本位为 7。
 * 前 48 位填毫秒时间戳，后续位来自 crypto.randomUUID()。
 */
export function uuidv7() {
  const now = Date.now();
  const uuid = crypto.randomUUID();
  const tsHex = now.toString(16).padStart(12, '0');
  return `${tsHex.slice(0, 8)}-${tsHex.slice(8, 12)}-7${uuid.slice(15, 18)}-${uuid.slice(19, 23)}-${uuid.slice(24)}`;
}
