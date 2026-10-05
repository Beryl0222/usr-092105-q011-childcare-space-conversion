/**
 * 领域策略规则（纯函数）：
 *  - 图纸修订影响矩阵：修订范围 -> 必须重做的检查专业线
 *  - 专业意见/材料检测有效性窗口与版次绑定
 *  - 人员容量按备案面积与人均指标折算
 *  - 产权期限与退出方案提前量
 *  - 分区局部开放条件
 * 规则集中在本文件，投影与命令校验共用，避免口径分叉。
 */
import { INSPECTION_DISCIPLINES, REVISION_SCOPES } from "./events.js";

export const MS_PER_DAY = 86_400_000;

/** 退出方案须在产权到期前提前形成的月数（长期班儿童安置需要提前量）。 */
export const EXIT_PLAN_LEAD_MONTHS = 12;

/**
 * 修订影响矩阵。key 为 affected_scopes 取值，value 为受影响、须重做的专业线。
 * material 专业线对应 MATERIAL_TEST_SUBMITTED（材料检测报告），其余对应 DISCIPLINE_OPINION_ISSUED。
 */
export const REVISION_IMPACT = Object.freeze({
  [REVISION_SCOPES.LAYOUT]: [INSPECTION_DISCIPLINES.FIRE, INSPECTION_DISCIPLINES.HEALTH],
  [REVISION_SCOPES.STRUCTURE]: [INSPECTION_DISCIPLINES.STRUCTURE, INSPECTION_DISCIPLINES.FIRE],
  [REVISION_SCOPES.MEP]: [
    INSPECTION_DISCIPLINES.MEP,
    INSPECTION_DISCIPLINES.FIRE,
    INSPECTION_DISCIPLINES.HEALTH,
  ],
  [REVISION_SCOPES.FIRE]: [INSPECTION_DISCIPLINES.FIRE],
  [REVISION_SCOPES.MATERIAL]: [
    INSPECTION_DISCIPLINES.MATERIAL,
    INSPECTION_DISCIPLINES.FIRE,
    INSPECTION_DISCIPLINES.HEALTH,
  ],
  [REVISION_SCOPES.EGRESS]: [INSPECTION_DISCIPLINES.FIRE],
  [REVISION_SCOPES.FACADE]: [INSPECTION_DISCIPLINES.FIRE],
});

/** 任何允许收托的分区都必须具备的现行专业线意见/检测。 */
export const REQUIRED_DISCIPLINES = Object.freeze([
  INSPECTION_DISCIPLINES.FIRE,
  INSPECTION_DISCIPLINES.HEALTH,
  INSPECTION_DISCIPLINES.MATERIAL,
]);

export function parseDate(value) {
  return new Date(value);
}

export function daysBetween(from, to) {
  return Math.round((parseDate(to).getTime() - parseDate(from).getTime()) / MS_PER_DAY);
}

export function addMonths(value, months) {
  const d = parseDate(value);
  d.setMonth(d.getMonth() + months);
  return d;
}

/** 退出方案最晚形成时间：产权到期前 EXIT_PLAN_LEAD_MONTHS 个月。 */
export function exitPlanDueDate(termEnd) {
  return addMonths(termEnd, -EXIT_PLAN_LEAD_MONTHS);
}

/**
 * 图纸修订后必须重做的检查清单。
 *
 * @param approval 新批准版次事件（含 affected_scopes、可选 affected_zones）
 * @param context  { zones：新版次分区清单， opinions：旧版次意见， materials：旧版次检测，
 *                   findings：缺陷， acceptances：旧版次分区验收 }
 * @returns {{item, discipline, zone_id, reason, invalidated_ref}[]}
 */
export function reworkDueToRevision(approval, context) {
  const { zones, opinions, materials, findings, acceptances } = context;
  const hitZones = approval.affected_zones?.length ? approval.affected_zones : zones;
  const disciplines = new Set(
    (approval.affected_scopes ?? []).flatMap((scope) => REVISION_IMPACT[scope] ?? []),
  );
  const rework = [];

  for (const zoneId of hitZones) {
    for (const discipline of disciplines) {
      if (discipline === INSPECTION_DISCIPLINES.MATERIAL) {
        const report = materials
          .filter((m) => m.revision_no === approval.supersedes_revision_no)
          .filter((m) => m.covered_zones.includes(zoneId))
          .at(-1);
        if (report) {
          const ref = report.report_ref ?? report.ref;
          rework.push({
            item: "材料检测复试",
            discipline,
            zone_id: zoneId,
            reason: `新版次修订触及材料相关范围，报告 ${ref} 仅对应旧版次`,
            invalidated_ref: ref,
          });
        }
      } else {
        const opinion = opinions
          .filter((o) => o.revision_no === approval.supersedes_revision_no)
          .filter((o) => o.discipline === discipline)
          .filter((o) => o.covered_zones.includes(zoneId))
          .at(-1);
        if (opinion) {
          rework.push({
            item: "专业意见重出",
            discipline,
            zone_id: zoneId,
            reason: `新版次修订触及 ${approval.affected_scopes.join("、")}，意见 ${opinion.opinion_ref} 仅对应旧版次`,
            invalidated_ref: opinion.opinion_ref,
          });
        }
      }

      // 旧版次上的缺陷即使已复验通过，施工依据已变，须重新检查确认。
      const stale = findings.filter(
        (f) => f.zone_id === zoneId && f.discipline === discipline && f.revision_no === approval.supersedes_revision_no,
      );
      for (const finding of stale) {
        rework.push({
          item: "缺陷现场复查",
          discipline,
          zone_id: zoneId,
          reason: `缺陷 ${finding.finding_id} 的处置基于旧版次施工，图纸修订后须重新检查`,
          invalidated_ref: finding.finding_id,
        });
      }

      // 分区验收按版次签署，旧版次验收自动失效。
      const acceptance = acceptances
        .filter((a) => a.zone_id === zoneId && a.revision_no === approval.supersedes_revision_no)
        .at(-1);
      if (acceptance) {
        rework.push({
          item: "分区验收重签",
          discipline,
          zone_id: zoneId,
          reason: `分区验收 ${acceptance.acceptance_ref} 签署于旧版次，不覆盖新图纸`,
          invalidated_ref: acceptance.acceptance_ref,
        });
      }
    }
  }

  // 去重：同一引用只列一次
  const seen = new Set();
  return rework.filter((r) => {
    const key = `${r.item}|${r.invalidated_ref}|${r.zone_id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * 折算备案容量：使用面积 / 人均使用面积指标，向下取整。
 * area_m2、per_child_m2 缺省时无法复算，返回 null（以人工备案数为准）。
 */
export function deriveCapacity({ area_m2: area, per_child_m2: perChild }) {
  if (typeof area !== "number" || typeof perChild !== "number" || perChild <= 0) return null;
  return Math.floor(area / perChild);
}

/**
 * 意见/检测在指定日期、针对指定版次与分区是否可被引用。
 * 规则：
 *  1) 不得晚于出具、不得超出有效期（过期意见一律不得重新引用）；
 *  2) 必须覆盖该分区；
 *  3) 出具版次不得新于被引版次；
 *  4) 出具版次之后的历次修订，若任一次按影响矩阵触及该专业线且覆盖该分区，
 *     则文书仅对应旧版次、必须重出；未受影响的专业线（如只改消防时的材料检测）可沿用。
 *
 * @param revisions 已批准版次列表（含 revision_no、affected_scopes、affected_zones）
 */
export function isOpinionUsable(record, { at, revisionNo, zoneId, revisions = [] }) {
  const time = parseDate(at).getTime();
  if (time < parseDate(record.issued_at).getTime()) return false;
  if (time > parseDate(record.valid_until).getTime()) return false;
  if (zoneId && !record.covered_zones.includes(zoneId)) return false;
  if (record.revision_no > revisionNo) return false;

  const later = revisions
    .filter((r) => r.approved_at)
    .filter((r) => r.revision_no > record.revision_no && r.revision_no <= revisionNo)
    .sort((a, b) => a.revision_no - b.revision_no);
  for (const rev of later) {
    const zonesHit = rev.affected_zones?.length ? rev.affected_zones : null; // null 表示整址
    if (zoneId && zonesHit && !zonesHit.includes(zoneId)) continue;
    const hitDisciplines = new Set((rev.affected_scopes ?? []).flatMap((s) => REVISION_IMPACT[s] ?? []));
    if (hitDisciplines.has(record.discipline)) return false;
  }
  return true;
}

/** 产权期限状态：用于状态台与到期提醒。 */
export function termStatus(termEnd, at) {
  const days = daysBetween(at, termEnd);
  const due = exitPlanDueDate(termEnd);
  return {
    days_remaining: days,
    exit_plan_due_at: due.toISOString().slice(0, 10),
    exit_plan_overdue: parseDate(at).getTime() > due.getTime(),
    expired: days < 0,
  };
}
