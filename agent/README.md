# 销售计划 Agent · 本地预览版

这个 Agent 是 **亚马逊运营工具箱** 的本地执行部分；网页在 `agent.html`，HTTP 编排在 `agent/server.py`，独立只读采集层在 `agent/read_only_collectors.py`。网页可以在任何电脑打开，但每台需要运行预览任务的电脑都要先启动自己的 Agent，并完成 Codex、领星 MCP 和飞书登录。

**当前版本只提供只读预览，无飞书写入接口**。采集先在宿主进程完成，再把带来源、时间和 SKU 映射的 JSON 快照交给 Codex；Codex 不再调用领星或飞书业务工具。领星的库存字段和在途去重仍需按实际返回逐项确认；不确定时结果会标记待核对，而不是输出未经验证的目标。

## 只读采集边界

- 领星固定走 `help → search → action`。只有 help 与 search 同时返回 `toolType=read`、参数通过 Schema 校验且工具 ID 在代码白名单内时才允许 action。目前白名单为：`erp_listing`、`get_fba_stock_list`、`query_fba_valid_list`、`query_product_performance_asin_lists`。
- 领星响应先按父/子 ASIN、SKU、MSKU、FNSKU 规范化并做目标范围过滤，再进入分析快照；接口返回的其他产品行会标记 `out_of_scope_response` 并排除。字段、接口和去重风险见 [FIELD_MAPPING.md](FIELD_MAPPING.md)。
- 飞书只允许 `auth status`、`wiki +space-list`、`wiki +node-list`、`sheets +workbook-info`、`sheets +table-get`，并对每条命令的 flags 再做固定白名单检查。命令通过参数数组执行，不经过 shell，也不接受网页或模型提供的命令文本。
- `+table-get` 遇到重复表头的 validation/exit 2 时，自动使用只读 `--no-header` 位置列模式重试并标记待核对；单个表格失败不会再抹掉其他已成功读取的表格。CLI 固定在用户主目录运行，并关闭更新/Skill 通知，确保 stdout 只用于 JSON。
- 飞书标题或表格内容精确匹配当前 ASIN/产品名时才标记为 `target`；只命中其他“销售计划/库存/利润”表时标记为 `reference`，仅保留结构元数据，业务数值在采集层即移除。SKU 映射也只扫描 `target` 表，禁止把其他产品数值用于当前计划。
- 利润数据只从已授权的现有飞书销售计划/利润表读取；当前不会用一个缺少产品筛选条件的领星利润接口批量拉取数据。
- 采集快照只保存在当前任务内存中。MCP HTTP 头、飞书授权信息、Cookie、API Key 和资源 token 不进入模型提示、浏览器响应或日志。
- 任一来源缺失或失败时，页面显示来源状态；两边均不可用时会把计划标记为 blocked，并清空库存和月目标，禁止模型补数。
- 领星先按请求 ASIN 查询 Listing，再按识别到的父 ASIN（或把请求值作为父 ASIN候选）分页展开全部子体；库存和自然月产品表现随后按完整父体范围查询。每个查询分别标记 `ok`、`empty_response`、`interface_failed`、`field_missing` 或 `possibly_truncated`。
- 数字 `0` 只有在已有记录明确返回对应字段时才标记 `reported_zero`；空响应、接口错误和字段缺失绝不转换成 0。库存仍按销售计划 Skill 逐 SKU 核对 FBA/AWD/在途字段，字段不全或批次无法去重时保持待核对。
- 历史销量使用产品表现接口的自然月维度，并机械检查是否覆盖每个规划月份对应的去年同期月份；缺任一自然月会标记 `period_incomplete`，不会用 Listing 的近 7/14/30 天字段替代。

## Windows 首次安装

1. 从你控制的 GitHub 仓库下载完整项目代码（`git clone` 或 `Code → Download ZIP`）。不要只保存网页文件。
2. 安装 Python 3.10+ 和飞书 `lark-cli`，在当前 Windows 用户中登录 Codex 与飞书 `user` 身份。**支持自动发现 Windows Codex 桌面版** `%LOCALAPPDATA%\OpenAI\Codex\bin\*\codex.exe`，无需将带版本号的目录添加到 PATH；也支持独立安装的 Codex CLI。
3. 在 Codex 中注册并验证 `yb-lingxing` MCP；确认自己的 `~/.codex/skills/feishu-amazon-sales-plan/SKILL.md` 可读取。首次迁移可执行 `powershell -ExecutionPolicy Bypass -File .\agent\install-skill.ps1` 安装项目中附带的通用 Skill；脚本发现同名 Skill 时不会覆盖，请先核对版本。
4. 双击项目里的 `agent/start-agent.bat`。如果电脑没有安装 Python Launcher，也可以在项目根目录执行 `python agent/server.py`。
5. 终端会显示一段随机**本机配对码**，只粘贴到你自己打开的 [销售计划 Agent 网页](https://dora-lou.github.io/amazon-variation-merge-tool/agent.html) 中，点击「连接 Agent」。
6. 在网页选择现有商品库的父 ASIN 或手动输入 ASIN，填写月份、目标和要求，点击「生成只读预览」。页面会列出领星、飞书各自的读取状态。

在 Windows PowerShell 验证环境（不要粘贴任何令牌或密钥）：

```powershell
python --version
lark-cli --version
# Codex 桌面版不在 PATH 时，启动 Agent 后用网页连接状态确认发现成功。
# 可选：使用 CODEX_BIN 环境变量指定 Codex CLI 可执行文件的完整路径。
```

如果浏览器提示「允许访问本地网络」，需要允许自己打开的受信任网站访问 `127.0.0.1`；如果被企业设备策略禁止，需要在获授权的个人设备上测试。不要为了绕过限制将 Agent 绑定到 `0.0.0.0` 或开放公网端口。

## 本机安全约束

- 后台**只监听 `127.0.0.1:8765`**，不会发布到公网或公司局域网。
- 仅接受来自本站 `https://dora-lou.github.io` 和本机允许来源的浏览器请求；创建任务必须提供当前进程启动时生成的随机配对码。
- 配对码仅保存在当前浏览器标签页会话存储中，关闭后可清除；每次重启 Agent 会更换配对码。
- 后台不保存业务数据、Token、MCP 密钥或执行日志；只在内存保留最近几次预览任务。重启本地服务后记录消失。
- `codex exec` 保留 `--sandbox read-only`、`--ask-for-approval never` 和 `--ephemeral`，并用本次进程级 `--ignore-user-config` 隔离全局 MCP 配置（不会修改本机配置；Codex 登录仍复用）。它只分析已经采集并校验的 JSON，不接触 MCP 或 lark-cli。此版本未提供飞书写入的 HTTP 入口。
- 每次分析前会以独立进程检查 CLI 版本、`exec --help` 中的必需参数和 `codex login status`。网页只显示固定诊断码：`CODEX_CLI_ARGUMENTS`、`CODEX_AUTHENTICATION`、`CODEX_INPUT_SIZE`、`CODEX_MODEL_CALL`、`CODEX_OUTPUT_SCHEMA`、`CODEX_OUTPUT_FORMAT`、`CODEX_SERVICE` 或 `CODEX_RUNTIME`；原始 stdout/stderr、请求头和凭证不会返回网页。
- 宿主采集层可以暂存较大的完整响应，但传给模型前会生成有体积上限的分析副本。发生截断时来源状态强制改为 `partial`，页面提示人工核对，任何被省略内容都不能当作 0；其他产品的 `reference` 表格数值在送模前直接移除。
- 不要在公共 GitHub 仓库上传公司 ASIN、库存、利润、客户数据、私钥、OAuth 凭证或 Codex 的个人登录文件。离职后只迁移有权保留的通用代码与个人资料；公司数据连接需依法停用。

## 迁移到另一台电脑

下载相同仓库代码 → 安装 Python/Codex/lark-cli → 重新连接个人有权访问的领星 MCP 和飞书账号 → 安装或核对 Skill → 启动 `start-agent.bat`。**不需要重新编写 Agent**；飞书里的既有计划是否可见，取决于新账号的真实访问权限。

商品库仍保存在网页 IndexedDB 中，若要跨电脑使用，需要通过原商品库的备份/恢复功能迁移你有权保存的数据；本地任务记录目前不会自动同步。

## 测试与开发

```powershell
python -m unittest discover -s agent -p "test_*.py" -v
```

自动化测试使用模拟 MCP/飞书响应，不需要领星和飞书认证。实际生产联调需要在用户自己的电脑执行，依次检查 `/api/health`、只读领星和飞书调用、库存字段映射、结构化输出。修改代码后通过 GitHub 更新；不要将凭证写入 `.py`、配置或 Git 日志。

接口：`GET /api/health`（公开健康状态）、`GET /api/auth`（验证配对码）、`POST /api/jobs/preview`（排队只读预览）、`GET /api/jobs/{id}`（查看进度/结果）。**不存在写入接口**。
