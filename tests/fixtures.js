/**
 * 测试夹具：按时间顺序追加事件，自动分配四个聚合各自连续的 version。
 */
let streamCounter = 0;

export function streamBuilder() {
  const seq = {};
  const events = [];
  let n = 0;
  streamCounter += 1;

  function add(aggregateType, eventType, occurredAt, summary, payload = {}) {
    n += 1;
    seq[aggregateType] = (seq[aggregateType] ?? 0) + 1;
    events.push({
      event_id: `evt-s${streamCounter}-${String(n).padStart(4, "0")}`,
      event_type: eventType,
      aggregate_type: aggregateType,
      aggregate_id: "site-test",
      occurred_at: occurredAt,
      version: seq[aggregateType],
      summary,
      payload: { site_id: "site-test", ...payload },
    });
    return events;
  }

  return { events, add };
}

/**
 * 搭好一个"只差开园签署"的最小合规站点：
 * Z-A（45㎡，已验收、已备案 15 人、三线意见齐备），Z-B 尚未验收备案。
 */
export function setupReadySite() {
  const { events, add } = streamBuilder();
  add("property_term", "TERM_REGISTERED", "2027-01-01T09:00:00+08:00", "登记五年期使用权", {
    owner: "测试产权单位",
    original_use: "老旧仓库",
    term_start: "2027-01-01",
    term_end: "2031-12-31",
  });
  add("design_revision", "DESIGN_SUBMITTED", "2027-01-05T10:00:00+08:00", "R1 报审", {
    revision_no: 1,
    submitted_at: "2027-01-05",
  });
  add("design_revision", "DESIGN_APPROVED", "2027-01-10T10:00:00+08:00", "R1 通过", {
    revision_no: 1,
    approving_authority: "联合审查组",
    approved_at: "2027-01-10",
    supersedes_revision_no: 0,
    affected_scopes: ["layout", "structure", "mep", "fire", "material", "egress"],
  });
  add("design_revision", "FUNCTIONAL_ZONES_DEFINED", "2027-01-10T11:00:00+08:00", "划定两个分区", {
    revision_no: 1,
    zones: [
      { zone_id: "Z-A", name: "甲区", purpose: "活动与午睡", area_m2: 45 },
      { zone_id: "Z-B", name: "乙区", purpose: "活动", area_m2: 45 },
    ],
  });
  add("design_revision", "MATERIAL_TEST_SUBMITTED", "2027-01-15T10:00:00+08:00", "材料检测合格", {
    revision_no: 1,
    report_ref: "MT-1",
    issued_at: "2027-01-15",
    discipline: "material",
    covered_zones: ["Z-A", "Z-B"],
    valid_until: "2028-01-14",
  });
  add("design_revision", "DISCIPLINE_OPINION_ISSUED", "2027-01-16T10:00:00+08:00", "消防意见合格", {
    revision_no: 1,
    opinion_ref: "FI-1",
    discipline: "fire",
    issued_at: "2027-01-16",
    valid_until: "2028-01-15",
    verdict: "pass",
    covered_zones: ["Z-A", "Z-B"],
  });
  add("design_revision", "DISCIPLINE_OPINION_ISSUED", "2027-01-17T10:00:00+08:00", "卫生意见合格", {
    revision_no: 1,
    opinion_ref: "HE-1",
    discipline: "health",
    issued_at: "2027-01-17",
    valid_until: "2028-01-16",
    verdict: "pass",
    covered_zones: ["Z-A", "Z-B"],
  });
  add("design_revision", "CONSTRUCTION_COMPLETED", "2027-02-01T17:00:00+08:00", "施工完成（自评）", {
    revision_no: 1,
    completed_at: "2027-02-01",
    built_zones: ["Z-A", "Z-B"],
  });
  add("opening_decision", "CAPACITY_FILED", "2027-02-02T10:00:00+08:00", "甲区备案 15 人", {
    revision_no: 1,
    zone_id: "Z-A",
    ratio_basis: "人均使用面积 3㎡",
    area_m2: 45,
    per_child_m2: 3,
    filed_capacity: 15,
    filed_at: "2027-02-02",
  });
  add("inspection_finding", "ZONE_ACCEPTED", "2027-02-05T15:00:00+08:00", "甲区分区验收通过", {
    zone_id: "Z-A",
    revision_no: 1,
    accepted_at: "2027-02-05",
    acceptance_ref: "ACC-A",
    inspectors: ["消防检查员", "卫生检查员"],
  });
  return { events, add };
}

/** 打开 Z-A 的标准开园命令（局部开放）。 */
export function openingCommandA(overrides = {}) {
  return {
    kind: "partial",
    decided_at: "2027-02-10T10:00:00+08:00",
    decision_ref: "OD-A",
    signed_by: { name: "区托育专班 负责人" },
    basis_revision_no: 1,
    zones_requested: ["Z-A"],
    basis_refs: ["FI-1", "HE-1", "MT-1", "ACC-A"],
    evidence_refs: ["EV-SITE-01.jpg", "CHK-LIST.pdf"],
    conditions: ["在托人数不超过备案容量 15 人"],
    ...overrides,
  };
}
