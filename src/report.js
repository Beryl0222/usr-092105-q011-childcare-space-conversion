// 命令行查看：node src/report.js [YYYY-MM-DD]
// 输出该日期下的站点总览、招生页面投影、图纸修订重做清单与退出筹备状态。

import { replay, siteOverview, enrollmentPage, checksRequiringRedo } from "./domain.js";
import { buildScenario, SITE_ID } from "./scenario.js";

const date = process.argv[2] ?? new Date().toISOString().slice(0, 10);
const file = buildScenario();
const state = replay(SITE_ID, file.events);

const overview = siteOverview(state, date);
const page = enrollmentPage(state, date);

const lines = [];
lines.push(`# ${overview.产权期限.场地名称 ?? SITE_ID} 验收状态总览（${date}）`);
lines.push("");
lines.push(`- 产权期限：${overview.产权期限.状态}（${overview.产权期限.使用期限 ?? "-"}，剩余 ${overview.产权期限.剩余天数 ?? "-"} 天）`);
lines.push(`- 原用途：${overview.产权期限.原用途 ?? "-"}；产权单位：${overview.产权期限.产权单位 ?? "-"}；整栋建筑面积 ${overview.产权期限.整栋建筑面积_m2 ?? "-"} ㎡（不用于容量折算）`);
lines.push(`- 设计版次：${overview.设计与施工.当前版次 ?? "-"}｜设计通过：${overview.设计与施工.设计通过 ?? "-"}｜施工完成：${overview.设计与施工.施工完成 ?? "-"}`);
const opinionLine = (label, arr) =>
  `- ${label}：` + arr.map((o) => (o.意见书编号 ? `${o.意见书编号}[${o.对应版次}] ${o.状态}（${o.有效期}，覆盖 ${o.覆盖分区.join("/")}）` : o.状态)).join("；");
lines.push(opinionLine("消防意见", overview.消防意见));
lines.push(opinionLine("卫生意见", overview.卫生意见));
lines.push("");
lines.push("## 功能分区");
for (const z of overview.功能分区) {
  lines.push(
    `- ${z.分区} ${z.名称}（${z.功能}，${z.室内面积_m2}㎡，可计容量=${z.可计容量}）：材料${z.材料检测}｜验收=${z.分区验收}｜开园=${z.开园状态}${z.未闭环缺陷.length ? `｜未闭环：${z.未闭环缺陷.join("、")}` : ""}`,
  );
}
lines.push("");
lines.push("## 图纸修订后必须重做的检查");
const redo = checksRequiringRedo(state);
if (!redo.length) lines.push("- 无");
for (const r of redo) lines.push(`- ${r.zone_id}：${r.items.map((i) => (i.opinion_no ? `${i.type}(${i.opinion_no})` : i.type)).join("、")}`);
lines.push("");
lines.push("## 招生页面投影（对外只允许公布这些内容）");
lines.push(`- 是否公布：${page.publish ? "公布" : "不公布"}`);
lines.push(`- 页面状态：${page.status}`);
lines.push(`- 备案容量：${page.capacity_filed} 人（按当前获准分区人均 3㎡ 折算，非整栋面积）`);
lines.push(`- 开放分区：${page.zones_opened.join("、") || "无"}`);
if (page.restrictions.length) lines.push(`- 限制条件：${page.restrictions.map((x) => `\n  - ${x}`).join("")}`);
if (page.notices.length) lines.push(`- 页面提示：${page.notices.map((x) => `\n  - ${x}`).join("")}`);
lines.push(`- 现场证据：${page.evidence.map((x) => `${x.kind}/${x.ref}`).join("、") || "无"}`);
lines.push("");
lines.push("## 缺陷整改");
for (const f of overview.缺陷整改) lines.push(`- ${f.缺陷}（${f.分区}，${f.等级 ?? "-"}）：${f.状态}`);
lines.push("");
lines.push("## 退出恢复");
lines.push(`- 状态：${overview.退出恢复.状态}`);
if (overview.退出恢复.方案) {
  const p = overview.退出恢复.方案;
  lines.push(`- 方案 ${p.plan_id}（计划交还 ${p.target_handback_date}）`);
  lines.push(`  - 设施：${p.facilities}`);
  lines.push(`  - 押金：${p.deposit}`);
  lines.push(`  - 儿童安置：${p.child_placement}`);
  lines.push(`  - 恢复责任：${p.restoration}`);
}

console.log(lines.join("\n"));
