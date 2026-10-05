/**
 * 托育空间改造验收状态台（只读）。
 * 用法：node src/report.js [事件流文件，默认 data/sample-stream.json]
 * 输出产权期限、原用途、设计版次、功能分区、材料检测、消防卫生意见、
 * 人员容量、共享时段、邻里约定、缺陷整改、分区验收、开园限制、退出恢复十三类状态。
 */
import { readFile } from "node:fs/promises";
import { validateStream } from "./validator.js";
import {
  allowedPublishedCapacity,
  currentRevision,
  currentZones,
  gates,
  openZonesAt,
  project,
  reworkLedger,
  termView,
  zoneView,
} from "./project.js";
import { REQUIRED_DISCIPLINES } from "./policy.js";

const DISCIPLINE_LABEL = { fire: "消防", health: "卫生", material: "材料", structure: "结构", mep: "机电" };
const KIND_LABEL = { full: "全面开放", partial: "局部开放", suspend: "暂停收托", rescind: "撤销开放" };

function line(title) {
  return `\n【${title}】`;
}

export async function buildReport(path) {
  const events = JSON.parse(await readFile(path, "utf8"));
  const errors = validateStream(events);
  if (errors.length) return `事件流不合规，无法出状态台：\n${errors.map((e) => `- ${e}`).join("\n")}`;

  const state = project(events);
  const at = state.as_of;
  const out = [];
  const rev = currentRevision(state);
  const term = termView(state, at);
  const g = gates(state, at);

  out.push(`托育点：${state.site.site_id ?? "未登记"}　状态截至：${at}`);

  // 1 产权期限
  out.push(line("产权（使用权）期限"));
  if (!term.registered) {
    out.push("  ✗ 尚未登记场地使用权期限");
  } else {
    out.push(`  产权单位：${term.owner}`);
    out.push(`  使用期限：${term.term_start} 至 ${term.term_end}（剩余 ${term.days_remaining} 天）`);
    out.push(`  退出方案最迟形成日：${term.exit_plan_due_at}（到期前 12 个月）${term.exit_plan_overdue ? "　⚠ 已逾期" : ""}`);
    if (state.site.term_changes.length) {
      out.push("  期限变更：");
      for (const c of state.site.term_changes) out.push(`    - ${c.term_end}：${c.reason}`);
    }
  }

  // 2 原用途
  out.push(line("房屋原用途"));
  out.push(term.original_use ? `  原用途：${term.original_use}` : "  ✗ 未登记原用途");
  out.push(term.original_use_evidence ? `  凭证：${term.original_use_evidence}` : "  ⚠ 缺原用途凭证（退出恢复目标无法核定）");

  // 3 设计版次与三道闸门
  out.push(line("设计版次（三道闸门各自独立）"));
  out.push(`  ① 设计通过：${g.design.status === "passed" ? `✓ R${g.design.revision_no}（${g.design.approved_at}，${g.design.approving_authority}）` : "未通过"}`);
  out.push(
    `  ② 施工完成：${g.construction.status === "completed" ? "✓ 全部分区" : g.construction.status === "partially_completed" ? `部分完成（${g.construction.built_zones.join("、")}；待完成：${g.construction.pending_zones.join("、")}）` : "未完成"}`,
  );
  out.push(`  ③ 允许收托：${g.opening.status === "not_allowed" ? "未开放" : g.opening.status === "full" ? "整址开放" : `局部开放（${g.opening.open_zones.join("、")}）`}，最近决定 ${g.opening.latest_decision_ref ?? "无"}`);

  // 4 图纸修订重做台账
  const ledger = reworkLedger(state);
  out.push(line("图纸修订后必须重做的检查"));
  if (!ledger.length) {
    out.push("  无修订版次");
  } else {
    for (const r of ledger) {
      out.push(`  R${r.supersedes_revision_no} → R${r.revision_no}（触及 ${r.affected_scopes.join("、")}）：${r.rework_required.length} 项`);
      for (const item of r.rework_required) {
        out.push(`    - [${item.zone_id}/${DISCIPLINE_LABEL[item.discipline] ?? item.discipline}] ${item.item}（${item.invalidated_ref}）`);
      }
    }
  }

  // 5 功能分区综合状态
  out.push(line("功能分区（材料检测 / 消防卫生意见 / 缺陷整改 / 分区验收 / 人员容量）"));
  const open = openZonesAt(state, at);
  for (const zone of currentZones(state)) {
    const v = zoneView(state, zone, at);
    out.push(`  ▸ ${zone.zone_id} ${zone.name}（${zone.purpose}，${zone.area_m2}㎡）　当前状态：${open.has(zone.zone_id) ? "已开放收托" : "未开放"}`);
    out.push(`      分区验收：${v.accepted ? `✓ ${v.accepted.acceptance_ref}（${v.accepted.accepted_at}）` : "✗ 无现行验收单"}`);
    for (const d of REQUIRED_DISCIPLINES) {
      const o = v.opinions[d];
      const text =
        o.status === "pass"
          ? `✓ ${o.ref}（有效至 ${o.valid_until}）`
          : o.status === "conditional_pass"
            ? `△ ${o.ref} 附条件（有效至 ${o.valid_until}）`
            : "✗ 缺现行有效文书";
      out.push(`      ${DISCIPLINE_LABEL[d]}：${text}`);
    }
    out.push(
      `      缺陷：严重未关闭 [${v.open_major_findings.join("、") || "无"}]，一般未关闭 [${v.open_minor_findings.join("、") || "无"}]`,
    );
    out.push(
      `      人员容量：${v.capacity_eligible ? `备案 ${v.filed_capacity ?? "未备案"} 人${v.derived_capacity !== null ? `（面积折算 ${v.derived_capacity} 人，${v.capacity_consistent ? "一致" : "✗ 不一致"}）` : ""}` : "配套用房，不折算托位"}`,
    );
    if (v.open_major_findings.length) out.push("      → 有严重缺陷，禁止任何形式开放");
    else if (v.ready_for_full) out.push("      → 具备全面开放条件（仍须签署开园决定）");
    else if (v.ready_for_partial) out.push(`      → 可申请局部开放，条件：${v.partial_conditions.join("；")}`);
    else out.push("      → 暂不具备开放条件");
  }

  // 6 共享时段与邻里约定
  out.push(line("共享时段"));
  if (!state.site.sharing.length) out.push("  无共享安排");
  for (const s of state.site.sharing) {
    out.push(`  ${s.space}：`);
    for (const slot of s.slots) out.push(`    - ${slot.days} ${slot.hours}：${slot.user}`);
  }
  out.push(line("邻里约定"));
  if (!state.site.neighbor_agreements.length) out.push("  无");
  for (const a of state.site.neighbor_agreements) {
    const current = a.agreed_from <= at.slice(0, 10) && a.agreed_until >= at.slice(0, 10);
    out.push(`  ${a.agreement_ref}（${a.agreed_from} 至 ${a.agreed_until}）：${a.parties.join("、")}　${current ? "现行有效" : "⚠ 已过期/未生效"}`);
  }

  // 7 开园决定与限制
  out.push(line("开园决定与限制条件"));
  if (!state.openings.length) out.push("  尚无开园决定");
  for (const d of state.openings) {
    out.push(`  ${KIND_LABEL[d.kind]} ${d.decision_ref}（${d.decided_at}，签署：${d.signed_by.name}）分区 [${d.zones_requested.join("、")}] 依据版次 R${d.basis_revision_no}`);
    out.push(`    现场证据：${d.evidence_refs.join("、")}`);
    for (const c of d.conditions) out.push(`    限制：${c}`);
  }

  // 8 招生发布
  out.push(line("招生页面容量发布"));
  const allowed = allowedPublishedCapacity(state, at);
  out.push(`  当前获准分区 [${allowed.open_zones.join("、") || "无"}]，仅可公布备案容量合计：${allowed.total} 人`);
  for (const p of state.publications) {
    out.push(`  发布 ${p.published_at}（${p.page_ref}）：分区 [${p.zones_included.join("、")}]，${p.published_capacity} 人`);
  }

  // 9 退出方案与交还
  out.push(line("退出方案与场地恢复"));
  if (!term.exit_plan) {
    out.push(term.exit_plan_required ? "  ⚠ 期限临近，退出方案尚未形成" : "  暂无（期限未到提前量）");
  } else {
    const p = term.exit_plan;
    out.push(`  方案 ${p.plan_ref}（${p.formed_at}），计划退出 ${p.target_exit_date}`);
    out.push(`    设施处置：${p.facilities.responsible_party} —— ${p.facilities.arrangement}`);
    out.push(`    押金清退：${p.deposit.responsible_party} —— ${p.deposit.arrangement}`);
    out.push(`    儿童安置：${p.child_placement.responsible_party}（${p.child_placement.children} 名儿童 / ${p.child_placement.long_term_classes} 个长期班）—— ${p.child_placement.arrangement}`);
    out.push(`    恢复责任：${p.restoration.responsible_party}，恢复为“${p.restoration.restore_to_use}”—— ${p.restoration.arrangement}`);
  }
  if (term.handed_back) {
    out.push(`  场地已于 ${term.handed_back.handed_back_at} 交还（${term.handed_back.handover_ref}），恢复确认：${term.handed_back.restoration_confirmed_by}`);
  } else {
    out.push("  场地尚未交还");
  }

  return out.join("\n");
}

const invokedPath = process.argv[1]?.endsWith("report.js");
if (invokedPath) {
  const target = process.argv[2] ?? new URL("../data/sample-stream.json", import.meta.url);
  buildReport(target).then((text) => console.log(text));
}
