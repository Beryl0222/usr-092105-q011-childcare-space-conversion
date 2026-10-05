// 可复现的中文联调场景：槐荫里社区托育点。
// 叙事背景：
//   - 产权单位 2026-03 年明确场地使用权至 2028-09-30（开放日时只剩约两年）；
//   - R1 图纸施工完成后，午睡区存在 major 缺陷正在整改，首期只能局部开放；
//   - 招生页早期曾想按整栋 320㎡ 公布满额容量，被规则拒绝，最终只公布获准分区折算的 35 人；
//   - 2026-09 R2 图纸修订午睡区，旧材料、旧意见、旧缺陷、旧验收全部按分区作废重做；
//   - 截至 2026-10-05，午睡区新缺陷仍在整改，继续排除在开放范围外。

import { SiteFile } from "./domain.js";

export const SITE_ID = "site-huaiyinli-01";

const ZONES_R1 = [
  { zone_id: "Z-nap", name: "午睡区", function: "睡眠休憩", indoor_area_m2: 45, capacity_eligible: true },
  { zone_id: "Z-act", name: "活动室", function: "游戏活动", indoor_area_m2: 60, capacity_eligible: true },
  { zone_id: "Z-dining", name: "就餐区", function: "就餐", indoor_area_m2: 30, capacity_eligible: true },
  { zone_id: "Z-multi", name: "多功能厅", function: "共享活动（与社区老年活动室错时共用）", indoor_area_m2: 40, capacity_eligible: true },
  { zone_id: "Z-health", name: "保健观察室", function: "卫生保健与临时隔离", indoor_area_m2: 12, capacity_eligible: false },
];

const ZONES_R2 = ZONES_R1.map((z) => (z.zone_id === "Z-nap" ? { ...z, name: "午睡区（R2 增设直通疏散门）" } : z));

const photo = (ref, at) => ({ kind: "现场照片", ref, captured_at: at });
const record = (ref, at) => ({ kind: "验收记录", ref, captured_at: at });
const sign = (role, name, at) => ({ role, name, signed_at: at });

/** 以可变时钟构建场景；返回 { file, get events(), state }。 */
export function buildScenario() {
  let now = new Date("2026-03-02T09:00:00+08:00");
  const file = new SiteFile(SITE_ID, { now: () => now });
  const at = (iso) => { now = new Date(iso); };
  const evidence = (ref) => photo(ref, now.toISOString());

  at("2026-03-02T09:00:00+08:00");
  file.registerProperty({
    site_name: "槐荫里社区托育点",
    original_use: "社区配套服务用房（原居委会仓储用房）",
    property_unit: "老城建设投资有限公司",
    area_total_m2: 320,
    term_start: "2024-11-01",
    term_end: "2028-09-30",
  });

  at("2026-03-05T10:00:00+08:00");
  file.recordNeighborAgreement({
    agreement_id: "NB-2026-01",
    parties: ["槐荫里居委会", "槐荫里托育运营有限公司", "1 号楼临街居民代表"],
    terms: ["日间活动音乐音量不超过 60 分贝", "接送高峰 07:40–08:40 不得占用消防通道", "每月 5 日向居委会公示投诉处理情况"],
    valid_from: "2026-03-05",
    valid_until: "2028-09-30",
  });

  at("2026-04-01T14:00:00+08:00");
  file.submitDesign({
    revision_no: "R1",
    supersedes: null,
    zones: ZONES_R1,
    affected_zone_ids: [],
  });

  at("2026-04-18T15:00:00+08:00");
  file.approveDesign({ revision_no: "R1", approved_by: "区住建委设计审查科", conditions: [] });

  at("2026-05-30T16:00:00+08:00");
  file.completeConstruction({ revision_no: "R1", completed_note: "按 R1 图纸完成全部五个分区装修" });

  at("2026-06-02T11:00:00+08:00");
  const materials = [
    ["MT-R1-NAP-01", "Z-nap", "PVC 地胶"],
    ["MT-R1-ACT-01", "Z-act", "木地板"],
    ["MT-R1-DIN-01", "Z-dining", "防滑地砖"],
    ["MT-R1-MUL-01", "Z-multi", "PVC 地胶"],
    ["MT-R1-HEA-01", "Z-health", "水性内墙涂料"],
  ];
  for (const [report_no, zone_id, material] of materials) {
    file.recordMaterialTest({ revision_no: "R1", zone_id, material, report_no, result: "PASS" });
  }

  at("2026-06-12T10:30:00+08:00");
  file.recordFireOpinion({
    revision_no: "R1",
    opinion_no: "XF-2026-001",
    zone_ids: ["Z-nap", "Z-act", "Z-dining", "Z-multi", "Z-health"],
    result: "有条件合格",
    conditions: ["疏散通道全天保持畅通"],
    issued_on: "2026-06-10",
    valid_until: "2027-06-09",
  });
  file.recordHealthOpinion({
    revision_no: "R1",
    opinion_no: "WS-2026-001",
    zone_ids: ["Z-nap", "Z-act", "Z-dining", "Z-multi", "Z-health"],
    result: "有条件合格",
    conditions: ["在岗保育员持有效健康证"],
    issued_on: "2026-06-11",
    valid_until: "2027-06-10",
  });

  at("2026-06-18T09:30:00+08:00");
  file.recordInspection({
    finding_id: "FD-NAP-01",
    revision_no: "R1",
    zone_id: "Z-nap",
    category: "消防",
    severity: "major",
    description: "午睡区应急照明照度不足，且一具疏散指示标志损坏",
    evidence: [photo("EV-NAP-01-A", now.toISOString())],
  });
  at("2026-06-20T14:00:00+08:00");
  file.assignDefect({ finding_id: "FD-NAP-01", assignee: "施工方项目经理 周工", due_date: "2026-07-31" });

  at("2026-06-25T10:00:00+08:00");
  for (const zone_id of ["Z-act", "Z-dining", "Z-multi"]) {
    file.acceptZone({
      revision_no: "R1",
      zone_id,
      signers: [
        sign("街道办事处验收专员", "李建国", now.toISOString()),
        sign("托育机构负责人", "陈敏", now.toISOString()),
      ],
      notes: `${zone_id} 现场复核符合 R1 图纸与部门意见`,
    });
  }

  at("2026-06-26T15:00:00+08:00");
  file.agreeSharedSlot({
    zone_id: "Z-multi",
    partner: "槐荫里社区老年活动室",
    slots: [
      { weekday: "周一", from: "08:00", to: "12:00", exclusive_for_childcare: true },
      { weekday: "周二", from: "08:00", to: "12:00", exclusive_for_childcare: true },
      { weekday: "周三", from: "08:00", to: "12:00", exclusive_for_childcare: true },
      { weekday: "周四", from: "08:00", to: "12:00", exclusive_for_childcare: true },
      { weekday: "周五", from: "08:00", to: "12:00", exclusive_for_childcare: true },
      { weekday: "周二", from: "14:00", to: "17:00", exclusive_for_childcare: false },
      { weekday: "周四", from: "14:00", to: "17:00", exclusive_for_childcare: false },
    ],
  });

  at("2026-06-28T16:00:00+08:00");
  file.decideOpening({
    decision_no: "OD-2026-01",
    mode: "PARTIAL",
    revision_no: "R1",
    zone_ids: ["Z-act", "Z-dining", "Z-multi"],
    excluded_zone_ids: ["Z-nap", "Z-health"],
    conditions: [
      "午睡区 FD-NAP-01 整改并复验前，幼儿不得进入午睡区，午休暂在活动室分区进行",
      "多功能厅非专用时段（周二、周四下午）不得安排幼儿活动",
    ],
    isolation_measures: "午睡区入口设置 1.2 米固定式围挡并张贴停用标识，由保健员每半日巡查一次",
    capacity_filed: 35,
    staffing: { caregivers: 6, ratio: 7 },
    restrictions: [
      "疏散通道全天保持畅通",
      "在岗保育员持有效健康证",
      "停止招收两年期及以上长期班，任何班期结业日不得晚于场地使用权到期日 2028-09-30，退出安排提前半年公告",
      "多功能厅仅在托育专用时段计入使用，周二、周四下午由社区老年活动室使用",
    ],
    evidence: [
      photo("EV-OPEN-01-A", now.toISOString()),
      photo("EV-OPEN-01-B", now.toISOString()),
      record("EV-OPEN-01-C", now.toISOString()),
    ],
    signers: [
      sign("街道（主管部门）批准人", "李建国", now.toISOString()),
      sign("托育机构负责人", "陈敏", now.toISOString()),
    ],
    valid_from: "2026-07-01",
    valid_until: "2027-06-09",
    based_on: {
      fire_opinion_nos: ["XF-2026-001"],
      health_opinion_nos: ["WS-2026-001"],
      material_report_nos: ["MT-R1-ACT-01", "MT-R1-DIN-01", "MT-R1-MUL-01"],
    },
  });

  // —— 2026-09：午睡区图纸修订 R2 ——
  at("2026-09-15T09:00:00+08:00");
  file.submitDesign({
    revision_no: "R2",
    supersedes: "R1",
    zones: ZONES_R2,
    affected_zone_ids: ["Z-nap"],
  });

  at("2026-09-18T10:00:00+08:00");
  file.approveDesign({ revision_no: "R2", approved_by: "区住建委设计审查科", conditions: [] });

  at("2026-09-19T17:00:00+08:00");
  file.completeConstruction({ revision_no: "R2", completed_note: "午睡区按 R2 增设直通疏散门并完成隔墙改造" });

  at("2026-09-20T10:00:00+08:00");
  file.recordMaterialTest({ revision_no: "R2", zone_id: "Z-nap", material: "防火门与新装 PVC 地胶", report_no: "MT-R2-NAP-01", result: "PASS" });

  at("2026-09-22T10:00:00+08:00");
  file.recordFireOpinion({
    revision_no: "R2",
    opinion_no: "XF-2026-018",
    zone_ids: ["Z-nap"],
    result: "合格",
    conditions: [],
    issued_on: "2026-09-21",
    valid_until: "2027-09-20",
  });
  file.recordHealthOpinion({
    revision_no: "R2",
    opinion_no: "WS-2026-022",
    zone_ids: ["Z-nap"],
    result: "合格",
    conditions: [],
    issued_on: "2026-09-21",
    valid_until: "2027-09-20",
  });

  at("2026-09-25T11:00:00+08:00");
  file.recordInspection({
    finding_id: "FD-NAP-02",
    revision_no: "R2",
    zone_id: "Z-nap",
    category: "消防",
    severity: "major",
    description: "新增直通疏散门后，门两侧隔墙耐火极限现场存疑，需提供隐蔽工程影像并复测",
    evidence: [photo("EV-NAP-02-A", now.toISOString())],
  });
  at("2026-09-28T14:30:00+08:00");
  file.assignDefect({ finding_id: "FD-NAP-02", assignee: "施工方项目经理 周工", due_date: "2026-10-20" });

  return file;
}

export { photo, record, sign };
