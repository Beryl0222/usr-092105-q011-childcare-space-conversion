/**
 * 事件投影：把四聚合一连串事实归约为托育点当前状态。
 * 投影只读事件、不产生新事实；所有"能不能"的判断以纯函数给出并注明依据事件。
 */
import {
  DEFECT_SEVERITIES,
  FINDING_STATUS,
  OPENING_KINDS,
  REVISION_SCOPES,
} from "./events.js";
import {
  REQUIRED_DISCIPLINES,
  REVISION_IMPACT,
  deriveCapacity,
  isOpinionUsable,
  reworkDueToRevision,
  termStatus,
} from "./policy.js";

function indexBy(list, keyFn) {
  return new Map(list.map((item) => [keyFn(item), item]));
}

/** 读取事件流并投影。asOf 用于按日期复算（默认取流中最后时间）。 */
export function project(events, asOf) {
  const state = {
    site: {
      site_id: null,
      owner: null,
      original_use: null,
      original_use_evidence: null,
      term_start: null,
      term_end: null,
      term_changes: [],
      sharing: [],
      neighbor_agreements: [],
    },
    revisions: [], // 按 revision_no 升序
    zones: [], // 当前视图：{zone_id,name,purpose,area_m2,revision_no}
    opinions: [], // 专业意见与材料检测统一登记，kind 区分
    findings: [],
    acceptances: [],
    capacities: [],
    openings: [],
    publications: [],
    exit_plans: [],
    handback: null,
    refs: new Map(), // 可被引用的文书编号 -> 摘要，防止引用不存在或过期文书
  };

  for (const event of [...events].sort((a, b) =>
    a.occurred_at < b.occurred_at ? -1 : a.occurred_at > b.occurred_at ? 1 : a.version - b.version,
  )) {
    apply(state, event);
  }

  state.as_of = asOf ?? (events.at(-1)?.occurred_at ?? new Date().toISOString());
  return state;
}

function registerRef(state, ref, summary) {
  if (ref) state.refs.set(ref, summary);
}

function apply(state, event) {
  const p = event.payload ?? {};
  switch (event.event_type) {
    case "TERM_REGISTERED":
      Object.assign(state.site, {
        site_id: p.site_id,
        owner: p.owner,
        original_use: p.original_use,
        term_start: p.term_start,
        term_end: p.term_end,
      });
      break;
    case "TERM_CHANGED":
      state.site.term_end = p.term_end;
      state.site.term_changes.push({ term_end: p.term_end, reason: p.reason, at: event.occurred_at });
      break;
    case "ORIGINAL_USE_RECORDED":
      state.site.original_use = p.original_use;
      state.site.original_use_evidence = p.evidence_ref;
      break;
    case "NEIGHBOR_AGREEMENT_RECORDED":
      state.site.neighbor_agreements.push({ ...p, recorded_at: event.occurred_at });
      registerRef(state, p.agreement_ref, "邻里约定");
      break;
    case "SHARING_SCHEDULE_RECORDED":
      state.site.sharing.push({ ...p, recorded_at: event.occurred_at });
      break;

    case "DESIGN_SUBMITTED": {
      const rev = revision(state, p.revision_no);
      rev.submitted_at = p.submitted_at;
      break;
    }
    case "DESIGN_APPROVED": {
      const rev = revision(state, p.revision_no);
      Object.assign(rev, {
        approved_at: p.approved_at,
        approving_authority: p.approving_authority,
        supersedes_revision_no: p.supersedes_revision_no,
        affected_scopes: p.affected_scopes,
        affected_zones: p.affected_zones ?? [],
      });
      // 图纸一旦修订批准，立即算出必须重做的检查清单
      if (p.supersedes_revision_no >= 1) {
        rev.rework_required = reworkDueToRevision(p, {
          zones: (p.affected_zones ?? []).length
            ? p.affected_zones
            : zonesOf(state, p.supersedes_revision_no).map((z) => z.zone_id),
          opinions: state.opinions.filter((o) => o.kind === "opinion"),
          materials: state.opinions.filter((o) => o.kind === "material"),
          findings: state.findings,
          acceptances: state.acceptances,
        });
      } else {
        rev.rework_required = [];
      }
      break;
    }
    case "FUNCTIONAL_ZONES_DEFINED": {
      const rev = revision(state, p.revision_no);
      for (const z of p.zones ?? []) {
        rev.zones.set(z.zone_id, { ...z, revision_no: p.revision_no });
      }
      break;
    }
    case "MATERIAL_TEST_SUBMITTED": {
      const record = {
        kind: "material",
        ref: p.report_ref,
        opinion_ref: p.report_ref,
        revision_no: p.revision_no,
        discipline: "material",
        verdict: "pass",
        issued_at: p.issued_at,
        valid_until: p.valid_until,
        covered_zones: p.covered_zones,
      };
      state.opinions.push(record);
      registerRef(state, p.report_ref, `材料检测报告（版次 R${p.revision_no}）`);
      break;
    }
    case "DISCIPLINE_OPINION_ISSUED": {
      const record = {
        kind: "opinion",
        ref: p.opinion_ref,
        opinion_ref: p.opinion_ref,
        revision_no: p.revision_no,
        discipline: p.discipline,
        verdict: p.verdict,
        issued_at: p.issued_at,
        valid_until: p.valid_until,
        covered_zones: p.covered_zones,
        conditions: p.conditions ?? [],
      };
      state.opinions.push(record);
      registerRef(state, p.opinion_ref, `${p.discipline} 专业意见（版次 R${p.revision_no}）`);
      break;
    }
    case "CONSTRUCTION_COMPLETED": {
      const rev = revision(state, p.revision_no);
      rev.completed_at = p.completed_at;
      rev.built_zones = p.built_zones;
      break;
    }

    case "INSPECTION_RECORDED": {
      state.findings.push({
        finding_id: p.finding_id,
        revision_no: p.revision_no,
        zone_id: p.zone_id,
        discipline: p.discipline,
        finding: p.finding,
        severity: p.severity,
        status: FINDING_STATUS.OPEN,
        recorded_at: event.occurred_at,
      });
      registerRef(state, p.finding_id, `检查发现（${p.zone_id}）`);
      break;
    }
    case "DEFECT_ASSIGNED": {
      const f = finding(state, p.finding_id);
      f.assignee = p.responsible_party;
      f.due_date = p.due_date;
      break;
    }
    case "DEFECT_RECTIFIED": {
      const f = finding(state, p.finding_id);
      f.status = FINDING_STATUS.RECTIFIED;
      f.rectified_at = p.rectified_at;
      f.rectification_evidence = p.evidence_refs;
      break;
    }
    case "FINDING_VERIFIED": {
      const f = finding(state, p.finding_id);
      f.status = p.verdict === "pass" ? FINDING_STATUS.VERIFIED : FINDING_STATUS.OPEN;
      f.verified_at = p.verified_at;
      f.verifier = p.verifier;
      f.verify_verdict = p.verdict;
      break;
    }
    case "FINDING_WAIVED": {
      const f = finding(state, p.finding_id);
      f.status = FINDING_STATUS.WAIVED;
      f.waived_at = p.waived_at;
      f.approver = p.approver;
      f.waiver_basis = p.basis_ref;
      break;
    }
    case "ZONE_ACCEPTED": {
      state.acceptances.push({
        zone_id: p.zone_id,
        revision_no: p.revision_no,
        accepted_at: p.accepted_at,
        acceptance_ref: p.acceptance_ref,
        inspectors: p.inspectors,
      });
      registerRef(state, p.acceptance_ref, `分区验收单（${p.zone_id} R${p.revision_no}）`);
      break;
    }

    case "CAPACITY_FILED": {
      const row = {
        zone_id: p.zone_id,
        revision_no: p.revision_no,
        ratio_basis: p.ratio_basis,
        area_m2: p.area_m2,
        per_child_m2: p.per_child_m2,
        filed_capacity: p.filed_capacity,
        filed_at: p.filed_at,
      };
      row.derived_capacity = deriveCapacity(row);
      state.capacities.push(row);
      break;
    }
    case "OPENING_DECIDED": {
      state.openings.push({ ...p, recorded_at: event.occurred_at });
      registerRef(state, p.decision_ref, `开园决定（${p.kind}）`);
      break;
    }
    case "CAPACITY_PUBLISHED": {
      state.publications.push({ ...p, recorded_at: event.occurred_at });
      break;
    }
    case "EXIT_PLAN_FORMED": {
      state.exit_plans.push({ ...p, recorded_at: event.occurred_at });
      registerRef(state, p.plan_ref, "退出方案");
      break;
    }
    case "SITE_HANDED_BACK": {
      state.handback = { ...p, recorded_at: event.occurred_at };
      break;
    }
  }
}

function revision(state, no) {
  let rev = state.revisions.find((r) => r.revision_no === no);
  if (!rev) {
    rev = { revision_no: no, zones: new Map(), rework_required: [] };
    state.revisions.push(rev);
    state.revisions.sort((a, b) => a.revision_no - b.revision_no);
  }
  return rev;
}

function finding(state, id) {
  const f = state.findings.find((x) => x.finding_id === id);
  if (!f) throw new Error(`引用了不存在的检查发现：${id}`);
  return f;
}

function zonesOf(state, revisionNo) {
  const rev = state.revisions.find((r) => r.revision_no === revisionNo);
  return rev ? [...rev.zones.values()] : [];
}

/**
 * 分区在某版次的有效备案容量：可沿用旧版次备案，但前提是自备案版次以来
 * 该分区面积/定义未在任何新版次中变化（图纸 layout 变更已由分区重定义体现）。
 */
/** 分区在当前版次是否被某次后批准的修订触及（用于判断旧验收/旧缺陷是否延续）。 */
function revisionsHittingZone(state, zoneId, sinceRev, revNo) {
  return state.revisions
    .filter((r) => r.approved_at && r.revision_no > sinceRev && r.revision_no <= revNo)
    .filter((r) => !r.affected_zones || r.affected_zones.length === 0 || r.affected_zones.includes(zoneId));
}

/** 有效施工完成：以最近触及该分区的版次是否已完成施工为准（首版视为触及全部分区）。 */
function builtForZone(state, zoneId, revNo) {
  const hit = state.revisions
    .filter((r) => r.revision_no <= revNo)
    .filter((r) => r.revision_no === 1 || (r.affected_zones ?? []).includes(zoneId))
    .at(-1);
  return Boolean(hit?.built_zones?.includes(zoneId));
}

/** 有效分区验收：允许沿用旧版次签署，但其后修订不得触及该分区。 */
function acceptanceForZone(state, zoneId, revNo) {
  const candidates = state.acceptances
    .filter((a) => a.zone_id === zoneId && a.revision_no <= revNo)
    .sort((a, b) => b.revision_no - a.revision_no);
  for (const a of candidates) {
    const touched = revisionsHittingZone(state, zoneId, a.revision_no, revNo);
    if (touched.length === 0) return a;
  }
  return null;
}

/** 当前版次下对分区仍有效的检查发现：旧版次缺陷沿用；被修订矩阵触及的，标记为须按新版复查。 */
function effectiveFindings(state, zoneId, revNo) {
  return state.findings
    .filter((f) => f.zone_id === zoneId && f.revision_no <= revNo)
    .map((f) => {
      const superseding = revisionsHittingZone(state, zoneId, f.revision_no, revNo).filter((r) =>
        (r.affected_scopes ?? []).flatMap((s) => REVISION_IMPACT[s] ?? []).includes(f.discipline),
      );
      const recheckAfter = superseding.map((r) => r.approved_at).sort().at(-1) ?? null;
      return recheckAfter ? { ...f, recheck_required_after: recheckAfter } : f;
    });
}

function capacityForZone(state, zoneId, revNo, at) {
  // 备案版次与当前版次上该分区面积不一致即视为布局已变，旧备案不得沿用
  const areaAt = (no) => state.revisions.find((r) => r.revision_no === no)?.zones.get(zoneId)?.area_m2;

  const rows = state.capacities
    .filter((c) => c.zone_id === zoneId && c.revision_no <= revNo)
    .filter((c) => new Date(c.filed_at).getTime() <= new Date(at).getTime())
    .filter((c) => areaAt(c.revision_no) === undefined || areaAt(c.revision_no) === areaAt(revNo))
    .sort((a, b) => b.revision_no - a.revision_no || b.filed_at.localeCompare(a.filed_at));
  return rows[0] ?? null;
}

// ---------- 派生视图 ----------

export function currentRevision(state) {
  return state.revisions.at(-1) ?? null;
}

/** 当前版次的功能分区清单。 */
export function currentZones(state) {
  const rev = currentRevision(state);
  return rev ? [...rev.zones.values()] : [];
}

export function findingsOpenAt(findingRecord, at) {
  const t = new Date(at).getTime();
  if (new Date(findingRecord.recorded_at).getTime() > t) return false;
  // 图纸修订触及该缺陷专业线后，修订批准前的复验/豁免不再算数，须按新版重新检查；
  // 修订批准之后完成的复验/豁免有效，缺陷关闭。
  if (findingRecord.recheck_required_after) {
    const cut = new Date(findingRecord.recheck_required_after).getTime();
    const reverified = findingRecord.verified_at && new Date(findingRecord.verified_at).getTime() > cut;
    const rewaived = findingRecord.waived_at && new Date(findingRecord.waived_at).getTime() > cut;
    if (reverified || rewaived) return false;
    return true;
  }
  if (findingRecord.verified_at && new Date(findingRecord.verified_at).getTime() <= t) return false;
  if (findingRecord.waived_at && new Date(findingRecord.waived_at).getTime() <= t) return false;
  return true;
}

/** 分区在 at 时点的完整状态。 */
export function zoneView(state, zone, at) {
  const rev = currentRevision(state);
  const revNo = rev.revision_no;

  const acceptance = acceptanceForZone(state, zone.zone_id, revNo);

  const openFindings = effectiveFindings(state, zone.zone_id, revNo).filter((f) => findingsOpenAt(f, at));
  const majorOpen = openFindings.filter((f) => f.severity === DEFECT_SEVERITIES.MAJOR);
  const minorOpen = openFindings.filter((f) => f.severity === DEFECT_SEVERITIES.MINOR);

  const usable = {};
  const missing = [];
  for (const discipline of REQUIRED_DISCIPLINES) {
    const pool = state.opinions.filter(
      (o) =>
        o.discipline === discipline &&
        isOpinionUsable(o, { at, revisionNo: revNo, zoneId: zone.zone_id, revisions: state.revisions }),
    );
    const passed = pool.find((o) => o.verdict === "pass" || o.kind === "material");
    const conditional = pool.find((o) => o.verdict === "conditional_pass");
    if (passed) {
      usable[discipline] = { status: "pass", ref: passed.opinion_ref, valid_until: passed.valid_until };
    } else if (conditional) {
      usable[discipline] = {
        status: "conditional_pass",
        ref: conditional.opinion_ref,
        valid_until: conditional.valid_until,
        conditions: conditional.conditions,
      };
    } else {
      usable[discipline] = { status: "missing" };
      missing.push(discipline);
    }
  }

  const built = builtForZone(state, zone.zone_id, revNo);
  const capacity = capacityForZone(state, zone.zone_id, revNo, at);

  // 局部开放：无未关闭 major、minor 全部带明确条件、已按现行版次验收、三线意见现行有效；
  // 可收托分区还必须有与折算一致的备案容量（配套用房 capacity_eligible=false 除外）。
  const capacityEligible = zone.capacity_eligible !== false;
  const capacityReady = !capacityEligible || (capacity && capacity.derived_capacity === capacity.filed_capacity);
  const readyForPartial =
    built &&
    Boolean(acceptance) &&
    majorOpen.length === 0 &&
    missing.length === 0 &&
    Object.values(usable).every((o) => o.status !== "missing") &&
    capacityReady;
  const readyForFull = readyForPartial && minorOpen.length === 0;

  const minorConditions = minorOpen.map((f) => `缺陷 ${f.finding_id} 限期整改（责任人 ${f.assignee ?? "未定"}，期限 ${f.due_date ?? "未定"}）`);

  return {
    zone_id: zone.zone_id,
    name: zone.name,
    purpose: zone.purpose,
    area_m2: zone.area_m2,
    revision_no: revNo,
    design_approved: Boolean(rev.approved_at),
    built,
    accepted: acceptance
      ? { acceptance_ref: acceptance.acceptance_ref, accepted_at: acceptance.accepted_at, inspectors: acceptance.inspectors }
      : null,
    open_major_findings: majorOpen.map((f) => f.finding_id),
    open_minor_findings: minorOpen.map((f) => f.finding_id),
    opinions: usable,
    missing_opinions: missing,
    filed_capacity: capacity?.filed_capacity ?? null,
    derived_capacity: capacity?.derived_capacity ?? null,
    capacity_eligible: capacityEligible,
    capacity_consistent: capacity
      ? capacity.derived_capacity === null || capacity.derived_capacity === capacity.filed_capacity
      : null,
    ready_for_full: readyForFull,
    ready_for_partial: readyForPartial,
    partial_conditions: minorConditions,
  };
}

/** 三道闸门状态：设计通过 / 施工完成 / 允许收托，各自独立、互不替代。 */
export function gates(state, at = state.as_of) {
  const rev = currentRevision(state);
  const design = rev?.approved_at
    ? {
        gate: "设计通过",
        status: "passed",
        revision_no: rev.revision_no,
        approved_at: rev.approved_at,
        approving_authority: rev.approving_authority,
      }
    : { gate: "设计通过", status: rev?.submitted_at ? "submitted" : "not_started" };

  const allZoneIds = [...rev.zones.keys()];
  const builtNow = allZoneIds.filter((z) => builtForZone(state, z, rev.revision_no));
  const construction =
    builtNow.length === allZoneIds.length
      ? {
          gate: "施工完成",
          status: "completed",
          revision_no: rev.revision_no,
          completed_at: rev.completed_at,
          built_zones: builtNow,
        }
      : builtNow.length > 0
        ? {
            gate: "施工完成",
            status: "partially_completed",
            revision_no: rev.revision_no,
            built_zones: builtNow,
            pending_zones: allZoneIds.filter((z) => !builtNow.includes(z)),
          }
        : { gate: "施工完成", status: "not_completed" };

  const openZones = openZonesAt(state, at);
  const allZones = currentZones(state).map((z) => z.zone_id);
  let openingStatus = "not_allowed";
  if (openZones.size > 0) {
    openingStatus = allZones.every((z) => openZones.has(z)) ? OPENING_KINDS.FULL : OPENING_KINDS.PARTIAL;
  }
  const latest = [...state.openings].reverse().find((d) => new Date(d.decided_at).getTime() <= new Date(at).getTime());
  const opening = {
    gate: "允许收托",
    status: openingStatus,
    latest_decision_ref: latest?.decision_ref ?? null,
    open_zones: [...openZones],
  };
  return { design, construction, opening };
}

/** 重放开园决定，得到 at 时点实际开放的分区集合。 */
export function openZonesAt(state, at) {
  const t = new Date(at).getTime();
  const open = new Set();
  for (const d of state.openings) {
    if (new Date(d.decided_at).getTime() > t) continue;
    if (d.kind === OPENING_KINDS.FULL) d.zones_requested.forEach((z) => open.add(z));
    if (d.kind === OPENING_KINDS.PARTIAL) d.zones_requested.forEach((z) => open.add(z));
    if (d.kind === OPENING_KINDS.SUSPEND) d.zones_requested.forEach((z) => open.delete(z));
    if (d.kind === OPENING_KINDS.RESCIND) d.zones_requested.forEach((z) => open.delete(z));
  }
  return open;
}

/** 当前获准分区折算后的备案容量——招生页面唯一允许公布的口径。 */
export function allowedPublishedCapacity(state, at = state.as_of) {
  const rev = currentRevision(state);
  const open = openZonesAt(state, at);
  const lines = [];
  for (const zoneId of open) {
    const cap = capacityForZone(state, zoneId, rev.revision_no, at);
    if (cap) lines.push({ zone_id: zoneId, filed_capacity: cap.filed_capacity });
  }
  return {
    open_zones: [...open],
    zone_capacities: lines,
    total: lines.reduce((sum, x) => sum + x.filed_capacity, 0),
  };
}

/** 产权期限与退出准备状态。 */
export function termView(state, at = state.as_of) {
  if (!state.site.term_end) return { registered: false };
  const status = termStatus(state.site.term_end, at);
  const plans = [...state.exit_plans].sort((a, b) => a.formed_at.localeCompare(b.formed_at));
  const plan = plans.at(-1) ?? null;
  return {
    registered: true,
    owner: state.site.owner,
    original_use: state.site.original_use,
    original_use_evidence: state.site.original_use_evidence,
    term_start: state.site.term_start,
    term_end: state.site.term_end,
    ...status,
    exit_plan: plan,
    exit_plan_required: status.exit_plan_overdue || status.days_remaining <= 365,
    handed_back: state.handback,
  };
}

/** 修订影响台账：逐版次列出图纸修订后必须重做的检查。 */
export function reworkLedger(state) {
  return state.revisions
    .filter((r) => r.approved_at && r.supersedes_revision_no >= 1)
    .map((r) => ({
      revision_no: r.revision_no,
      supersedes_revision_no: r.supersedes_revision_no,
      affected_scopes: r.affected_scopes,
      rework_required: r.rework_required,
    }));
}

/** 对一条历史开园决定做事后稽核：引用了过期/旧版次意见等会在此暴露。 */
export function auditDecision(state, decision) {
  const at = decision.decided_at;
  const revNo = decision.basis_revision_no;
  const flags = [];

  for (const ref of decision.basis_refs ?? []) {
    if (!state.refs.has(ref)) flags.push(`引用了不存在的文书：${ref}`);
  }
  for (const zoneId of decision.zones_requested) {
    if (decision.kind === OPENING_KINDS.SUSPEND || decision.kind === OPENING_KINDS.RESCIND) continue;
    for (const discipline of REQUIRED_DISCIPLINES) {
      const match = state.opinions.find(
        (o) =>
          o.opinion_ref !== undefined &&
          decision.basis_refs.includes(o.opinion_ref) &&
          o.discipline === discipline &&
          o.covered_zones.includes(zoneId),
      );
      if (!match) continue; // 缺引用由命令侧拦截，这里只查"引用了但无效"
      if (!isOpinionUsable(match, { at, revisionNo: revNo, zoneId, revisions: state.revisions })) {
        flags.push(`分区 ${zoneId}：${refLabel(match)} 已不可用于 R${revNo}——已过期或被其后图纸修订触及，不接受过期意见被重新引用`);
      }
      if (match.verdict === "fail") {
        flags.push(`分区 ${zoneId}：${refLabel(match)} 结论为不合格`);
      }
    }
    const acceptance = state.acceptances.find(
      (a) => a.acceptance_ref && decision.basis_refs.includes(a.acceptance_ref) && a.zone_id === zoneId,
    );
    if (acceptance && acceptance.revision_no !== revNo) {
      flags.push(`分区 ${zoneId}：验收单 ${acceptance.acceptance_ref} 签署于旧版次 R${acceptance.revision_no}`);
    }
  }
  return flags;
}

function refLabel(record) {
  return record.kind === "material" ? `材料检测报告 ${record.opinion_ref}` : `${record.discipline} 意见 ${record.opinion_ref}`;
}

/** 招生页面发布稽核：只能发布当前获准区域折算后的备案容量。 */
export function auditPublication(state, pub) {
  const flags = [];
  const allowed = allowedPublishedCapacity(state, pub.published_at);
  const included = [...pub.zones_included].sort();
  const openAllowed = [...allowed.open_zones].sort();
  if (JSON.stringify(included) !== JSON.stringify(openAllowed)) {
    flags.push(
      `发布分区与当前获准开放分区不一致：发布 [${pub.zones_included.join("、")}]，获准 [${allowed.open_zones.join("、") || "无"}]`,
    );
  }
  if (pub.published_capacity !== allowed.total) {
    flags.push(`公布容量 ${pub.published_capacity} 与获准区域备案容量合计 ${allowed.total} 不符；整栋满额口径禁止对外发布`);
  }
  return flags;
}

export { REVISION_SCOPES };
