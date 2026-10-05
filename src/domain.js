// 老城区托育空间改造验收 —— 事件溯源领域模型
//
// 四个聚合流（沿用底座，不新增聚合类型）：
//   property_term      产权期限 / 原用途 / 邻里约定 / 共享时段 / 退出方案 / 交还恢复
//   design_revision    设计版次 / 设计通过 / 施工完成 / 材料检测 / 消防与卫生意见
//   inspection_finding 检查缺陷 / 派单 / 整改 / 分区验收
//   opening_decision   开园决定（全园或局部）
//
// 三条硬约束：
//   1. 设计通过(DESIGN_APPROVED)、施工完成(CONSTRUCTION_COMPLETED)、允许收托(OPENING_DECIDED)
//      是三个独立事件，任何两个都不能互相推导或合并。
//   2. 图纸修订按 affected_zone_ids 作废旧版次上受影响分区的全部检查结论，必须重做。
//   3. 备案容量只能按“当前获准开放、可计容量的分区室内面积”折算；整栋建筑面积仅登记不用。

export const AREA_PER_CHILD_M2 = 3; // 每名儿童最低人均面积
export const WEEKLY_EXCLUSIVE_HOURS = 50; // 周一至周五 08:00–18:00
export const EXIT_LEAD_DAYS = 180; // 提前半年形成退出方案
export const LONG_TERM_CLASS_ONE_YEAR = 365; // 剩余不足一年：一年期及以上长期班停招
export const LONG_TERM_CLASS_TWO_YEAR = 730; // 剩余不足两年：两年期及以上长期班停招

/** 按剩余使用天数生成长期班招生限制文案。 */
export function longTermClassNotice(remainingDays) {
  if (remainingDays < LONG_TERM_CLASS_ONE_YEAR) return "场地使用权剩余不足一年，停止招收一年期及以上长期班";
  if (remainingDays < LONG_TERM_CLASS_TWO_YEAR) return "场地使用权剩余不足两年，停止招收两年期及以上长期班，一年期班结业日不得晚于使用权到期日";
  return null;
}

export class DomainError extends Error {
  constructor(errors) {
    super(errors.join("；"));
    this.name = "DomainError";
    this.errors = errors;
  }
}

const todayOf = (clock) => clock().toISOString().slice(0, 10);
const daysBetween = (from, to) => Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);
const slug = (s) => s.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24) || "site";

const STREAM_CODE = {
  property_term: "PT",
  design_revision: "DR",
  inspection_finding: "IF",
  opening_decision: "OD",
};

// ---------- 事件回放 ----------

export function replay(siteId, events) {
  const state = freshState(siteId);
  const ordered = [...events].sort((a, b) => {
    const t = a.occurred_at.localeCompare(b.occurred_at);
    return t !== 0 ? t : a.version - b.version;
  });
  for (const event of ordered) applyEvent(state, event);
  return state;
}

function freshState(siteId) {
  return {
    siteId,
    property: null,
    neighborAgreements: [],
    sharedSlots: [],
    exitPlan: null,
    handback: null,
    revisions: [], // 按提交顺序
    revisionByNo: new Map(),
    currentRevisionNo: null,
    materials: [],
    opinions: [],
    findings: new Map(),
    acceptances: [],
    openings: [],
    counters: { seq: 0, versions: new Map() },
  };
}

function applyEvent(state, event) {
  const p = event.payload;
  switch (event.event_type) {
    case "PROPERTY_TERM_REGISTERED":
      state.property = { ...p, registeredAt: event.occurred_at };
      break;
    case "NEIGHBOR_AGREEMENT_RECORDED":
      state.neighborAgreements.push({ ...p, recordedAt: event.occurred_at });
      break;
    case "SHARED_SLOT_AGREED":
      state.sharedSlots.push({
        zoneId: p.zone_id,
        partner: p.partner,
        slots: p.slots,
        agreedAt: event.occurred_at,
      });
      break;
    case "EXIT_PLAN_FORMED":
      state.exitPlan = { ...p, formedAt: event.occurred_at };
      break;
    case "SITE_HANDED_BACK":
      state.handback = { ...p, at: event.occurred_at };
      break;
    case "DESIGN_SUBMITTED":
      applyDesignSubmitted(state, event);
      break;
    case "DESIGN_APPROVED": {
      const rev = state.revisionByNo.get(p.revision_no);
      rev.approved = { at: event.occurred_at, by: p.approved_by, conditions: p.conditions ?? [] };
      break;
    }
    case "CONSTRUCTION_COMPLETED": {
      const rev = state.revisionByNo.get(p.revision_no);
      rev.constructionCompletedAt = event.occurred_at;
      rev.completedNote = p.completed_note ?? "";
      break;
    }
    case "MATERIAL_TEST_RECORDED":
      state.materials.push({
        reportNo: p.report_no,
        revisionNo: p.revision_no,
        zoneId: p.zone_id,
        material: p.material,
        result: p.result,
        at: event.occurred_at,
        invalidated: false,
      });
      break;
    case "FIRE_OPINION_RECORDED":
    case "HEALTH_OPINION_RECORDED":
      state.opinions.push({
        opinionNo: p.opinion_no,
        kind: event.event_type === "FIRE_OPINION_RECORDED" ? "fire" : "health",
        revisionNo: p.revision_no,
        zoneIds: [...p.zone_ids],
        result: p.result,
        conditions: p.conditions ?? [],
        issuedOn: p.issued_on,
        validUntil: p.valid_until,
        at: event.occurred_at,
        invalidated: false,
        invalidatedZones: [],
      });
      break;
    case "INSPECTION_RECORDED":
      state.findings.set(p.finding_id, {
        findingId: p.finding_id,
        revisionNo: p.revision_no,
        zoneId: p.zone_id,
        category: p.category,
        severity: p.severity,
        description: p.description,
        status: "open",
        assignee: null,
        dueDate: null,
        rectifications: [],
        evidence: p.evidence ?? [],
        invalidated: false,
        at: event.occurred_at,
      });
      break;
    case "DEFECT_ASSIGNED": {
      const f = state.findings.get(p.finding_id);
      f.status = "assigned";
      f.assignee = p.assignee;
      f.dueDate = p.due_date;
      break;
    }
    case "DEFECT_RECTIFIED": {
      const f = state.findings.get(p.finding_id);
      f.status = "rectified";
      f.rectifications.push({ evidence: p.evidence, at: event.occurred_at });
      break;
    }
    case "ZONE_ACCEPTED":
      state.acceptances.push({
        revisionNo: p.revision_no,
        zoneId: p.zone_id,
        signers: p.signers,
        notes: p.notes ?? "",
        at: event.occurred_at,
        invalidated: false,
      });
      break;
    case "OPENING_DECIDED":
      state.openings.push({ ...p, at: event.occurred_at });
      break;
    default:
      throw new Error(`未知事件类型：${event.event_type}`);
  }
}

// 图纸修订：登记新版次，并把受影响分区上旧版次的检查结论全部作废。
function applyDesignSubmitted(state, event) {
  const p = event.payload;
  const rev = {
    revisionNo: p.revision_no,
    supersedes: p.supersedes ?? null,
    affectedZoneIds: [...p.affected_zone_ids],
    zones: new Map(p.zones.map((z) => [z.zone_id, z])),
    submittedAt: event.occurred_at,
    approved: null,
    constructionCompletedAt: null,
    supersededBy: null,
  };
  const previous = state.currentRevisionNo ? state.revisionByNo.get(state.currentRevisionNo) : null;
  if (previous) {
    previous.supersededBy = rev.revisionNo;
    const affected = new Set(rev.affectedZoneIds);
    for (const zoneId of affected) {
      for (const m of state.materials) {
        if (!m.invalidated && m.revisionNo === previous.revisionNo && m.zoneId === zoneId) {
          m.invalidated = true;
          m.invalidatedBy = rev.revisionNo;
        }
      }
      for (const o of state.opinions) {
        if (!o.invalidated && o.revisionNo === previous.revisionNo && o.zoneIds.includes(zoneId)) {
          o.invalidated = true;
          o.invalidatedZones = [...new Set([...o.invalidatedZones, zoneId])];
          o.invalidatedBy = rev.revisionNo;
        }
      }
      for (const f of state.findings.values()) {
        if (!f.invalidated && f.revisionNo === previous.revisionNo && f.zoneId === zoneId) {
          f.invalidated = true;
          f.invalidatedBy = rev.revisionNo;
        }
      }
      for (const a of state.acceptances) {
        if (!a.invalidated && a.revisionNo === previous.revisionNo && a.zoneId === zoneId) {
          a.invalidated = true;
          a.invalidatedBy = rev.revisionNo;
        }
      }
    }
  }
  state.revisions.push(rev);
  state.revisionByNo.set(rev.revisionNo, rev);
  state.currentRevisionNo = rev.revisionNo;
}

// ---------- 选择器（只读推导） ----------

const currentRevision = (state) =>
  state.currentRevisionNo ? state.revisionByNo.get(state.currentRevisionNo) : null;

const zoneExists = (state, zoneId) => !!currentRevision(state)?.zones.has(zoneId);

/** 分区从 fromRev 到 toRev 期间未被任何修订触及、且仍存在于新版图。 */
export function zoneCarried(state, zoneId, fromRev, toRev) {
  const start = state.revisions.findIndex((r) => r.revisionNo === fromRev);
  const end = state.revisions.findIndex((r) => r.revisionNo === toRev);
  if (start === -1 || end === -1 || start > end) return false;
  if (!state.revisionByNo.get(toRev).zones.has(zoneId)) return false;
  return state.revisions.slice(start + 1, end + 1).every((r) => !r.affectedZoneIds.includes(zoneId));
}

/** 该分区当前仍有效的缺陷。 */
export function effectiveFindings(state, zoneId) {
  return [...state.findings.values()].filter((f) => !f.invalidated && f.zoneId === zoneId && zoneExists(state, zoneId));
}

/** 阻断开放的缺陷：critical、major 未整改即阻断。 */
function seriousDefectOpen(state, zoneId) {
  return effectiveFindings(state, zoneId).filter((f) => f.severity !== "minor" && f.status !== "rectified");
}

/** 已整改但尚未经“验收记录”复验闭环的关键/重大缺陷。 */
function defectsPendingReverify(state, zoneId) {
  return effectiveFindings(state, zoneId).filter((f) => {
    if (f.severity === "minor" || f.status !== "rectified") return false;
    return !f.rectifications.some((r) => r.evidence.some((x) => x.kind === "验收记录"));
  });
}

function minorDefectOpen(state, zoneId) {
  return effectiveFindings(state, zoneId).filter((f) => f.severity === "minor" && f.status !== "rectified");
}

/** 每种材料以最新一次检测为准，任一材料最新结果 FAIL 即阻断。 */
export function failedMaterials(state, zoneId) {
  const latest = new Map();
  for (const m of state.materials) {
    if (m.invalidated || m.zoneId !== zoneId) continue;
    const key = m.material;
    if (!latest.has(key) || m.at > latest.get(key).at) latest.set(key, m);
  }
  return [...latest.values()].filter((m) => m.result === "FAIL");
}

/** 当前可援引的部门意见：该分区未随修订作废、在有效期内且结果非不合格。 */
export function effectiveOpinion(state, kind, zoneId, today) {
  return state.opinions
    .filter(
      (o) =>
        o.kind === kind &&
        o.zoneIds.includes(zoneId) &&
        !(o.invalidated && o.invalidatedZones.includes(zoneId)) &&
        o.result !== "不合格" &&
        o.issuedOn <= today &&
        today <= o.validUntil,
    )
    .sort((a, b) => b.at.localeCompare(a.at))[0];
}

/** 某份意见书在指定分区上是否仍可援引。 */
export function opinionValidForZone(opinion, zoneId, today) {
  return (
    opinion &&
    opinion.zoneIds.includes(zoneId) &&
    !(opinion.invalidated && opinion.invalidatedZones.includes(zoneId)) &&
    opinion.result !== "不合格" &&
    opinion.issuedOn <= today &&
    today <= opinion.validUntil
  );
}

/** 分区是否已在当前版次下完成分区验收（未受修订波及的旧验收继续有效）。 */
export function isZoneAccepted(state, zoneId, today) {
  const a = state.acceptances
    .filter((x) => !x.invalidated && x.zoneId === zoneId)
    .sort((a, b) => b.at.localeCompare(a.at))[0];
  if (!a) return false;
  if (!zoneCarried(state, zoneId, a.revisionNo, state.currentRevisionNo)) return false;
  // 验收后新出现的严重缺陷，或整改后尚未复验闭环的严重缺陷，都会使验收状态失效。
  if (seriousDefectOpen(state, zoneId).length > 0 || defectsPendingReverify(state, zoneId).length > 0) return false;
  if (failedMaterials(state, zoneId).length > 0) return false;
  if (!effectiveOpinion(state, "fire", zoneId, today) || !effectiveOpinion(state, "health", zoneId, today)) {
    return false;
  }
  return true;
}

function weeklyExclusiveHours(state, zoneId) {
  let hours = 0;
  for (const agreement of state.sharedSlots.filter((s) => s.zoneId === zoneId)) {
    for (const slot of agreement.slots) {
      if (!slot.exclusive_for_childcare) continue;
      const [fh, fm] = slot.from.split(":").map(Number);
      const [th, tm] = slot.to.split(":").map(Number);
      hours += (th * 60 + tm - (fh * 60 + fm)) / 60;
    }
  }
  return Math.min(hours, WEEKLY_EXCLUSIVE_HOURS);
}

/** 备案容量：只统计当前获准分区中 capacity_eligible 的室内面积，共享区域按专用时段折算。 */
export function capacityForZones(state, zoneIds) {
  const rev = currentRevision(state);
  if (!rev) return 0;
  let area = 0;
  for (const zoneId of zoneIds) {
    const zone = rev.zones.get(zoneId);
    if (!zone || !zone.capacity_eligible) continue;
    const shared = state.sharedSlots.some((s) => s.zoneId === zoneId);
    const factor = shared ? weeklyExclusiveHours(state, zoneId) / WEEKLY_EXCLUSIVE_HOURS : 1;
    area += zone.indoor_area_m2 * factor;
  }
  return Math.floor(area / AREA_PER_CHILD_M2);
}

/** 图纸修订后必须重做的检查清单（按受影响分区）。 */
export function checksRequiringRedo(state, revisionNo = state.currentRevisionNo) {
  const rev = state.revisionByNo.get(revisionNo);
  if (!rev) return [];
  return rev.affectedZoneIds.map((zoneId) => {
    const items = [];
    const materials = state.materials.filter((m) => m.invalidatedBy === revisionNo && m.zoneId === zoneId);
    if (materials.length) items.push({ type: "材料检测", reports: materials.map((m) => m.reportNo) });
    for (const o of state.opinions.filter((x) => x.invalidatedBy === revisionNo && x.invalidatedZones.includes(zoneId))) {
      items.push({ type: o.kind === "fire" ? "消防意见" : "卫生意见", opinion_no: o.opinionNo });
    }
    const findings = [...state.findings.values()].filter((f) => f.invalidatedBy === revisionNo && f.zoneId === zoneId);
    if (findings.length) items.push({ type: "缺陷复检", findings: findings.map((f) => f.findingId) });
    items.push({ type: "分区验收" });
    return { zone_id: zoneId, items };
  });
}

// ---------- 招生页面投影 ----------

export function enrollmentPage(state, today) {
  const closed = {
    publish: false,
    capacity_filed: 0,
    status: "暂不招生",
    zones_opened: [],
    restrictions: [],
    valid_until: null,
    notices: [],
    evidence: [],
  };
  if (!state.property || (state.handback && state.handback.restoration_verified)) {
    return { ...closed, status: state.handback ? "场地已交还，招生页停止公布容量" : "场地未登记，招生页不得公布容量" };
  }
  if (daysBetween(today, state.property.term_end) < 0) return { ...closed, status: "场地使用权已到期" };
  if (!state.currentRevisionNo) return { ...closed, status: "设计版次尚未提交" };

  const valid = [...state.openings]
    .reverse()
    .filter((d) => d.valid_from <= today && today <= d.valid_until)
    .find((d) => state.revisionByNo.has(d.revision_no));
  if (!valid) return { ...closed, status: "当前无在有效期内的开园决定" };

  // 依据的消防/卫生意见（可多份）在获准分区上仍可援引，否则决定失效，不得继续按旧容量招生。
  const fireNos = valid.based_on.fire_opinion_nos ?? [];
  const healthNos = valid.based_on.health_opinion_nos ?? [];
  const fires = state.opinions.filter((o) => fireNos.includes(o.opinionNo));
  const healths = state.opinions.filter((o) => healthNos.includes(o.opinionNo));
  const coveredBy = (opinions, zoneId, today) =>
    opinions.some((o) => opinionValidForZone(o, zoneId, today));
  const basisOkFor = (zones) =>
    fires.length === fireNos.length &&
    healths.length === healthNos.length &&
    zones.every((z) => coveredBy(fires, z, today) && coveredBy(healths, z, today));

  // 版次变化后，只有未被修订触及的获准分区可以继续开放。
  const zonesStillOpen = valid.zone_ids.filter(
    (zoneId) => zoneExists(state, zoneId) && zoneCarried(state, zoneId, valid.revision_no, state.currentRevisionNo),
  );
  const dropped = valid.zone_ids.filter((zoneId) => !zonesStillOpen.includes(zoneId));
  if (!basisOkFor(zonesStillOpen))
    return { ...closed, status: "开园依据的消防或卫生意见在获准分区上已失效（过期或因图纸修订作废），需重新出具并重作开园决定" };
  let capacity = valid.capacity_filed;
  let status = valid.mode === "FULL" ? "全园开放" : "局部开放";
  const notices = [];
  if (dropped.length) {
    capacity = capacityForZones(state, zonesStillOpen);
    status = "图纸修订后局部失效，仅公布仍获准分区折算容量";
    notices.push(`以下分区因图纸修订已暂停开放，须重做检查后另行决定：${dropped.join("、")}`);
  }
  if (zonesStillOpen.length === 0) return { ...closed, status: "原获准分区全部涉及图纸修订，需重新验收与开园决定" };

  const remaining = daysBetween(today, state.property.term_end);
  const longTermNotice = longTermClassNotice(remaining);
  if (longTermNotice) notices.push(longTermNotice);
  if (remaining <= EXIT_LEAD_DAYS && !state.exitPlan) notices.push("场地已进入退出筹备期，退出方案尚未形成");
  if (state.exitPlan) notices.push(`退出方案 ${state.exitPlan.plan_id} 已形成，撤点前将按方案安置在托儿童`);

  return {
    publish: true,
    capacity_filed: capacity,
    status,
    zones_opened: zonesStillOpen,
    restrictions: valid.restrictions,
    valid_until: valid.valid_until,
    notices,
    evidence: valid.evidence,
    decision_no: valid.decision_no,
  };
}

// ---------- 站点总览（每个维度一个清晰状态） ----------

function opinionStatus(state, kind, today) {
  const list = [...state.opinions].filter((x) => x.kind === kind).sort((a, b) => b.at.localeCompare(a.at));
  if (!list.length) return [{ 状态: "未取得" }];
  return list.map((o) => {
    const deadZones = o.invalidatedZones ?? [];
    const deadAll = o.invalidated && deadZones.length === o.zoneIds.length;
    let status;
    if (deadAll) status = "图纸修订后整体作废，需重新出具";
    else if (o.result === "不合格") status = "不合格";
    else if (today > o.validUntil || today < o.issuedOn) status = "已过期，不得作为开园依据";
    else if (deadZones.length) status = `部分分区随修订作废（${deadZones.join("、")} 须重新出具意见）`;
    else status = o.result === "合格" ? "有效" : "有效（有条件）";
    return {
      状态: status,
      意见书编号: o.opinionNo,
      对应版次: o.revisionNo,
      审查结果: o.result,
      条件: o.conditions,
      有效期: `${o.issuedOn} 至 ${o.validUntil}`,
      覆盖分区: o.zoneIds,
    };
  });
}

export function siteOverview(state, today = null) {
  today = today ?? new Date().toISOString().slice(0, 10);
  const rev = currentRevision(state);
  const zones = [];
  if (rev) {
    const page = enrollmentPage(state, today);
    for (const zone of rev.zones.values()) {
      const findings = effectiveFindings(state, zone.zone_id);
      const open = page.zones_opened?.includes(zone.zone_id);
      let acceptState = "未验收";
      if (state.acceptances.some((a) => a.invalidated && a.zoneId === zone.zone_id)) acceptState = "图纸修订后验收作废，需重新验收";
      else if (isZoneAccepted(state, zone.zone_id, today)) acceptState = "已验收";
      zones.push({
        分区: zone.zone_id,
        名称: zone.name,
        功能: zone.function,
        室内面积_m2: zone.indoor_area_m2,
        可计容量: zone.capacity_eligible,
        材料检测: failedMaterials(state, zone.zone_id).length
          ? "存在不合格材料"
          : state.materials.some((m) => !m.invalidated && m.zoneId === zone.zone_id)
            ? "合格"
            : "未检测",
        未闭环缺陷: findings
          .filter((f) => f.status !== "rectified")
          .map((f) => `${f.findingId}(${f.severity}/${f.status})`),
        分区验收: acceptState,
        开园状态: open
          ? isZoneAccepted(state, zone.zone_id, today)
            ? "开放"
            : "条件开放（未完成分区验收，按开园决定附加条件执行）"
          : "未开放",
      });
    }
  }

  let termStatus = "未登记";
  if (state.property) {
    const remaining = daysBetween(today, state.property.term_end);
    if (remaining < 0) termStatus = "使用权已到期";
    else if (state.handback) termStatus = "已交还";
    else if (remaining <= EXIT_LEAD_DAYS) termStatus = "临期（180 天内），退出方案必须就绪";
    else termStatus = "有效";
  }

  let exitStatus = "未进入退出筹备期";
  if (state.handback) exitStatus = state.handback.restoration_verified ? "已交还并验收恢复" : "已交还，恢复待验收";
  else if (state.exitPlan) exitStatus = `退出方案已形成（${state.exitPlan.plan_id}）`;
  else if (state.property && daysBetween(today, state.property.term_end) <= EXIT_LEAD_DAYS)
    exitStatus = "已临期但退出方案缺失（设施、押金、儿童安置、恢复责任不得无人负责）";

  const page = enrollmentPage(state, today);
  const activeDecision = page.publish ? state.openings.find((d) => d.decision_no === page.decision_no) : null;
  return {
    场地标识: state.siteId,
    产权期限: state.property
      ? {
          状态: termStatus,
          场地名称: state.property.site_name,
          原用途: state.property.original_use,
          产权单位: state.property.property_unit,
          整栋建筑面积_m2: state.property.area_total_m2,
          使用期限: `${state.property.term_start} 至 ${state.property.term_end}`,
          剩余天数: state.handback ? 0 : Math.max(0, daysBetween(today, state.property.term_end)),
        }
      : { 状态: termStatus },
    设计与施工: rev
      ? {
          当前版次: rev.revisionNo,
          上一版次: rev.supersedes,
          设计通过: rev.approved ? `已通过（${rev.approved.at.slice(0, 10)}，${rev.approved.by}）` : "未通过",
          施工完成: rev.constructionCompletedAt ? `已完成（${rev.constructionCompletedAt.slice(0, 10)}）` : "未完成",
          本次修订影响分区: rev.affectedZoneIds,
        }
      : { 状态: "尚无设计版次" },
    功能分区: zones,
    消防意见: opinionStatus(state, "fire", today),
    卫生意见: opinionStatus(state, "health", today),
    人员容量: page.publish && activeDecision
      ? {
          备案容量: page.capacity_filed,
          保育人员: activeDecision.staffing?.caregivers,
          配比上限: `1:${activeDecision.staffing?.ratio}`,
          人员可支持容量: (activeDecision.staffing?.caregivers ?? 0) * (activeDecision.staffing?.ratio ?? 0),
        }
      : { 备案容量: 0, 说明: "未获开园许可，不得对外公布容量" },
    共享时段: state.sharedSlots.map((s) => ({
      分区: s.zoneId,
      共享方: s.partner,
      每周专用小时: Math.min(WEEKLY_EXCLUSIVE_HOURS, weeklyExclusiveHours(state, s.zoneId)),
      时段: s.slots,
    })),
    邻里约定: state.neighborAgreements.length
      ? state.neighborAgreements.map((a) => ({
          编号: a.agreement_id,
          状态: today >= a.valid_from && today <= a.valid_until ? "有效" : "已过期或未生效",
          签约方: a.parties,
          约定: a.terms,
        }))
      : [{ 状态: "未登记" }],
    缺陷整改: [...state.findings.values()].map((f) => {
      if (f.invalidated) return { 缺陷: f.findingId, 分区: f.zoneId, 状态: `图纸 ${f.invalidatedBy} 修订后作废，需重新检查` };
      const needReverify = f.severity !== "minor" && f.status === "rectified";
      const reverified = f.rectifications.some((r) => r.evidence.some((e) => e.kind === "验收记录"));
      return {
        缺陷: f.findingId,
        分区: f.zoneId,
        类别: f.category,
        等级: f.severity,
        状态: f.status === "open" ? "待整改" : f.status === "assigned" ? `整改中（${f.assignee}，限期 ${f.dueDate}）` : reverified || !needReverify ? "已整改闭环" : "已整改待复验",
      };
    }),
    开园限制: page.publish
      ? {
          决定编号: page.decision_no,
          开放性质: page.status,
          开放分区: page.zones_opened,
          备案容量: page.capacity_filed,
          限制条件: page.restrictions,
          有效期至: page.valid_until,
        }
      : { 状态: page.status },
    退出恢复: { 状态: exitStatus, 方案: state.exitPlan, 交还记录: state.handback },
  };
}

// ---------- 命令式登记入口（追加事件前执行全部业务规则） ----------

export class SiteFile {
  constructor(siteId, { events = [], now } = {}) {
    this.siteId = siteId;
    this.clock = typeof now === "function" ? now : () => now ?? new Date();
    this.events = [];
    this.state = freshState(siteId);
    for (const event of [...events].sort((a, b) => a.occurred_at.localeCompare(b.occurred_at))) this.#ingest(event);
  }

  #ingest(event) {
    applyEvent(this.state, event);
    this.events.push(event);
    const seq = (this.state.counters.versions.get(event.aggregate_type) ?? 0) + 1;
    this.state.counters.versions.set(event.aggregate_type, seq);
    this.state.counters.seq += 1;
    return event;
  }

  #append(type, aggregateType, payload, summary) {
    const version = (this.state.counters.versions.get(aggregateType) ?? 0) + 1;
    const seq = this.state.counters.seq + 1;
    const event = {
      event_id: `evt-${slug(this.siteId)}-${String(seq).padStart(4, "0")}`,
      event_type: type,
      aggregate_type: aggregateType,
      aggregate_id: this.siteId,
      occurred_at: this.clock().toISOString(),
      version,
      summary,
      payload,
    };
    return this.#ingest(event);
  }

  #fail(errors) {
    if (errors.length) throw new DomainError([...new Set(errors)]);
  }

  #requireProperty(errors) {
    if (!this.state.property) errors.push("必须先登记产权期限与原用途（PROPERTY_TERM_REGISTERED）");
    else if (this.state.handback) errors.push("场地已交还，不能再办理新的验收或开园事项");
  }

  #requireCurrentRevision() {
    const rev = currentRevision(this.state);
    if (!rev) throw new DomainError(["必须先提交设计版次（DESIGN_SUBMITTED）"]);
    return rev;
  }

  registerProperty(p) {
    const e = [];
    if (this.state.property) e.push("产权信息已登记，不得重复登记");
    for (const k of ["site_name", "original_use", "property_unit", "term_start", "term_end"])
      if (!p?.[k]) e.push(`缺少字段：${k}`);
    if (!(Number(p?.area_total_m2) > 0)) e.push("整栋建筑面积必须为正数（仅登记，不用于容量折算）");
    if (p?.term_start && p?.term_end && p.term_end <= p.term_start) e.push("使用期限截止日必须晚于起始日");
    this.#fail(e);
    return this.#append("PROPERTY_TERM_REGISTERED", "property_term", p, `登记场地产权期限与原用途：${p.original_use}`);
  }

  recordNeighborAgreement(p) {
    const e = [];
    this.#requireProperty(e);
    for (const k of ["agreement_id", "parties", "terms", "valid_from", "valid_until"]) if (!p?.[k] || (Array.isArray(p[k]) && !p[k].length)) e.push(`缺少字段：${k}`);
    if (p?.valid_until && p?.valid_from && p.valid_until <= p.valid_from) e.push("邻里约定有效期不合法");
    this.#fail(e);
    return this.#append("NEIGHBOR_AGREEMENT_RECORDED", "property_term", p, `登记邻里约定 ${p.agreement_id}`);
  }

  agreeSharedSlot(p) {
    const e = [];
    this.#requireProperty(e);
    if (!p?.zone_id || !zoneExists(this.state, p.zone_id)) e.push("共享时段必须挂到设计图纸中的分区");
    if (!p?.partner) e.push("缺少共享方");
    if (!Array.isArray(p?.slots) || !p.slots.length) e.push("至少约定一个共享时段");
    p?.slots?.forEach((s) => {
      if (s.to <= s.from) e.push(`时段 ${s.weekday} ${s.from}-${s.to} 结束时间必须晚于开始时间`);
    });
    this.#fail(e);
    return this.#append("SHARED_SLOT_AGREED", "property_term", p, `登记分区 ${p.zone_id} 与${p.partner}的共享时段`);
  }

  submitDesign(p) {
    const e = [];
    this.#requireProperty(e);
    const rev = currentRevision(this.state);
    if (!/^R[0-9]+$/.test(p?.revision_no ?? "")) e.push("revision_no 形如 R1、R2");
    if (this.state.revisionByNo.has(p?.revision_no)) e.push(`版次 ${p.revision_no} 已存在`);
    if (!Array.isArray(p?.zones) || p.zones.length === 0) e.push("图纸必须包含至少一个功能分区");
    const ids = new Set();
    p?.zones?.forEach((z) => {
      if (ids.has(z.zone_id)) e.push(`分区编号重复：${z.zone_id}`);
      ids.add(z.zone_id);
      if (!(Number(z.indoor_area_m2) >= 0)) e.push(`分区 ${z.zone_id} 面积不合法`);
    });
    const affected = p?.affected_zone_ids ?? [];
    if (!rev && affected.length) e.push("首个版次不存在“受影响分区”，affected_zone_ids 必须为空");
    if (rev) {
      if (p.supersedes && p.supersedes !== rev.revisionNo) e.push(`supersedes 必须指向当前版次 ${rev.revisionNo}`);
      for (const zoneId of affected) {
        if (!rev.zones.has(zoneId)) e.push(`受影响分区 ${zoneId} 不存在于 ${rev.revisionNo} 图纸中`);
        if (!ids.has(zoneId)) e.push(`受影响分区 ${zoneId} 必须出现在新版图纸中（删除分区无需列入 affected）`);
      }
      if (rev.approved && !rev.constructionCompletedAt && affected.length)
        e.push("提示：新版次在施工尚未完成时提交，旧版次审批结论不再沿用到受影响分区");
    }
    this.#fail(e);
    return this.#append("DESIGN_SUBMITTED", "design_revision", { ...p, supersedes: p.supersedes ?? rev?.revisionNo ?? null, affected_zone_ids: affected }, `提交设计图纸 ${p.revision_no}，受影响分区 ${affected.join("、") || "无"}`);
  }

  approveDesign(p) {
    const e = [];
    this.#requireProperty(e);
    const rev = this.state.revisionByNo.get(p?.revision_no);
    if (!rev) e.push(`版次 ${p?.revision_no} 不存在`);
    else if (rev.revisionNo !== this.state.currentRevisionNo) e.push(`版次 ${rev.revisionNo} 已被 ${rev.supersededBy} 取代，不能补审批`);
    else if (rev.approved) e.push(`版次 ${rev.revisionNo} 已通过设计审批，不能重复审批`);
    if (!p?.approved_by) e.push("缺少审批单位 approved_by");
    this.#fail(e);
    return this.#append("DESIGN_APPROVED", "design_revision", { conditions: [], ...p }, `设计通过：${p.revision_no}（不等同施工完成或允许收托）`);
  }

  completeConstruction(p) {
    const e = [];
    this.#requireProperty(e);
    const rev = this.state.revisionByNo.get(p?.revision_no);
    if (!rev) e.push(`版次 ${p?.revision_no} 不存在`);
    else {
      if (rev.revisionNo !== this.state.currentRevisionNo) e.push(`版次 ${rev.revisionNo} 已被取代，不能补报施工完成`);
      if (!rev.approved) e.push("设计尚未通过审批，施工完成事件不能成立（设计通过是独立前置闸门）");
      if (rev.constructionCompletedAt) e.push(`版次 ${rev.revisionNo} 已报施工完成`);
    }
    this.#fail(e);
    return this.#append("CONSTRUCTION_COMPLETED", "design_revision", p, `施工完成：${p.revision_no}（不等同允许收托）`);
  }

  #checkOpinion(kind, p) {
    const e = [];
    this.#requireProperty(e);
    const rev = this.state.revisionByNo.get(p?.revision_no);
    if (!rev) e.push(`版次 ${p?.revision_no} 不存在`);
    else if (rev.revisionNo !== this.state.currentRevisionNo) e.push("意见书必须针对当前版次出具，旧版次意见先按修订影响作废重出");
    if (this.state.opinions.some((o) => o.opinionNo === p?.opinion_no)) e.push(`意见书编号重复：${p?.opinion_no}`);
    for (const z of p?.zone_ids ?? []) if (!rev?.zones.has(z)) e.push(`意见书覆盖分区 ${z} 不在图纸中`);
    if (p?.valid_until && p?.issued_on && p.valid_until <= p.issued_on) e.push("意见书有效期不合法");
    return e;
  }

  recordFireOpinion(p) {
    const e = this.#checkOpinion("fire", p);
    this.#fail(e);
    return this.#append("FIRE_OPINION_RECORDED", "design_revision", { conditions: [], ...p }, `登记消防意见 ${p.opinion_no}：${p.result}`);
  }

  recordHealthOpinion(p) {
    const e = this.#checkOpinion("health", p);
    this.#fail(e);
    return this.#append("HEALTH_OPINION_RECORDED", "design_revision", { conditions: [], ...p }, `登记卫生评价意见 ${p.opinion_no}：${p.result}`);
  }

  recordMaterialTest(p) {
    const e = [];
    this.#requireProperty(e);
    const rev = this.state.revisionByNo.get(p?.revision_no);
    if (!rev) e.push(`版次 ${p?.revision_no} 不存在`);
    else if (rev.revisionNo !== this.state.currentRevisionNo) e.push("检测报告必须针对当前版次；受修订影响分区须重新送检");
    if (p?.zone_id && !rev?.zones.has(p.zone_id)) e.push(`检测分区 ${p.zone_id} 不在图纸中`);
    if (this.state.materials.some((m) => m.reportNo === p?.report_no)) e.push(`检测报告编号重复：${p?.report_no}`);
    if (p?.result !== "PASS" && p?.result !== "FAIL") e.push("检测结果只能为 PASS 或 FAIL");
    this.#fail(e);
    return this.#append("MATERIAL_TEST_RECORDED", "design_revision", p, `登记${p.zone_id}${p.material}检测 ${p.report_no}：${p.result === "PASS" ? "合格" : "不合格"}`);
  }

  recordInspection(p) {
    const e = [];
    this.#requireProperty(e);
    const rev = this.state.revisionByNo.get(p?.revision_no);
    if (!rev) e.push(`版次 ${p?.revision_no} 不存在`);
    else if (rev.revisionNo !== this.state.currentRevisionNo) e.push("检查必须针对当前版次记录，旧版次分区请在新图纸上重新检查");
    if (p?.zone_id && !rev?.zones.has(p.zone_id)) e.push(`缺陷分区 ${p.zone_id} 不在图纸中`);
    if (this.state.findings.has(p?.finding_id)) e.push(`缺陷编号重复：${p?.finding_id}`);
    this.#fail(e);
    return this.#append("INSPECTION_RECORDED", "inspection_finding", p, `记录检查缺陷 ${p.finding_id}（${p.zone_id}/${p.severity}）`);
  }

  assignDefect(p) {
    const e = [];
    const f = this.state.findings.get(p?.finding_id);
    if (!f) e.push(`缺陷 ${p?.finding_id} 不存在`);
    else if (f.invalidated) e.push(`缺陷 ${f.findingId} 已随图纸修订作废，须重新检查立项`);
    if (!p?.assignee) e.push("缺少整改责任人");
    if (!p?.due_date) e.push("缺少整改期限");
    this.#fail(e);
    return this.#append("DEFECT_ASSIGNED", "inspection_finding", p, `缺陷 ${p.finding_id} 派单给${p.assignee}，限期 ${p.due_date}`);
  }

  rectifyDefect(p) {
    const e = [];
    const f = this.state.findings.get(p?.finding_id);
    if (!f) e.push(`缺陷 ${p?.finding_id} 不存在`);
    else {
      if (f.invalidated) e.push(`缺陷 ${f.findingId} 已随图纸修订作废，整改事件不予受理`);
      if (f.status === "rectified" && !(p.evidence ?? []).some((x) => x.kind === "验收记录"))
        e.push(`缺陷 ${f.findingId} 已整改；复验只能补录含“验收记录”的证据`);
    }
    if (!Array.isArray(p?.evidence) || p.evidence.length < 1) e.push("整改必须留存至少一份可追溯现场证据");
    this.#fail(e);
    const isReverify = f.status === "rectified";
    return this.#append(
      "DEFECT_RECTIFIED",
      "inspection_finding",
      p,
      isReverify ? `缺陷 ${p.finding_id} 复验通过，验收记录 ${p.evidence.map((x) => x.ref).join("、")}` : `缺陷 ${p.finding_id} 整改完成，证据 ${p.evidence.map((x) => x.ref).join("、")}`,
    );
  }

  acceptZone(p) {
    const e = [];
    this.#requireProperty(e);
    const today = todayOf(this.clock);
    const rev = this.state.revisionByNo.get(p?.revision_no);
    if (!rev) e.push(`版次 ${p?.revision_no} 不存在`);
    else if (rev.revisionNo !== this.state.currentRevisionNo) e.push("分区验收必须针对当前版次");
    const zone = rev?.zones.get(p?.zone_id);
    if (rev && !zone) e.push(`分区 ${p?.zone_id} 不在 ${rev.revisionNo} 图纸中`);
    if (rev && zone) {
      if (!rev.approved) e.push("设计未通过，不能组织分区验收");
      if (!rev.constructionCompletedAt) e.push("施工未完成，不能组织分区验收（施工完成是独立闸门）");
      if (failedMaterials(this.state, p.zone_id).length) e.push(`分区 ${p.zone_id} 存在不合格材料检测，须复检合格后验收`);
      if (!effectiveOpinion(this.state, "fire", p.zone_id, today)) e.push(`分区 ${p.zone_id} 缺少有效消防意见（过期或版次不符均不受理）`);
      if (!effectiveOpinion(this.state, "health", p.zone_id, today)) e.push(`分区 ${p.zone_id} 缺少有效卫生意见（过期或版次不符均不受理）`);
      const serious = seriousDefectOpen(this.state, p.zone_id);
      if (serious.length) e.push(`分区 ${p.zone_id} 的 critical/major 缺陷未整改（${serious.map((f) => f.findingId).join("、")}）`);
      const pending = defectsPendingReverify(this.state, p.zone_id);
      if (pending.length) e.push(`分区 ${p.zone_id} 已整改的关键/重大缺陷（${pending.map((f) => f.findingId).join("、")}）尚缺“验收记录”复验，不能完成分区验收`);
      const minors = minorDefectOpen(this.state, p.zone_id);
      if (minors.length) e.push(`分区 ${p.zone_id} 尚有 minor 缺陷未整改（${minors.map((f) => f.findingId).join("、")}）`);
    }
    const roles = new Set((p?.signers ?? []).map((s) => s.role));
    if ((p?.signers ?? []).length < 2 || roles.size < 2) e.push("分区验收须至少两方责任人签署");
    this.#fail(e);
    return this.#append("ZONE_ACCEPTED", "inspection_finding", p, `分区验收通过：${p.zone_id}（${p.revision_no}）`);
  }

  decideOpening(p) {
    const s = this.state;
    const e = [];
    this.#requireProperty(e);
    const today = todayOf(this.clock);
    const rev = currentRevision(s);
    if (!rev) e.push("尚未提交任何设计版次");
    else {
      if (p?.revision_no !== rev.revisionNo) e.push(`开园决定必须基于当前版次 ${rev.revisionNo}，不能引用 ${p?.revision_no}`);
      if (!rev.approved) e.push("设计未通过审批，不允许收托");
      if (!rev.constructionCompletedAt) e.push("施工未完成，不允许收托（设计通过、施工完成、允许收托是三道独立闸门）");
    }
    if (s.openings.some((d) => d.decision_no === p?.decision_no)) e.push(`开园决定编号重复：${p?.decision_no}`);

    const zoneIds = p?.zone_ids ?? [];
    const excluded = p?.excluded_zone_ids ?? [];
    const allZones = rev ? [...rev.zones.keys()] : [];
    if (new Set(zoneIds).size !== zoneIds.length) e.push("开放分区重复列出");
    if (zoneIds.some((z) => !allZones.includes(z))) e.push("开放分区存在图纸外编号");
    if (excluded.some((z) => !allZones.includes(z))) e.push("排除分区存在图纸外编号");
    if (zoneIds.some((z) => excluded.includes(z))) e.push("同一分区不能既开放又排除");

    if (p?.mode === "FULL") {
      if (excluded.length) e.push("全园开放不得设置排除分区");
      if (zoneIds.length !== allZones.length) e.push("全园开放必须覆盖图纸全部部分分区");
    } else if (p?.mode === "PARTIAL") {
      if (![...zoneIds, ...excluded].sort().join("|") || [...new Set([...zoneIds, ...excluded])].length !== allZones.length)
        e.push("局部开放必须逐一列明开放分区与排除分区，覆盖图纸全部部分分区");
      if (!p.isolation_measures) e.push("局部开放必须说明对缺陷/未开放区域的物理隔离措施");
    } else e.push("开放模式必须为 FULL 或 PARTIAL");

    // 分区级条件：已验收可开放；未验收分区只有在无硬阻断、带明确条件、签署齐全时才可局部开放。
    for (const zoneId of zoneIds) {
      const accepted = isZoneAccepted(s, zoneId, today);
      if (!accepted) {
        if (p?.mode !== "PARTIAL") e.push(`分区 ${zoneId} 未通过分区验收，只能在局部开放决定中列明`);
        if (seriousDefectOpen(s, zoneId).length) e.push(`分区 ${zoneId} 存在未闭环的 critical/major 缺陷，必须排除不得开放`);
        if (failedMaterials(s, zoneId).length) e.push(`分区 ${zoneId} 存在不合格材料，必须排除不得开放`);
        if (!p?.conditions?.length) e.push(`分区 ${zoneId} 未验收即开放，必须给出明确开放条件 conditions`);
      }
      const minor = minorDefectOpen(s, zoneId);
      const pending = defectsPendingReverify(s, zoneId);
      if ((minor.length || pending.length) && !p?.conditions?.length)
        e.push(`分区 ${zoneId} 存在未闭环事项（${[...minor, ...pending].map((f) => f.findingId).join("、")}），局部开放条件必须逐项列明`);
    }

    // 依据文件：存在、覆盖全部开放分区、在对应分区上未作废且在有效期内 —— 过期意见一律拒绝引用。
    const fireNos = p?.based_on?.fire_opinion_nos ?? [];
    const healthNos = p?.based_on?.health_opinion_nos ?? [];
    const checkOpinions = (nos, kind, label) => {
      if (!nos.length) return e.push(`缺少${label}意见书引用 ${kind}_opinion_nos`);
      for (const no of nos) {
        const o = s.opinions.find((x) => x.opinionNo === no);
        if (!o) { e.push(`未找到${label}意见书 ${no}`); continue; }
        if (o.kind !== kind) { e.push(`${label}意见书编号 ${no} 引用了错误种类的文件`); continue; }
        if (o.result === "不合格") e.push(`${label}意见书 ${no} 结论为不合格，不允许开园`);
        for (const z of zoneIds) {
          if (o.zoneIds.includes(z) && (o.invalidated && o.invalidatedZones.includes(z)))
            e.push(`${label}意见书 ${no} 对分区 ${z} 已随图纸修订作废，必须重新出具后引用`);
          if (o.zoneIds.includes(z) && (today > o.validUntil || today < o.issuedOn))
            e.push(`${label}意见书 ${no} 不在有效期内（${o.issuedOn} 至 ${o.validUntil}），过期意见不得重新引用`);
        }
        for (const c of o.conditions) if (!(p?.restrictions ?? []).some((r) => r.includes(c))) e.push(`${label}意见书 ${no} 附带条件“${c}”必须写入开园限制条件`);
        if (p?.valid_until && p.valid_until > o.validUntil) e.push(`开园有效期不得超过${label}意见书 ${no} 的有效期 ${o.validUntil}`);
      }
      for (const z of zoneIds) {
        const covers = s.opinions.some(
          (o) => nos.includes(o.opinionNo) && o.kind === kind && opinionValidForZone(o, z, today),
        );
        if (!covers) e.push(`开放分区 ${z} 缺少一份在有效期内、覆盖该分区且未作废的${label}意见书`);
      }
    };
    if (rev) {
      checkOpinions(fireNos, "fire", "消防");
      checkOpinions(healthNos, "health", "卫生");
    }

    // 材料依据：逐区可追溯，不合格不得开放。
    const citedReports = p?.based_on?.material_report_nos ?? [];
    for (const no of citedReports) {
      const m = s.materials.find((x) => x.reportNo === no);
      if (!m) e.push(`检测报告 ${no} 不存在`);
      else if (m.invalidated) e.push(`检测报告 ${no} 已随图纸修订作废，须重新送检`);
      else if (m.result !== "PASS") e.push(`检测报告 ${no} 结论不合格，不能作为开园依据`);
    }
    for (const zoneId of zoneIds) {
      if (failedMaterials(s, zoneId).length) e.push(`分区 ${zoneId} 存在最新结论不合格的材料`);
      const reports = s.materials.filter((m) => !m.invalidated && m.zoneId === zoneId && m.result === "PASS");
      if (!reports.some((m) => citedReports.includes(m.reportNo))) e.push(`分区 ${zoneId} 缺少可追溯的合格材料检测报告编号`);
    }

    // 容量：必须等于按当前获准分区折算的备案容量，禁止按整栋建筑面积填报。
    const expectedCapacity = rev ? capacityForZones(s, zoneIds) : 0;
    if (p?.capacity_filed !== expectedCapacity)
      e.push(`备案容量填报 ${p?.capacity_filed}，按当前获准分区折算应为 ${expectedCapacity}；整栋建筑面积不得用于折算`);
    if (p?.capacity_filed > 0) {
      const need = Math.ceil(p.capacity_filed / (p.staffing?.ratio ?? Infinity));
      if (!p.staffing || (p.staffing.caregivers ?? 0) < need)
        e.push(`备案容量 ${p.capacity_filed}、配比 1:${p.staffing?.ratio ?? "?"} 至少需要 ${need === Infinity ? "?" : need} 名保育人员`);
    }

    // 证据、限制、签署、期限。
    if (!Array.isArray(p?.evidence) || p.evidence.length < 1) e.push("开园决定必须附可追溯的现场证据（照片/视频/验收记录）");
    p?.evidence?.forEach((x) => {
      if (!x?.ref || !x?.captured_at) e.push("每份现场证据须含档案编号 ref 与采集时间 captured_at");
    });
    if (!Array.isArray(p?.restrictions) || p.restrictions.length < 1) e.push("开园决定必须列明限制条件");
    const signerRoles = new Set((p?.signers ?? []).map((x) => x.role));
    if ((p?.signers ?? []).length < 2 || signerRoles.size < 2) e.push("开园决定须至少两方责任人签署");
    if (!p?.valid_from || !p?.valid_until || p.valid_from > p.valid_until) e.push("开园有效期不合法");
    if (p?.valid_from && p.valid_from < today) e.push("开园生效日不得早于决定日");
    if (s.property && p?.valid_until && p.valid_until > s.property.term_end)
      e.push(`开园有效期不得超过场地使用权期限 ${s.property.term_end}`);
    const remaining = s.property ? daysBetween(today, s.property.term_end) : Infinity;
    const longTermNotice = Number.isFinite(remaining) ? longTermClassNotice(remaining) : null;
    if (longTermNotice && !(p?.restrictions ?? []).some((r) => r.includes("长期班")))
      e.push(`限制条件必须明确：${longTermNotice}`);

    this.#fail(e);
    return this.#append("OPENING_DECIDED", "opening_decision", p, `作出${p.mode === "FULL" ? "全园" : "局部"}开园决定 ${p.decision_no}，备案容量 ${p.capacity_filed} 人`);
  }

  formExitPlan(p) {
    const e = [];
    if (!this.state.property) e.push("场地未登记");
    if (this.state.handback) e.push("场地已交还");
    for (const k of ["plan_id", "facilities", "deposit", "child_placement", "restoration", "target_handback_date"])
      if (!p?.[k]) e.push(`退出方案字段 ${k} 必须明确责任安排，不得空缺`);
    const fieldNames = { facilities: "设施处置", deposit: "押金结算", child_placement: "儿童安置", restoration: "恢复责任" };
    for (const k of ["facilities", "deposit", "child_placement", "restoration"])
      if (typeof p?.[k] === "string" && p[k].trim().length < 5) e.push(`退出方案的${fieldNames[k]}（${k}）必须写明具体责任安排（不少于 5 个字）`);
    if (p?.target_handback_date && this.state.property && p.target_handback_date > this.state.property.term_end)
      e.push(`交还日期不得晚于使用权到期日 ${this.state.property.term_end}`);
    const roles = new Set((p?.signers ?? []).map((x) => x.role));
    if ((p?.signers ?? []).length < 3 || roles.size < 3) e.push("退出方案须产权单位、托育机构、街道（主管部门）三方签署");
    if (![...roles].some((r) => r.includes("产权"))) e.push("退出方案缺少产权单位签署");
    if (![...roles].some((r) => r.includes("托育"))) e.push("退出方案缺少托育机构签署");
    this.#fail(e);
    return this.#append("EXIT_PLAN_FORMED", "property_term", p, `形成到期退出方案 ${p.plan_id}：设施、押金、儿童安置、恢复责任逐项落实`);
  }

  handBack(p) {
    const e = [];
    if (!this.state.exitPlan) e.push("未形成退出方案不得交还场地（儿童安置与恢复责任不得悬空）");
    if (!p?.handback_date) e.push("缺少交还日期");
    if (p?.restoration_verified !== true) e.push("场地恢复须验收合格后才能登记交还");
    this.#fail(e);
    return this.#append("SITE_HANDED_BACK", "property_term", p, `场地交还产权单位，恢复责任已验收：${p.handback_date}`);
  }
}
