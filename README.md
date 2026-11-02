# 亚马逊运营工具箱

在线工具：https://dora-lou.github.io/amazon-variation-merge-tool/

目前四个模块：

- **知识库**：合并/拆分变体、FBA 发货 SOP 等。
- **表格自动生成工具**：变体合并和 Listing 修改，生成 Excel 上传文件。
- **商品库**：本浏览器保存 ASIN/MSKU、类目模板；支持 ZIP 备份与恢复。
- **AI Agent（本地预览版）**：通过本机 Codex CLI + 领星 MCP + 飞书 lark-cli + 销售计划 Skill，读取真实数据并生成销售计划预览；目前**没有飞书写入接口**。

## 首次使用销售计划 Agent

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
