# DirectR2 — 前端监控数据直写 Cloudflare R2

将 Snapmaker 前端监控 SDK（`src/`）上报的数据**直接写入 Cloudflare R2**，不采用 Queues 或 Durable Object。

## 架构

```
浏览器 SDK                     DirectR2 Worker                    Cloudflare R2
┌──────────────┐    POST      ┌──────────────────────┐  JSONL    ┌────────────┐
│ sendBeacon / │  ─────────>  │ fetch(request)       │ ────────> │            │
│ XHR          │              │                      │           │ data-      │
│              │  <─────────  │ 1. 验证 / 脱敏        │ 分区写入  │ analyse    │
│ { logs: [...]}   200 OK    │ 2. 分组 / JSONL      │           │            │
└──────────────┘              │ 3. R2.put()           │           │ app_id/    │
                              └──────────────────────┘           │   date/HH/ │
                                                                 └────────────┘
```

## 为什么要用 DirectR2（不用 Queues/DO）

| 方案        | 延迟  | 可靠性         | 运维复杂度 | 适用场景                           |
|------------|-------|----------------|-----------|------------------------------------|
| DirectR2   | 较低  | 中等（同步写） | 最低      | 低流量、可接受少量丢数据           |
| Queues     | 低    | 高（重试/DLQ） | 中        | 生产环境、吞吐量稳定               |
| Durable Obj| 较高  | 极高（强一致） | 高        | 需要去重/聚合/实时计算             |

**DirectR2 定位**：快速起步、零中间件、直接写 R2 的简化方案。

## R2 文件分区格式

```
<safe_app_id>/YYYY-MM-DD/HH/<uuid>.jsonl
```

示例：
```
snapmaker-model-community/2026-07-02/14/a1b2c3d4-5678-7abc-def0-123456789abc.jsonl
```

| 段 | 说明 |
|---|---|
| `<safe_app_id>` | app_id 转义后的值（非单词字符替换为 `_`）|
| `YYYY-MM-DD` | UTC 日期分区 |
| `HH` | UTC 小时分区（24 小时制）|
| `<uuid>.jsonl` | UUID v7 文件名，JSONL 格式内容 |

## 部署

### 前置条件

1. 安装 [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/)
2. 已创建 R2 bucket `data-analyse`（名称可在 `wrangler.jsonc` 中修改）

### 部署步骤

```bash
# 1. 进入 DirectR2 目录
cd DirectR2

# 2. 登录 Cloudflare（如未登录）
npx wrangler login

# 3. 部署
npx wrangler deploy

# 4. 配置环境变量（若需修改默认值）
npx wrangler secret put PII_HMAC_SALT
```

### 部署后配置

部署完成后，将输出的 Worker URL（如 `https://monitor-direct-r2.<your-subdomain>.workers.dev`）配置到 SDK 的 `reportUrl` 中：

```js
MonitorSDK.init({
  appId: 'snapmaker-model-community',
  reportUrl: 'https://monitor-direct-r2.<your-subdomain>.workers.dev/api/v1/report',
  // ...
});
```

## 环境变量

| 变量             | 必需 | 默认值 | 说明                                    |
|-----------------|------|--------|----------------------------------------|
| `MONITOR_BUCKET` | 是   | —      | R2 bucket binding（wrangler.jsonc 配置）|
| `PII_HMAC_SALT`  | 否   | `""`   | HMAC salt（缺省降级为 SHA256）          |
| `ALLOWED_ORIGINS`| 否   | `""`   | CORS 允许域名（逗号分隔；缺省允许所有） |
| `LOG_LEVEL`      | 否   | `info` | 日志级别：debug/info/warn/error         |

## 本地开发

```bash
# 启动本地开发服务器
npx wrangler dev

# 测试上报
curl -X POST http://localhost:8787/api/v1/report \
  -H "Content-Type: application/json" \
  -d '{
    "logs": [{
      "event_type": "view",
      "event_id": "page_view",
      "user_id": "user_test_001",
      "app_id": "snapmaker-model-community",
      "timestamp": 1718445600000
    }]
  }'
```

## 文件结构

```
DirectR2/
├── src/
│   ├── index.js       # Worker 主入口（fetch handler）
│   ├── validation.js  # 请求体 & 事件格式验证（纯 JS，无 zod）
│   ├── r2.js          # R2 key 生成 / JSONL 序列化 / 分组
│   ├── crypto.js      # PII 脱敏（sha256 / hmac / IP 截断）
│   ├── uuid.js        # UUID v7 生成
│   └── logger.js      # 日志封装（支持 LOG_LEVEL 控制）
├── wrangler.jsonc     # Wrangler 配置（R2 binding + vars）
└── README.md          # 本文档
```

## 性能说明

- **同步写 R2**：await R2.put() 后才返回响应，确保 SDK 的 XHR 重试机制生效
- **sendBeacon 兼容**：浏览器 sendBeacon 是 fire-and-forget，但 Worker 仍会完整执行 R2 写入
- **批处理**：单次请求中的所有事件合并为少量 JSONL 文件（按 app_id 分组），避免产生过多小文件
- **脱敏前置**：PII 脱敏（user_id HMAC / session_id SHA256）在写入 R2 前完成，R2 中不留明文
