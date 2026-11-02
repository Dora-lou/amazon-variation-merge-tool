# 销售计划 Agent · 本地预览版

这个 Agent 是 **亚马逊运营工具箱** 的本地执行部分；网页在 `agent.html`，后台在 `agent/server.py`。网页可以在任何电脑打开，但每台需要运行预览任务的电脑都要先启动自己的 Agent，并完成 Codex、领星 MCP 和飞书登录。

**当前版本只提供只读预览，无飞书写入接口**。领星的库存字段和在途去重仍待逐项确认；不确定时结果应标记待核对，而不是输出未经验证的目标。

## Windows 首次安装

1. 从你控制的 GitHub 仓库下载完整项目代码（`git clone` 或 `Code → Download ZIP`）。不要只保存网页文件。
2. 安装 Python 3.10+、Codex CLI 和飞书 `lark-cli`，确认在当前 Windows 用户中能运行 `codex`、`lark-cli`，并登录 Codex、飞书 `user` 身份。
3. 在 Codex 中注册并验证 `yb-lingxing` MCP；确认自己的 `~/.codex/skills/feishu-amazon-sales-plan/SKILL.md` 可读取。首次迁移可执行 `powershell -ExecutionPolicy Bypass -File .\agent\install-skill.ps1` 安装项目中附带的通用 Skill；脚本发现同名 Skill 时不会覆盖，请先核对版本。
4. 双击项目里的 `agent/start-agent.bat`。如果电脑没有安装 Python Launcher，也可以在项目根目录执行 `python agent/server.py`。
5. 终端会显示一段随机**本机配对码**，只粘贴到你自己打开的 [销售计划 Agent 网页](https://dora-lou.github.io/amazon-variation-merge-tool/agent.html) 中，点击「连接 Agent」。
6. 在网页选择现有商品库的父 ASIN 或手动输入 ASIN，填写月份、目标和要求，点击「生成只读预览」。

在 Windows PowerShell 验证环境（不要粘贴任何令牌或密钥）：

```powershell
codex --version
lark-cli --version
python --version
```

如果浏览器提示「允许访问本地网络」，需要允许自己打开的受信任网站访问 `127.0.0.1`；如果被企业设备策略禁止，需要在获授权的个人设备上测试。不要为了绕过限制将 Agent 绑定到 `0.0.0.0` 或开放公网端口。

## 本机安全约束

- 后台**只监听 `127.0.0.1:8765`**，不会发布到公网或公司局域网。
- 仅接受来自本站 `https://dora-lou.github.io` 和本机允许来源的浏览器请求；创建任务必须提供当前进程启动时生成的随机配对码。
- 配对码仅保存在当前浏览器标签页会话存储中，关闭后可清除；每次重启 Agent 会更换配对码。
- 后台不保存业务数据、Token、MCP 密钥或执行日志；只在内存保留最近几次预览任务。重启本地服务后记录消失。
- `codex exec` 使用 `read-only` 本地沙盒，并要求只执行只读 MCP 操作。但**本地沙盒无法从机制上阻止所有远程 MCP 写操作**，正式接入写入功能前必须在 MCP 权限层限制写权限或增加人工审批。此版本未提供飞书写入的 HTTP 入口。
- 不要在公共 GitHub 仓库上传公司 ASIN、库存、利润、客户数据、私钥、OAuth 凭证或 Codex 的个人登录文件。离职后只迁移有权保留的通用代码与个人资料；公司数据连接需依法停用。

## 迁移到另一台电脑

下载相同仓库代码 → 安装 Python/Codex/lark-cli → 重新连接个人有权访问的领星 MCP 和飞书账号 → 安装或核对 Skill → 启动 `start-agent.bat`。**不需要重新编写 Agent**；飞书里的既有计划是否可见，取决于新账号的真实访问权限。

商品库仍保存在网页 IndexedDB 中，若要跨电脑使用，需要通过原商品库的备份/恢复功能迁移你有权保存的数据；本地任务记录目前不会自动同步。

## 测试与开发

```powershell
python -m unittest discover -s agent -p "test_*.py" -v
```

测试不需要领星和飞书认证；实际生产联调需要在用户自己的电脑执行，依次检查 `/api/health`、只读领星和飞书调用、库存字段映射、结构化输出。修改代码后通过 GitHub 更新；不要将凭证写入 `.py`、配置或 Git 日志。

接口：`GET /api/health`（公开健康状态）、`GET /api/auth`（验证配对码）、`POST /api/jobs/preview`（排队只读预览）、`GET /api/jobs/{id}`（查看进度/结果）。**不存在写入接口**。