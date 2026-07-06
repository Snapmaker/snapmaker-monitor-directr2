/**
 * DirectR2 — 前端监控数据直接写入 Cloudflare R2 + D1 双写
 *
 * ▸ 不采用 Queues / Durable Object
 * ▸ 每个 HTTP 请求验证数据后直接写 R2（同步等待，确保 SDK 重试机制生效）
 * ▸ 与 SDK reporter.js 输出的 { logs: [...] } 格式兼容
 * ▸ D1 写入使用 ctx.waitUntil() 异步执行，不增加响应延迟
 *
 * Workers 环境变量（wrangler.jsonc / CF Dashboard，已移除 PII 脱敏）：
 *   MONITOR_BUCKET       — R2 bucket 绑定（必需）
 *   MY_BINDING_D1        — D1 数据库绑定（Phase 1 双写用，可选）
   *   LOG_LEVEL            — 日志级别 debug/info/warn/error（可选，默认 info）
 */

import { validateEvent, validateReportBody, extractEvents } from './validation.js';
import { generateKey, toJSONL, groupByAppId } from './r2.js';

import { uuidv7 } from './uuid.js';
import { createLogger } from './logger.js';
//
export default {
  async fetch(request, env, ctx) {
    const log = createLogger(env);

    // ── CORS 预检 ──────────────────────────────────────────────
    if (request.method === 'OPTIONS') {
      return handleCORS(request, env);
    }

    // ── 路由 ─────────────────────────────────────────────────
    const url = new URL(request.url);

    // GET /api/v1/stats — D1 查询接口
    if (request.method === 'GET' && url.pathname === '/api/v1/stats') {
      return handleStats(request, env, log);
    }

    // 仅允许 POST /api/v1/report
    if (request.method !== 'POST' || url.pathname !== '/api/v1/report') {
      return corsResponse(jsonResponse(404, { code: 404, message: 'Not found' }), request, env);
    }

    // ── Content-Type 检查 ──────────────────────────────────────
    const contentType = request.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      return corsResponse(
        jsonResponse(415, { code: 415, message: 'Content-Type must be application/json' }),
        request,
        env
      );
    }

    // ── 解析 JSON 请求体 ─────────────────────────────────────
    let body;
    try {
      body = await request.json();
    } catch {
      return corsResponse(
        jsonResponse(400, { code: 400, message: 'Invalid JSON body' }),
        request,
        env
      );
    }

    // ── 验证顶层结构 ──────────────────────────────────────────
    const schemaCheck = validateReportBody(body);
    if (!schemaCheck.valid) {
      return corsResponse(
        jsonResponse(400, { code: 400, message: schemaCheck.error }),
        request,
        env
      );
    }

    // ── 提取原始事件 ──────────────────────────────────────────
    const rawEvents = extractEvents(body);
    if (!rawEvents.length) {
      return corsResponse(
        jsonResponse(400, { code: 400, message: 'No events found in logs array' }),
        request,
        env
      );
    }

    // ── 逐条验证（同步，无 await）──────────────────────────
    const clientIP = request.headers.get('cf-connecting-ip') || '';

    const validationErrors = [];
    const validData = [];

    for (const raw of rawEvents) {
      const result = validateEvent(raw);
      if (!result.valid) {
        validationErrors.push(result.error);
        continue;
      }
      validData.push(result.data);
    }

    if (!validData.length) {
      return corsResponse(
        jsonResponse(400, {
          code: 400,
          message: 'All events failed validation',
          errors: validationErrors.slice(0, 20),
        }),
        request,
        env
      );
    }

    // ── 直接使用原始数据，不进行任何 PII 脱敏 ────────────
    const validEvents = validData.map(ev => ({ ...ev, _client_ip: clientIP }));

    // ── 按 app_id 分组 ──────────────────────────────────────
    const groups = groupByAppId(validEvents);

    // 构建各分组的 R2 key 与写入操作，同时为 D1 异步写入保留 key 信息
    const writeOps = [...groups].map(([appId, evs]) => {
      const key = generateKey(uuidv7(), appId);
      return {
        key,
        events: evs,
        promise: env.MONITOR_BUCKET.put(key, toJSONL(evs), {
          httpMetadata: { contentType: 'application/x-ndjson' },
          customMetadata: {
            'app-id': String(appId || 'unknown'),
            'event-count': String(evs.length),
            'schema-version': '1.0',
          },
        }),
      };
    });

    // ── 并行写入 R2（JSONL 格式，同步阻塞）────────────────
    let writeOk = true;
    let files = 0;

    try {
      const results = await Promise.allSettled(writeOps.map((op) => op.promise));
      for (const r of results) {
        if (r.status === 'fulfilled') {
          files++;
        } else {
          writeOk = false;
          log.error({ err: r.reason?.message ?? String(r.reason) }, 'R2 write failed');
        }
      }
      if (writeOk) {
        log.info(
          { accepted: validEvents.length, rejected: rawEvents.length - validEvents.length, files },
          'R2 write completed'
        );
      }
    } catch (err) {
      writeOk = false;
      log.error({ err: err.message }, 'R2 write failed');
    }

    if (!writeOk) {
      return corsResponse(
        jsonResponse(500, {
          code: 500,
          message: 'Internal server error — R2 write failed',
          accepted: 0,
          rejected: rawEvents.length,
        }),
        request,
        env
      );
    }

    // ── 响应已成功 ─────────────────────────────────────────

    // ── 成功后非阻塞写入 D1（best-effort）───────────────────
    // R2 是提交点；D1 走 ctx.waitUntil 异步写，失败由对账 cron 兜底。
    if (validEvents.length > 0 && env.MY_BINDING_D1) {
      const receivedAt = Date.now();
      const d1Rows = [];

      for (const op of writeOps) {
        op.events.forEach((ev, offset) => {
          d1Rows.push(mapEventToRow(ev, op.key, offset, receivedAt));
        });
      }

      ctx.waitUntil(
        insertD1Batch(env.MY_BINDING_D1, d1Rows).catch((e) => {
          log.error({ err: e.message, rowCount: d1Rows.length }, 'D1 batch insert failed');
        })
      );
    }

    const accepted = validEvents.length;
    const rejected = rawEvents.length - accepted;

    return corsResponse(
      jsonResponse(200, {
        code: 200,
        message: 'OK',
        data: {
          accepted,
          rejected,
          validationErrors:
            validationErrors.length > 0 ? validationErrors.slice(0, 20) : undefined,
        },
      }),
      request,
      env
    );
  },

  // ── 定时任务：对账回补（R2→D1 自愈）+ 滚动清理（删超期行）──────────
  // 由 wrangler.jsonc triggers.crons 触发；controller.cron 区分具体任务。
  async scheduled(controller, env, ctx) {
    const log = createLogger(env);
    if (controller.cron === RECONCILE_CRON) {
      ctx.waitUntil(
        reconcileD1(env, log).catch((e) =>
          log.error({ err: e?.message ?? String(e) }, 'D1 reconcile failed')
        )
      );
    } else if (controller.cron === CLEANUP_CRON) {
      ctx.waitUntil(
        cleanupD1(env, log).catch((e) =>
          log.error({ err: e?.message ?? String(e) }, 'D1 cleanup failed')
        )
      );
    }
  },
};

// ==============================================================================
// CORS 工具
// ==============================================================================

function handleCORS(request, env) {
  const origin = request.headers.get('origin') || '';
  const allowed = getAllowedOrigins(env);

  if (allowed.size > 0 && !allowed.has(origin)) {
    return new Response(null, { status: 403 });
  }

  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': allowed.size === 0 ? '*' : origin,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-App-Key, X-SDK-Version',
      'Access-Control-Max-Age': '86400',
    },
  });
}

function corsResponse(response, request, env) {
  const headers = new Headers(response.headers);
  const origin = request.headers.get('origin') || '';
  const allowed = getAllowedOrigins(env);
  if (allowed.size === 0) {
    headers.set('Access-Control-Allow-Origin', '*');
  } else if (allowed.has(origin)) {
    headers.set('Access-Control-Allow-Origin', origin);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function getAllowedOrigins(env) {
  const raw = env.ALLOWED_ORIGINS || '';
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  );
}

// ==============================================================================
// D1 工具
// ==============================================================================

/**
 * D1 INSERT 语句（19 个参数，与 events 表字段一一对应）
 */
const D1_INSERT_SQL = `INSERT OR IGNORE INTO events
  (r2_key, r2_offset, event_type, event_id, ts, received_at, app_id,
   user_id, device_id, session_id, page_url, page_title, referrer, sdk_version,
   client_type, fingerprint_id, client_ip, extra, raw_extra)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

/**
 * 批量插入 D1（自动分片，每批最多 50 条）
 *
 * D1 的 batch() 将多条语句包裹在同一个事务中执行。
 * 使用 INSERT OR IGNORE 确保对账/重跑幂等。
 *
 * @param {import('@cloudflare/workers-types').D1Database} db
 * @param {Array<Array<*>>} rows
 * @param {number} [chunkSize=50]
 */
async function insertD1Batch(db, rows, chunkSize = 50) {
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const stmts = chunk.map((row) => db.prepare(D1_INSERT_SQL).bind(...row));
    await db.batch(stmts);
  }
}

/**
 * 把一条规范化事件映射成 D1 行（19 元素数组，与 events 表字段一一对应）
 *
 * 双写与对账回补共用此映射，保证两处产出的行结构完全一致；
 * 对账时 (r2_key, r2_offset) 命中已有行即被 INSERT OR IGNORE 跳过。
 *
 * @param {Object} ev - 已校验 + 已脱敏的事件（来自上报或 R2 JSONL）
 * @param {string} r2Key - 来源 R2 对象 key
 * @param {number} offset - 在该 JSONL 文件中的行号
 * @param {number} receivedAt - 入库时间(ms)，双写用 Date.now()，回补用 R2 uploaded
 * @returns {Array<*>}
 */
function mapEventToRow(ev, r2Key, offset, receivedAt) {
  const extraStr = JSON.stringify(ev.extra || {});
  const truncatedExtra =
    extraStr.length > 2000 ? '<TRUNC>' + extraStr.slice(0, 2000) : extraStr;

  return [
    r2Key, // r2_key
    offset, // r2_offset
    ev.event_type || '', // event_type
    ev.event_id || '', // event_id
    Number(ev.timestamp) || 0, // ts（强制数值，避免字符串时间戳导致范围比较错乱）
    receivedAt, // received_at
    ev.app_id || '', // app_id
    ev.user_id || '', // user_id（原始值，未脱敏）
    ev.device_id || '', // device_id（原始值，未脱敏）
    ev.session_id || '', // session_id（原始值，未脱敏）
    ev.page_url || '', // page_url
    ev.page_title || '', // page_title
    ev.referrer || '', // referrer
    ev.sdk_version || '', // sdk_version
    ev.client_type || 'Web', // client_type
    ev.fingerprint_id || '', // fingerprint_id
    ev._client_ip || '', // client_ip（原始值）
    truncatedExtra, // extra（超 2000 字符截断）
    extraStr.length, // raw_extra
  ];
}

/**
 * GET /api/v1/stats — D1 查询接口
 *
 * 参数（均为可选）：
 *   app_id      过滤应用
 *   from        起始时间戳 ms（默认 24h 前）
 *   to          结束时间戳 ms（默认当前）
 *   granularity 聚合粒度 hour|day（默认 hour）
 *
 * 返回 JSON：
 *   { data: { total, pv, uv, by_type, time_series, meta } }
 *   - total: 窗口内事件总数
 *   - pv:    页面浏览数（event_id='page_view'；不用 event_type='view'，避免把滚动等算进来）
 *   - uv:    独立访客数（COUNT(DISTINCT device_id)；空 device_id 不计，旧事件不计入 UV）
 */
async function handleStats(request, env, log) {
  if (!env.MY_BINDING_D1) {
    return jsonResponse(503, { code: 503, message: 'D1 not configured' });
  }

  const url = new URL(request.url);
  const appId = url.searchParams.get('app_id') || '';
  const now = Date.now();
  const from = parseInt(url.searchParams.get('from') || String(now - 86400000));
  const to = parseInt(url.searchParams.get('to') || String(now));
  const granularity = url.searchParams.get('granularity') || 'hour';

  const db = env.MY_BINDING_D1;

  try {
    // 1）总计数 + PV + UV（一次表扫描）
    //    PV 用 event_id='page_view'（event_type='view' 会包含 page_scroll 等，会虚高）。
    //    UV 用 NULLIF(device_id,'')：COUNT(DISTINCT) 自动忽略 NULL，空 device_id（旧事件）不计入 UV。
    const totalRow = await db
      .prepare(
        `SELECT
           COUNT(*) AS total,
           COUNT(CASE WHEN event_id = 'page_view' THEN 1 END) AS pv,
           COUNT(DISTINCT NULLIF(device_id, '')) AS uv
         FROM events
         WHERE ts >= ? AND ts <= ? AND (? = '' OR app_id = ?)`
      )
      .bind(from, to, appId, appId)
      .first();

    // 2）按 event_type 分布
    const byType = await db
      .prepare(
        `SELECT event_type, COUNT(*) AS cnt FROM events
         WHERE ts >= ? AND ts <= ? AND (? = '' OR app_id = ?)
         GROUP BY event_type ORDER BY cnt DESC`
      )
      .bind(from, to, appId, appId)
      .all();

    // 3）时间序列
    const timeFmt =
      granularity === 'day'
        ? `strftime('%Y-%m-%d', ts / 1000, 'unixepoch')`
        : `strftime('%Y-%m-%dT%H', ts / 1000, 'unixepoch')`;

    const timeSeries = await db
      .prepare(
        `SELECT ${timeFmt} AS period, COUNT(*) AS cnt FROM events
         WHERE ts >= ? AND ts <= ? AND (? = '' OR app_id = ?)
         GROUP BY period ORDER BY period`
      )
      .bind(from, to, appId, appId)
      .all();

    const result = {
      total: totalRow?.total || 0,
      pv: totalRow?.pv || 0,
      uv: totalRow?.uv || 0,
      by_type: Object.fromEntries(
        (byType.results || []).map((r) => [r.event_type, r.cnt])
      ),
      time_series: timeSeries.results || [],
      meta: { from, to, app_id: appId || '(all)', granularity },
    };

    return corsResponse(
      jsonResponse(200, { code: 200, data: result }),
      request,
      env
    );
  } catch (err) {
    log.error({ err: err.message }, 'Stats query failed');
    return corsResponse(
      jsonResponse(500, { code: 500, message: 'Query failed' }),
      request,
      env
    );
  }
}

// ==============================================================================
// 定时任务（对账回补 / 滚动清理）
// ==============================================================================

// 与 wrangler.jsonc triggers.crons 一一对应，scheduled handler 据此路由
const RECONCILE_CRON = '*/15 * * * *';
const CLEANUP_CRON = '17 3 * * *';

const WM_KEY = 'reconcile_watermark'; // meta 表中的 watermark 键
const INITIAL_LOOKBACK_MS = 2 * 3600000; // 首次回看 2 小时
const SAFETY_MARGIN_MS = 5 * 60000; // watermark 回退 5 分钟，保证扫描期内上传的文件下次再扫
const MAX_BUCKETS = 72; // 单次最多扫描 72 个小时分区（≈3 天），防止异常 watermark 导致全表扫描
const MAX_OBJECTS = 1000; // 单次最多处理对象数，防止单次 cron 超时

/**
 * 对账回补：扫描近期 R2 文件，把 D1 缺失的事件补齐（自愈双写失败）
 *
 * 增量策略（watermark = 已回补到的「接收时间」ms）：
 *   1. 读 meta.reconcile_watermark（缺省 = now - 2h）
 *   2. 枚举 [watermark, now] 覆盖的小时分区（R2 按「接收时间」date/HH 分区）
 *   3. 逐 app × 分区 list R2 对象 → get → 解析 JSONL → INSERT OR IGNORE
 *   4. 推进 watermark = scanStart - 5min（下次重扫安全窗口，配合 IGNORE 幂等）
 *
 * @param {Object} env
 * @param {Object} log
 */
async function reconcileD1(env, log) {
  if (!env.MY_BINDING_D1 || !env.MONITOR_BUCKET) return;
  const db = env.MY_BINDING_D1;
  const bucket = env.MONITOR_BUCKET;
  const scanStart = Date.now();

  // 1) 读 watermark
  const wmRow = await db.prepare('SELECT value FROM meta WHERE key = ?').bind(WM_KEY).first();
  const fromMs = wmRow ? Number(wmRow.value) : scanStart - INITIAL_LOOKBACK_MS;

  // 2) 枚举需扫描的小时分区
  const buckets = hourBuckets(fromMs, scanStart, MAX_BUCKETS);

  // 3) 发现所有 app 前缀（delimiter 列举，开销与 app 数量成正比）
  const apps = await listAppPrefixes(bucket);

  // 4) 逐 app × 分区 回补
  let objects = 0;
  let backfilled = 0;
  const failedKeys = [];
  stop: for (const app of apps) {
    for (const part of buckets) {
      const prefix = `${app}${part}/`;
      let cursor;
      do {
        const listed = await bucket.list({ prefix, cursor, limit: 500 });
        for (const meta of listed.objects) {
          if (objects >= MAX_OBJECTS) break stop;
          objects++;
          try {
            const full = await bucket.get(meta.key);
            if (!full) continue; // 并发删除等边界：对象已不存在
            const text = await full.text();
            const uploaded =
              meta.uploaded instanceof Date ? meta.uploaded.getTime() : scanStart;
            const lines = text.split('\n');
            const rows = [];
            for (let i = 0; i < lines.length; i++) {
              const line = lines[i].trim();
              if (!line) continue;
              try {
                rows.push(mapEventToRow(JSON.parse(line), meta.key, i, uploaded));
              } catch {
                failedKeys.push(`${meta.key}:${i}`); // 单行解析失败，不阻塞其余行
              }
            }
            if (rows.length) {
              await insertD1Batch(db, rows); // INSERT OR IGNORE：已存在的行自动跳过
              backfilled += rows.length;
            }
          } catch (e) {
            failedKeys.push(meta.key);
            log.warn({ key: meta.key, err: e?.message ?? String(e) }, 'reconcile object failed');
          }
        }
        cursor = listed.truncated ? listed.cursor : undefined;
      } while (cursor);
    }
  }

  // 5) 推进 watermark（回退安全窗口，下次幂等重扫最近几分钟）
  const newWm = scanStart - SAFETY_MARGIN_MS;
  await db
    .prepare(
      `INSERT INTO meta(key, value) VALUES(?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    )
    .bind(WM_KEY, String(newWm))
    .run();

  log.info(
    {
      from: new Date(fromMs).toISOString(),
      to: new Date(scanStart).toISOString(),
      apps: apps.length,
      buckets: buckets.length,
      objects,
      backfilled,
      failed: failedKeys.length,
    },
    'D1 reconcile done'
  );
}

/**
 * 滚动清理：删除超过保留期的 D1 行（R2 仍保留全量原始数据，可随时回补）
 *
 * @param {Object} env
 * @param {Object} log
 */
async function cleanupD1(env, log) {
  if (!env.MY_BINDING_D1) return;
  const retentionDays = Number(env.D1_RETENTION_DAYS) || 60;
  const cutoff = Date.now() - retentionDays * 86400000;
  const res = await env.MY_BINDING_D1
    .prepare('DELETE FROM events WHERE received_at < ?')
    .bind(cutoff)
    .run();
  log.info({ deleted: res.meta?.changes ?? 0, retentionDays }, 'D1 cleanup done');
}

/**
 * 枚举两个时间戳之间的小时分区（对应 R2 key 中的 date/HH）
 *
 * @param {number} fromMs
 * @param {number} toMs
 * @param {number} maxBuckets
 * @returns {Array<string>} 形如 ['2026-07-03/14', '2026-07-03/15']
 */
function hourBuckets(fromMs, toMs, maxBuckets) {
  const out = [];
  const start = Math.floor(fromMs / 3600000) * 3600000; // 向下取整到整点
  for (let t = start; t <= toMs && out.length < maxBuckets; t += 3600000) {
    const d = new Date(t);
    out.push(`${d.toISOString().slice(0, 10)}/${String(d.getUTCHours()).padStart(2, '0')}`);
  }
  return out;
}

/**
 * 列举所有 app 前缀（R2 key 顶层目录 = safe_app_id/）
 *
 * @param {import('@cloudflare/workers-types').R2Bucket} bucket
 * @returns {Promise<Array<string>>} 形如 ['snapmaker-model-community/']
 */
async function listAppPrefixes(bucket) {
  const apps = [];
  let cursor;
  do {
    const listed = await bucket.list({ delimiter: '/', cursor, limit: 1000 });
    for (const p of listed.delimitedPrefixes || []) {
      apps.push(p.endsWith('/') ? p : `${p}/`);
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
  return apps;
}

// ==============================================================================
// 辅助
// ==============================================================================

function jsonResponse(status, data) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}


