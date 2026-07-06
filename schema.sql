-- DirectR2 D1 数据库 Schema
-- 适用数据库: monitor-sdk-data (binding: MY_BINDING_D1)
-- 执行方式: npx wrangler d1 execute monitor-sdk-data --file=./schema.sql

CREATE TABLE IF NOT EXISTS events (
  -- 来源追踪（去重 + 回补 + 排査）
  r2_key      TEXT    NOT NULL,          -- 来源 R2 对象 key
  r2_offset   INTEGER NOT NULL,          -- 在 JSONL 文件中的行号（从 0 起）

  -- 事件核心
  event_type  TEXT    NOT NULL,
  event_id    TEXT    NOT NULL DEFAULT '',
  ts          INTEGER NOT NULL,          -- 事件 timestamp(ms)
  received_at INTEGER NOT NULL,          -- Worker 写入时间(ms)，用于保留清理
  app_id      TEXT    NOT NULL DEFAULT '',

  -- 主体字段（user_id/device_id/session_id 已哈希）
  user_id       TEXT NOT NULL DEFAULT '',
  device_id     TEXT NOT NULL DEFAULT '',   -- 匿名设备身份，UV 去重键（HMAC 哈希）
  session_id    TEXT NOT NULL DEFAULT '',
  page_url      TEXT NOT NULL DEFAULT '',
  page_title    TEXT NOT NULL DEFAULT '',
  referrer      TEXT NOT NULL DEFAULT '',
  sdk_version   TEXT NOT NULL DEFAULT '',
  client_type   TEXT NOT NULL DEFAULT 'Web',
  fingerprint_id TEXT NOT NULL DEFAULT '',
  client_ip     TEXT NOT NULL DEFAULT '',

  -- extra：截断入库（全文在 R2）
  extra       TEXT    NOT NULL DEFAULT '',
  raw_extra   INTEGER NOT NULL DEFAULT 0,

  PRIMARY KEY (r2_key, r2_offset)
);

-- 查询索引
CREATE INDEX IF NOT EXISTS idx_events_app_ts   ON events(app_id, ts);
CREATE INDEX IF NOT EXISTS idx_events_type_ts  ON events(event_type, ts);
CREATE INDEX IF NOT EXISTS idx_events_user     ON events(user_id);
CREATE INDEX IF NOT EXISTS idx_events_device   ON events(device_id);   -- UV: COUNT(DISTINCT device_id)
CREATE INDEX IF NOT EXISTS idx_events_session  ON events(session_id);
CREATE INDEX IF NOT EXISTS idx_events_received ON events(received_at);

-- 元数据表：存储对账 watermark 等状态（对账 cron 用）
-- 幂等：CREATE TABLE IF NOT EXISTS，可重复执行 schema.sql 安全
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- ============================================================================
-- 迁移说明（仅「已存在」的 events 表需要执行；新建库上面的 CREATE TABLE 即可）
-- ============================================================================
-- device_id 是后加字段。若库已存在（无 device_id 列），执行一次性 ALTER：
--   npx wrangler d1 execute monitor-sdk-data --remote \
--     --command="ALTER TABLE events ADD COLUMN device_id TEXT NOT NULL DEFAULT '';"
--   npx wrangler d1 execute monitor-sdk-data --remote \
--     --command="CREATE INDEX IF NOT EXISTS idx_events_device ON events(device_id);"
-- 说明：老行 device_id 为 ''（旧 SDK 未上报，无法回填）。UV 统计跨迁移点的连续性，
--       可用 COUNT(DISTINCT COALESCE(NULLIF(device_id,''), user_id)) 桥接旧 user_id 口径。

