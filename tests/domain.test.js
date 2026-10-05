import assert from "node:assert/strict";
import test from "node:test";

import {
  SiteFile,
  DomainError,
  replay,
  enrollmentPage,
  siteOverview,
  checksRequiringRedo,
  capacityForZones,
  AREA_PER_CHILD_M2,
  EXIT_LEAD_DAYS,
} from "../src/domain.js";

// ---------- 最小就绪场景夹具 ----------

const ZONES_A_B = [
  { zone_id: "Z-a", name: "活动室甲", function: "游戏活动", indoor_area_m2: 60, capacity_eligible: true },
  { zone_id: "Z-b", name: "活动室乙", function: "游戏活动", indoor_area_m2: 30, capacity_eligible: true },
];

const ev = (ref, at) => ({ kind: "现场照片", ref, captured_at: at });
const rec = (ref, at) => ({ kind: "验收记录", ref, captured_at: at });
const sig = (role, name, at) => ({ role, name, signed_at: at });

/** 可拨时钟的最小站点：已登记产权、提交并通过 R1、施工完成、材料合格、消防卫生意见齐备、两区分区验收。 */
function readySite({ termEnd = "2030-12-31", start = "2026-10-05T09:00:00+08:00" } = {}) {
  let t = new Date(start);
  const file = new SiteFile("site-test-01", { now: () => t });
  const set = (iso) => { t = new Date(iso); };
  const now = () => t.toISOString();

  set("2026-03-01T09:00:00+08:00");
  file.registerProperty({
    site_name: "测试托育点",
    original_use: "旧厂房配套用房",
    property_unit: "某产权单位",
    area_total_m2: 500,
    term_start: "2024-01-01",
    term_end: termEnd,
  });
  set("2026-04-01T09:00:00+08:00");
  file.submitDesign({ revision_no: "R1", supersedes: null, zones: ZONES_A_B, affected_zone_ids: [] });
  set("2026-04-10T09:00:00+08:00");
  file.approveDesign({ revision_no: "R1", approved_by: "设计审查科" });
  set("2026-05-10T09:00:00+08:00");
  file.completeConstruction({ revision_no: "R1" });
  set("2026-05-20T09:00:00+08:00");
  for (const [zone_id, no] of [["Z-a", "MT-A-1"], ["Z-b", "MT-B-1"]]) {
    file.recordMaterialTest({ revision_no: "R1", zone_id, material: "地胶", report_no: no, result: "PASS" });
  }
  file.recordFireOpinion({
    revision_no: "R1", opinion_no: "XF-1", zone_ids: ["Z-a", "Z-b"], result: "合格",
    issued_on: "2026-05-20", valid_until: "2027-05-19",
  });
  file.recordHealthOpinion({
    revision_no: "R1", opinion_no: "WS-1", zone_ids: ["Z-a", "Z-b"], result: "合格",
    issued_on: "2026-05-20", valid_until: "2027-05-19",
  });
  set("2026-06-01T09:00:00+08:00");
  for (const zone_id of ["Z-a", "Z-b"]) {
    file.acceptZone({
      revision_no: "R1", zone_id,
      signers: [sig("街道验收专员", "甲", now()), sig("托育机构负责人", "乙", now())],
    });
  }
  set(start);
  return { file, set, now };
}

function openingInput(file, overrides = {}) {
  const today = file.clock().toISOString().slice(0, 10);
  return {
    decision_no: "OD-1",
    mode: "FULL",
    revision_no: "R1",
    zone_ids: ["Z-a", "Z-b"],
    excluded_zone_ids: [],
    capacity_filed: 30,
    staffing: { caregivers: 5, ratio: 7 },
    restrictions: ["按意见书条件运行"],
    evidence: [ev("EV-1", file.clock().toISOString())],
    signers: [sig("街道批准人", "甲", file.clock().toISOString()), sig("托育机构负责人", "乙", file.clock().toISOString())],
    valid_from: today,
    valid_until: "2027-05-19",
    based_on: { fire_opinion_nos: ["XF-1"], health_opinion_nos: ["WS-1"], material_report_nos: ["MT-A-1", "MT-B-1"] },
    ...overrides,
  };
}

const expectReject = (fn, fragment) => {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof DomainError);
    assert.ok(error.errors.some((m) => m.includes(fragment)), `应包含“${fragment}”，实际：${error.errors.join("｜")}`);
    return true;
  });
};

// ---------- 三道独立闸门 ----------

test("闸门：设计未通过不能报施工完成，施工未完成不能开园", () => {
  let t = new Date("2026-03-01T09:00:00+08:00");
  const file = new SiteFile("gates", { now: () => t });
  const set = (iso) => { t = new Date(iso); };
  file.registerProperty({
    site_name: "g", original_use: "旧厂房", property_unit: "p",
    area_total_m2: 100, term_start: "2025-01-01", term_end: "2030-01-01",
  });
  set("2026-04-01T09:00:00+08:00");
  file.submitDesign({ revision_no: "R1", supersedes: null, zones: ZONES_A_B, affected_zone_ids: [] });
  expectReject(() => file.completeConstruction({ revision_no: "R1" }), "设计尚未通过");
  set("2026-04-02T09:00:00+08:00");
  file.approveDesign({ revision_no: "R1", approved_by: "科" });
  // 设计通过 ≠ 允许收托：缺施工完成与分区验收，开园被拒
  expectReject(() => file.decideOpening(openingInput(file)), "施工未完成");
});

test("闸门：设计通过、施工完成事件不能互相替代，也不自动允许收托", () => {
  const { file } = readySite();
  // 已施工完成但不作出 OPENING_DECIDED：招生页无容量
  const state = replay("site-test-01", file.events);
  const page = enrollmentPage(state, "2026-10-05");
  assert.equal(page.publish, false);
  assert.match(page.status, /无在有效期内的开园决定/);
  assert.equal(page.capacity_filed, 0);
});

test("闸门：被取代的旧版次不能补审批或补报施工完成", () => {
  const { file, set, now } = readySite();
  set("2026-09-01T09:00:00+08:00");
  file.submitDesign({ revision_no: "R2", supersedes: "R1", zones: ZONES_A_B, affected_zone_ids: ["Z-a"] });
  expectReject(() => file.approveDesign({ revision_no: "R1", approved_by: "科" }), "已被 R2 取代");
  expectReject(() => file.completeConstruction({ revision_no: "R1" }), "已被取代");
});

// ---------- 容量折算 ----------

test("容量：只能按当前获准分区室内面积折算，按整栋面积虚报被拒", () => {
  const { file } = readySite();
  const expected = Math.floor((60 + 30) / AREA_PER_CHILD_M2);
  assert.equal(expected, 30);
  expectReject(() => file.decideOpening(openingInput(file, { capacity_filed: 166 })), "整栋建筑面积不得用于折算");
  file.decideOpening(openingInput(file)); // 30 人通过
});

test("容量：共享区域按每周专用时段比例折算（20 专用小时 / 50）", () => {
  const { file, set, now } = readySite();
  set("2026-09-20T09:00:00+08:00");
  file.agreeSharedSlot({
    zone_id: "Z-b",
    partner: "社区活动室",
    slots: [
      { weekday: "周一", from: "08:00", to: "12:00", exclusive_for_childcare: true },
      { weekday: "周二", from: "08:00", to: "12:00", exclusive_for_childcare: true },
      { weekday: "周三", from: "08:00", to: "12:00", exclusive_for_childcare: true },
      { weekday: "周四", from: "08:00", to: "12:00", exclusive_for_childcare: true },
      { weekday: "周五", from: "08:00", to: "12:00", exclusive_for_childcare: true },
      { weekday: "周三", from: "14:00", to: "17:00", exclusive_for_childcare: false },
    ],
  });
  const state = replay("site-test-01", file.events);
  // 60 + 30*(20/50)=72 → 24 人
  assert.equal(capacityForZones(state, ["Z-a", "Z-b"]), 24);
  expectReject(() => file.decideOpening(openingInput(file)), "折算应为 24");
  file.decideOpening(openingInput(file, { capacity_filed: 24, staffing: { caregivers: 4, ratio: 7 } }));
});

test("容量：保育人员不足时按配比拒绝", () => {
  const { file } = readySite();
  expectReject(
    () => file.decideOpening(openingInput(file, { capacity_filed: 30, staffing: { caregivers: 3, ratio: 7 } })),
    "至少需要 5 名保育人员",
  );
});

// ---------- 图纸修订与重做 ----------

test("修订：受影响分区的材料、意见、缺陷、验收按分区作废；未触及分区继续有效", () => {
  const { file, set, now } = readySite();
  set("2026-08-01T09:00:00+08:00");
  file.recordInspection({
    finding_id: "FD-A-1", revision_no: "R1", zone_id: "Z-a", category: "设施",
    severity: "minor", description: "扶手松动",
  });
  set("2026-09-01T09:00:00+08:00");
  file.submitDesign({ revision_no: "R2", supersedes: "R1", zones: ZONES_A_B, affected_zone_ids: ["Z-a"] });

  const state = replay("site-test-01", file.events);
  const redo = checksRequiringRedo(state, "R2");
  assert.deepEqual(redo.map((x) => x.zone_id), ["Z-a"]);
  const types = redo[0].items.map((i) => i.type);
  assert.deepEqual(types, ["材料检测", "消防意见", "卫生意见", "缺陷复检", "分区验收"]);

  // Z-b 的旧材料/意见/验收仍然有效：只开 Z-b 时可以继续引用 XF-1/WS-1
  set("2026-09-10T09:00:00+08:00");
  file.approveDesign({ revision_no: "R2", approved_by: "科" });
  file.completeConstruction({ revision_no: "R2" });
  assert.doesNotThrow(() =>
    file.decideOpening(
      openingInput(file, {
        decision_no: "OD-2",
        mode: "PARTIAL",
        revision_no: "R2",
        zone_ids: ["Z-b"],
        excluded_zone_ids: ["Z-a"],
        isolation_measures: "Z-a 封闭围挡",
        capacity_filed: 10,
        staffing: { caregivers: 2, ratio: 7 },
        based_on: { fire_opinion_nos: ["XF-1"], health_opinion_nos: ["WS-1"], material_report_nos: ["MT-B-1"] },
        valid_from: "2026-09-10",
        valid_until: "2027-05-19",
      }),
    ),
  );
  // 想用旧意见覆盖被修订的 Z-a 则被拒
  expectReject(
    () =>
      file.decideOpening(
        openingInput(file, {
          decision_no: "OD-3",
          mode: "FULL",
          revision_no: "R2",
          zone_ids: ["Z-a", "Z-b"],
          excluded_zone_ids: [],
          capacity_filed: 30,
          valid_from: "2026-09-11",
        }),
      ),
    "缺少一份在有效期内",
  );
});

test("修订：随修订作废的缺陷整改事件不予受理，须重新检查立项", () => {
  const { file, set } = readySite();
  set("2026-08-01T09:00:00+08:00");
  file.recordInspection({
    finding_id: "FD-A-1", revision_no: "R1", zone_id: "Z-a", category: "消防",
    severity: "major", description: "问题",
  });
  set("2026-09-01T09:00:00+08:00");
  file.submitDesign({ revision_no: "R2", supersedes: "R1", zones: ZONES_A_B, affected_zone_ids: ["Z-a"] });
  expectReject(
    () => file.assignDefect({ finding_id: "FD-A-1", assignee: "周工", due_date: "2026-10-01" }),
    "已随图纸修订作废",
  );
});

// ---------- 缺陷整改与局部开放 ----------

test("缺陷：critical/major 整改后须以验收记录复验，否则分区验收不成立", () => {
  const { file, set, now } = readySite();
  set("2026-08-01T09:00:00+08:00");
  file.recordInspection({
    finding_id: "FD-B-1", revision_no: "R1", zone_id: "Z-b", category: "消防",
    severity: "major", description: "应急照明故障",
  });
  // 已有的 R1 分区验收因此实质失效：再次验收被拒
  set("2026-08-05T09:00:00+08:00");
  file.assignDefect({ finding_id: "FD-B-1", assignee: "周工", due_date: "2026-08-20" });
  set("2026-08-18T09:00:00+08:00");
  file.rectifyDefect({ finding_id: "FD-B-1", evidence: [ev("EV-FIX-1", now())] });
  // 只整改未复验 → 验收拒绝
  expectReject(
    () => file.acceptZone({ revision_no: "R1", zone_id: "Z-b", signers: [sig("街道", "甲", now()), sig("机构", "乙", now())] }),
    "尚缺“验收记录”复验",
  );
  // 补复验证据后通过
  file.rectifyDefect({ finding_id: "FD-B-1", evidence: [rec("EV-REV-1", now())] });
  assert.doesNotThrow(() =>
    file.acceptZone({ revision_no: "R1", zone_id: "Z-b", signers: [sig("街道", "甲", now()), sig("机构", "乙", now())] }),
  );
});

test("局部开放：有 major 缺陷的分区必须排除；minor 缺陷可凭明确条件与隔离措施局部开放", () => {
  const { file, set, now } = readySite();
  set("2026-08-01T09:00:00+08:00");
  file.recordInspection({
    finding_id: "FD-A-9", revision_no: "R1", zone_id: "Z-a", category: "消防",
    severity: "major", description: "疏散门故障",
  });
  set("2026-08-10T09:00:00+08:00");
  // 把 Z-a 放进开放范围 → 拒绝
  expectReject(
    () =>
      file.decideOpening(
        openingInput(file, {
          mode: "PARTIAL",
          zone_ids: ["Z-a", "Z-b"],
          excluded_zone_ids: [],
          capacity_filed: 30,
        }),
      ),
    "未闭环的 critical/major",
  );
  // 排除 Z-a 但缺隔离措施/条件 → 拒绝
  expectReject(
    () =>
      file.decideOpening(
        openingInput(file, { mode: "PARTIAL", zone_ids: ["Z-b"], excluded_zone_ids: ["Z-a"], capacity_filed: 10 }),
      ),
    "物理隔离措施",
  );
  assert.doesNotThrow(() =>
    file.decideOpening(
      openingInput(file, {
        mode: "PARTIAL",
        zone_ids: ["Z-b"],
        excluded_zone_ids: ["Z-a"],
        isolation_measures: "Z-a 入口固定围挡并张贴停用标识",
        conditions: ["FD-A-9 整改复验前幼儿不得进入 Z-a"],
        capacity_filed: 10,
        staffing: { caregivers: 2, ratio: 7 },
        material_report_nos: ["MT-B-1"],
      }),
    ),
  );
});

test("局部开放：至少两方签署，且必须附现场证据与限制条件", () => {
  const { file } = readySite();
  const base = openingInput(file, {
    mode: "PARTIAL",
    zone_ids: ["Z-b"],
    excluded_zone_ids: ["Z-a"],
    isolation_measures: "围挡",
    capacity_filed: 10,
    staffing: { caregivers: 2, ratio: 7 },
    material_report_nos: ["MT-B-1"],
  });
  expectReject(() => file.decideOpening({ ...base, signers: [sig("机构", "乙", file.clock().toISOString())] }), "两方责任人签署");
  expectReject(() => file.decideOpening({ ...base, evidence: [] }), "现场证据");
  expectReject(() => file.decideOpening({ ...base, restrictions: [] }), "限制条件");
});

// ---------- 过期/作废意见 ----------

test("意见：过期消防意见不得重新引用", () => {
  const { file, set, now } = readySite();
  set("2027-05-20T09:00:00+08:00"); // XF-1/WS-1 已过期
  expectReject(
    () =>
      file.decideOpening(
        openingInput(file, { decision_no: "OD-late", valid_from: "2027-05-20", valid_until: "2027-12-31" }),
      ),
    "过期意见不得重新引用",
  );
});

test("意见：不合格结论直接阻断开园，附带条件必须写入限制", () => {
  let t = new Date("2026-10-01T09:00:00+08:00");
  const file = new SiteFile("site-op", { now: () => t });
  file.registerProperty({
    site_name: "o", original_use: "旧厂房", property_unit: "p", area_total_m2: 200,
    term_start: "2025-01-01", term_end: "2030-01-01",
  });
  file.submitDesign({ revision_no: "R1", supersedes: null, zones: ZONES_A_B, affected_zone_ids: [] });
  file.approveDesign({ revision_no: "R1", approved_by: "科" });
  file.completeConstruction({ revision_no: "R1" });
  for (const [z, no] of [["Z-a", "MT-A-1"], ["Z-b", "MT-B-1"]])
    file.recordMaterialTest({ revision_no: "R1", zone_id: z, material: "m", report_no: no, result: "PASS" });
  file.recordFireOpinion({
    revision_no: "R1", opinion_no: "XF-bad", zone_ids: ["Z-a", "Z-b"], result: "不合格",
    issued_on: "2026-09-20", valid_until: "2027-09-19",
  });
  file.recordHealthOpinion({
    revision_no: "R1", opinion_no: "WS-1", zone_ids: ["Z-a", "Z-b"], result: "合格",
    issued_on: "2026-09-20", valid_until: "2027-09-19",
  });
  // 消防结论不合格：分区验收也无法成立，直接以 FULL 开园被“不合格”结论拦下
  expectReject(
    () =>
      file.decideOpening({
        ...openingInput(file, {
          based_on: { fire_opinion_nos: ["XF-bad"], health_opinion_nos: ["WS-1"], material_report_nos: ["MT-A-1", "MT-B-1"] },
          valid_from: "2026-10-01",
          valid_until: "2027-09-19",
        }),
      }),
    "结论为不合格",
  );
});

// ---------- 招生页投影 ----------

test("招生页：只公布当前获准分区折算容量；意见过期后立即下架", () => {
  const { file } = readySite();
  file.decideOpening(openingInput(file));
  let state = replay("site-test-01", file.events);
  let page = enrollmentPage(state, "2026-10-05");
  assert.equal(page.publish, true);
  assert.equal(page.capacity_filed, 30);
  assert.deepEqual(page.zones_opened.sort(), ["Z-a", "Z-b"]);
  assert.ok(page.evidence.every((x) => x.ref && x.captured_at));

  page = enrollmentPage(state, "2027-05-20");
  assert.equal(page.publish, false);
  assert.equal(page.capacity_filed, 0);
  // 决定有效期与意见书同期结束；过期后招生页无任何容量可公布（过期意见重新引用在开园命令中另行拦截）
  assert.match(page.status, /已失效|无在有效期内的开园决定/);
});

test("招生页：图纸修订触及已开放分区后，容量仅按未受波及分区重算", () => {
  const { file, set, now } = readySite();
  file.decideOpening(openingInput(file));
  set("2026-11-01T09:00:00+08:00");
  file.submitDesign({ revision_no: "R2", supersedes: "R1", zones: ZONES_A_B, affected_zone_ids: ["Z-a"] });
  const state = replay("site-test-01", file.events);
  const page = enrollmentPage(state, "2026-11-05");
  assert.equal(page.publish, true);
  assert.deepEqual(page.zones_opened, ["Z-b"]);
  assert.equal(page.capacity_filed, 10); // 30/3
  assert.match(page.status, /图纸修订后局部失效/);
  assert.match(page.notices[0], /Z-a/);
});

test("招生页：场地交还后停止公布容量", () => {
  const { file, set, now } = readySite();
  file.decideOpening(openingInput(file, { valid_until: "2027-05-19" }));
  set("2028-06-01T09:00:00+08:00");
  file.formExitPlan({
    plan_id: "EP-1",
    facilities: "可拆卸教具由机构搬走，固定装修无偿移交产权单位",
    deposit: "押金 5 万元在恢复验收合格后 10 个工作日内无息退还",
    child_placement: "32 名在托儿童按家长意愿分流至周边两个托育点，保留同等待遇",
    restoration: "拆除后加隔墙并恢复原仓储门，由机构承担费用，产权单位验收",
    target_handback_date: "2028-08-31",
    signers: [sig("产权单位代表", "方某", now()), sig("托育机构负责人", "乙", now()), sig("街道办事处代表", "甲", now())],
  });
  set("2028-08-31T10:00:00+08:00");
  file.handBack({ handback_date: "2028-08-31", restoration_verified: true, signers: [sig("产权单位代表", "方某", now())] });
  const state = replay("site-test-01", file.events);
  const page = enrollmentPage(state, "2028-09-01");
  assert.equal(page.publish, false);
  assert.match(page.status, /已交还/);
});

// ---------- 产权期限与退出方案 ----------

test("产权：期限倒置与重复登记被拒", () => {
  let t = new Date("2026-10-05T09:00:00+08:00");
  const file = new SiteFile("site-term", { now: () => t });
  expectReject(
    () =>
      file.registerProperty({
        site_name: "s", original_use: "u", property_unit: "p", area_total_m2: 100,
        term_start: "2026-01-01", term_end: "2025-01-01",
      }),
    "截止日必须晚于起始日",
  );
  file.registerProperty({
    site_name: "s", original_use: "u", property_unit: "p", area_total_m2: 100,
    term_start: "2024-01-01", term_end: "2027-03-01",
  });
  expectReject(
    () =>
      file.registerProperty({
        site_name: "s", original_use: "u", property_unit: "p", area_total_m2: 100,
        term_start: "2024-01-01", term_end: "2030-01-01",
      }),
    "不得重复登记",
  );
});

test("退出：剩余 180 天内总览提示方案缺失；方案须涵盖设施、押金、儿童安置、恢复责任并三方签署", () => {
  const { file, set, now } = readySite({ termEnd: "2027-03-01" });
  let state = replay("site-test-01", file.events);
  const overview = siteOverview(state, "2026-10-05");
  assert.match(overview.产权期限.状态, /临期/);
  assert.match(overview.退出恢复.状态, /退出方案缺失/);

  const good = {
    plan_id: "EP-1",
    facilities: "可拆卸教具由机构搬走，固定装修移交产权单位",
    deposit: "押金 5 万元恢复验收合格后 10 个工作日内退还",
    child_placement: "在托儿童分流至周边托育点并保留同等待遇",
    restoration: "拆除后加隔墙，恢复原用途，费用由机构承担",
    target_handback_date: "2027-02-20",
  };
  expectReject(() => file.formExitPlan({ ...good, facilities: "无" }), "设施");
  expectReject(
    () => file.formExitPlan({ ...good, signers: [sig("托育机构", "乙", now()), sig("街道", "甲", now())] }),
    "三方签署",
  );
  expectReject(
    () =>
      file.formExitPlan({
        ...good,
        signers: [sig("使用方", "x", now()), sig("托育机构", "乙", now()), sig("街道", "甲", now())],
      }),
    "产权单位签署",
  );
  set("2026-10-10T09:00:00+08:00");
  assert.doesNotThrow(() =>
    file.formExitPlan({
      ...good,
      signers: [sig("产权单位代表", "方某", now()), sig("托育机构负责人", "乙", now()), sig("街道代表", "甲", now())],
    }),
  );
  // 无方案不得交还；恢复未验收不得登记交还
  const fresh = readySite({ termEnd: "2027-03-01" });
  expectReject(() => fresh.file.handBack({ handback_date: "2027-02-20", restoration_verified: true }), "未形成退出方案");
  expectReject(
    () => fresh.file.handBack({ handback_date: "2027-02-20", restoration_verified: false }),
    "恢复须验收合格",
  );
});

test("开园期限：不得超过使用权到期日；剩余不足两年必须写入长期班限制", () => {
  const { file } = readySite({ termEnd: "2027-06-01" });
  expectReject(
    () => file.decideOpening(openingInput(file, { valid_until: "2028-01-01" })),
    "不得超过场地使用权期限",
  );
  expectReject(
    () => file.decideOpening(openingInput(file, { valid_until: "2027-05-19", restrictions: ["按意见书条件运行"] })),
    "长期班",
  );
  assert.doesNotThrow(() =>
    file.decideOpening(
      openingInput(file, {
        valid_until: "2027-05-19",
        restrictions: ["按意见书条件运行", "停止招收两年期及以上长期班，班期结业日不晚于 2027-06-01"],
      }),
    ),
  );
});

// ---------- 完整中文叙事场景 ----------

test("槐荫里场景：午睡区整改中被排除，招生页只公布 35 人，重做清单精确到午睡区", async () => {
  const { buildScenario, SITE_ID } = await import("../src/scenario.js");
  const file = buildScenario();
  const state = replay(SITE_ID, file.events);
  const overview = siteOverview(state, "2026-10-05");
  const page = enrollmentPage(state, "2026-10-05");

  // 设计通过/施工完成各自独立
  assert.match(overview.设计与施工.设计通过, /已通过/);
  assert.match(overview.设计与施工.施工完成, /已完成/);
  // 午睡区状态
  const nap = overview.功能分区.find((z) => z.分区 === "Z-nap");
  assert.equal(nap.分区验收, "未验收");
  assert.equal(nap.开园状态, "未开放");
  assert.ok(nap.未闭环缺陷.some((x) => x.includes("FD-NAP-02")));
  // 旧缺陷作废、新缺陷整改中
  assert.ok(overview.缺陷整改.find((f) => f.缺陷 === "FD-NAP-01").状态.includes("作废"));
  assert.ok(overview.缺陷整改.find((f) => f.缺陷 === "FD-NAP-02").状态.includes("整改中"));
  // 重做清单
  const redo = checksRequiringRedo(state, "R2").find((r) => r.zone_id === "Z-nap");
  assert.deepEqual(redo.items.map((i) => i.type), ["材料检测", "消防意见", "卫生意见", "缺陷复检", "分区验收"]);
  // 招生页
  assert.equal(page.publish, true);
  assert.equal(page.capacity_filed, 35);
  assert.deepEqual(page.zones_opened, ["Z-act", "Z-dining", "Z-multi"]);
  assert.ok(!page.zones_opened.includes("Z-nap"));
  assert.ok(page.notices.some((n) => n.includes("两年")));
  // 旧意见对其他分区仍有效、对午睡区已作废
  const fireR1 = overview.消防意见.find((o) => o.意见书编号 === "XF-2026-001");
  assert.match(fireR1.状态, /Z-nap/);
});
