const http = require("http");
const { readFile, writeFile, rename: renameFile, mkdir } = require("fs/promises");
const path = require("path");

const PORT = Number(process.env.PORT || 3019);
const DB_FILE = process.env.DB_FILE || path.join(__dirname, "data", "db.json");
// 午夜拆分使用固定时区偏移（分钟），默认东八区；测试可固定为 0
const TZ_OFFSET_MINUTES = Number(process.env.TZ_OFFSET_MINUTES ?? 480);

const nowIso = () => new Date().toISOString();

const initialData = {
  tunes: [
    {
      id: "tune_demo",
      title: "雨后圆舞曲",
      composer: "匿名",
      stripSpec: {
        widthMm: 70,
        scale: "20音",
        tempoBpm: 82,
        paperType: "半透明纸带"
      },
      createdAt: "2026-06-16T00:00:00.000Z"
    }
  ],
  sections: [
    {
      id: "section_demo_1",
      tuneId: "tune_demo",
      startBeat: 1,
      endBeat: 32,
      laneRange: "1-10",
      checked: true,
      note: "开头主题已试奏"
    },
    {
      id: "section_demo_2",
      tuneId: "tune_demo",
      startBeat: 33,
      endBeat: 64,
      laneRange: "4-18",
      checked: false,
      note: "副歌段等待校对"
    }
  ],
  issues: [
    {
      id: "issue_demo",
      tuneId: "tune_demo",
      sectionId: "section_demo_2",
      type: "漏孔",
      beat: 41,
      lane: 12,
      description: "第41拍高音孔漏打",
      status: "open",
      createdAt: "2026-06-16T00:00:00.000Z",
      resolvedAt: null
    }
  ],
  workers: [
    { id: "worker_demo", name: "陈师傅", code: "W001", active: true, createdAt: "2026-06-16T00:00:00.000Z" }
  ],
  machines: [
    { id: "machine_demo", name: "一号打孔机", code: "M001", active: true, createdAt: "2026-06-16T00:00:00.000Z" }
  ],
  rates: [
    {
      id: "rate_demo_worker",
      targetType: "worker",
      targetId: "worker_demo",
      amountCents: 6000,
      effectiveFrom: "2026-01-01T00:00:00.000Z",
      effectiveTo: null,
      createdAt: "2026-06-16T00:00:00.000Z"
    },
    {
      id: "rate_demo_machine",
      targetType: "machine",
      targetId: "machine_demo",
      amountCents: 9000,
      effectiveFrom: "2026-01-01T00:00:00.000Z",
      effectiveTo: null,
      createdAt: "2026-06-16T00:00:00.000Z"
    }
  ],
  timeEntries: [],
  feeDetails: [],
  adjustments: []
};

const routes = [
  "GET /health",
  "GET /tunes",
  "POST /tunes",
  "GET /tunes/:id/progress",
  "GET /tunes/:id/sections",
  "POST /tunes/:id/sections",
  "GET /tunes/:id/unchecked-sections",
  "PATCH /sections/:id/check",
  "GET /issues",
  "POST /issues",
  "PATCH /issues/:id/status",
  "GET /workers",
  "POST /workers",
  "GET /machines",
  "POST /machines",
  "GET /rates",
  "POST /rates",
  "GET /time-entries",
  "POST /time-entries",
  "GET /time-entries/:id",
  "PATCH /time-entries/:id",
  "DELETE /time-entries/:id",
  "POST /time-entries/:id/confirm",
  "GET /fee-details",
  "GET /adjustments",
  "POST /adjustments",
  "GET /cost-report"
];

/* ---------------- 存储：互斥事务 + 原子写入 ---------------- */

function normalizeDb(db) {
  return {
    tunes: db.tunes || [],
    sections: db.sections || [],
    issues: db.issues || [],
    workers: db.workers || [],
    machines: db.machines || [],
    rates: db.rates || [],
    timeEntries: db.timeEntries || [],
    feeDetails: db.feeDetails || [],
    adjustments: db.adjustments || []
  };
}

async function ensureDb() {
  await mkdir(path.dirname(DB_FILE), { recursive: true });
  try {
    JSON.parse(await readFile(DB_FILE, "utf8"));
  } catch {
    await atomicWrite(normalizeDb(initialData));
  }
}

async function readDb() {
  await ensureDb();
  const raw = await readFile(DB_FILE, "utf8");
  let db;
  try {
    db = JSON.parse(raw);
  } catch {
    // 文件损坏时不静默重置，避免掩盖数据事故
    const error = new Error("数据库文件损坏，拒绝启动以保护数据");
    error.status = 500;
    throw error;
  }
  return normalizeDb(db);
}

// 临时文件 + rename：崩溃不会留下写了一半的 db.json
async function atomicWrite(data) {
  const tmp = `${DB_FILE}.tmp-${process.pid}-${writeSeq++}`;
  await writeFile(tmp, JSON.stringify(data, null, 2));
  await renameFile(tmp, DB_FILE);
}
let writeSeq = 0;

// 单进程串行化所有写事务：读-校验-改-写全程持锁，杜绝并发重叠占用与重复计费
let chain = Promise.resolve();
function transaction(fn) {
  const run = chain.then(async () => {
    const db = await readDb();
    const result = await fn(db); // fn 内部只做校验与内存修改，全部成功后统一落盘
    await atomicWrite(db);
    return result;
  });
  // 失败不污染后续请求
  chain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

/* ---------------- HTTP 工具 ---------------- */

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body, null, 2));
}

function parseUrl(req) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  return { pathname: url.pathname, searchParams: url.searchParams };
}

async function parseBody(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  if (!raw) return {};
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw httpError(400, "请求体必须是合法JSON");
  }
  // 只接受 JSON 对象：整体为 null、数组、数字/字符串/布尔原始值一律按参数错误拒绝
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw httpError(400, "请求体必须是JSON对象");
  }
  return parsed;
}

function makeId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function required(body, fields) {
  const missing = fields.filter((field) => body[field] === undefined || body[field] === null || body[field] === "");
  if (missing.length) {
    const error = new Error(`缺少字段：${missing.join(", ")}`);
    error.status = 400;
    throw error;
  }
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function parseTime(value, field) {
  if (typeof value !== "string") throw httpError(400, `${field} 必须是ISO时间字符串`);
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw httpError(400, `${field} 不是合法时间：${value}`);
  return ms;
}

/* ---------------- 领域逻辑 ---------------- */

function findTune(db, tuneId) {
  const tune = db.tunes.find((item) => item.id === tuneId);
  if (!tune) throw httpError(404, "曲目不存在");
  return tune;
}

function buildProgress(db, tuneId) {
  findTune(db, tuneId);
  const sections = db.sections.filter((item) => item.tuneId === tuneId);
  const issues = db.issues.filter((item) => item.tuneId === tuneId);
  const checkedCount = sections.filter((item) => item.checked).length;
  const openIssues = issues.filter((item) => item.status !== "resolved").length;
  return {
    tuneId,
    totalSections: sections.length,
    checkedSections: checkedCount,
    uncheckedSections: sections.length - checkedCount,
    openIssues,
    resolvedIssues: issues.length - openIssues,
    percent: sections.length ? Math.round((checkedCount / sections.length) * 100) : 0
  };
}

// 金额以整数分存储，避免浮点误差
// 金额入参必须是有限数字；布尔、数组、null、数字文本、NaN/Infinity 一律拒绝。
// 换算成分后必须仍在安全整数范围内，否则丢精度，直接按参数错误拒绝。
const MAX_AMOUNT_CENTS = Number.MAX_SAFE_INTEGER;
const MAX_AMOUNT_YUAN = MAX_AMOUNT_CENTS / 100;

function toCents(value, { nonNegative, label }) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw httpError(400, `${label}必须是有限数字（元），不接受布尔、数组、空值或数字文本`);
  }
  if (nonNegative && value < 0) {
    throw httpError(400, `${label}必须是非负数字（元）`);
  }
  const cents = Math.round(value * 100);
  if (!Number.isSafeInteger(cents)) {
    const range = nonNegative
      ? `最大允许 ${MAX_AMOUNT_YUAN} 元`
      : `允许范围 -${MAX_AMOUNT_YUAN} ~ ${MAX_AMOUNT_YUAN} 元`;
    throw httpError(400, `${label}换算成分后超出安全整数范围（9007199254740991 分），${range}`);
  }
  return cents;
}

const yuanToCents = (value) =>
  toCents(value, { nonNegative: true, label: "费率" });
const yuanToCentsSigned = (value) =>
  toCents(value, { nonNegative: false, label: "调整金额" });

function centsToYuan(cents) {
  return Math.round(cents) / 100;
}

function rateView(rate) {
  return { ...rate, amount: centsToYuan(rate.amountCents) };
}

// 半开区间重叠：[start,end) 之间有交集即冲突；首尾相接（end==start）允许
function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

// 本地时区下的午夜 UTC 毫秒
function midnightUtcMs(localDayShift, fromMs) {
  const shifted = new Date(fromMs + TZ_OFFSET_MINUTES * 60000 + localDayShift * 86400000);
  return Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()) - TZ_OFFSET_MINUTES * 60000;
}

// 本地日期所在月份，返回 "YYYY-MM"
function localMonth(ms) {
  const d = new Date(ms + TZ_OFFSET_MINUTES * 60000);
  return d.toISOString().slice(0, 7);
}

function monthRange(month) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw httpError(400, "month 格式必须为 YYYY-MM");
  const [y, m] = month.split("-").map(Number);
  const offset = TZ_OFFSET_MINUTES * 60000;
  // m 为 1-based，Date.UTC 的月份索引 12 自动滚到次年 1 月
  const start = Date.UTC(y, m - 1, 1) - offset;
  const end = Date.UTC(y, m, 1) - offset;
  return { start, end };
}

// 校验工人/机台在 [startMs,endMs) 内不与任何已登记工时重叠（草稿也占用）
function assertNoTimeOverlap(db, startMs, endMs, workerId, machineId, ignoreEntryId) {
  for (const entry of db.timeEntries) {
    if (entry.id === ignoreEntryId) continue;
    if (overlaps(startMs, endMs, entry.startMs, entry.endMs)) {
      if (entry.workerId === workerId) {
        throw httpError(409, `工人工时与已登记记录 ${entry.id} 重叠（${entry.startAt} ~ ${entry.endAt}）`);
      }
      if (entry.machineId === machineId) {
        throw httpError(409, `机台工时与已登记记录 ${entry.id} 重叠（${entry.startAt} ~ ${entry.endAt}）`);
      }
    }
  }
}

// 找目标在 atMs 时刻生效的费率（半开区间 [effectiveFrom, effectiveTo)）
function rateAt(db, targetType, targetId, atMs) {
  return db.rates.find(
    (r) =>
      r.targetType === targetType &&
      r.targetId === targetId &&
      r.effectiveFromMs <= atMs &&
      (r.effectiveToMs === null || atMs < r.effectiveToMs)
  );
}

// 计算 [start,end) 内所有切分点：本地午夜 + 目标费率生效边界
function splitBoundaries(db, targetType, targetId, startMs, endMs) {
  const points = new Set([startMs, endMs]);
  for (let day = 1; ; day++) {
    const mid = midnightUtcMs(day, startMs);
    if (mid >= endMs) break;
    points.add(mid);
  }
  for (const r of db.rates) {
    if (r.targetType !== targetType || r.targetId !== targetId) continue;
    if (r.effectiveFromMs > startMs && r.effectiveFromMs < endMs) points.add(r.effectiveFromMs);
    if (r.effectiveToMs !== null && r.effectiveToMs > startMs && r.effectiveToMs < endMs) points.add(r.effectiveToMs);
  }
  return [...points].sort((a, b) => a - b);
}

// 确认工时：按午夜与费率切换自动拆分生成不可变费用明细；任一段缺费率整体失败（事务内，不留半条）
function buildFeeDetails(db, entry) {
  const specs = [
    { kind: "labor", targetType: "worker", targetId: entry.workerId },
    { kind: "machine", targetType: "machine", targetId: entry.machineId }
  ];
  const details = [];
  for (const spec of specs) {
    const label = spec.targetType === "worker" ? "工人" : "机台";
    const bounds = splitBoundaries(db, spec.targetType, spec.targetId, entry.startMs, entry.endMs);
    for (let i = 0; i < bounds.length - 1; i++) {
      const segStart = bounds[i];
      const segEnd = bounds[i + 1];
      if (segEnd <= segStart) continue;
      const rate = rateAt(db, spec.targetType, spec.targetId, segStart);
      if (!rate) {
        throw httpError(
          422,
          `${label}在 ${new Date(segStart).toISOString()} 没有生效费率，请先补登记费率再确认`
        );
      }
      const minutes = (segEnd - segStart) / 60000;
      const amountCents = Math.round((rate.amountCents * minutes) / 60);
      if (!Number.isSafeInteger(amountCents)) {
        // 费率×时长溢出安全整数：拒绝整条确认（事务回滚，不写任何半条明细），避免丢精度
        throw httpError(
          422,
          `${label}在 ${new Date(segStart).toISOString()} ~ ${new Date(segEnd).toISOString()} 的费用（${rate.amountCents} 分 × ${minutes} 分钟）超出安全整数范围，请调整费率后再确认`
        );
      }
      details.push({
        id: makeId("fee"),
        entryId: entry.id,
        tuneId: entry.tuneId,
        sectionId: entry.sectionId,
        workerId: entry.workerId,
        machineId: entry.machineId,
        kind: spec.kind,
        startMs: segStart,
        endMs: segEnd,
        startAt: new Date(segStart).toISOString(),
        endAt: new Date(segEnd).toISOString(),
        month: localMonth(segStart),
        rateId: rate.id,
        rateAmountCents: rate.amountCents,
        durationMinutes: minutes,
        amountCents,
        createdAt: nowIso()
      });
    }
  }
  return details;
}

function feeView(d) {
  return { ...d, rateAmount: centsToYuan(d.rateAmountCents), amount: centsToYuan(d.amountCents) };
}

function entrySummary(db, entry) {
  if (entry.status !== "confirmed") {
    return { detailCount: 0, totalDurationMinutes: 0, totalAmountCents: 0, totalAmount: 0 };
  }
  const details = db.feeDetails.filter((d) => d.entryId === entry.id);
  const totalAmountCents = details.reduce((sum, d) => sum + d.amountCents, 0);
  // 人工 + 机台两条线各自计时，总时长只按一条统计，避免翻倍
  const labor = details.filter((d) => d.kind === "labor");
  const totalDurationMinutes = labor.reduce((sum, d) => sum + d.durationMinutes, 0);
  return {
    detailCount: details.length,
    totalDurationMinutes,
    totalAmountCents,
    totalAmount: centsToYuan(totalAmountCents)
  };
}

function entryView(db, entry) {
  return { ...entry, ...entrySummary(db, entry) };
}

function entryFilters(db, params) {
  let rows = db.timeEntries;
  if (params.tuneId) rows = rows.filter((e) => e.tuneId === params.tuneId);
  if (params.sectionId) rows = rows.filter((e) => e.sectionId === params.sectionId);
  if (params.workerId) rows = rows.filter((e) => e.workerId === params.workerId);
  if (params.machineId) rows = rows.filter((e) => e.machineId === params.machineId);
  if (params.status) rows = rows.filter((e) => e.status === params.status);
  if (params.month) {
    const { start, end } = monthRange(params.month);
    rows = rows.filter((e) => e.startMs >= start && e.startMs < end);
  }
  return rows;
}

/* ---------------- 路由处理 ---------------- */

async function handle(req, res) {
  const { pathname, searchParams } = parseUrl(req);
  const params = Object.fromEntries(searchParams.entries());

  if (req.method === "GET" && pathname === "/health") {
    return send(res, 200, { ok: true, service: "organ-strip-punch-api", routes });
  }

  /* ---------- 既有接口（行为保持不变，写入走串行事务+原子写） ---------- */

  if (req.method === "GET" && pathname === "/tunes") {
    const db = await readDb();
    const tunes = db.tunes.map((tune) => ({ ...tune, progress: buildProgress(db, tune.id) }));
    return send(res, 200, { data: tunes });
  }

  if (req.method === "POST" && pathname === "/tunes") {
    const body = await parseBody(req);
    required(body, ["title", "stripSpec"]);
    const tune = await transaction((db) => {
      const item = {
        id: makeId("tune"),
        title: body.title,
        composer: body.composer || "",
        stripSpec: body.stripSpec,
        createdAt: nowIso()
      };
      db.tunes.push(item);
      return item;
    });
    return send(res, 201, { data: tune });
  }

  const tuneSectionsMatch = pathname.match(/^\/tunes\/([^/]+)\/sections$/);
  if (tuneSectionsMatch && req.method === "GET") {
    const db = await readDb();
    findTune(db, tuneSectionsMatch[1]);
    return send(res, 200, { data: db.sections.filter((item) => item.tuneId === tuneSectionsMatch[1]) });
  }

  if (tuneSectionsMatch && req.method === "POST") {
    const tuneId = tuneSectionsMatch[1];
    const body = await parseBody(req);
    required(body, ["startBeat", "endBeat", "laneRange"]);
    const section = await transaction((db) => {
      findTune(db, tuneId);
      const item = {
        id: makeId("section"),
        tuneId,
        startBeat: Number(body.startBeat),
        endBeat: Number(body.endBeat),
        laneRange: body.laneRange,
        checked: Boolean(body.checked),
        note: body.note || ""
      };
      db.sections.push(item);
      return item;
    });
    return send(res, 201, { data: section });
  }

  const uncheckedMatch = pathname.match(/^\/tunes\/([^/]+)\/unchecked-sections$/);
  if (uncheckedMatch && req.method === "GET") {
    const db = await readDb();
    findTune(db, uncheckedMatch[1]);
    return send(res, 200, {
      data: db.sections.filter((item) => item.tuneId === uncheckedMatch[1] && !item.checked)
    });
  }

  const progressMatch = pathname.match(/^\/tunes\/([^/]+)\/progress$/);
  if (progressMatch && req.method === "GET") {
    const db = await readDb();
    return send(res, 200, { data: buildProgress(db, progressMatch[1]) });
  }

  const checkMatch = pathname.match(/^\/sections\/([^/]+)\/check$/);
  if (checkMatch && req.method === "PATCH") {
    const body = await parseBody(req);
    const section = await transaction((db) => {
      const item = db.sections.find((s) => s.id === checkMatch[1]);
      if (!item) throw httpError(404, "区间不存在");
      item.checked = body.checked !== undefined ? Boolean(body.checked) : true;
      item.note = body.note ?? item.note;
      return item;
    });
    return send(res, 200, { data: section });
  }

  if (req.method === "GET" && pathname === "/issues") {
    const db = await readDb();
    const tuneId = searchParams.get("tuneId");
    const status = searchParams.get("status");
    const issues = db.issues.filter(
      (item) => (!tuneId || item.tuneId === tuneId) && (!status || item.status === status)
    );
    return send(res, 200, { data: issues });
  }

  if (req.method === "POST" && pathname === "/issues") {
    const body = await parseBody(req);
    required(body, ["tuneId", "sectionId", "type", "description"]);
    const issue = await transaction((db) => {
      findTune(db, body.tuneId);
      const section = db.sections.find((item) => item.id === body.sectionId && item.tuneId === body.tuneId);
      if (!section) throw httpError(400, "区间不存在或不属于该曲目");
      const item = {
        id: makeId("issue"),
        tuneId: body.tuneId,
        sectionId: body.sectionId,
        type: body.type,
        beat: body.beat === undefined ? null : Number(body.beat),
        lane: body.lane === undefined ? null : Number(body.lane),
        description: body.description,
        status: "open",
        createdAt: nowIso(),
        resolvedAt: null
      };
      db.issues.push(item);
      return item;
    });
    return send(res, 201, { data: issue });
  }

  const issueStatusMatch = pathname.match(/^\/issues\/([^/]+)\/status$/);
  if (issueStatusMatch && req.method === "PATCH") {
    const body = await parseBody(req);
    required(body, ["status"]);
    const issue = await transaction((db) => {
      const item = db.issues.find((i) => i.id === issueStatusMatch[1]);
      if (!item) throw httpError(404, "问题不存在");
      item.status = body.status;
      item.resolvedAt = body.status === "resolved" ? nowIso() : null;
      item.note = body.note ?? item.note;
      return item;
    });
    return send(res, 200, { data: issue });
  }

  /* ---------- 工人 / 机台 ---------- */

  if (req.method === "GET" && pathname === "/workers") {
    const db = await readDb();
    return send(res, 200, { data: db.workers });
  }

  if (req.method === "POST" && pathname === "/workers") {
    const body = await parseBody(req);
    required(body, ["name"]);
    const worker = await transaction((db) => {
      if (body.code && db.workers.some((w) => w.code === body.code)) {
        throw httpError(409, `工号已存在：${body.code}`);
      }
      const item = {
        id: makeId("worker"),
        name: body.name,
        code: body.code || null,
        active: body.active !== undefined ? Boolean(body.active) : true,
        createdAt: nowIso()
      };
      db.workers.push(item);
      return item;
    });
    return send(res, 201, { data: worker });
  }

  if (req.method === "GET" && pathname === "/machines") {
    const db = await readDb();
    return send(res, 200, { data: db.machines });
  }

  if (req.method === "POST" && pathname === "/machines") {
    const body = await parseBody(req);
    required(body, ["name"]);
    const machine = await transaction((db) => {
      if (body.code && db.machines.some((m) => m.code === body.code)) {
        throw httpError(409, `机台编号已存在：${body.code}`);
      }
      const item = {
        id: makeId("machine"),
        name: body.name,
        code: body.code || null,
        active: body.active !== undefined ? Boolean(body.active) : true,
        createdAt: nowIso()
      };
      db.machines.push(item);
      return item;
    });
    return send(res, 201, { data: machine });
  }

  /* ---------- 费率（生效区间） ---------- */

  if (req.method === "GET" && pathname === "/rates") {
    const db = await readDb();
    let rows = db.rates;
    if (params.targetType) rows = rows.filter((r) => r.targetType === params.targetType);
    if (params.targetId) rows = rows.filter((r) => r.targetId === params.targetId);
    rows = [...rows].sort((a, b) => a.effectiveFromMs - b.effectiveFromMs);
    return send(res, 200, { data: rows.map(rateView) });
  }

  if (req.method === "POST" && pathname === "/rates") {
    const body = await parseBody(req);
    required(body, ["targetType", "targetId", "amount", "effectiveFrom"]);
    if (!["worker", "machine"].includes(body.targetType)) {
      throw httpError(400, "targetType 必须是 worker 或 machine");
    }
    const amountCents = yuanToCents(body.amount);
    const fromMs = parseTime(body.effectiveFrom, "effectiveFrom");
    const toMs = body.effectiveTo === undefined || body.effectiveTo === null ? null : parseTime(body.effectiveTo, "effectiveTo");
    if (toMs !== null && toMs <= fromMs) throw httpError(400, "effectiveTo 必须晚于 effectiveFrom");

    const created = await transaction((db) => {
      const pool = body.targetType === "worker" ? db.workers : db.machines;
      if (!pool.some((t) => t.id === body.targetId)) throw httpError(404, "费率目标不存在");

      const targetRates = db.rates.filter(
        (r) => r.targetType === body.targetType && r.targetId === body.targetId
      );

      // 新增开放费率（effectiveTo 为空）时，自动把旧的开放费率在新生效时刻闭合
      if (toMs === null) {
        const open = targetRates.filter((r) => r.effectiveToMs === null);
        for (const r of open) {
          if (r.effectiveFromMs >= fromMs) {
            throw httpError(
              409,
              `已存在不早于新生效时间的开放费率 ${r.id}，新费率会与之冲突，请显式指定区间`
            );
          }
          r.effectiveToMs = fromMs;
          r.effectiveTo = new Date(fromMs).toISOString();
        }
      }

      // 生效区间不允许重叠
      for (const r of targetRates) {
        const rEnd = r.effectiveToMs === null ? Infinity : r.effectiveToMs;
        const newEnd = toMs === null ? Infinity : toMs;
        if (overlaps(fromMs, newEnd, r.effectiveFromMs, rEnd)) {
          throw httpError(409, `费率生效区间与 ${r.id} 重叠（${r.effectiveFrom} ~ ${r.effectiveTo || "至今"}）`);
        }
      }

      const item = {
        id: makeId("rate"),
        targetType: body.targetType,
        targetId: body.targetId,
        amountCents,
        effectiveFromMs: fromMs,
        effectiveToMs: toMs,
        effectiveFrom: new Date(fromMs).toISOString(),
        effectiveTo: toMs === null ? null : new Date(toMs).toISOString(),
        createdAt: nowIso()
      };
      db.rates.push(item);
      return item;
    });
    return send(res, 201, { data: rateView(created) });
  }

  /* ---------- 工时登记 ---------- */

  if (req.method === "GET" && pathname === "/time-entries") {
    const db = await readDb();
    const rows = entryFilters(db, params).sort((a, b) => a.startMs - b.startMs);
    return send(res, 200, { data: rows.map((e) => entryView(db, e)) });
  }

  if (req.method === "POST" && pathname === "/time-entries") {
    const body = await parseBody(req);
    required(body, ["tuneId", "sectionId", "workerId", "machineId", "startAt", "endAt"]);
    const startMs = parseTime(body.startAt, "startAt");
    const endMs = parseTime(body.endAt, "endAt");
    if (endMs <= startMs) throw httpError(400, "endAt 必须晚于 startAt");

    const entry = await transaction((db) => {
      findTune(db, body.tuneId);
      const section = db.sections.find((s) => s.id === body.sectionId && s.tuneId === body.tuneId);
      if (!section) throw httpError(400, "区间不存在或不属于该曲目");
      if (!db.workers.some((w) => w.id === body.workerId)) throw httpError(404, "工人不存在");
      if (!db.machines.some((m) => m.id === body.machineId)) throw httpError(404, "机台不存在");

      // 幂等重试先于重叠判定：同一幂等键的并发重试直接返回原记录，不算冲突
      const idempotencyKey = body.idempotencyKey || null;
      if (idempotencyKey) {
        const dup = db.timeEntries.find((e) => e.idempotencyKey === idempotencyKey);
        if (dup) return dup;
      }

      assertNoTimeOverlap(db, startMs, endMs, body.workerId, body.machineId, null);

      const item = {
        id: makeId("entry"),
        tuneId: body.tuneId,
        sectionId: body.sectionId,
        workerId: body.workerId,
        machineId: body.machineId,
        startMs,
        endMs,
        startAt: new Date(startMs).toISOString(),
        endAt: new Date(endMs).toISOString(),
        note: body.note || "",
        status: "draft",
        idempotencyKey,
        createdAt: nowIso(),
        confirmedAt: null
      };
      db.timeEntries.push(item);
      return item;
    });
    const db = await readDb();
    return send(res, 201, { data: entryView(db, entry) });
  }

  const entryMatch = pathname.match(/^\/time-entries\/([^/]+)$/);
  if (entryMatch && req.method === "GET") {
    const db = await readDb();
    const entry = db.timeEntries.find((e) => e.id === entryMatch[1]);
    if (!entry) return send(res, 404, { error: "工时记录不存在" });
    return send(res, 200, {
      data: entryView(db, entry),
      feeDetails: db.feeDetails.filter((d) => d.entryId === entry.id).map(feeView)
    });
  }

  if (entryMatch && req.method === "PATCH") {
    const body = await parseBody(req);
    const entry = await transaction((db) => {
      const item = db.timeEntries.find((e) => e.id === entryMatch[1]);
      if (!item) throw httpError(404, "工时记录不存在");
      if (item.status === "confirmed") {
        throw httpError(409, "工时已确认，历史明细不可修改；请通过 POST /adjustments 另开调整");
      }
      const startMs = body.startAt !== undefined ? parseTime(body.startAt, "startAt") : item.startMs;
      const endMs = body.endAt !== undefined ? parseTime(body.endAt, "endAt") : item.endMs;
      if (endMs <= startMs) throw httpError(400, "endAt 必须晚于 startAt");
      assertNoTimeOverlap(db, startMs, endMs, item.workerId, item.machineId, item.id);
      item.startMs = startMs;
      item.endMs = endMs;
      item.startAt = new Date(startMs).toISOString();
      item.endAt = new Date(endMs).toISOString();
      item.note = body.note ?? item.note;
      return item;
    });
    const db = await readDb();
    return send(res, 200, { data: entryView(db, entry) });
  }

  if (entryMatch && req.method === "DELETE") {
    await transaction((db) => {
      const idx = db.timeEntries.findIndex((e) => e.id === entryMatch[1]);
      if (idx === -1) throw httpError(404, "工时记录不存在");
      if (db.timeEntries[idx].status === "confirmed") {
        throw httpError(409, "工时已确认，不能删除；请通过调整单纠错");
      }
      db.timeEntries.splice(idx, 1);
    });
    return send(res, 200, { data: { deleted: entryMatch[1] } });
  }

  const confirmMatch = pathname.match(/^\/time-entries\/([^/]+)\/confirm$/);
  if (confirmMatch && req.method === "POST") {
    const result = await transaction((db) => {
      const entry = db.timeEntries.find((e) => e.id === confirmMatch[1]);
      if (!entry) throw httpError(404, "工时记录不存在");
      if (entry.status === "confirmed") {
        // 重试安全：重复确认不重复生成明细
        return {
          entry,
          details: db.feeDetails.filter((d) => d.entryId === entry.id),
          alreadyConfirmed: true
        };
      }
      // 落盘前再校验一次占用（草稿可能已被并发改动过的可能性在串行锁下不存在，此处保持防御）
      assertNoTimeOverlap(db, entry.startMs, entry.endMs, entry.workerId, entry.machineId, entry.id);
      // 拆分与费率校验全部在内存中完成：任一段缺费率则抛错，整条不落盘，无半条记录
      const details = buildFeeDetails(db, entry);
      entry.status = "confirmed";
      entry.confirmedAt = nowIso();
      db.feeDetails.push(...details);
      return { entry, details, alreadyConfirmed: false };
    });
    const db = await readDb();
    return send(res, result.alreadyConfirmed ? 200 : 201, {
      data: entryView(db, result.entry),
      feeDetails: result.details.map(feeView)
    });
  }

  /* ---------- 费用明细（不可变，只读） ---------- */

  if (req.method === "GET" && pathname === "/fee-details") {
    const db = await readDb();
    let rows = db.feeDetails;
    if (params.tuneId) rows = rows.filter((d) => d.tuneId === params.tuneId);
    if (params.sectionId) rows = rows.filter((d) => d.sectionId === params.sectionId);
    if (params.workerId) rows = rows.filter((d) => d.workerId === params.workerId);
    if (params.machineId) rows = rows.filter((d) => d.machineId === params.machineId);
    if (params.kind) rows = rows.filter((d) => d.kind === params.kind);
    if (params.entryId) rows = rows.filter((d) => d.entryId === params.entryId);
    if (params.month) {
      const { start, end } = monthRange(params.month);
      rows = rows.filter((d) => d.startMs >= start && d.startMs < end);
    }
    rows = [...rows].sort((a, b) => a.startMs - b.startMs);
    const totalCents = rows.reduce((sum, d) => sum + d.amountCents, 0);
    const totalDurationMinutes = rows
      .filter((d) => d.kind === "labor")
      .reduce((sum, d) => sum + d.durationMinutes, 0);
    return send(res, 200, {
      data: rows.map(feeView),
      summary: {
        count: rows.length,
        totalDurationMinutes,
        totalAmountCents: totalCents,
        totalAmount: centsToYuan(totalCents)
      }
    });
  }

  /* ---------- 调整单（补录/纠错，历史明细不可变） ---------- */

  if (req.method === "GET" && pathname === "/adjustments") {
    const db = await readDb();
    let rows = db.adjustments;
    for (const key of ["tuneId", "sectionId", "workerId", "machineId", "entryId", "month", "reasonType"]) {
      if (params[key]) rows = rows.filter((a) => a[key] === params[key]);
    }
    rows = [...rows].sort((a, b) => a.createdMs - b.createdMs);
    const totalCents = rows.reduce((sum, a) => sum + a.amountCents, 0);
    return send(res, 200, {
      data: rows.map((a) => ({ ...a, amount: centsToYuan(a.amountCents) })),
      summary: { count: rows.length, totalAmountCents: totalCents, totalAmount: centsToYuan(totalCents) }
    });
  }

  if (req.method === "POST" && pathname === "/adjustments") {
    const body = await parseBody(req);
    required(body, ["reasonType", "amount", "occurredAt"]);
    if (!["correction", "backfill"].includes(body.reasonType)) {
      throw httpError(400, "reasonType 必须是 correction 或 backfill");
    }
    const amountCents = yuanToCentsSigned(body.amount);
    const occurredMs = parseTime(body.occurredAt, "occurredAt");

    const adjustment = await transaction((db) => {
      let entry = null;
      if (body.entryId) {
        entry = db.timeEntries.find((e) => e.id === body.entryId);
        if (!entry) throw httpError(404, "关联工时不存在");
        if (entry.status !== "confirmed") throw httpError(409, "只能对已确认工时开调整单");

        // 归属必须与关联工时完全一致：传入不同值即参数错误（整体失败，不写调整单）
        const mismatch = [];
        for (const field of ["tuneId", "sectionId", "workerId", "machineId"]) {
          if (body[field] !== undefined && body[field] !== null && body[field] !== entry[field]) {
            mismatch.push(field);
          }
        }
        if (mismatch.length) {
          throw httpError(
            400,
            `调整单归属与关联工时 ${entry.id} 不一致的字段：${mismatch.join("、")}；` +
              "请省略这些字段（自动沿用关联工时）或传入完全一致的值"
          );
        }
      }

      // 无关联工时或未显式传值时才需要独立校验存在性；关联工时上的取值必然有效
      if (!entry && body.tuneId) findTune(db, body.tuneId);
      if (!entry && body.workerId && !db.workers.some((w) => w.id === body.workerId)) {
        throw httpError(404, "工人不存在");
      }
      if (!entry && body.machineId && !db.machines.some((m) => m.id === body.machineId)) {
        throw httpError(404, "机台不存在");
      }

      const item = {
        id: makeId("adj"),
        reasonType: body.reasonType,
        entryId: body.entryId || null,
        tuneId: body.tuneId || (entry && entry.tuneId) || null,
        sectionId: body.sectionId || (entry && entry.sectionId) || null,
        workerId: body.workerId || (entry && entry.workerId) || null,
        machineId: body.machineId || (entry && entry.machineId) || null,
        amountCents,
        occurredMs,
        occurredAt: new Date(occurredMs).toISOString(),
        month: localMonth(occurredMs),
        reason: body.reason || "",
        createdMs: Date.now(),
        createdAt: nowIso()
      };
      db.adjustments.push(item);
      return item;
    });
    return send(res, 201, { data: { ...adjustment, amount: centsToYuan(adjustment.amountCents) } });
  }

  /* ---------- 成本汇总：按曲目/区间/工人/月份查询工时与金额 ---------- */

  if (req.method === "GET" && pathname === "/cost-report") {
    const db = await readDb();
    const month = params.month;
    let range = null;
    if (month) range = monthRange(month);

    const detailMatch = (d) =>
      (!params.tuneId || d.tuneId === params.tuneId) &&
      (!params.sectionId || d.sectionId === params.sectionId) &&
      (!params.workerId || d.workerId === params.workerId) &&
      (!params.machineId || d.machineId === params.machineId) &&
      (!range || (d.startMs >= range.start && d.startMs < range.end));

    const details = db.feeDetails.filter(detailMatch);
    const adjustments = db.adjustments.filter(
      (a) =>
        (!params.tuneId || a.tuneId === params.tuneId) &&
        (!params.sectionId || a.sectionId === params.sectionId) &&
        (!params.workerId || a.workerId === params.workerId) &&
        (!params.machineId || a.machineId === params.machineId) &&
        (!range || (a.occurredMs >= range.start && a.occurredMs < range.end))
    );

    const feesCents = details.reduce((s, d) => s + d.amountCents, 0);
    const adjCents = adjustments.reduce((s, a) => s + a.amountCents, 0);
    const laborMinutes = details.filter((d) => d.kind === "labor").reduce((s, d) => s + d.durationMinutes, 0);

    // 工时维度：只统计与明细相关的已确认工时
    const entryIds = new Set(details.map((d) => d.entryId));
    const entries = db.timeEntries
      .filter((e) => entryIds.has(e.id))
      .map((e) => entryView(db, e));

    return send(res, 200, {
      data: {
        month: month || null,
        filters: {
          tuneId: params.tuneId || null,
          sectionId: params.sectionId || null,
          workerId: params.workerId || null,
          machineId: params.machineId || null
        },
        entryCount: entries.length,
        totalDurationMinutes: laborMinutes,
        feeCount: details.length,
        feesAmountCents: feesCents,
        feesAmount: centsToYuan(feesCents),
        adjustmentCount: adjustments.length,
        adjustmentsAmountCents: adjCents,
        adjustmentsAmount: centsToYuan(adjCents),
        totalAmountCents: feesCents + adjCents,
        totalAmount: centsToYuan(feesCents + adjCents),
        entries
      }
    });
  }

  return send(res, 404, { error: "接口不存在", routes });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((error) =>
    send(res, error.status || 500, { error: error.message || "服务器错误" })
  );
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Organ strip punch API running at http://127.0.0.1:${PORT}`);
});
