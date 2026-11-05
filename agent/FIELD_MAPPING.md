# 销售计划只读字段映射

更新时间：2026-11-04。此文档记录通过领星 MCP `help → search` 确认的只读接口，以及宿主采集层实际采用的规范字段。领星 `search` 当前只返回入参 Schema，不返回完整出参 Schema；因此出参字段只有在目标查询的真实响应中出现时才标记为 `value_present` 或 `reported_zero`，未出现一律是 `field_missing`，不能按 0 计算。

## 标识映射

| 规范字段 | 领星响应候选字段 | 含义与约束 |
| --- | --- | --- |
| `parent_asin` | `parent_asin`, `parentAsin`, `parentASIN` | 父体 ASIN；先由目标 ASIN Listing 识别，再用父 ASIN精确展开全家族。 |
| `asin` | `asin`, `ASIN`, `child_asin`, `childAsin` | 子 ASIN。父体查询返回的每一行必须属于已确认父体。 |
| `sku` | `local_sku`, `localSku`, `sku`, `SKU` | 领星本地 SKU。不得默认等同于 Amazon MSKU。 |
| `msku` | `seller_sku`, `sellerSku`, `msku`, `MSKU` | Amazon Seller SKU/MSKU。 |
| `fnsku` | `fnsku`, `FNSKU` | Amazon FNSKU。 |

`erp_listing` 已由 MCP 元数据确认是只读接口，支持 `asin`、`parent_asin`、`msku` 等搜索维度。采集顺序固定为：目标 ASIN 精确查询 → 识别唯一父 ASIN → 父 ASIN 分页展开。相同 SKU/MSKU/FNSKU 指向多个子 ASIN、分页未完成或任一子体缺少全部 SKU 标识时，映射状态为 `needs_review`。

## 历史自然月销量

| 项目 | 当前实现 |
| --- | --- |
| 接口 | `query_product_performance_asin_lists`（只读） |
| 目标范围 | 已确认父 ASIN；无法确认父体时仅查询请求 ASIN |
| 日期口径 | `date_type=purchase`，按下单时间 |
| 时间维度 | `date_view_type=month`，自然月 |
| 汇总维度 | `summary_field=sku`, `summary_field_level1=sku` |
| 数量字段 | `volume`, `sales_quantity`, `salesQuantity`, `totalSalesQuantity` 中实际出现的字段 |
| 月份字段 | `month`, `date`, `date_time`, `dateTime`, `report_date`, `reportDate` 中实际出现的字段 |
| 完整性检查 | 必须覆盖规划月份对应的全部去年同期自然月；缺月为 `period_incomplete` |

查询从“去年同期规划起点”和“当前月往前 24 个月”中的更早日期开始，到上一个完整自然月末结束。`query_order_profit=false`，避免把订单利润明细混入销量响应。`platform_v2_page_list` 虽然是只读销量统计接口，但其 Schema 没有目标 ASIN/SKU搜索参数，因此不进入白名单，避免拉取并混入其他产品。

完整自然月查询实际截止到上一个自然月末，避免把本月累计销量冒充整月。相同只读接口另执行一次最近30个已结束自然日查询（`date_view_type=day`），只用于趋势说明，不替代自然月季节性。历史结果如包含多个店铺、同一SKU月份重复行或缺少任一同期月份，计划计算会被阻断。

## 库存字段

### FBA/AWD 快照：`get_fba_stock_list`

| 计划字段 | 响应候选字段 | 统计口径与风险 |
| --- | --- | --- |
| FBA 可售 | `afn_fulfillable_quantity`, `fba_available_quantity`, `available_quantity` | 当前可履约库存；只有目标 SKU 行明确返回时才可使用。 |
| FBA 待调仓 | `afn_reserved_fc_transfers`, `reserved_fc_transfers`, `pending_transfer_quantity`, `transfer_quantity` | FC 调拨/待调仓候选；不能标成当前可售。具体字段语义仍须以目标账户返回字段人工确认。 |
| FBA 入库中总量 | `inbound_quantity`, `afn_inbound_quantity` | 若返回总量，不与下列 working/shipped/receiving 再次相加。 |
| FBA 入库计划 | `afn_inbound_working_quantity`, `inbound_working_quantity` | 入库流程 working 阶段。 |
| FBA 已发往仓库 | `afn_inbound_shipped_quantity`, `inbound_shipped_quantity` | 已发货但未完全接收；可能与“实际在途”重叠。 |
| FBA 接收中 | `afn_inbound_receiving_quantity`, `inbound_receiving_quantity` | Amazon 接收中；可能与入库总量重叠。 |
| AWD 可用 | `awd_available_quantity`, `awd_available`, `awd_available_inventory`, `awd_usable_quantity` | 只有响应实际出现字段时才可使用。 |
| AWD 标发在途 | `awd_standard_transit_quantity`, `awd_standard_transit`, `awd_inbound_quantity`, `awd_to_fba_quantity` | 字段语义和是否已包含于 FBA 在途需人工核对。 |

查询使用完整子 ASIN数组的高级搜索，显式 `is_hide_zero_stock=0`。响应行必须匹配已确认的 ASIN/SKU/MSKU/FNSKU 范围；接口返回但全部越界时标记 `out_of_scope_response`，不会进入模型。

### 补货与在途：`query_fba_valid_list`

| 计划字段 | 响应候选字段 | 风险 |
| --- | --- | --- |
| FBA 实际在途 | `real_transit_quantity`, `actualTransitQuantity`, `actual_transit_quantity` | 补货建议口径中的在途候选；需与货件、FBA shipped/receiving 及 AWD 标发在途按批次/日期去重。 |
| FBA 计划入库 | `stock_up_num`, `stockUpNum`, `planned_inbound_quantity` | 计划/建议数量候选，不能默认视为已经发货。 |
| 可用量辅助校验 | `available_quantity`, `availableQuantity`, `afn_fulfillable_quantity` | 只用于交叉核对，不能与 FBA 可售重复累计。 |
| 预计到货日 | `arrival_date`, `arrivalDate`, `expected_arrival_date`, `expectedArrivalDate`, `estimated_arrival_date` | 有日期时按月判断可承接量；缺日期不能假设可用于较早月份。 |

`get_fba_shipment_list`、`get_delivery_order_relation_quantities` 和 `get_fba_shipment_receive_details` 均经元数据确认是只读接口，但前者参数复杂，后两者要求先取得真实货件明细 ID。当前没有安全、稳定的目标货件调用链和出参 Schema，因此暂未加入自动白名单；实际在途与 AWD/FBA 批次去重仍需人工确认。

宿主只对完全相同的重复记录自动去重；存在真实 `batch_id/shipment_id` 时，同一物理批次按状态进度只计一次并保留被去除状态。多种在途/计划字段同时为正但没有批次标识、预计到货日缺失、统计时间不一致或跨店铺时，规划库存总量为 `null`。月度分配只使用截至该月末已可售或预计到货的数量，不能用未来库存支持更早月份。

## 状态语义

| 状态 | 含义 |
| --- | --- |
| `value_present` | 目标范围内至少一条记录明确返回非零值。 |
| `reported_zero` | 目标范围内已有记录，且该字段所有已返回值均明确为数字 0（包括字符串 `"0"` 的安全数值化）。 |
| `field_missing` | 有目标记录，但响应没有可识别字段。 |
| `empty_response` | 接口成功但没有业务记录。 |
| `out_of_scope_response` | 接口返回记录，但记录均不匹配目标父子体/SKU 范围。 |
| `interface_failed` | 元数据校验、Schema 校验、网络或 action 调用失败。 |
| `period_incomplete` | 自然月销量缺少至少一个去年同期规划月份。 |

只有 `value_present` 和 `reported_zero` 是字段事实；后三类缺失/失败状态绝不能参与加总。库存七字段全部可识别、父子体映射无冲突、历史月份完整、飞书目标表唯一且成本口径足够时，才具备生成可执行销售计划的条件，否则保持 `needs_review` 或 `blocked`。
