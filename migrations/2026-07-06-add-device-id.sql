-- 迁移：为 events 表新增 device_id 列与索引（前端 SDK 两层身份模型 + UV 查询配套）
--
-- 适用：已存在 events 表的 D1 库。新建库请用根目录 schema.sql（已含 device_id）。
-- 执行（在 D:\CloudflareSystem\DirectR2 目录）：
--   npx wrangler d1 execute monitor-sdk-data --remote --file=migrations/2026-07-06-add-device-id.sql
--   （本地开发库把 --remote 换成 --local）
--
-- 幂等性：CREATE INDEX IF NOT EXISTS 可重复执行；ALTER ADD COLUMN 不可（重复报 duplicate column）。
-- 老行 device_id 默认 ''（旧 SDK 未上报），UV 查询已用 NULLIF 忽略空值，不计入 UV。

ALTER TABLE events ADD COLUMN device_id TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_events_device ON events(device_id);
