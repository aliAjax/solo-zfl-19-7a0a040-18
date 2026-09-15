"use strict";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const net = require("node:net");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const SERVER = path.join(__dirname, "..", "server.js");
const HOST = "127.0.0.1";

let port;
let dbFile;
let child;

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, HOST, () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
    srv.on("error", reject);
  });
}

async function startServer() {
  child = spawn(process.execPath, [SERVER], {
    cwd: path.join(__dirname, ".."),
    env: { ...process.env, PORT: String(port), DB_FILE: dbFile, TZ_OFFSET_MINUTES: "0" },
    stdio: ["ignore", "ignore", "pipe"]
  });
  child.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));
  for (;;) {
    try {
      await api("GET", "/health");
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 30));
    }
  }
}

async function stopServer() {
  if (!child) return;
  child.kill("SIGTERM");
  await once(child, "exit");
  child = null;
}

async function restartServer() {
  await stopServer();
  await startServer();
}

function api(method, urlPath, body) {
  const payload = body === undefined ? null : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: HOST,
        port,
        path: urlPath,
        method,
        headers: payload
          ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }
          : {}
      },
      (res) => {
        let raw = "";
        res.on("data", (d) => (raw += d));
        res.on("end", () => {
          let json = null;
          try {
            json = raw ? JSON.parse(raw) : null;
          } catch {
            reject(new Error(`非JSON响应 ${res.statusCode}: ${raw}`));
            return;
          }
          resolve({ status: res.statusCode, body: json });
        });
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// 公共资源 id，在测试1/2中建立，后续用例复用
const ids = {};

before(async () => {
  port = await getFreePort();
  dbFile = path.join(os.tmpdir(), `labor-test-${process.pid}-${Date.now()}.json`);
  await startServer();
});

after(async () => {
  await stopServer();
  try {
    fs.unlinkSync(dbFile);
  } catch {
    /* 临时文件，忽略 */
  }
});

test("0. 保留现有接口与种子数据", async () => {
  const health = await api("GET", "/health");
  assert.equal(health.status, 200);
  assert.ok(health.body.routes.includes("PATCH /sections/:id/check"));
  assert.ok(health.body.routes.includes("POST /time-entries/:id/confirm"));

  const tunes = await api("GET", "/tunes");
  assert.equal(tunes.status, 200);
  assert.ok(tunes.body.data.some((t) => t.id === "tune_demo"));
  const demo = tunes.body.data.find((t) => t.id === "tune_demo");
  assert.equal(demo.progress.totalSections, 2);
  assert.equal(demo.progress.openIssues, 1);

  const sections = await api("GET", "/tunes/tune_demo/sections");
  assert.equal(sections.body.data.length, 2);
  const unchecked = await api("GET", "/tunes/tune_demo/unchecked-sections");
  assert.equal(unchecked.body.data[0].id, "section_demo_2");
  const issues = await api("GET", "/issues?tuneId=tune_demo");
  assert.equal(issues.body.data.length, 1);

  // 旧接口依然可写
  const created = await api("POST", "/issues", {
    tuneId: "tune_demo",
    sectionId: "section_demo_2",
    type: "错孔",
    beat: 45,
    lane: 9,
    description: "第45拍第9轨多打孔"
  });
  assert.equal(created.status, 201);
  const patched = await api("PATCH", `/issues/${created.body.data.id}/status`, { status: "resolved" });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.data.status, "resolved");
  assert.ok(patched.body.data.resolvedAt);

  // 新增曲目/区间接口仍正常（后续用例挂在 demo 曲目上）
  const check = await api("PATCH", "/sections/section_demo_2/check", { checked: true });
  assert.equal(check.status, 200);
  assert.equal(check.body.data.checked, true);
});

test("1. 工人/机台登记与重叠占用校验", async () => {
  const w1 = await api("POST", "/workers", { name: "王工", code: "W1" });
  const w2 = await api("POST", "/workers", { name: "李工", code: "W2" });
  const m1 = await api("POST", "/machines", { name: "打孔机A", code: "M1" });
  const m2 = await api("POST", "/machines", { name: "打孔机B", code: "M2" });
  assert.equal(w1.status, 201);
  assert.equal(w2.status, 201);
  assert.equal(m1.status, 201);
  assert.equal(m2.status, 201);
  ids.w1 = w1.body.data.id;
  ids.w2 = w2.body.data.id;
  ids.m1 = m1.body.data.id;
  ids.m2 = m2.body.data.id;

  const dupCode = await api("POST", "/workers", { name: "重号", code: "W1" });
  assert.equal(dupCode.status, 409);

  // 基准工时：2026-09-10 10:00-12:00 UTC（草稿）
  const base = await api("POST", "/time-entries", {
    tuneId: "tune_demo",
    sectionId: "section_demo_1",
    workerId: ids.w1,
    machineId: ids.m1,
    startAt: "2026-09-10T10:00:00Z",
    endAt: "2026-09-10T12:00:00Z",
    note: "基准"
  });
  assert.equal(base.status, 201, JSON.stringify(base.body));
  assert.equal(base.body.data.status, "draft");

  // 同一工人重叠（换机台）
  const workerClash = await api("POST", "/time-entries", {
    tuneId: "tune_demo",
    sectionId: "section_demo_1",
    workerId: ids.w1,
    machineId: ids.m2,
    startAt: "2026-09-10T11:00:00Z",
    endAt: "2026-09-10T13:00:00Z"
  });
  assert.equal(workerClash.status, 409);
  assert.match(workerClash.body.error, /工人/);

  // 同机台重叠（换工人）
  const machineClash = await api("POST", "/time-entries", {
    tuneId: "tune_demo",
    sectionId: "section_demo_1",
    workerId: ids.w2,
    machineId: ids.m1,
    startAt: "2026-09-10T11:30:00Z",
    endAt: "2026-09-10T12:30:00Z"
  });
  assert.equal(machineClash.status, 409);
  assert.match(machineClash.body.error, /机台/);

  // 首尾相接允许：12:00 起
  const touching = await api("POST", "/time-entries", {
    tuneId: "tune_demo",
    sectionId: "section_demo_1",
    workerId: ids.w1,
    machineId: ids.m1,
    startAt: "2026-09-10T12:00:00Z",
    endAt: "2026-09-10T13:00:00Z"
  });
  assert.equal(touching.status, 201);

  // 不同工人不同机台同刻允许
  const parallel = await api("POST", "/time-entries", {
    tuneId: "tune_demo",
    sectionId: "section_demo_1",
    workerId: ids.w2,
    machineId: ids.m2,
    startAt: "2026-09-10T10:00:00Z",
    endAt: "2026-09-10T12:00:00Z"
  });
  assert.equal(parallel.status, 201);

  // 失败不留记录：冲突两次后，该曲目只有 3 条（基准/相接/并行）
  const list = await api("GET", "/time-entries?tuneId=tune_demo");
  assert.equal(list.body.data.length, 3);

  // endAt <= startAt
  const bad = await api("POST", "/time-entries", {
    tuneId: "tune_demo",
    sectionId: "section_demo_1",
    workerId: ids.w1,
    machineId: ids.m1,
    startAt: "2026-09-11T10:00:00Z",
    endAt: "2026-09-11T09:00:00Z"
  });
  assert.equal(bad.status, 400);
});

test("2. 费率区间管理：自动闭合与重叠拒绝", async () => {
  // W1：9/1 起 50 元/小时（开放）
  const first = await api("POST", "/rates", {
    targetType: "worker",
    targetId: ids.w1,
    amount: 50,
    effectiveFrom: "2026-09-01T00:00:00Z"
  });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assert.equal(first.body.data.effectiveTo, null);
  ids.w1RateOld = first.body.data.id;

  // 新开放费率（9/15 起 70）自动把旧费率闭合
  const second = await api("POST", "/rates", {
    targetType: "worker",
    targetId: ids.w1,
    amount: 70,
    effectiveFrom: "2026-09-15T00:00:00Z"
  });
  assert.equal(second.status, 201);
  const rates = (await api("GET", `/rates?targetType=worker&targetId=${ids.w1}`)).body.data;
  const old = rates.find((r) => r.id === ids.w1RateOld);
  assert.equal(old.effectiveTo, "2026-09-15T00:00:00.000Z");
  assert.equal(old.amount, 50);

  // 显式区间与已有区间重叠 -> 409
  const overlap = await api("POST", "/rates", {
    targetType: "worker",
    targetId: ids.w1,
    amount: 999,
    effectiveFrom: "2026-09-10T00:00:00Z",
    effectiveTo: "2026-09-20T00:00:00Z"
  });
  assert.equal(overlap.status, 409);

  // M1 机台费率：30 元/小时，9 月
  const mr = await api("POST", "/rates", {
    targetType: "machine",
    targetId: ids.m1,
    amount: 30,
    effectiveFrom: "2026-09-01T00:00:00Z",
    effectiveTo: "2026-10-01T00:00:00Z"
  });
  assert.equal(mr.status, 201);

  // M2 机台费率：40 元/小时，9 月起开放
  const mr2 = await api("POST", "/rates", {
    targetType: "machine",
    targetId: ids.m2,
    amount: 40,
    effectiveFrom: "2026-09-01T00:00:00Z"
  });
  assert.equal(mr2.status, 201);

  // 非法目标 404、负费率 400
  const noTarget = await api("POST", "/rates", {
    targetType: "worker",
    targetId: "nope",
    amount: 10,
    effectiveFrom: "2026-09-01T00:00:00Z"
  });
  assert.equal(noTarget.status, 404);
  const neg = await api("POST", "/rates", {
    targetType: "machine",
    targetId: ids.m1,
    amount: -1,
    effectiveFrom: "2026-11-01T00:00:00Z"
  });
  assert.equal(neg.status, 400);
});

test("3. 跨午夜 + 跨费率切换：自动拆分、金额正确", async () => {
  // 9/14 22:00 -> 9/15 02:00 UTC：午夜即费率切换点（W1: 50→70）
  const entry = await api("POST", "/time-entries", {
    tuneId: "tune_demo",
    sectionId: "section_demo_1",
    workerId: ids.w1,
    machineId: ids.m1,
    startAt: "2026-09-14T22:00:00Z",
    endAt: "2026-09-15T02:00:00Z"
  });
  assert.equal(entry.status, 201, JSON.stringify(entry.body));
  ids.entryCrossMidnight = entry.body.data.id;

  const confirmed = await api("POST", `/time-entries/${ids.entryCrossMidnight}/confirm`, {});
  assert.equal(confirmed.status, 201, JSON.stringify(confirmed.body));
  assert.equal(confirmed.body.data.status, "confirmed");
  assert.ok(confirmed.body.data.confirmedAt);
  const fees = confirmed.body.feeDetails;
  assert.equal(fees.length, 4);

  const labor = fees.filter((f) => f.kind === "labor").sort((a, b) => a.startMs - b.startMs);
  assert.equal(labor.length, 2);
  assert.equal(labor[0].startAt, "2026-09-14T22:00:00.000Z");
  assert.equal(labor[0].endAt, "2026-09-15T00:00:00.000Z");
  assert.equal(labor[0].durationMinutes, 120);
  assert.equal(labor[0].rateAmount, 50);
  assert.equal(labor[0].amount, 100);
  assert.equal(labor[0].month, "2026-09");
  assert.equal(labor[1].startAt, "2026-09-15T00:00:00.000Z");
  assert.equal(labor[1].durationMinutes, 120);
  assert.equal(labor[1].rateAmount, 70);
  assert.equal(labor[1].amount, 140);

  const machine = fees.filter((f) => f.kind === "machine").sort((a, b) => a.startMs - b.startMs);
  assert.equal(machine.length, 2);
  assert.equal(machine[0].amount, 60);
  assert.equal(machine[1].amount, 60);
  // 机台费率 9 月底到期，10 月段本例会失败——本用例全在 9 月，验证通过即可

  // 明细总金额：人工 240 + 机台 120
  const detail = await api("GET", `/time-entries/${ids.entryCrossMidnight}`);
  assert.equal(detail.body.data.totalAmount, 360);
  assert.equal(detail.body.data.totalAmountCents, 36000);
  assert.equal(detail.body.data.totalDurationMinutes, 240);
  assert.equal(detail.body.data.detailCount, 4);
  assert.equal(detail.body.feeDetails.length, 4);
});

test("4. 非午夜的费率切换点：按生效边界拆分", async () => {
  // 使用全新工人/机台，费率在 9/16 12:00（非午夜）切换
  const w = (await api("POST", "/workers", { name: "切换工", code: "WSW" })).body.data;
  const m = (await api("POST", "/machines", { name: "切换机", code: "MSW" })).body.data;
  await api("POST", "/rates", { targetType: "worker", targetId: w.id, amount: 50, effectiveFrom: "2026-09-01T00:00:00Z" });
  await api("POST", "/rates", { targetType: "worker", targetId: w.id, amount: 80, effectiveFrom: "2026-09-16T12:00:00Z" });
  await api("POST", "/rates", { targetType: "machine", targetId: m.id, amount: 10, effectiveFrom: "2026-09-01T00:00:00Z" });

  // 9/16 10:00-14:00：10-12 旧费率 2h，12-14 新费率 2h，不跨午夜
  const entry = await api("POST", "/time-entries", {
    tuneId: "tune_demo",
    sectionId: "section_demo_2",
    workerId: w.id,
    machineId: m.id,
    startAt: "2026-09-16T10:00:00Z",
    endAt: "2026-09-16T14:00:00Z"
  });
  assert.equal(entry.status, 201, JSON.stringify(entry.body));

  const confirmed = await api("POST", `/time-entries/${entry.body.data.id}/confirm`, {});
  assert.equal(confirmed.status, 201, JSON.stringify(confirmed.body));
  const labor = confirmed.body.feeDetails.filter((f) => f.kind === "labor").sort((a, b) => a.startMs - b.startMs);
  assert.equal(labor.length, 2);
  assert.equal(labor[0].startAt, "2026-09-16T10:00:00.000Z");
  assert.equal(labor[0].endAt, "2026-09-16T12:00:00.000Z");
  assert.equal(labor[0].rateAmount, 50);
  assert.equal(labor[0].amount, 100);
  assert.equal(labor[1].startAt, "2026-09-16T12:00:00.000Z");
  assert.equal(labor[1].endAt, "2026-09-16T14:00:00.000Z");
  assert.equal(labor[1].rateAmount, 80);
  assert.equal(labor[1].amount, 160);

  const machine = confirmed.body.feeDetails.filter((f) => f.kind === "machine");
  assert.equal(machine.length, 1);
  assert.equal(machine[0].amount, 40); // 4h * 10
  assert.equal(confirmed.body.data.totalAmount, 300);
});

test("5. 缺费率确认整体失败且不留半条明细", async () => {
  const wNew = (await api("POST", "/workers", { name: "无费率工", code: "WN" })).body.data;
  const mNew = (await api("POST", "/machines", { name: "无费率机", code: "MN" })).body.data;

  const entry = await api("POST", "/time-entries", {
    tuneId: "tune_demo",
    sectionId: "section_demo_1",
    workerId: wNew.id,
    machineId: mNew.id,
    startAt: "2026-09-20T08:00:00Z",
    endAt: "2026-09-20T10:00:00Z"
  });
  assert.equal(entry.status, 201);

  const fail = await api("POST", `/time-entries/${entry.body.data.id}/confirm`, {});
  assert.equal(fail.status, 422);
  assert.match(fail.body.error, /没有生效费率/);

  // 仍是草稿，没有任何关联明细
  const got = await api("GET", `/time-entries/${entry.body.data.id}`);
  assert.equal(got.body.data.status, "draft");
  assert.equal(got.body.feeDetails.length, 0);
  const fees = await api("GET", `/fee-details?entryId=${entry.body.data.id}`);
  assert.equal(fees.body.data.length, 0);
  assert.equal(fees.body.summary.totalAmount, 0);

  // 只补工人费率仍失败（机台缺），且仍无明细
  await api("POST", "/rates", { targetType: "worker", targetId: wNew.id, amount: 10, effectiveFrom: "2026-09-01T00:00:00Z" });
  const fail2 = await api("POST", `/time-entries/${entry.body.data.id}/confirm`, {});
  assert.equal(fail2.status, 422);
  const fees2 = await api("GET", `/fee-details?entryId=${entry.body.data.id}`);
  assert.equal(fees2.body.data.length, 0);

  // 补齐机台费率后确认成功
  await api("POST", "/rates", { targetType: "machine", targetId: mNew.id, amount: 20, effectiveFrom: "2026-09-01T00:00:00Z" });
  const ok = await api("POST", `/time-entries/${entry.body.data.id}/confirm`, {});
  assert.equal(ok.status, 201);
  assert.equal(ok.body.feeDetails.length, 2);
  assert.equal(ok.body.feeDetails.find((f) => f.kind === "labor").amount, 20);
  assert.equal(ok.body.feeDetails.find((f) => f.kind === "machine").amount, 40);
});

test("6. 确认后不可变：改删被拒，重复确认不重复计费", async () => {
  const entry = await api("POST", "/time-entries", {
    tuneId: "tune_demo",
    sectionId: "section_demo_1",
    workerId: ids.w1,
    machineId: ids.m1,
    startAt: "2026-09-16T08:00:00Z",
    endAt: "2026-09-16T09:00:00Z"
  });
  await api("POST", `/time-entries/${entry.body.data.id}/confirm`, {});
  ids.entryImmut = entry.body.data.id;

  const patch = await api("PATCH", `/time-entries/${entry.body.data.id}`, {
    startAt: "2026-09-16T08:30:00Z"
  });
  assert.equal(patch.status, 409);
  const del = await api("DELETE", `/time-entries/${entry.body.data.id}`);
  assert.equal(del.status, 409);

  // 重复确认幂等：200，明细仍是 2 条，金额不变
  const again = await api("POST", `/time-entries/${entry.body.data.id}/confirm`, {});
  assert.equal(again.status, 200);
  assert.equal(again.body.feeDetails.length, 2);
  const fees = await api("GET", `/fee-details?entryId=${entry.body.data.id}`);
  assert.equal(fees.body.data.length, 2);
  // 9/16 w1=70/h；M1 9 月 30/h
  assert.equal(fees.body.summary.totalAmount, 100);

  // 草稿可以改/删
  const draft = await api("POST", "/time-entries", {
    tuneId: "tune_demo",
    sectionId: "section_demo_1",
    workerId: ids.w1,
    machineId: ids.m1,
    startAt: "2026-09-17T08:00:00Z",
    endAt: "2026-09-17T09:00:00Z"
  });
  const moved = await api("PATCH", `/time-entries/${draft.body.data.id}`, {
    startAt: "2026-09-17T09:00:00Z",
    endAt: "2026-09-17T10:00:00Z",
    note: "改期"
  });
  assert.equal(moved.status, 200);
  assert.equal(moved.body.data.startAt, "2026-09-17T09:00:00.000Z");
  // 改成与别人重叠 -> 409 且记录不变
  const intoClash = await api("PATCH", `/time-entries/${draft.body.data.id}`, {
    startAt: "2026-09-16T08:30:00Z",
    endAt: "2026-09-16T09:30:00Z"
  });
  assert.equal(intoClash.status, 409);
  const removed = await api("DELETE", `/time-entries/${draft.body.data.id}`);
  assert.equal(removed.status, 200);
  const gone = await api("GET", `/time-entries/${draft.body.data.id}`);
  assert.equal(gone.status, 404);
});

test("7. 调整单：纠错与补录，只追加不改历史", async () => {
  const before = (await api("GET", `/fee-details?entryId=${ids.entryImmut}`)).body.data;

  // 纠错：多计 10 元
  const corr = await api("POST", "/adjustments", {
    reasonType: "correction",
    entryId: ids.entryImmut,
    amount: -10,
    occurredAt: "2026-09-16T09:00:00Z",
    reason: "机台停转10分钟误计"
  });
  assert.equal(corr.status, 201);
  assert.equal(corr.body.data.amount, -10);
  assert.equal(corr.body.data.month, "2026-09");
  assert.equal(corr.body.data.workerId, ids.w1);
  assert.equal(corr.body.data.machineId, ids.m1);
  assert.equal(corr.body.data.tuneId, "tune_demo");

  // 补录：独立补贴 25 元
  const back = await api("POST", "/adjustments", {
    reasonType: "backfill",
    tuneId: "tune_demo",
    workerId: ids.w1,
    machineId: ids.m1,
    amount: 25,
    occurredAt: "2026-09-16T18:00:00Z",
    reason: "夜间作业补贴补录"
  });
  assert.equal(back.status, 201);

  // 历史明细金额与数量完全不变（不可变）
  const after = (await api("GET", `/fee-details?entryId=${ids.entryImmut}`)).body.data;
  assert.deepEqual(after, before);

  const adjs = await api("GET", `/adjustments?workerId=${ids.w1}&month=2026-09`);
  assert.equal(adjs.body.data.length, 2);
  assert.equal(adjs.body.summary.totalAmount, 15);

  // 非法类型 400；缺字段 400
  const bad = await api("POST", "/adjustments", {
    reasonType: "hack",
    amount: 1,
    occurredAt: "2026-09-16T09:00:00Z"
  });
  assert.equal(bad.status, 400);
  const missing = await api("POST", "/adjustments", { reasonType: "correction", amount: 1 });
  assert.equal(missing.status, 400);

  // 不能对草稿开调整
  const draft = await api("POST", "/time-entries", {
    tuneId: "tune_demo",
    sectionId: "section_demo_1",
    workerId: ids.w2,
    machineId: ids.m2,
    startAt: "2026-09-17T08:00:00Z",
    endAt: "2026-09-17T09:00:00Z"
  });
  const adjDraft = await api("POST", "/adjustments", {
    reasonType: "correction",
    entryId: draft.body.data.id,
    amount: -1,
    occurredAt: "2026-09-17T09:00:00Z"
  });
  assert.equal(adjDraft.status, 409);
  // 失败不留调整单
  const allAdj = await api("GET", "/adjustments");
  assert.equal(allAdj.body.data.length, 2);
});

test("8. 多维查询：曲目/区间/工人/月份 + 成本汇总", async () => {
  // 明细查询：按工人+月份（机台类明细也带操作工，故 4+2=6 条）
  const fees = await api("GET", `/fee-details?workerId=${ids.w1}&month=2026-09`);
  assert.equal(fees.body.data.length, 6);
  for (const f of fees.body.data) {
    assert.equal(f.workerId, ids.w1);
    assert.equal(f.month, "2026-09");
  }
  assert.equal(fees.body.summary.totalDurationMinutes, 300); // 只按人工线计时 240+60
  assert.equal(fees.body.summary.totalAmount, 460); // 测试3 的360 + 测试6 的100

  // 10 月无明细（所有已确认工时都在 9 月）
  const oct = await api("GET", "/fee-details?month=2026-10");
  assert.equal(oct.body.data.length, 0);
  assert.equal(oct.body.summary.totalAmount, 0);

  // 工时按区间+状态查
  const s2 = await api("GET", "/time-entries?sectionId=section_demo_2&status=confirmed");
  assert.ok(s2.body.data.length >= 1);
  const byTune = await api("GET", "/time-entries?tuneId=tune_demo");
  assert.ok(byTune.body.data.length >= 5);

  // 成本汇总：w1 的 9 月
  const report = await api("GET", `/cost-report?workerId=${ids.w1}&month=2026-09`);
  assert.equal(report.status, 200);
  const r = report.body.data;
  // w1 已确认工时：测试3（跨午夜）+ 测试6，共 2 条
  assert.equal(r.entryCount, 2);
  // fees = 明细合计；调整 -10 +25 = +15；总额 = fees + 15
  assert.equal(r.totalAmount, r.feesAmount + 15);
  assert.equal(r.adjustmentsAmount, 15);
  assert.equal(r.totalDurationMinutes, 300); // 240 + 60
  // fees: 测试3 人工240+机120=360；测试6 70+30=100 → 460
  assert.equal(r.feesAmount, 460);
  assert.equal(r.totalAmount, 475);

  // 按曲目过滤包含两条调整
  const byTuneReport = await api("GET", "/cost-report?tuneId=tune_demo&month=2026-09");
  assert.equal(byTuneReport.body.data.adjustmentsAmount, 15);

  // w2 无调整
  const w2report = await api("GET", `/cost-report?workerId=${ids.w2}&month=2026-09`);
  assert.equal(w2report.body.data.adjustmentsAmount, 0);

  // 非法月份
  const badMonth = await api("GET", "/fee-details?month=2026-9");
  assert.equal(badMonth.status, 400);
});

test("9. 并发写入：同时段只有一条胜出、不重复计费、不重叠者全成功", async () => {
  // 9A: 8 个请求竞争同一工人同一机台同一时段
  const payload = {
    tuneId: "tune_demo",
    sectionId: "section_demo_1",
    workerId: ids.w1,
    machineId: ids.m1,
    startAt: "2026-09-18T08:00:00Z",
    endAt: "2026-09-18T09:00:00Z"
  };
  const results1 = await Promise.all(Array.from({ length: 8 }, () => api("POST", "/time-entries", payload)));
  const ok1 = results1.filter((x) => x.status === 201);
  assert.equal(ok1.length, 1, `应只有1条成功: ${results1.map((x) => x.status)}`);
  assert.equal(results1.filter((x) => x.status === 409).length, 7);

  // 并发确认这条工时 8 次：201 只有一次，明细只有一套
  const entryId = ok1[0].body.data.id;
  const confirms = await Promise.all(
    Array.from({ length: 8 }, () => api("POST", `/time-entries/${entryId}/confirm`, {}))
  );
  assert.equal(confirms.filter((x) => x.status === 201).length, 1);
  assert.equal(confirms.filter((x) => x.status === 200).length, 7);
  const fees = await api("GET", `/fee-details?entryId=${entryId}`);
  assert.equal(fees.body.data.length, 2);
  assert.equal(fees.body.summary.totalAmount, 100); // 70 + 30

  // 9B: 三对不同工人+机台，同一时段并发，全部成功
  const pairs = [];
  for (let i = 0; i < 3; i++) {
    const w = await api("POST", "/workers", { name: `并发工${i}`, code: `CPW${i}` });
    const m = await api("POST", "/machines", { name: `并发机${i}`, code: `CPM${i}` });
    pairs.push([w.body.data.id, m.body.data.id]);
  }
  await Promise.all(
    pairs.map(([wid]) =>
      api("POST", "/rates", { targetType: "worker", targetId: wid, amount: 40, effectiveFrom: "2026-09-01T00:00:00Z" })
    )
  );
  await Promise.all(
    pairs.map(([, mid]) =>
      api("POST", "/rates", { targetType: "machine", targetId: mid, amount: 20, effectiveFrom: "2026-09-01T00:00:00Z" })
    )
  );
  const parallelResults = await Promise.all(
    pairs.map(([wid, mid]) =>
      api("POST", "/time-entries", {
        tuneId: "tune_demo",
        sectionId: "section_demo_1",
        workerId: wid,
        machineId: mid,
        startAt: "2026-09-18T10:00:00Z",
        endAt: "2026-09-18T12:00:00Z"
      })
    )
  );
  assert.equal(parallelResults.filter((x) => x.status === 201).length, 3);
  const confirmedParallel = await Promise.all(
    parallelResults.map((x) => api("POST", `/time-entries/${x.body.data.id}/confirm`, {}))
  );
  for (const c of confirmedParallel) {
    assert.equal(c.status, 201);
    assert.equal(c.body.data.totalAmount, 120); // 2h*40 + 2h*20
  }

  // 9C: 同幂等键并发 5 次只落一条
  const idemResults = await Promise.all(
    Array.from({ length: 5 }, () =>
      api("POST", "/time-entries", {
        tuneId: "tune_demo",
        sectionId: "section_demo_1",
        workerId: ids.w1,
        machineId: ids.m1,
        startAt: "2026-09-19T08:00:00Z",
        endAt: "2026-09-19T09:00:00Z",
        idempotencyKey: "idem-0919-w1m1"
      })
    )
  );
  assert.equal(idemResults.filter((x) => x.status === 201).length, 5);
  const idemIds = new Set(idemResults.map((x) => x.body.data.id));
  assert.equal(idemIds.size, 1);
  const idemList = await api("GET", "/time-entries");
  assert.equal(idemList.body.data.filter((e) => e.idempotencyKey === "idem-0919-w1m1").length, 1);

  // 9D: 同一目标并发新增同一生效时间的开放费率，只允许一条
  const cpw0 = pairs[0][0];
  const rateResults = await Promise.all(
    Array.from({ length: 4 }, (_, i) =>
      api("POST", "/rates", {
        targetType: "worker",
        targetId: cpw0,
        amount: 45 + i,
        effectiveFrom: "2026-10-01T00:00:00Z"
      })
    )
  );
  assert.equal(rateResults.filter((x) => x.status === 201).length, 1,
    `费率并发应只成1条: ${rateResults.map((x) => x.status)}`);
  assert.equal(rateResults.filter((x) => x.status === 409).length, 3);
});

test("10. 重启后费率、调整、明细完全一致，规则继续生效", async () => {
  const beforeFees = (await api("GET", "/fee-details?month=2026-09")).body;
  const beforeAdj = (await api("GET", "/adjustments?month=2026-09")).body;
  const beforeRates = (await api("GET", "/rates")).body.data;
  const beforeEntries = (await api("GET", "/time-entries")).body.data;
  const beforeReport = (await api("GET", "/cost-report?tuneId=tune_demo&month=2026-09")).body.data;
  const beforeWorkers = (await api("GET", "/workers")).body.data;

  await restartServer();

  assert.deepEqual((await api("GET", "/fee-details?month=2026-09")).body, beforeFees);
  assert.deepEqual((await api("GET", "/adjustments?month=2026-09")).body, beforeAdj);
  assert.deepEqual((await api("GET", "/rates")).body.data, beforeRates);
  assert.deepEqual((await api("GET", "/time-entries")).body.data, beforeEntries);
  assert.deepEqual((await api("GET", "/cost-report?tuneId=tune_demo&month=2026-09")).body.data, beforeReport);
  assert.deepEqual((await api("GET", "/workers")).body.data, beforeWorkers);

  // 旧数据与旧接口
  const tunes = await api("GET", "/tunes");
  assert.ok(tunes.body.data.some((t) => t.id === "tune_demo"));
  const progress = await api("GET", "/tunes/tune_demo/progress");
  assert.equal(progress.status, 200);

  // 重启后重叠规则仍生效
  const clash = await api("POST", "/time-entries", {
    tuneId: "tune_demo",
    sectionId: "section_demo_1",
    workerId: ids.w1,
    machineId: ids.m1,
    startAt: "2026-09-18T08:30:00Z",
    endAt: "2026-09-18T08:45:00Z"
  });
  assert.equal(clash.status, 409);

  // 重启后幂等键仍防重
  const idemAgain = await api("POST", "/time-entries", {
    tuneId: "tune_demo",
    sectionId: "section_demo_1",
    workerId: ids.w1,
    machineId: ids.m1,
    startAt: "2026-09-19T08:00:00Z",
    endAt: "2026-09-19T09:00:00Z",
    idempotencyKey: "idem-0919-w1m1"
  });
  assert.equal(idemAgain.status, 201);
  const idemList = await api("GET", "/time-entries");
  assert.equal(idemList.body.data.filter((e) => e.idempotencyKey === "idem-0919-w1m1").length, 1);

  // 原子写不留临时文件
  const tmpFiles = fs
    .readdirSync(path.dirname(dbFile))
    .filter((f) => f.startsWith(path.basename(dbFile) + ".tmp-"));
  assert.equal(tmpFiles.length, 0);
});
