/**
 * 领域事件目录：多部门补件统一落在底座的四个聚合上：
 * property_term / design_revision / inspection_finding / opening_decision。
 *
 * 三道闸门分别由不同事件表达，任何代码与报表面板都不得合并：
 *   设计通过  DESIGN_APPROVED      —— 图纸可以据此施工，不代表现场合格
 *   施工完成  CONSTRUCTION_COMPLETED —— 施工方自评完工，不代表任何检查通过
 *   允许收托  OPENING_DECIDED      —— 满足全部前置条件后由责任主体签署
 */

export const AGGREGATES = Object.freeze({
  PROPERTY_TERM: "property_term",
  DESIGN_REVISION: "design_revision",
  INSPECTION_FINDING: "inspection_finding",
  OPENING_DECISION: "opening_decision",
});

/** 图纸修订影响范围：决定哪些既有检查结论在修订后必须重做。 */
export const REVISION_SCOPES = Object.freeze({
  LAYOUT: "layout", // 功能分区与平面
  STRUCTURE: "structure", // 结构与分隔
  MEP: "mep", // 机电与给排水
  FIRE: "fire", // 消防专项
  MATERIAL: "material", // 装修材料
  EGRESS: "egress", // 疏散通道
  FACADE: "facade", // 外立面与招牌
});

/** 检查专业线，同时是意见出具单位类别。 */
export const INSPECTION_DISCIPLINES = Object.freeze({
  FIRE: "fire",
  HEALTH: "health",
  MATERIAL: "material",
  STRUCTURE: "structure",
  MEP: "mep",
});

/** 缺陷严重级别：major 阻断所在分区收托；minor 可带条件局部开放。 */
export const DEFECT_SEVERITIES = Object.freeze({
  MAJOR: "major",
  MINOR: "minor",
});

export const FINDING_STATUS = Object.freeze({
  OPEN: "open",
  RECTIFIED: "rectified", // 已整改，待复验
  VERIFIED: "verified", // 复验通过
  WAIVED: "waived", // 按明确依据豁免
});

export const ZONE_STATUS = Object.freeze({
  PENDING: "pending",
  ACCEPTED: "accepted",
  REJECTED: "rejected",
});

/** 开园决定类型。 */
export const OPENING_KINDS = Object.freeze({
  FULL: "full", // 整址开放
  PARTIAL: "partial", // 分区局部开放
  SUSPEND: "suspend", // 暂停收托
  RESCIND: "rescind", // 撤销此前开放
});

export const CAPACITY_SOURCES = Object.freeze({
  DESIGN: "design", // 设计测算（仅供内部）
  FILED: "filed", // 备案容量
  PUBLISHED: "published", // 招生页面发布
});

/**
 * 事件目录：aggregate -> { eventType -> 负载必填字段 }
 * 日期型字段会被校验器识别为 ISO-8601。
 */
export const EVENT_CATALOG = Object.freeze({
  property_term: {
    TERM_REGISTERED: {
      required: ["site_id", "owner", "original_use", "term_start", "term_end"],
      dates: ["term_start", "term_end"],
    },
    TERM_CHANGED: {
      required: ["site_id", "term_end", "reason"],
      dates: ["term_end"],
    },
    ORIGINAL_USE_RECORDED: {
      required: ["site_id", "original_use", "evidence_ref"],
    },
    NEIGHBOR_AGREEMENT_RECORDED: {
      required: ["site_id", "agreement_ref", "parties", "agreed_from", "agreed_until"],
      dates: ["agreed_from", "agreed_until"],
    },
    SHARING_SCHEDULE_RECORDED: {
      required: ["site_id", "space", "slots"],
    },
  },

  design_revision: {
    DESIGN_SUBMITTED: {
      required: ["site_id", "revision_no", "submitted_at"],
      dates: ["submitted_at"],
    },
    DESIGN_APPROVED: {
      required: ["site_id", "revision_no", "approving_authority", "approved_at", "supersedes_revision_no", "affected_scopes"],
      dates: ["approved_at"],
    },
    FUNCTIONAL_ZONES_DEFINED: {
      required: ["site_id", "revision_no", "zones"],
    },
    MATERIAL_TEST_SUBMITTED: {
      required: ["site_id", "revision_no", "report_ref", "issued_at", "discipline", "covered_zones", "valid_until"],
      dates: ["issued_at", "valid_until"],
    },
    DISCIPLINE_OPINION_ISSUED: {
      required: ["site_id", "revision_no", "opinion_ref", "discipline", "issued_at", "valid_until", "verdict", "covered_zones"],
      dates: ["issued_at", "valid_until"],
    },
    CONSTRUCTION_COMPLETED: {
      required: ["site_id", "revision_no", "completed_at", "built_zones"],
      dates: ["completed_at"],
    },
  },

  inspection_finding: {
    INSPECTION_RECORDED: {
      required: ["site_id", "revision_no", "finding_id", "zone_id", "discipline", "finding", "severity"],
    },
    DEFECT_ASSIGNED: {
      required: ["site_id", "finding_id", "zone_id", "responsible_party", "due_date"],
      dates: ["due_date"],
    },
    DEFECT_RECTIFIED: {
      required: ["site_id", "finding_id", "rectified_at", "evidence_refs"],
      dates: ["rectified_at"],
    },
    FINDING_VERIFIED: {
      required: ["site_id", "finding_id", "verified_at", "verifier", "verdict"],
      dates: ["verified_at"],
    },
    FINDING_WAIVED: {
      required: ["site_id", "finding_id", "waived_at", "approver", "basis_ref"],
      dates: ["waived_at"],
    },
    ZONE_ACCEPTED: {
      required: ["site_id", "zone_id", "revision_no", "accepted_at", "acceptance_ref", "inspectors"],
      dates: ["accepted_at"],
    },
  },

  opening_decision: {
    CAPACITY_FILED: {
      required: ["site_id", "revision_no", "zone_id", "ratio_basis", "area_m2", "per_child_m2", "filed_capacity", "filed_at"],
      dates: ["filed_at"],
    },
    OPENING_DECIDED: {
      required: [
        "site_id",
        "kind",
        "decided_at",
        "decision_ref",
        "signed_by",
        "basis_revision_no",
        "zones_requested",
        "basis_refs",
        "evidence_refs",
        "conditions",
      ],
      dates: ["decided_at"],
    },
    CAPACITY_PUBLISHED: {
      required: ["site_id", "published_at", "page_ref", "zones_included", "published_capacity"],
      dates: ["published_at"],
    },
    EXIT_PLAN_FORMED: {
      required: ["site_id", "plan_ref", "formed_at", "target_exit_date", "facilities", "deposit", "child_placement", "restoration"],
      dates: ["formed_at", "target_exit_date"],
    },
    SITE_HANDED_BACK: {
      required: ["site_id", "handed_back_at", "handover_ref", "restoration_confirmed_by", "children_settled"],
      dates: ["handed_back_at"],
    },
  },
});

/** 事件类型 -> 所属聚合（反查表）。 */
export const EVENT_AGGREGATE = Object.freeze(
  Object.fromEntries(
    Object.entries(EVENT_CATALOG).flatMap(([aggregate, events]) =>
      Object.keys(events).map((eventType) => [eventType, aggregate]),
    ),
  ),
);

export const ALL_EVENT_TYPES = Object.freeze(Object.keys(EVENT_AGGREGATE));
