/**
 * 生成老城区"槐香里托育点"完整场景事件流并写入 data/。
 * 场景覆盖：产权两年期、原用途登记、两版图纸、午睡区重大缺陷、
 * 修订影响重做、带条件局部开放、招生容量发布与提前退出方案。
 * 运行：node scripts/build-sample.mjs
 */
import { writeFile } from "node:fs/promises";

const SITE = "site-huaixiangli";
const events = [];
const seq = { property_term: 0, design_revision: 0, inspection_finding: 0, opening_decision: 0 };
let n = 0;

function add(aggregateType, type, occurredAt, summary, payload) {
  n += 1;
  seq[aggregateType] += 1;
  events.push({
    event_id: `evt-hxl-${String(n).padStart(4, "0")}`,
    event_type: type,
    aggregate_type: aggregateType,
    aggregate_id: SITE,
    occurred_at: occurredAt,
    version: seq[aggregateType],
    summary,
    payload: { site_id: SITE, ...payload },
  });
}

const ZONES_R1 = [
  { zone_id: "Z-NAP", name: "午睡区", purpose: "婴幼儿午睡", area_m2: 55 },
  { zone_id: "Z-PLAY", name: "活动室", purpose: "游戏与日间活动", area_m2: 75 },
  { zone_id: "Z-CARE", name: "保健观察与配餐区", purpose: "卫生保健、观察隔离与配餐", area_m2: 30, capacity_eligible: false },
];

// ---------- 产权期限、原用途、邻里与共享 ----------
add("property_term", "TERM_REGISTERED", "2024-08-20T10:00:00+08:00", "登记场地使用权：区属公房出租作托育使用，首期五年", {
  owner: "槐城区公房管理中心",
  original_use: "社区配套仓储用房",
  term_start: "2024-09-01",
  term_end: "2029-08-31",
});
add("property_term", "ORIGINAL_USE_RECORDED", "2026-03-05T14:00:00+08:00", "补登房屋原用途凭证（公房资产卡片）", {
  original_use: "社区配套仓储用房",
  evidence_ref: "DOC-GY-2011-037",
});
add("property_term", "TERM_CHANGED", "2026-09-25T09:30:00+08:00", "产权单位函告：场地另有用途，使用权调整为两年后到期收回", {
  term_end: "2028-10-31",
  reason: "公房管理中心 GC-2026-058 号函，期满收回用于社区综合服务",
});
add("property_term", "NEIGHBOR_AGREEMENT_RECORDED", "2026-09-26T16:00:00+08:00", "与居委会及相邻商户签订庭院分时段使用与噪声约定", {
  agreement_ref: "NB-2026-09-01",
  parties: ["槐树里社区居委会", "相邻商户联建小组", "槐香里托育点运营方"],
  agreed_from: "2026-10-01",
  agreed_until: "2027-09-30",
});
add("property_term", "SHARING_SCHEDULE_RECORDED", "2026-09-26T16:10:00+08:00", "登记共享庭院时段：晨间托育户外活动，傍晚归还社区", {
  space: "院内庭院",
  slots: [
    { days: "工作日", hours: "08:00-09:00", user: "托育点户外活动" },
    { days: "工作日", hours: "17:00-19:00", user: "社区居民活动" },
  ],
});

// ---------- R1 图纸、意见、施工 ----------
add("design_revision", "DESIGN_SUBMITTED", "2026-03-10T11:00:00+08:00", "提交改造施工图 R1（仓储改托育）", {
  revision_no: 1,
  submitted_at: "2026-03-10",
});
add("design_revision", "DESIGN_APPROVED", "2026-04-01T15:00:00+08:00", "R1 图纸经联合审查通过（首版）", {
  revision_no: 1,
  approving_authority: "区托育服务联合审查组",
  approved_at: "2026-04-01",
  supersedes_revision_no: 0,
  affected_scopes: ["layout", "structure", "mep", "fire", "material", "egress"],
});
add("design_revision", "FUNCTIONAL_ZONES_DEFINED", "2026-04-01T15:10:00+08:00", "R1 划定三个功能分区（整栋 420㎡，托育备案面积仅计分区使用面积）", {
  revision_no: 1,
  zones: ZONES_R1,
});
add("design_revision", "MATERIAL_TEST_SUBMITTED", "2026-04-10T10:00:00+08:00", "R1 装修材料环保/阻燃检测合格，覆盖三区", {
  revision_no: 1,
  report_ref: "MT-2026-0410",
  issued_at: "2026-04-10",
  discipline: "material",
  covered_zones: ["Z-NAP", "Z-PLAY", "Z-CARE"],
  valid_until: "2027-04-09",
});
add("design_revision", "DISCIPLINE_OPINION_ISSUED", "2026-04-12T10:00:00+08:00", "R1 消防设计审查意见：合格", {
  revision_no: 1,
  opinion_ref: "FI-2026-0412",
  discipline: "fire",
  issued_at: "2026-04-12",
  valid_until: "2027-04-11",
  verdict: "pass",
  covered_zones: ["Z-NAP", "Z-PLAY", "Z-CARE"],
});
add("design_revision", "DISCIPLINE_OPINION_ISSUED", "2026-04-13T10:00:00+08:00", "R1 卫生评价意见：合格（通风与采光满足）", {
  revision_no: 1,
  opinion_ref: "HE-2026-0413",
  discipline: "health",
  issued_at: "2026-04-13",
  valid_until: "2027-04-12",
  verdict: "pass",
  covered_zones: ["Z-NAP", "Z-PLAY", "Z-CARE"],
});
add("design_revision", "CONSTRUCTION_COMPLETED", "2026-08-20T17:00:00+08:00", "施工方申报 R1 改造完工并自评（不等于检查通过、更不等于允许收托）", {
  revision_no: 1,
  completed_at: "2026-08-20",
  built_zones: ["Z-NAP", "Z-PLAY", "Z-CARE"],
});

// ---------- 容量备案（仅按分区使用面积折算，3㎡/人） ----------
add("opening_decision", "CAPACITY_FILED", "2026-08-22T10:00:00+08:00", "午睡区备案容量 18 人（55㎡ ÷ 3㎡/人）", {
  revision_no: 1,
  zone_id: "Z-NAP",
  ratio_basis: "人均使用面积不低于 3㎡（托育机构设置标准）",
  area_m2: 55,
  per_child_m2: 3,
  filed_capacity: 18,
  filed_at: "2026-08-22",
});
add("opening_decision", "CAPACITY_FILED", "2026-08-22T10:10:00+08:00", "活动室备案容量 25 人（75㎡ ÷ 3㎡/人）；保健配餐区不折算托位", {
  revision_no: 1,
  zone_id: "Z-PLAY",
  ratio_basis: "人均使用面积不低于 3㎡（托育机构设置标准）",
  area_m2: 75,
  per_child_m2: 3,
  filed_capacity: 25,
  filed_at: "2026-08-22",
});

// ---------- 检查发现与整改 ----------
add("inspection_finding", "INSPECTION_RECORDED", "2026-08-25T10:00:00+08:00", "消防检查：午睡区疏散指示与备用照明未接通（严重缺陷，阻断收托）", {
  revision_no: 1,
  finding_id: "F-NAP-01",
  zone_id: "Z-NAP",
  discipline: "fire",
  finding: "午睡区通往室外的疏散走道指示灯与备用照明未接专用回路",
  severity: "major",
});
add("inspection_finding", "DEFECT_ASSIGNED", "2026-08-25T11:00:00+08:00", "F-NAP-01 责令施工单位限期整改", {
  finding_id: "F-NAP-01",
  zone_id: "Z-NAP",
  responsible_party: "城南建筑修缮工程队",
  due_date: "2026-11-30",
});
add("inspection_finding", "INSPECTION_RECORDED", "2026-08-25T14:00:00+08:00", "材料复检：午睡区新置储物柜 TVOC 初检偏高（一般缺陷）", {
  revision_no: 1,
  finding_id: "F-NAP-02",
  zone_id: "Z-NAP",
  discipline: "material",
  finding: "午睡区储物柜 TVOC 检测值接近限值，需更换板材并复试",
  severity: "minor",
});
add("inspection_finding", "DEFECT_ASSIGNED", "2026-08-26T09:00:00+08:00", "F-NAP-02 责令供货方更换并送检", {
  finding_id: "F-NAP-02",
  zone_id: "Z-NAP",
  responsible_party: "安童家具供货方",
  due_date: "2026-10-12",
});
add("inspection_finding", "INSPECTION_RECORDED", "2026-08-25T15:00:00+08:00", "卫生检查：活动室洗手池角阀渗水（一般缺陷）", {
  revision_no: 1,
  finding_id: "F-PLAY-01",
  zone_id: "Z-PLAY",
  discipline: "health",
  finding: "活动室洗手池角阀渗水，地面积水有滑倒隐患",
  severity: "minor",
});
add("inspection_finding", "DEFECT_ASSIGNED", "2026-08-26T09:20:00+08:00", "F-PLAY-01 限期修复", {
  finding_id: "F-PLAY-01",
  zone_id: "Z-PLAY",
  responsible_party: "城南建筑修缮工程队",
  due_date: "2026-09-15",
});
add("inspection_finding", "DEFECT_RECTIFIED", "2026-09-10T11:00:00+08:00", "F-PLAY-01 已更换角阀并做止水试验", {
  finding_id: "F-PLAY-01",
  rectified_at: "2026-09-10",
  evidence_refs: ["EV-2026-0910-PLAY-01.jpg", "EV-2026-0910-PLAY-02.jpg"],
});
add("inspection_finding", "FINDING_VERIFIED", "2026-09-12T10:00:00+08:00", "F-PLAY-01 复验通过", {
  finding_id: "F-PLAY-01",
  verified_at: "2026-09-12",
  verifier: "区卫生健康中心 钱检查员",
  verdict: "pass",
});

// ---------- 分区验收：午睡区因严重缺陷未通过 ----------
add("inspection_finding", "ZONE_ACCEPTED", "2026-09-18T15:00:00+08:00", "活动室分区验收通过（消防、卫生联合签署）", {
  zone_id: "Z-PLAY",
  revision_no: 1,
  accepted_at: "2026-09-18",
  acceptance_ref: "ACC-2026-PLAY-R1",
  inspectors: ["区消防救援大队 孙检查员", "区卫生健康中心 钱检查员"],
});
add("inspection_finding", "ZONE_ACCEPTED", "2026-09-18T15:20:00+08:00", "保健观察与配餐区分区验收通过", {
  zone_id: "Z-CARE",
  revision_no: 1,
  accepted_at: "2026-09-18",
  acceptance_ref: "ACC-2026-CARE-R1",
  inspectors: ["区消防救援大队 孙检查员", "区卫生健康中心 钱检查员"],
});

// ---------- 带条件局部开放：活动室先行，午睡区封闭 ----------
add("opening_decision", "OPENING_DECIDED", "2026-09-28T09:00:00+08:00", "局部开放决定：仅活动室允许收托半日班；午睡区未验收、严重缺陷未消除，封闭禁用", {
  kind: "partial",
  decided_at: "2026-09-28",
  decision_ref: "OD-2026-09-01",
  signed_by: { name: "区托育服务专班 周负责人", title: "专班负责人" },
  basis_revision_no: 1,
  zones_requested: ["Z-PLAY"],
  basis_refs: ["FI-2026-0412", "HE-2026-0413", "MT-2026-0410", "ACC-2026-PLAY-R1"],
  evidence_refs: ["EV-2026-0928-SITE-01.jpg", "EV-2026-0928-SITE-02.mp4", "CHK-2026-0928-LIST.pdf"],
  conditions: [
    "仅招收半日班儿童，在托人数不超过备案容量 25 人，不设午睡",
    "午睡区（Z-NAP）以硬隔离封闭并张贴禁用标识，开放日起每日开园前拍照留痕",
    "F-NAP-01、F-NAP-02 整改复验并完成 R2 图纸审查前，午睡区不得启用",
    "共享庭院使用遵守 NB-2026-09-01 时段约定",
  ],
});
add("opening_decision", "CAPACITY_PUBLISHED", "2026-09-29T10:00:00+08:00", "招生页面更正发布：当前仅活动室获准，公布备案容量 25 人", {
  published_at: "2026-09-29",
  page_ref: "https://example.org/admission/huaixiangli",
  zones_included: ["Z-PLAY"],
  published_capacity: 25,
});

// ---------- R2 图纸修订（午睡区疏散与储物柜），自动生成重做清单 ----------
add("design_revision", "DESIGN_SUBMITTED", "2026-09-30T10:00:00+08:00", "提交 R2：午睡区增设独立疏散指示灯回路、更换储物柜板材", {
  revision_no: 2,
  submitted_at: "2026-09-30",
});
add("design_revision", "DESIGN_APPROVED", "2026-10-02T11:00:00+08:00", "R2 图纸通过，仅涉及午睡区疏散与材料；活动室、保健区不在影响范围", {
  revision_no: 2,
  approving_authority: "区托育服务联合审查组",
  approved_at: "2026-10-02",
  supersedes_revision_no: 1,
  affected_scopes: ["egress", "material"],
  affected_zones: ["Z-NAP"],
});
add("design_revision", "FUNCTIONAL_ZONES_DEFINED", "2026-10-02T11:10:00+08:00", "R2 分区清单：午睡区维持 55㎡，其余分区不变", {
  revision_no: 2,
  zones: [
    { zone_id: "Z-NAP", name: "午睡区", purpose: "婴幼儿午睡", area_m2: 55 },
    { zone_id: "Z-PLAY", name: "活动室", purpose: "游戏与日间活动", area_m2: 75 },
    { zone_id: "Z-CARE", name: "保健观察与配餐区", purpose: "卫生保健、观察隔离与配餐", area_m2: 30, capacity_eligible: false },
  ],
});
add("design_revision", "MATERIAL_TEST_SUBMITTED", "2026-10-03T15:00:00+08:00", "R2 午睡区更换板材后 TVOC、阻燃复试合格（旧报告 MT-2026-0410 对午睡区失效）", {
  revision_no: 2,
  report_ref: "MT-2026-1003",
  issued_at: "2026-10-03",
  discipline: "material",
  covered_zones: ["Z-NAP"],
  valid_until: "2027-10-02",
});
add("design_revision", "DISCIPLINE_OPINION_ISSUED", "2026-10-04T09:30:00+08:00", "R2 消防意见：午睡区疏散改造合格（旧 FI-2026-0412 对午睡区失效，其余分区沿用）", {
  revision_no: 2,
  opinion_ref: "FI-2026-1004",
  discipline: "fire",
  issued_at: "2026-10-04",
  valid_until: "2027-10-03",
  verdict: "pass",
  covered_zones: ["Z-NAP"],
});
add("design_revision", "DISCIPLINE_OPINION_ISSUED", "2026-10-04T10:30:00+08:00", "R2 卫生意见：午睡区更换家具后室内空气合格（旧 HE-2026-0413 对午睡区失效）", {
  revision_no: 2,
  opinion_ref: "HE-2026-1004",
  discipline: "health",
  issued_at: "2026-10-04",
  valid_until: "2027-10-03",
  verdict: "pass",
  covered_zones: ["Z-NAP"],
});
add("inspection_finding", "DEFECT_RECTIFIED", "2026-10-04T16:00:00+08:00", "F-NAP-02 储物柜更换完成并附进场检测", {
  finding_id: "F-NAP-02",
  rectified_at: "2026-10-04",
  evidence_refs: ["EV-2026-1004-NAP-CAB-01.jpg", "MT-2026-1003"],
});
add("inspection_finding", "FINDING_VERIFIED", "2026-10-05T09:00:00+08:00", "F-NAP-02 复验通过", {
  finding_id: "F-NAP-02",
  verified_at: "2026-10-05",
  verifier: "区卫生健康中心 钱检查员",
  verdict: "pass",
});
add("inspection_finding", "DEFECT_RECTIFIED", "2026-10-05T11:00:00+08:00", "F-NAP-01 疏散指示与备用照明专用回路施工完成，申请复验", {
  finding_id: "F-NAP-01",
  rectified_at: "2026-10-05",
  evidence_refs: ["EV-2026-1005-NAP-EXIT-01.jpg", "EV-2026-1005-NAP-EXIT-02.jpg"],
});
add("design_revision", "CONSTRUCTION_COMPLETED", "2026-10-05T11:30:00+08:00", "R2 午睡区整改施工完成并自评（独立于设计通过，仍须复验与验收）", {
  revision_no: 2,
  completed_at: "2026-10-05",
  built_zones: ["Z-NAP"],
});

// ---------- 产权只剩两年：提前形成退出方案 ----------
add("opening_decision", "EXIT_PLAN_FORMED", "2026-10-05T15:00:00+08:00", "距到期两年，提前形成退出方案，覆盖设施、押金、长期班儿童安置与恢复责任", {
  plan_ref: "EX-2026-10-01",
  formed_at: "2026-10-05",
  target_exit_date: "2028-09-30",
  facilities: {
    responsible_party: "槐香里托育点运营方",
    arrangement: "可拆卸教玩具 2028 年 6 月前迁运至备选场地；固定装修按恢复责任处理",
  },
  deposit: {
    responsible_party: "槐城区公房管理中心",
    arrangement: "押金 8 万元在交还验收确认后 30 日内无息退还；欠费自押金抵扣并公示",
  },
  child_placement: {
    responsible_party: "区托育服务专班（牵头）会同运营方",
    long_term_classes: 2,
    children: 12,
    arrangement: "2028 年秋季开学前，按家长意愿优先转入就近公立托育点或对口幼儿园托班，一人一档跟踪到安置确认",
  },
  restoration: {
    responsible_party: "槐香里托育点运营方（施工保证金担保）",
    restore_to_use: "社区配套仓储用房",
    arrangement: "拆除隔断与坡道、封堵新增门洞、复原地面与墙面，经公房管理中心现场确认后签署交还单",
  },
});

await writeFile(new URL("../data/sample-stream.json", import.meta.url), JSON.stringify(events, null, 2) + "\n", "utf8");
await writeFile(new URL("../data/sample.json", import.meta.url), JSON.stringify(events[0], null, 2) + "\n", "utf8");
console.log(`已生成 ${events.length} 条事件 -> data/sample-stream.json`);
