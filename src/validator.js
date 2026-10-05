import { EVENT_AGGREGATE, EVENT_CATALOG } from "./events.js";

const ENVELOPE_REQUIRED = [
  "event_id",
  "event_type",
  "aggregate_type",
  "aggregate_id",
  "occurred_at",
  "version",
  "summary",
  "payload",
];

const ISO_DATE = /^\d{4}-\d{2}-\d{2}(T.*)?$/;

function isIsoDate(value) {
  return typeof value === "string" && ISO_DATE.test(value) && !Number.isNaN(Date.parse(value));
}

/** 单条事件信封校验：结构、聚合归属、负载必填字段、日期格式。 */
export function validateEvent(record) {
  const errors = ENVELOPE_REQUIRED.filter((name) => !(name in record)).map(
    (name) => `缺少字段：${name}`,
  );
  if (errors.length) return errors;

  const { event_type: type, aggregate_type: aggregate } = record;

  if (!Number.isInteger(record.version) || record.version < 1) {
    errors.push("version 必须是正整数");
  }
  if (typeof record.event_id !== "string" || record.event_id.length < 8) {
    errors.push("event_id 长度不足 8 位");
  }
  if (!isIsoDate(record.occurred_at)) {
    errors.push("occurred_at 必须是 ISO-8601 时间");
  }
  if (typeof record.summary !== "string" || record.summary.trim().length < 2) {
    errors.push("summary 必须是不少于 2 个字符的中文摘要");
  }

  const ownerAggregate = EVENT_AGGREGATE[type];
  if (!ownerAggregate) {
    errors.push(`未知事件类型：${type}`);
    return errors;
  }
  if (aggregate !== ownerAggregate) {
    errors.push(`事件 ${type} 必须登记在聚合 ${ownerAggregate}，实际为 ${aggregate}`);
  }

  const spec = EVENT_CATALOG[ownerAggregate][type];
  const payload = record.payload;
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    errors.push("payload 必须是对象");
    return errors;
  }
  for (const field of spec.required ?? []) {
    const value = payload[field];
    const empty =
      value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0);
    if (empty) errors.push(`负载缺少必填字段：${field}`);
  }
  for (const field of spec.dates ?? []) {
    if (payload[field] !== undefined && !isIsoDate(payload[field])) {
      errors.push(`负载字段 ${field} 必须是 ISO-8601 日期`);
    }
  }
  return errors;
}

/**
 * 流级校验：event_id 不得重复；同一聚合内 version 必须从 1 连续递增。
 * 跨聚合事件按 occurred_at 交织不影响各自版本序列。
 */
export function validateStream(events) {
  const errors = [];
  const seenIds = new Set();
  const versions = new Map();

  events.forEach((event, index) => {
    const at = (text) => `第 ${index + 1} 条事件（${event.event_id ?? "无标识"}）：${text}`;

    if (seenIds.has(event.event_id)) errors.push(at("event_id 重复，补件重试必须沿用原事件而非新增"));
    seenIds.add(event.event_id);

    for (const err of validateEvent(event)) errors.push(at(err));

    const key = `${event.aggregate_type}/${event.aggregate_id}`;
    const next = (versions.get(key) ?? 0) + 1;
    if (event.version !== next) {
      errors.push(at(`聚合 ${key} 版本不连续：期望 ${next}，实际 ${event.version}`));
    }
    versions.set(key, event.version);
  });
  return errors;
}
