import assert from "node:assert/strict";
import test from "node:test";

import {
  allowedPublishedCapacity,
  auditDecision,
  currentZones,
  gates,
  openZonesAt,
  project,
  reworkLedger,
  termView,
  zoneView,
} from "../src/project.js";
import { isOpinionUsable, reworkDueToRevision } from "../src/policy.js";
import {
  checkCapacityFiled,
  checkCapacityPublished,
  checkExitPlan,
  checkHandback,
  checkOpeningDecision,
} from "../src/commands.js";
import { openingCommandA, setupReadySite } from "./fixtures.js";

const P = "property_term";
const D = "design_revision";
const I = "inspection_finding";
const O = "opening_decision";

test("三道闸门分离：施工完成不代表允许收托，缺验收或缺施工都不能开园", () => {
  const { events } = setupReadySite();

  // 只有设计通过、没有施工完成
  const noConstruction = project(events.filter((e) => e.event_type !== "CONSTRUCTION_COMPLETED"));
  assert.equal(gates(noConstruction).construction.status, "not_completed");
  assert.match(checkOpeningDecision(noConstruction, openingCommandA()).join("；"), /施工尚未完成/);

  // 施工完成但分区未验收
  const noAcceptance = project(events.filter((e) => e.event_type !== "ZONE_ACCEPTED"));
  assert.equal(gates(noAcceptance).construction.status, "completed");
  assert.equal(gates(noAcceptance).opening.status, "not_allowed");
  assert.match(checkOpeningDecision(noAcceptance, openingCommandA()).join("；"), /分区验收签署/);

  // 条件齐备：三道闸门状态彼此独立，允许收托发生在签署开园决定之后
  const state = project(events);
  assert.deepEqual(
    Object.keys(gates(state)).map((g) => g),
    ["design", "construction", "opening"],
  );
  assert.equal(gates(state).design.status, "passed");
  assert.equal(gates(state).construction.status, "completed");
  assert.equal(gates(state).opening.status, "not_allowed");
  assert.deepEqual(checkOpeningDecision(state, openingCommandA()), []);
});

test("开园决定必须有签署人、现场证据，且限制条件非空", () => {
  const state = project(setupReadySite().events);
  const errors = checkOpeningDecision(state, openingCommandA({ signed_by: {}, evidence_refs: [], conditions: [] }));
  assert.match(errors.join("；"), /责任主体签署/);
  assert.match(errors.join("；"), /现场证据/);
  assert.match(errors.join("；"), /限制条件/);
});

test("图纸修订：只触及消防时，仅消防意见与消防验收须重做，材料与卫生沿用", () => {
  const { events, add } = setupReadySite();
  add(D, "DESIGN_SUBMITTED", "2027-03-01T09:00:00+08:00", "R2 报审", { revision_no: 2, submitted_at: "2027-03-01" });
  add(D, "DESIGN_APPROVED", "2027-03-05T10:00:00+08:00", "R2 通过，仅改甲区消防", {
    revision_no: 2,
    approving_authority: "联合审查组",
    approved_at: "2027-03-05",
    supersedes_revision_no: 1,
    affected_scopes: ["fire"],
    affected_zones: ["Z-A"],
  });
  add(D, "FUNCTIONAL_ZONES_DEFINED", "2027-03-05T11:00:00+08:00", "R2 分区不变", {
    revision_no: 2,
    zones: [
      { zone_id: "Z-A", name: "甲区", purpose: "活动与午睡", area_m2: 45 },
      { zone_id: "Z-B", name: "乙区", purpose: "活动", area_m2: 45 },
    ],
  });
  const state = project(events);
  const ledger = reworkLedger(state);
  assert.equal(ledger.length, 1);
  const items = ledger[0].rework_required.map((r) => `${r.zone_id}:${r.discipline}:${r.item}`);
  assert.deepEqual(items.sort(), ["Z-A:fire:专业意见重出", "Z-A:fire:分区验收重签"].sort());

  const revisions = state.revisions;
  const fire = state.opinions.find((o) => o.opinion_ref === "FI-1");
  const health = state.opinions.find((o) => o.opinion_ref === "HE-1");
  const material = state.opinions.find((o) => o.opinion_ref === "MT-1");
  const at = "2027-03-10T10:00:00+08:00";
  assert.equal(isOpinionUsable(fire, { at, revisionNo: 2, zoneId: "Z-A", revisions }), false);
  assert.equal(isOpinionUsable(fire, { at, revisionNo: 2, zoneId: "Z-B", revisions }), true); // 乙区未受影响
  assert.equal(isOpinionUsable(health, { at, revisionNo: 2, zoneId: "Z-A", revisions }), true);
  assert.equal(isOpinionUsable(material, { at, revisionNo: 2, zoneId: "Z-A", revisions }), true);

  // 旧版次开园依据被驳回
  assert.match(checkOpeningDecision(state, openingCommandA()).join("；"), /已被 R2 取代/);
});

test("修订触及分区后：旧复验结论失效须复查，修订后的复验通过才关闭缺陷", () => {
  const { events, add } = setupReadySite();
  add(I, "INSPECTION_RECORDED", "2027-02-08T10:00:00+08:00", "甲区消防一般缺陷", {
    revision_no: 1,
    finding_id: "F-A1",
    zone_id: "Z-A",
    discipline: "fire",
    finding: "一具灭火器超期",
    severity: "minor",
  });
  add(I, "DEFECT_RECTIFIED", "2027-02-09T10:00:00+08:00", "已更换", {
    finding_id: "F-A1",
    rectified_at: "2027-02-09",
    evidence_refs: ["EV-FA1-1.jpg"],
  });
  add(I, "FINDING_VERIFIED", "2027-02-10T09:00:00+08:00", "R1 复验通过", {
    finding_id: "F-A1",
    verified_at: "2027-02-10",
    verifier: "消防检查员",
    verdict: "pass",
  });
  add(D, "DESIGN_SUBMITTED", "2027-03-01T09:00:00+08:00", "R2 报审", { revision_no: 2, submitted_at: "2027-03-01" });
  add(D, "DESIGN_APPROVED", "2027-03-05T10:00:00+08:00", "R2 改甲区消防", {
    revision_no: 2,
    approving_authority: "审查组",
    approved_at: "2027-03-05",
    supersedes_revision_no: 1,
    affected_scopes: ["fire"],
    affected_zones: ["Z-A"],
  });
  add(D, "FUNCTIONAL_ZONES_DEFINED", "2027-03-05T11:00:00+08:00", "R2 分区", {
    revision_no: 2,
    zones: [{ zone_id: "Z-A", name: "甲区", purpose: "活动", area_m2: 45 }],
  });

  const beforeReverify = project(events);
  const za = currentZones(beforeReverify).find((z) => z.zone_id === "Z-A");
  assert.deepEqual(zoneView(beforeReverify, za, "2027-03-10T10:00:00+08:00").open_minor_findings, ["F-A1"]);

  add(I, "FINDING_VERIFIED", "2027-03-12T10:00:00+08:00", "R2 施工后现场复查通过", {
    finding_id: "F-A1",
    verified_at: "2027-03-12",
    verifier: "消防检查员",
    verdict: "pass",
  });
  const after = project(events);
  const za2 = currentZones(after).find((z) => z.zone_id === "Z-A");
  assert.deepEqual(zoneView(after, za2, "2027-03-13T10:00:00+08:00").open_minor_findings, []);
});

test("不接受过期意见被重新引用", () => {
  const state = project(setupReadySite().events);
  // 决定日期晚于所有意见有效期
  const cmd = openingCommandA({ decided_at: "2028-03-01T10:00:00+08:00" });
  assert.match(checkOpeningDecision(state, cmd).join("；"), /现行有效/);

  // 事后稽核同样标出过期引用
  const decision = { ...cmd, decided_at: "2027-02-10T10:00:00+08:00" };
  const expired = state.opinions.map((o) => ({ ...o, valid_until: "2027-01-01" }));
  const staleState = { ...state, opinions: expired };
  assert.match(auditDecision(staleState, decision).join("；"), /过期/);
});

test("局部开放：严重缺陷禁止开放；一般缺陷须逐条写入限制条件并经签署", () => {
  const { events, add } = setupReadySite();
  add(I, "INSPECTION_RECORDED", "2027-02-08T10:00:00+08:00", "甲区严重消防缺陷", {
    revision_no: 1,
    finding_id: "F-MAJOR",
    zone_id: "Z-A",
    discipline: "fire",
    finding: "安全出口被封堵",
    severity: "major",
  });
  const blocked = project(events);
  assert.match(checkOpeningDecision(blocked, openingCommandA()).join("；"), /严重缺陷/);
});

test("全面开放时若仍有一般缺陷，只能转局部开放并附条件", () => {
  const { events, add } = setupReadySite();
  add(I, "INSPECTION_RECORDED", "2027-02-08T10:00:00+08:00", "甲区一般卫生缺陷", {
    revision_no: 1,
    finding_id: "F-MIN",
    zone_id: "Z-A",
    discipline: "health",
    finding: "洗手池标识缺失",
    severity: "minor",
  });
  const state = project(events);

  // 全面开放被拒
  const full = openingCommandA({ kind: "full" });
  assert.match(checkOpeningDecision(state, full).join("；"), /只能申请局部开放/);

  // 局部开放但限制条件未点名缺陷 -> 被拒
  assert.match(checkOpeningDecision(state, openingCommandA()).join("；"), /F-MIN/);

  // 点名缺陷与期限 -> 通过
  const ok = openingCommandA({
    conditions: ["备案容量 15 人", "缺陷 F-MIN 限于 2027-02-20 前整改并复验"],
  });
  assert.deepEqual(checkOpeningDecision(state, ok), []);
});

test("容量备案：禁止按整栋建筑面积折算，备案数必须可复算", () => {
  const state = project(setupReadySite().events);
  assert.match(
    checkCapacityFiled(state, {
      zone_id: "Z-A",
      area_m2: 420, // 整栋建筑面积
      per_child_m2: 3,
      filed_capacity: 140,
    }).join("；"),
    /整栋建筑面积/,
  );
  assert.match(
    checkCapacityFiled(state, { zone_id: "Z-A", area_m2: 45, per_child_m2: 3, filed_capacity: 20 }).join("；"),
    /应为 15/,
  );
});

test("招生页面只能发布当前获准分区折算后的备案容量", () => {
  const { events, add } = setupReadySite();
  add(O, "OPENING_DECIDED", "2027-02-10T10:00:00+08:00", "局部开放甲区", {
    ...openingCommandA(),
    kind: "partial",
  });
  const state = project(events);
  assert.deepEqual(allowedPublishedCapacity(state), {
    open_zones: ["Z-A"],
    zone_capacities: [{ zone_id: "Z-A", filed_capacity: 15 }],
    total: 15,
  });

  // 按整栋满额 140 人发布 -> 被拒
  assert.match(
    checkCapacityPublished(state, {
      published_at: "2027-02-11",
      page_ref: "https://example.org/p",
      zones_included: ["Z-A", "Z-B"],
      published_capacity: 140,
    }).join("；"),
    /获准开放分区不一致|备案容量合计/,
  );

  // 只发布获准分区、合计一致 -> 通过
  assert.deepEqual(
    checkCapacityPublished(state, {
      published_at: "2027-02-11",
      page_ref: "https://example.org/p",
      zones_included: ["Z-A"],
      published_capacity: 15,
    }),
    [],
  );

  // 无开放分区时不得发布
  const empty = project(setupReadySite().events);
  assert.match(checkCapacityPublished(empty, {
    published_at: "2027-02-11",
    page_ref: "p",
    zones_included: [],
    published_capacity: 0,
  }).join("；"), /不得公布容量/);
});

test("开园决定落事件后开放集合可随暂停/撤销重放", () => {
  const { events, add } = setupReadySite();
  add(O, "OPENING_DECIDED", "2027-02-10T10:00:00+08:00", "局部开放甲区", { ...openingCommandA() });
  let state = project(events);
  assert.deepEqual([...openZonesAt(state)], ["Z-A"]);

  assert.deepEqual(
    checkOpeningDecision(state, {
      kind: "suspend",
      decided_at: "2027-03-01T10:00:00+08:00",
      decision_ref: "OD-S1",
      signed_by: { name: "专班负责人" },
      basis_revision_no: 1,
      zones_requested: ["Z-A"],
      basis_refs: [],
      evidence_refs: ["EV-SUS.jpg"],
      conditions: ["隐患排查期间暂停"],
    }),
    [],
  );
  add(O, "OPENING_DECIDED", "2027-03-01T10:00:00+08:00", "暂停甲区收托", {
    kind: "suspend",
    decided_at: "2027-03-01",
    decision_ref: "OD-S1",
    signed_by: { name: "专班负责人" },
    basis_revision_no: 1,
    zones_requested: ["Z-A"],
    basis_refs: [],
    evidence_refs: ["EV-SUS.jpg"],
    conditions: ["隐患排查期间暂停"],
  });
  state = project(events);
  assert.deepEqual([...openZonesAt(state)], []);
  assert.equal(gates(state).opening.status, "not_allowed");
});

test("场地剩余不足一年：无退出方案不得继续收托；有方案则可", () => {
  const { events, add } = setupReadySite();
  add(P, "TERM_CHANGED", "2027-01-20T09:00:00+08:00", "产权单位提前收房", {
    term_end: "2027-06-30",
    reason: "另有用途",
  });
  const stateNoPlan = project(events);
  assert.match(checkOpeningDecision(stateNoPlan, openingCommandA()).join("；"), /退出方案/);

  add(O, "EXIT_PLAN_FORMED", "2027-01-25T10:00:00+08:00", "形成退出方案", {
    plan_ref: "EX-1",
    formed_at: "2027-01-25",
    target_exit_date: "2027-06-25",
    facilities: { responsible_party: "运营方", arrangement: "迁走" },
    deposit: { responsible_party: "产权方", arrangement: "退还" },
    child_placement: { responsible_party: "专班", children: 8, arrangement: "对口安置" },
    restoration: { responsible_party: "运营方", restore_to_use: "老旧仓库", arrangement: "复原" },
  });
  const stateWithPlan = project(events);
  assert.deepEqual(checkOpeningDecision(stateWithPlan, openingCommandA()), []);

  // 到期后禁止开园
  const expiredCmd = openingCommandA({ decided_at: "2027-07-01T10:00:00+08:00" });
  assert.match(checkOpeningDecision(stateWithPlan, expiredCmd).join("；"), /到期/);
});

test("退出方案：四要素与儿童安置责任人缺一不可，且恢复用途须与原用途一致", () => {
  const base = project(setupReadySite().events);
  const valid = {
    plan_ref: "EX-2",
    formed_at: "2030-06-01",
    target_exit_date: "2031-12-01",
    facilities: { responsible_party: "运营方", arrangement: "x" },
    deposit: { responsible_party: "产权方", arrangement: "x" },
    child_placement: { responsible_party: "专班", arrangement: "x" },
    restoration: { responsible_party: "运营方", restore_to_use: "老旧仓库", arrangement: "x" },
  };
  assert.deepEqual(checkExitPlan(base, valid), []);

  const noOwner = { ...valid, plan_ref: "EX-3", child_placement: { arrangement: "x" } };
  assert.match(checkExitPlan(base, noOwner).join("；"), /儿童安置必须明确责任主体/);

  const missingSection = { ...valid, plan_ref: "EX-4", deposit: null };
  assert.match(checkExitPlan(base, missingSection).join("；"), /押金清退/);

  const wrongUse = {
    ...valid,
    plan_ref: "EX-5",
    restoration: { responsible_party: "运营方", restore_to_use: "商业餐饮", arrangement: "x" },
  };
  assert.match(checkExitPlan(base, wrongUse).join("；"), /原用途/);

  const late = { ...valid, plan_ref: "EX-6", formed_at: "2031-06-01" };
  assert.match(checkExitPlan(base, late).join("；"), /提前 12 个月/);
});

test("场地交还：方案在先、儿童安置完成、恢复经确认且不逾期", () => {
  const { events, add } = setupReadySite();
  let state = project(events);
  assert.match(
    checkHandback(state, { handed_back_at: "2031-12-20", handover_ref: "HB-1", restoration_confirmed_by: "产权方", children_settled: true }).join("；"),
    /先形成退出方案/,
  );

  add(O, "EXIT_PLAN_FORMED", "2030-06-01T10:00:00+08:00", "退出方案", {
    plan_ref: "EX-9",
    formed_at: "2030-06-01",
    target_exit_date: "2031-12-01",
    facilities: { responsible_party: "运营方", arrangement: "x" },
    deposit: { responsible_party: "产权方", arrangement: "x" },
    child_placement: { responsible_party: "专班", arrangement: "x" },
    restoration: { responsible_party: "运营方", restore_to_use: "老旧仓库", arrangement: "x" },
  });
  state = project(events);
  assert.match(
    checkHandback(state, { handed_back_at: "2031-12-20", handover_ref: "HB-1", restoration_confirmed_by: null, children_settled: false }).join("；"),
    /恢复须经产权单位确认|未完成安置/,
  );
  assert.deepEqual(
    checkHandback(state, { handed_back_at: "2031-12-20", handover_ref: "HB-1", restoration_confirmed_by: "公房中心", children_settled: true }),
    [],
  );
});

test("共享时段必须落在现行邻里约定期限内", () => {
  const { events, add } = setupReadySite();
  add(P, "SHARING_SCHEDULE_RECORDED", "2027-02-09T16:00:00+08:00", "登记共享时段", {
    space: "院子",
    slots: [{ days: "工作日", hours: "08:00-09:00", user: "托育" }],
  });
  // 无邻里约定 -> 拒
  assert.match(checkOpeningDecision(project(events), openingCommandA()).join("；"), /邻里约定/);

  add(P, "NEIGHBOR_AGREEMENT_RECORDED", "2027-02-09T17:00:00+08:00", "补签邻里约定", {
    agreement_ref: "NB-1",
    parties: ["居委会", "运营方"],
    agreed_from: "2027-02-01",
    agreed_until: "2028-01-31",
  });
  assert.deepEqual(checkOpeningDecision(project(events), openingCommandA()), []);
});
