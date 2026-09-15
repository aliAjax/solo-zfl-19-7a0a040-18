# 手摇风琴纸带打孔API

纯后端零依赖 Node 服务，使用 `data/db.json` 持久化曲目、纸带区间、试奏问题，以及生产工时与费用核算。

## 启动

```bash
PORT=3019 node server.js
npm test          # node:test 真实 HTTP 接口自动化测试（子进程启动服务、临时库、可重启）
```

环境变量：

- `PORT`（默认 3019）
- `DB_FILE`（默认 `data/db.json`；测试与多实例可用它指向独立文件）
- `TZ_OFFSET_MINUTES`（午夜拆分所用时区偏移，分钟；默认 480=东八区，测试固定 0）

## 纸带接口（原有，保持不变）

- `GET /health`
- `GET /tunes` · `POST /tunes`
- `GET /tunes/:id/progress`
- `GET /tunes/:id/sections` · `POST /tunes/:id/sections`
- `GET /tunes/:id/unchecked-sections`
- `PATCH /sections/:id/check`
- `GET /issues?tuneId=&status=` · `POST /issues` · `PATCH /issues/:id/status`

## 工时核算接口

- 工人/机台：`GET/POST /workers`、`GET/POST /machines`（`code` 唯一）
- 费率：`GET /rates?targetType=&targetId=`、`POST /rates`
  - `targetType` 为 `worker`/`machine`；`amount` 为元/小时（内部按整数分存储）
  - 按 `[effectiveFrom, effectiveTo)` 生效区间保存；区间重叠返回 409
  - 新增不带 `effectiveTo` 的开放费率时，自动把该目标原开放费率在新生效时刻闭合
- 工时：`GET /time-entries?tuneId=&sectionId=&workerId=&machineId=&status=&month=`
  - `POST /time-entries`：按曲目区间登记 `workerId + machineId + startAt + endAt`（ISO 时间）
    - 同一工人或同一机台的时间区间 `[start,end)` 不能重叠，首尾相接允许；冲突返回 409（区分工人/机台）
    - 支持 `idempotencyKey`，并发/重试同键只落一条
  - 草稿可 `PATCH /time-entries/:id`、`DELETE /time-entries/:id`；已确认一律拒绝（409）
  - `POST /time-entries/:id/confirm`：确认并生成**不可变**费用明细；重复确认幂等（200），不重复计费
- 明细：`GET /fee-details?tuneId=&sectionId=&workerId=&machineId=&kind=&entryId=&month=`（只读）
- 调整：`GET /adjustments`、`POST /adjustments`
  - `reasonType` 为 `correction`（纠错，金额可为负）或 `backfill`（补录）；只追加，永不改写历史明细
  - 只能对已确认工时开调整；可带 `entryId` 或只挂曲目/工人/机台
- 汇总：`GET /cost-report?tuneId=&sectionId=&workerId=&machineId=&month=`
  - 返回工时数、总工时分钟、明细金额、调整金额、合计

## 核算与一致性语义

- **自动拆分**：确认时按「本地午夜」与「费率生效边界」两类切点，把人工线与机台线分别切成明细段；一段缺失生效费率则整条确认失败（422），不落任何半条明细。
- **金额**：整数分存储，`amountCents = round(费率分 × 段分钟 / 60)`；接口同时返回元值。人工、机台各计一份费用；总工时只按人工线计时，不翻倍。
- **不可变 + 调整**：确认后的明细与工时不可修改/删除；补录、纠错另开调整单，汇总时 `合计 = 明细 + 调整`。
- **并发**：单进程写事务串行化（读-校验-改-原子写全程持锁），并发登记同一时段仅一条胜出，其余 409；并发确认只生成一套明细。
- **原子落盘**：临时文件 + `rename`，失败不会留下写坏/写一半的 `db.json`；无遗留 `.tmp-*` 文件。
- **重启一致**：费率（含毫秒字段）、工时、明细、调整全部持久化，重启后查询结果与规则行为不变。
- 旧 `db.json` 缺新集合时自动按空集合兼容，旧数据与接口原样保留。

## 闭环示例

```bash
curl http://127.0.0.1:3019/tunes/tune_demo/progress

WID=$(curl -s -X POST http://127.0.0.1:3019/workers -H 'Content-Type: application/json' \
  -d '{"name":"陈师傅","code":"W001"}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).data.id')
MID=$(curl -s -X POST http://127.0.0.1:3019/machines -H 'Content-Type: application/json' \
  -d '{"name":"一号打孔机","code":"M001"}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).data.id')
curl -X POST http://127.0.0.1:3019/rates -H 'Content-Type: application/json' \
  -d "{\"targetType\":\"worker\",\"targetId\":\"$WID\",\"amount\":60,\"effectiveFrom\":\"2026-01-01T00:00:00Z\"}"
curl -X POST http://127.0.0.1:3019/rates -H 'Content-Type: application/json' \
  -d "{\"targetType\":\"machine\",\"targetId\":\"$MID\",\"amount\":90,\"effectiveFrom\":\"2026-01-01T00:00:00Z\"}"

EID=$(curl -s -X POST http://127.0.0.1:3019/time-entries -H 'Content-Type: application/json' \
  -d "{\"tuneId\":\"tune_demo\",\"sectionId\":\"section_demo_1\",\"workerId\":\"$WID\",\"machineId\":\"$MID\",\"startAt\":\"2026-09-15T22:00:00Z\",\"endAt\":\"2026-09-16T02:00:00Z\"}" \
  | node -pe 'JSON.parse(require("fs").readFileSync(0)).data.id')
curl -X POST http://127.0.0.1:3019/time-entries/$EID/confirm          # 跨午夜自动拆成 4 段
curl "http://127.0.0.1:3019/cost-report?workerId=$WID&month=2026-09"
curl -X POST http://127.0.0.1:3019/adjustments -H 'Content-Type: application/json' \
  -d "{\"reasonType\":\"correction\",\"entryId\":\"$EID\",\"amount\":-10,\"occurredAt\":\"2026-09-16T02:00:00Z\",\"reason\":\"停转误计\"}"
```
