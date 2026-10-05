/**
 * 写入侧命令规则：在产生开园决定、容量备案、招生发布、退出方案等事实前，
 * 依据当前投影状态做前置校验。返回中文错误清单；空数组表示可以落事件。
 *
 * 这些函数只做判断、不修改状态，便于在接口层、批处理与测试中复用同一口径。
 */
import { OPENING_KINDS } from "./events.js";
import {
  EXIT_PLAN_LEAD_MONTHS,
  REQUIRED_DISCIPLINES,
  daysBetween,
  exitPlanDueDate,
  isOpinionUsable,
} from "./policy.js";
import {
  allowedPublishedCapacity,
  auditDecision,
  auditPublication,
  currentRevision,
  openZonesAt,
  zoneView,
} from "./project.js";

function nonEmptySection(value, label) {
  if (value === undefined || value === null) return [`退出方案缺少“${label}”安排`];
  if (typeof value === "string") return value.trim() ? [] : [`退出方案的“${label}”不得为空`];
  if (typeof value === "object") return Object.keys(value).length ? [] : [`退出方案的“${label}”不得为空`];
  return [];
}

/** 开园 / 暂停 / 撤销收托决定前置校验。 */
export function checkOpeningDecision(state, command) {
  const errors = [];
  const {
    kind,
    decided_at: decidedAt,
    basis_revision_no: basisRev,
    zones_requested: requested,
    signed_by: signedBy,
    basis_refs: basisRefs = [],
    evidence_refs: evidenceRefs = [],
    conditions = [],
  } = command;

  if (!signedBy?.name) errors.push("开园决定必须由责任主体签署（signed_by.name）");
  if (evidenceRefs.length === 0) errors.push("每次开园决定须附可追溯的现场证据（evidence_refs）");
  if (![OPENING_KINDS.FULL, OPENING_KINDS.PARTIAL, OPENING_KINDS.SUSPEND, OPENING_KINDS.RESCIND].includes(kind)) {
    errors.push(`未知开园决定类型：${kind}`);
    return errors;
  }

  const rev = currentRevision(state);
  if (!rev?.approved_at) {
    errors.push("设计尚未通过审查，不允许作出任何开园决定——设计通过是独立闸门");
    return errors;
  }

  // 场地期限
  if (!state.site.term_end) {
    errors.push("尚未登记产权（使用权）期限，不得开园");
  } else {
    const remaining = daysBetween(decidedAt, state.site.term_end);
    if (remaining <= 0) errors.push(`场地使用权已于 ${state.site.term_end} 到期，不得作出开园决定`);
    if (remaining > 0 && remaining <= EXIT_PLAN_LEAD_MONTHS * 30.4) {
      const due = exitPlanDueDate(state.site.term_end);
      const plan = [...state.exit_plans].filter((e) => e.formed_at <= decidedAt).at(-1);
      if (!plan) errors.push(`场地剩余期限不足一年（应于 ${due.toISOString().slice(0, 10)} 前形成退出方案），未形成退出方案不得继续收托`);
    }
  }

  // 暂停 / 撤销只校验分区当前是否开放
  if (kind === OPENING_KINDS.SUSPEND || kind === OPENING_KINDS.RESCIND) {
    const open = openZonesAt(state, decidedAt);
    for (const z of requested) {
      if (!open.has(z)) errors.push(`分区 ${z} 当前并未开放，无须${kind === "suspend" ? "暂停" : "撤销"}`);
    }
    errors.push(...auditDecision(state, command));
    return errors;
  }

  // 允许收托必须基于当前获批版次，旧图纸上的决定一律驳回
  if (basisRev !== rev.revision_no) {
    errors.push(`开园依据版次 R${basisRev} 已被 R${rev.revision_no} 取代，须按新图纸重新检查后再决定`);
  }

  const zoneIds = [...rev.zones.keys()];
  const openAtDecision = openZonesAt(state, decidedAt);
  const cited = new Set(basisRefs);

  for (const zoneId of requested) {
    const zone = rev.zones.get(zoneId);
    if (!zone) {
      errors.push(`分区 ${zoneId} 不存在于版次 R${rev.revision_no} 图纸`);
      continue;
    }
    if (openAtDecision.has(zoneId)) errors.push(`分区 ${zoneId} 已在开放中，重复开园决定无意义（如需变更请先暂停/撤销）`);

    const view = zoneView(state, zone, decidedAt);

    if (!view.design_approved) errors.push(`分区 ${zoneId}：图纸版次尚未通过审查`);
    if (!view.built) errors.push(`分区 ${zoneId}：施工尚未完成，施工完成是独立闸门，不得跳过`);
    if (!view.accepted) {
      errors.push(`分区 ${zoneId}：缺少版次 R${rev.revision_no} 的分区验收签署`);
    } else if (!cited.has(view.accepted.acceptance_ref)) {
      errors.push(`分区 ${zoneId}：决定依据中未引用现行分区验收单 ${view.accepted.acceptance_ref}`);
    }

    if (view.open_major_findings.length) {
      errors.push(`分区 ${zoneId}：存在未关闭的严重缺陷 ${view.open_major_findings.join("、")}，禁止收托`);
    }

    if (kind === OPENING_KINDS.PARTIAL) {
      for (const minorId of view.open_minor_findings) {
        const covered = conditions.some((c) => c.includes(minorId));
        if (!covered) {
          errors.push(`分区 ${zoneId}：局部开放须为缺陷 ${minorId} 明确限制条件与整改期限（conditions 中未提及）`);
        }
      }
    }
    if (kind === OPENING_KINDS.FULL && view.open_minor_findings.length) {
      errors.push(`分区 ${zoneId}：仍有一般缺陷 ${view.open_minor_findings.join("、")}，只能申请局部开放`);
    }

    // 三线文书（消防、卫生、材料）必须逐条引用且现行有效
    for (const discipline of REQUIRED_DISCIPLINES) {
      const usable = state.opinions
        .filter((o) => o.discipline === discipline)
        .filter((o) => isOpinionUsable(o, { at: decidedAt, revisionNo: basisRev, zoneId, revisions: state.revisions }))
        .filter((o) => o.verdict !== "fail")
        .filter((o) => cited.has(o.opinion_ref));
      if (usable.length === 0) {
        errors.push(
          `分区 ${zoneId}：缺少对版次 R${basisRev} 现行有效、覆盖本分区且被本决定引用的${
            discipline === "fire" ? "消防" : discipline === "health" ? "卫生" : "材料检测"
          }文书；过期意见或旧版次意见不得重新引用`,
        );
      }
      const conditional = usable.find((o) => o.verdict === "conditional_pass");
      if (conditional && !conditions.some((c) => c.includes(conditional.opinion_ref))) {
        errors.push(`分区 ${zoneId}：附条件合格意见 ${conditional.opinion_ref} 的限制条款未写入开园条件`);
      }
    }

    if (view.capacity_eligible && view.filed_capacity === null) {
      errors.push(`分区 ${zoneId}：尚无备案容量，不允许收托`);
    } else if (view.capacity_consistent === false) {
      errors.push(`分区 ${zoneId}：备案容量 ${view.filed_capacity} 与按面积指标折算结果 ${view.derived_capacity} 不一致`);
    }
  }

  // 引用了不存在文书的情况
  for (const ref of basisRefs) {
    if (!state.refs.has(ref)) errors.push(`决定引用了系统中不存在的文书：${ref}`);
  }

  // 共享时段须落在现行邻里约定内
  if (state.site.sharing.length) {
    const validAgreement = state.site.neighbor_agreements.some(
      (a) => a.agreed_from <= decidedAt.slice(0, 10) && a.agreed_until >= decidedAt.slice(0, 10),
    );
    if (!validAgreement) errors.push("存在共享时段安排，但没有覆盖决定日期的现行邻里约定");
  }

  if (!conditions.length) errors.push("开园决定必须列明限制条件（即使全面开放也须载明容量等限制）");

  errors.push(...auditDecision(state, command));
  return errors;
}

/** 分区容量备案：面积必须取自版次分区定义，备案数必须可由指标复算。 */
export function checkCapacityFiled(state, command) {
  const errors = [];
  const rev = currentRevision(state);
  if (!rev) return ["尚无任何设计版次"];
  const zone = rev.zones.get(command.zone_id);
  if (!zone) return [`分区 ${command.zone_id} 不存在于当前版次 R${rev.revision_no}`];

  if (command.area_m2 !== zone.area_m2) {
    errors.push(
      `备案面积 ${command.area_m2}㎡ 与版次图纸分区面积 ${zone.area_m2}㎡ 不符；禁止按整栋建筑面积折算分区容量`,
    );
  }
  const derived = Math.floor(command.area_m2 / command.per_child_m2);
  if (command.filed_capacity !== derived) {
    errors.push(`备案容量 ${command.filed_capacity} 无法由 ${command.area_m2}㎡ ÷ ${command.per_child_m2}㎡/人 折算（应为 ${derived}）`);
  }
  return errors;
}

/** 招生页面发布：只能发布当前获准分区折算后的备案容量合计。 */
export function checkCapacityPublished(state, command) {
  const errors = [];
  const allowed = allowedPublishedCapacity(state, command.published_at);
  if (allowed.open_zones.length === 0) {
    errors.push("当前没有任何获准收托的分区，招生页面不得公布容量");
  }
  if (allowed.zone_capacities.length !== allowed.open_zones.length) {
    errors.push("获准开放的分区中存在未完成容量备案者，发布前须补齐");
  }
  errors.push(...auditPublication(state, command));
  return errors;
}

/** 退出方案：须提前形成，四要素齐备并落实责任人。 */
export function checkExitPlan(state, command) {
  const errors = [];
  if (!state.site.term_end) errors.push("尚未登记场地使用权期限，无法编制退出方案");

  for (const [key, label] of [
    ["facilities", "设施处置"],
    ["deposit", "押金清退"],
    ["child_placement", "儿童安置"],
    ["restoration", "场地恢复责任"],
  ]) {
    errors.push(...nonEmptySection(command[key], label));
  }

  const placement = command.child_placement;
  if (placement && typeof placement === "object" && !placement.responsible_party) {
    errors.push("儿童安置必须明确责任主体，不得出现无人负责的长期班退出安排");
  }
  const restoration = command.restoration;
  if (restoration && typeof restoration === "object") {
    if (!restoration.responsible_party) errors.push("场地恢复必须明确责任主体");
    if (state.site.original_use && restoration.restore_to_use && restoration.restore_to_use !== state.site.original_use) {
      errors.push(`恢复用途“${restoration.restore_to_use}”与登记原用途“${state.site.original_use}”不一致`);
    }
  }

  if (state.site.term_end) {
    const due = exitPlanDueDate(state.site.term_end);
    if (new Date(command.formed_at).getTime() > due.getTime()) {
      errors.push(
        `退出方案形成于 ${command.formed_at.slice(0, 10)}，晚于提前 ${EXIT_PLAN_LEAD_MONTHS} 个月的要求时限 ${due.toISOString().slice(0, 10)}`,
      );
    }
    if (command.target_exit_date > state.site.term_end) {
      errors.push(`计划退出日期 ${command.target_exit_date} 晚于场地使用权到期日 ${state.site.term_end}`);
    }
  }
  return errors;
}

/** 交还场地：退出方案已形成、儿童已安置、恢复经确认，且不晚于到期日。 */
export function checkHandback(state, command) {
  const errors = [];
  const plan = [...state.exit_plans]
    .filter((e) => new Date(e.formed_at).getTime() <= new Date(command.handed_back_at).getTime())
    .at(-1);
  if (!plan) errors.push("交还场地前必须先形成退出方案");
  if (!command.restoration_confirmed_by) errors.push("场地恢复须经产权单位确认（restoration_confirmed_by）");
  if (command.children_settled !== true) errors.push("仍有在托儿童未完成安置，不得交还场地");
  if (state.site.term_end && command.handed_back_at.slice(0, 10) > state.site.term_end) {
    errors.push(`交还日期晚于使用权到期日 ${state.site.term_end}`);
  }
  return errors;
}
