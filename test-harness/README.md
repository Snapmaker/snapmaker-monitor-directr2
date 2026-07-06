# DirectR2 上报测试台（test-harness）

一个**单文件、零依赖**的 HTML 测试页，用于向已部署的 DirectR2 Worker 发送前端监控 SDK 数据，联调 `/api/v1/report` 端点。

- 文件：`index.html`（内联 CSS + JS，无外部依赖）
- 双击即可打开；若浏览器限制 `file://` 跨域 fetch，用本地静态服务器打开（`npx serve`）。

## 为什么需要它

`src/`（SDK）→ `DirectR2`（Worker）→ R2 是一条链路。这个页面让你在不依赖完整 SDK 运行环境的前提下，手动构造任意 `logs` 负载发往 Worker，快速验证：连通性、字段校验、批处理分组、错误码、CORS。

## 目标端点

```
POST https://direnctr2.snapmaker-app.workers.dev/api/v1/report
Content-Type: application/json
Body: { "logs": [ { event_type, event_id, ... }, ... ] }
```

DirectR2 Worker **无 token 鉴权**，仅靠 CORS origin（默认 `ALLOWED_ORIGINS=""` 允许所有）。

## 功能

| 区 | 说明 |
|---|---|
| ① 模板 | 一键填充 JSON：PV(view)/点击(click)/JS错误(fail)/API(success)/性能(process)/自定义/批量×10（双 app_id，测 R2 分组）|
| ② 表单构造器 | 逐字段填单条事件，event_type 必填（带真实值 datalist），extra 支持 JSON；「添加到 logs」追加 |
| ③ JSON 负载 | `{ logs: [...] }` 的**唯一真相源**；表单/模板/删除都更新它，也可直接手改 |
| ④ 发送 | `fetch` POST，显示耗时 |
| ⑤ 响应结果 | 状态码（2xx绿/4xx橙/5xx红）、accepted/rejected 计数、`validationErrors` 高亮、完整响应 JSON 美化 |
| ⑥ 边界用例 | 一键发非法数据，验证 Worker 返回 400/415：缺 event_type、page_url 超长、空 logs、logs 含非对象、错误 Content-Type、非 JSON body |

## 设计要点

1. **JSON 编辑器是唯一真相源**——表单只是"构造一条并追加"的便捷入口，模板是覆盖式更新。避免双向绑定的复杂度与状态不一致。
2. **模板数据真实可信**——`event_type/event_id` 取自 SDK `reporter.js` 的映射表（view/click/success/fail/process + page_view/element_click/js_error/api_request/perf_lcp），`app_id/sdk_version/client_type` 取自 `config.js`/README。
3. **边界用例与 Worker 校验逻辑一一对应**——每个用例的预期错误信息可在 `DirectR2/src/validation.js`、`index.js` 中找到对应分支（如 `event_type is required`、`page_url exceeds 4096 characters`、`Invalid JSON body`、415 Content-Type 检查）。
4. **URL 持久化**——存 localStorage，避免每次重填。

## 验证清单

发送后，可到 R2（bucket `data-analyse`）确认数据落盘路径：
```
<safe_app_id>/YYYY-MM-DD/HH/<uuid>.jsonl
```
「批量×10」用例应产生 2 个 JSONL 文件（两个 app_id 各一组）。

## 接口契约参考

- 请求体：`{ logs: Array }`，`logs` 非空
- 每条事件：`event_type` 必填（≤50字符）；可选 `event_id/timestamp/user_id/session_id/page_url/page_title/referrer/app_id/sdk_version/client_type/fingerprint_id/extra`
- 字段长度上限见 `DirectR2/src/validation.js` 的 `MAX_LEN`
- 成功响应：`200 { code, message, data:{ accepted, rejected, validationErrors? } }`
- 脱敏：`user_id`(HMAC/SHA256)、`session_id`(SHA256)、`_client_ip`(截断) 在落盘前完成，R2 无明文
