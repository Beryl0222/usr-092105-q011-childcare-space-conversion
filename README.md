# 老城区托育空间改造验收系统

记录并裁决老城区存量房屋改造为托育点的跨部门事实，保证以下事项各自有清晰状态、各有签署与证据：

| 状态项 | 事实来源（事件，沿用底座四聚合） |
| --- | --- |
| 产权期限 | `TERM_REGISTERED`、`TERM_CHANGED`（property_term） |
| 原用途 | `ORIGINAL_USE_RECORDED`（property_term） |
| 设计版次 | `DESIGN_SUBMITTED`、`DESIGN_APPROVED`（design_revision） |
| 功能分区 | `FUNCTIONAL_ZONES_DEFINED`（design_revision） |
| 材料检测 | `MATERIAL_TEST_SUBMITTED`（design_revision） |
| 消防/卫生意见 | `DISCIPLINE_OPINION_ISSUED`（design_revision） |
| 人员容量 | `CAPACITY_FILED`、`CAPACITY_PUBLISHED`（opening_decision） |
| 共享时段 | `SHARING_SCHEDULE_RECORDED`（property_term） |
| 邻里约定 | `NEIGHBOR_AGREEMENT_RECORDED`（property_term） |
| 缺陷整改 | `INSPECTION_RECORDED`、`DEFECT_ASSIGNED`、`DEFECT_RECTIFIED`、`FINDING_VERIFIED`、`FINDING_WAIVED`（inspection_finding） |
| 分区验收 | `ZONE_ACCEPTED`（inspection_finding） |
| 开园限制 | `OPENING_DECIDED`（opening_decision，kind=full/partial/suspend/rescind） |
| 退出安排 | `EXIT_PLAN_FORMED`、`SITE_HANDED_BACK`（opening_decision） |
| 施工状态 | `CONSTRUCTION_COMPLETED`（design_revision） |

多部门补件统一落在底座的四个聚合上：`property_term`、`design_revision`、`inspection_finding`、`opening_decision`。

## 核心规则

1. **三道闸门绝不合并**：`DESIGN_APPROVED`（设计通过）、`CONSTRUCTION_COMPLETED`（施工完成）、`OPENING_DECIDED`（允许收托）是三个独立事实。施工方自评完工既不代表检查通过，也不产生任何收托资格。
2. **图纸修订即算重做账**：`DESIGN_APPROVED` 带 `affected_scopes`（layout/structure/mep/fire/material/egress/facade）与 `affected_zones`。系统按修订影响矩阵（`src/policy.js` 的 `REVISION_IMPACT`）自动列出每个分区必须重做的专业意见、材料复试、缺陷复查与分区验收；未被修订触及的分区与专业线沿用既有结论。
3. **过期意见不得重新引用**：消防、卫生意见与材料检测均带 `valid_until` 和出具版次；开园决定逐条引用文书编号，系统同时校验有效期、版次链与覆盖分区。
4. **有缺陷区域只能局部开放**：存在未关闭严重缺陷（major）的分区禁止收托；仅当无严重缺陷、分区已按现行版次验收、三线文书现行有效、每个一般缺陷（minor）都在 `conditions` 中写清限制条件与整改期限，并由责任主体 `signed_by` 签署后，方可局部开放。
5. **招生容量只认获准区域**：招生页面 `CAPACITY_PUBLISHED` 只能发布"当前获准开放分区"的备案容量合计；备案容量必须按**分区使用面积 ÷ 人均指标**折算，禁止按整栋建筑面积公布满额。
6. **开园决定必有现场证据**：每次 `OPENING_DECIDED` 必须附 `evidence_refs`（照片/视频/现场清单）、`basis_refs`（逐条文书编号）与 `conditions`（限制条件）。
7. **期限临近先有退出方案**：距产权到期不足 12 个月时，未形成 `EXIT_PLAN_FORMED` 不得继续作出开园决定；退出方案必须齐备设施处置、押金清退、儿童安置（含长期班责任人）、恢复为原用途的责任安排；交还须儿童已安置且恢复经产权单位确认。

## 代码结构

- `contracts/domain.schema.json`：事件信封与 22 类事件的契约。
- `src/events.js`：事件目录——聚合归属、各事件负载必填字段、枚举。
- `src/validator.js`：单事件与事件流校验（聚合归属、版本连续、负载与日期）。
- `src/policy.js`：修订影响矩阵、容量折算、意见有效性窗口、租期阈值（纯规则）。
- `src/project.js`：事件投影——三道闸门、分区状态、开放集合重放、重做台账、容量口径、事后稽核。
- `src/commands.js`：写入侧前置校验——开园决定、容量备案、招生发布、退出方案、交还。
- `src/report.js`：只读状态台 CLI。
- `data/sample-stream.json`：老城区"槐香里托育点"37 条完整中文场景事件（午睡区缺陷整改、R2 图纸修订、局部开放、容量发布、两年租期退出方案）。
- `scripts/build-sample.mjs`：场景事件生成器。
- `tests/`：契约测试、领域规则测试、场景集成测试。

## 使用

```bash
npm test                 # 运行全部测试（node --test）
node src/report.js       # 输出样例站点十三类状态台
node scripts/build-sample.mjs   # 重新生成 data/sample-stream.json
```

事件由 `event_id` 唯一标识，来源系统重试必须沿用原标识；同一聚合内 `version` 从 1 连续递增，`occurred_at` 保留真实发生时间。
