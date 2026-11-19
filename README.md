# 亚马逊运营工具箱

在线工具：https://dora-lou.github.io/amazon-variation-merge-tool/

目前四个主要模块：

- **知识库**：合并/拆分变体、FBA 发货 SOP 等。
- **运营工具中心**：变体合并和 Listing 修改，生成 Excel 上传文件。
- **商品库**：本浏览器保存 ASIN/MSKU、类目模板；支持 ZIP 备份与恢复。
- **AI Skills**：集中展示 Codex 技能，目前收录销售计划 Skill，提供启动指令及 Skill 文件链接。
- **Niche 数据提取**：按产品管理多个 Niche，上传 Product 与 Search Term CSV 后自动计算并导出一个多 Sheet Excel 工作簿。

旧版 **AI Agent** 入口已从导航和首页移除，相关代码保留在仓库中供未来参考，不再作为日常推荐入口。

## 旧版销售计划 Agent（保留代码，非推荐入口）

1. 下载整个项目代码。在需要运行 Agent 的 Windows 电脑上安装 Python 3.10+、Codex CLI、飞书 CLI 并配置有权使用的领星 MCP。
2. 确认安装 `feishu-amazon-sales-plan` Skill。仓库 `agent/skills/` 附带通用版本；如已有个人维护的同名 Skill，不要直接覆盖。
3. 双击 `agent/start-agent.bat`，将终端显示的随机配对码填入 [销售计划 Agent 页面](https://dora-lou.github.io/amazon-variation-merge-tool/agent.html)。
4. 选择 ASIN、月份和消化目标，点击「生成只读预览」。

详细配置、环境约束和测试请阅读 [agent/README.md](agent/README.md)。

## 重要提醒

- 商品库和类目模板保存在当前浏览器；换电脑需迁移有权保留的 ZIP 备份。
- AI Agent 运行在本机，代码可迁移；新电脑须重新安装本机环境并授权领星和飞书。
- Agent 服务只监听 `127.0.0.1`，不应开放到公网。配对码不能用于登录领星/飞书。
- 商品经营数据和任何 Token/Secret 都不应提交至公共 GitHub 仓库；离职后不得继续使用未经授权的公司数据或凭证。
- 只读预览不等于已完成库存口径验收：在途去重、成本缺失等问题须核对，正式表格写入功能尚未开放。


## Niche 数据提取

- 每个 Niche 单独上传后台导出的 Product CSV 与 Search Term CSV。
- 系统自动识别 CSV 表头、汇总 Total Clicks，并按搜索量 × 搜索转化率估算 Orders。
- 同一产品下可保存多个 Niche；重新上传同名 Niche 时仅覆盖该 Niche，其他 Niche 保留。
- 导出时，一个产品生成一个 Excel 工作簿，每个 Niche 对应一个 Sheet。
- 每个 Sheet 的字段顺序固定为：搜索词、搜索量（过去 360 天）、CVR、Clicks、Orders%、Orders；其后保留原始 Search Term 表中的其他全部字段，并沿用原表字段顺序。
- Excel 使用统一的标题区、核心指标卡片、分组表头、交替行底色、数字格式、筛选和冻结窗格。
- 更新前已保存的旧版 Niche 没有保存原始 ST 其他字段；如需补齐，请重新上传该 Niche 的 Product CSV 和 Search Term CSV。
- 数据保存在当前浏览器的 IndexedDB 中；不调用 AI API，也不会将原始 CSV 上传到服务器。不同浏览器或设备之间不会自动同步。
- 当前版本暂不处理 SQR。
