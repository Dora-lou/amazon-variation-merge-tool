# 执行规则补充

## 数据统计与去重不是同一个周期

- report_days：本次出单词报告回溯天数，由用户自定义。
- duplicate_impression_days：判断关键词是否已经有效投放的曝光检查窗口，默认 7 天，可配置。
- 后续自动调价观察周期不属于第一阶段，不要将其混入创建任务。

## Campaign Pool 键

建议使用稳定键：

store_id|marketplace|advertised_asin|pool_key

其中 pool_key 由结构配置决定，例如：
- exact
- phrase_broad
- phrase
- broad
- all_match_types

Campaign Registry 必须以 Campaign ID 为主键，名称只用于展示。用户手动修改名称后，仍能找到对应 Campaign。

## 容量分配

- Campaign 总关键词数 = 该 Campaign 下所有 Ad Group 的 Keyword Target 数量。
- 一个词投放 Exact 和 Phrase，计为两条 Keyword Target。
- Phrase + Broad 共用 Campaign 时，两个 Ad Group 的 Keyword Target 数量合并计数。
- 追加前重新读取广告实际对象数量，不能只相信本地缓存计数。
- 本地 Registry 与领星实际数据不一致时，以领星实际数据为准并修复 Registry。
- 未满 Campaign 优先复用；达到上限后新建下一序号 Campaign。
- 如果一批新词跨越容量边界，先填旧 Campaign，再创建新 Campaign。

## 关键词候选分配

- 每个匹配方式独立判断订单区间，允许区间重叠。
- 同一个搜索词可生成多个 Keyword Target（不同 Match Type）。
- 每个 Match Type 独立做去重。
- 每个 Match Type 内按相关性、目标 ACOS 下的表现、CVR、订单量排序。
- 共享 Campaign 容量有限时，按 Exact、Phrase、Broad 的匹配优先级分配；同一匹配方式内再按关键词质量排序。若 Exact 未选中，则从已选匹配方式开始。
- 不为凑满数量添加不合格词。

## Bid 递减

对同一 Customer Search Term 先计算基础 CPC，再乘以用户配置的系数。默认 Exact=1.00、Phrase=0.85、Broad=0.70。

两位小数舍入后仍必须严格递减。若无法同时满足最低 Bid、最高 Bid 和递减关系，不要强行创建，标记为待人工确认。

## 状态边界

- 新建 Campaign：PAUSED。
- 新建 Ad Group、Product Ad、Keyword：ENABLED。
- 复用已启用的 Skill Campaign：Campaign 保持 ENABLED，新 Keyword ENABLED，所属 Skill Ad Group 必须 ENABLED。
- 复用仍暂停的 Skill Campaign：Campaign 保持 PAUSED，Ad Group/Keyword ENABLED。
- 对非 Skill Campaign：任何写操作均禁止。

## 部分失败

每次广告创建均先读取已有对象。写操作返回的 ID 必须保存。任何重试前重新读取，以免因上次部分成功而重复创建。不能通过删除已创建对象来掩盖失败。
