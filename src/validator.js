// 事件信封校验：在底座公共标识（event_id / aggregate_id / version / occurred_at）
// 之上补充本领域允许的事件类型与四个聚合的配对关系。
// 只校验信封，不替代 src/domain.js 中的业务规则。

export const EVENT_TYPES = [
  "PROPERTY_TERM_REGISTERED",
  "NEIGHBOR_AGREEMENT_RECORDED",
  "SHARED_SLOT_AGREED",
  "EXIT_PLAN_FORMED",
  "SITE_HANDED_BACK",
  "DESIGN_SUBMITTED",
  "DESIGN_APPROVED",
  "CONSTRUCTION_COMPLETED",
  "MATERIAL_TEST_RECORDED",
  "FIRE_OPINION_RECORDED",
  "HEALTH_OPINION_RECORDED",
  "INSPECTION_RECORDED",
  "DEFECT_ASSIGNED",
  "DEFECT_RECTIFIED",
  "ZONE_ACCEPTED",
  "OPENING_DECIDED",
];

export const AGGREGATE_TYPES = ["property_term", "design_revision", "inspection_finding", "opening_decision"];

// 事件类型必须落在对应的聚合上：多部门补件不得新开聚合类型。
const EVENT_AGGREGATE = {
  PROPERTY_TERM_REGISTERED: "property_term",
  NEIGHBOR_AGREEMENT_RECORDED: "property_term",
  SHARED_SLOT_AGREED: "property_term",
  EXIT_PLAN_FORMED: "property_term",
  SITE_HANDED_BACK: "property_term",
  DESIGN_SUBMITTED: "design_revision",
  DESIGN_APPROVED: "design_revision",
  CONSTRUCTION_COMPLETED: "design_revision",
  MATERIAL_TEST_RECORDED: "design_revision",
  FIRE_OPINION_RECORDED: "design_revision",
  HEALTH_OPINION_RECORDED: "design_revision",
  INSPECTION_RECORDED: "inspection_finding",
  DEFECT_ASSIGNED: "inspection_finding",
  DEFECT_RECTIFIED: "inspection_finding",
  ZONE_ACCEPTED: "inspection_finding",
  OPENING_DECIDED: "opening_decision",
};

const required = ["event_id", "event_type", "aggregate_type", "aggregate_id", "occurred_at", "version", "summary", "payload"];

const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/** 返回可以直接展示给接入方的中文错误；无错误时返回空数组。 */
export function validateEvent(record) {
  const errors = required
    .filter((name) => !(name in record))
    .map((name) => `缺少字段：${name}`);
  if (errors.length) return errors;

  if (typeof record.event_id !== "string" || record.event_id.length < 8) errors.push("event_id 长度不足 8 位");
  if (!EVENT_TYPES.includes(record.event_type)) errors.push(`不支持的事件类型：${record.event_type}`);
  if (!AGGREGATE_TYPES.includes(record.aggregate_type)) errors.push(`不支持的聚合类型：${record.aggregate_type}`);
  if (EVENT_AGGREGATE[record.event_type] && EVENT_AGGREGATE[record.event_type] !== record.aggregate_type) {
    errors.push(`事件 ${record.event_type} 必须挂在聚合 ${EVENT_AGGREGATE[record.event_type]} 下，不能挂到 ${record.aggregate_type}`);
  }
  if (typeof record.aggregate_id !== "string" || record.aggregate_id.length < 1) errors.push("aggregate_id 不能为空");
  if (!ISO_DATE_TIME.test(record.occurred_at)) errors.push("occurred_at 必须是带时区的 ISO 日期时间");
  if (!Number.isInteger(record.version) || record.version < 1) errors.push("version 必须是正整数");
  if (typeof record.summary !== "string" || record.summary.length < 2) errors.push("summary 至少 2 个字符");
  if (typeof record.payload !== "object" || record.payload === null || Array.isArray(record.payload)) {
    errors.push("payload 必须是对象");
  }
  return errors;
}

/** 校验整段事件流：信封合法、event_id 不重复、同一聚合流（类型+标识）version 连续递增。 */
export function validateStream(events) {
  const seenIds = new Set();
  const versions = new Map();
  const errors = [];
  events.forEach((event, index) => {
    validateEvent(event).forEach((message) => errors.push(`第 ${index + 1} 条事件（${event.event_id ?? "?"}）：${message}`));
    if (seenIds.has(event.event_id)) errors.push(`event_id 重复：${event.event_id}（来源系统重试必须沿用原标识，而不是新发一条）`);
    seenIds.add(event.event_id);
    const streamKey = `${event.aggregate_type}:${event.aggregate_id}`;
    const next = versions.get(streamKey) ?? 1;
    if (event.version !== next) {
      errors.push(`聚合流 ${streamKey} 的 version 应从 1 连续递增，期望 ${next}，实际 ${event.version}`);
    }
    versions.set(streamKey, next + 1);
  });
  return errors;
}
