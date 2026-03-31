# Agent Email

[![npm version](https://img.shields.io/npm/v/email-agent-mcp)](https://www.npmjs.com/package/email-agent-mcp)
[![npm downloads](https://img.shields.io/npm/dm/email-agent-mcp.svg)](https://npmjs.org/package/email-agent-mcp)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![CI](https://github.com/UseJunior/email-agent-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/UseJunior/email-agent-mcp/actions/workflows/ci.yml)
[![codecov](https://img.shields.io/codecov/c/github/UseJunior/email-agent-mcp/main)](https://app.codecov.io/gh/UseJunior/email-agent-mcp)
[![GitHub stargazers](https://img.shields.io/github/stars/UseJunior/email-agent-mcp?style=social)](https://github.com/UseJunior/email-agent-mcp/stargazers)
[![Tests: Vitest](https://img.shields.io/badge/tests-vitest-6E9F18)](https://vitest.dev/)
[![OpenSpec Traceability](https://img.shields.io/badge/openspec-traceability%20gate-brightgreen)](./scripts/check-spec-coverage.mjs)
[![Socket Badge](https://socket.dev/api/badge/npm/package/email-agent-mcp)](https://socket.dev/npm/package/email-agent-mcp)
[![install size](https://packagephobia.com/badge?p=email-agent-mcp)](https://packagephobia.com/result?p=email-agent-mcp)

[English](./README.md) | [Español](./README.es.md) | [简体中文](./README.zh.md) | [Português (Brasil)](./README.pt-br.md) | [Deutsch](./README.de.md)

> **翻译说明：** 英文 README.md 是权威来源。此翻译可能稍有滞后。

**email-agent-mcp** 由 [UseJunior](https://usejunior.com) 开发 -- 为 AI 代理提供电子邮件连接能力。

Agent Email 是一个开源的 TypeScript MCP 服务器，为 AI 代理提供安全的电子邮件访问。它通过 [Model Context Protocol](https://modelcontextprotocol.io/) 暴露电子邮件操作，适用于任何兼容 MCP 的代理运行时 -- Claude Code、Gemini CLI、Cursor、Goose 等。安全优先的默认配置意味着代理在您明确配置允许列表之前无法发送电子邮件。

## 为什么需要这个项目

AI 代理需要读取、回复和处理电子邮件，但电子邮件 API 非常复杂。OAuth 流程、Graph 增量查询、Gmail 推送订阅、HTML 到 Markdown 转换、线程语义 -- 每个提供商都有自己的特殊之处。

Agent Email 将这些复杂性封装为带有安全防护的确定性 MCP 工具：

- 发送和接收允许列表，控制代理可以联系的对象
- 默认禁用删除功能（需要明确启用）
- 错误信息净化，自动剥离 API 密钥、文件路径和堆栈跟踪
- 邮件正文文件沙箱，具有路径遍历保护

## 在 Claude Code 中使用

添加到 `~/.claude/settings.json` 或项目的 `.claude/settings.json` 中：

```json
{
  "mcpServers": {
    "email-agent-mcp": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "email-agent-mcp"]
    }
  }
}
```

## 在 Gemini CLI 中使用

```bash
gemini extensions install https://github.com/UseJunior/email-agent-mcp
```

## 在 Cursor 中使用

```json
// .cursor/mcp.json
{
  "mcpServers": {
    "email-agent-mcp": {
      "command": "npx",
      "args": ["-y", "email-agent-mcp"]
    }
  }
}
```

## 通过命令行使用

```bash
npx -y email-agent-mcp
```

交互式配置向导将引导您完成 OAuth 配置和邮箱选择。

## 工具参考

Agent Email 提供 15 个 MCP 工具：

| 工具 | 描述 | 类型 |
|------|------|------|
| `list_emails` | 列出近期邮件并支持筛选 | 读取 |
| `read_email` | 读取完整邮件内容（Markdown 格式） | 读取 |
| `search_emails` | 跨邮箱全文搜索 | 读取 |
| `get_mailbox_status` | 获取连接状态和警告信息 | 读取 |
| `get_thread` | 获取完整会话上下文 | 读取 |
| `send_email` | 发送新邮件（受允许列表限制） | 写入 |
| `reply_to_email` | 按 RFC 标准进行线程回复 | 写入 |
| `create_draft` | 创建邮件草稿 | 写入 |
| `update_draft` | 更新草稿内容 | 写入 |
| `send_draft` | 发送已保存的草稿 | 写入 |
| `label_email` | 添加标签/分类 | 写入 |
| `flag_email` | 标记/取消标记邮件 | 写入 |
| `mark_read` | 标记为已读/未读 | 写入 |
| `move_to_folder` | 在文件夹之间移动邮件 | 写入 |
| `delete_email` | 删除邮件（需要明确启用） | 破坏性 |

## 提供商支持

| 提供商 | 状态 | 包名 |
|--------|------|------|
| Microsoft 365 (Graph API) | 完全支持 | `@usejunior/provider-microsoft` |
| Gmail | 即将推出 | `@usejunior/provider-gmail` |

Gmail 提供商包已编写完成并具有完整的测试覆盖。接入 MCP 服务器的工作正在进行中。

## 安全默认值

Agent Email 默认采用严格的安全配置，您可以根据需要逐步放宽：

- **发送允许列表**：默认为空 -- 代理在您添加收件人之前无法发送任何邮件
- **接收允许列表**：默认接受所有来源 -- 控制哪些发件人会触发监听器
- **删除功能默认禁用**：代理无法删除邮件，除非您设置 `user_explicitly_requested_deletion: true`
- **错误信息净化**：API 密钥、文件路径和堆栈跟踪会从错误响应中被移除
- **邮件正文文件沙箱**：禁止 `../` 路径遍历、禁止符号链接、检测二进制文件

## 包结构

| 包名 | 描述 |
|------|------|
| `@usejunior/email-core` | 核心邮件操作、内容引擎、安全模块和提供商接口 |
| `@usejunior/email-mcp` | MCP 服务器适配器、CLI 和监听器 |
| `@usejunior/provider-microsoft` | Microsoft Graph API 邮件提供商 |
| `@usejunior/provider-gmail` | Gmail API 邮件提供商 |
| `email-agent-mcp` | 分发包装器（`npx email-agent-mcp`） |

## 质量与信任指标

- CI 在每次拉取请求和推送到 main 分支时运行（lint、类型检查、Node 20 + 22 上的测试）
- CodeQL 和 Semgrep 安全扫描
- 覆盖率报告发布到 Codecov
- 通过 `npm run check:spec-coverage` 进行 OpenSpec 可追溯性验证
- 34 个测试文件中包含 310 个测试
- 维护者：[Steven Obiajulu](https://www.linkedin.com/in/steven-obiajulu/)

## 架构

```
email-agent-mcp/
├── packages/
│   ├── email-core          核心操作、内容引擎、安全模块
│   ├── email-mcp           MCP 服务器适配器、CLI、监听器
│   ├── provider-microsoft  Microsoft Graph 提供商
│   ├── provider-gmail      Gmail API 提供商
│   └── email-agent-mcp         分发包装器（npx 入口）
├── openspec/               规范驱动开发
└── scripts/                CI 和验证脚本
```

## 发布

通过 GitHub Actions 进行标签驱动的发布，使用 npm OIDC 可信发布。所有 5 个包按依赖顺序发布，带有 `--provenance` 标记。

## 常见问题

### 这个项目能和 Claude Code 一起使用吗？

可以。运行 `npx email-agent-mcp` 启动 MCP 服务器，然后在 Claude Code 设置中进行配置。

### 代理能在未经我许可的情况下发送邮件吗？

不能。发送允许列表默认为空。代理在您明确配置允许的收件人之前无法发送任何邮件。

### 这个项目会存储我的邮件凭据吗？

OAuth 令牌由 MSAL（Microsoft）管理，存储在您操作系统的钥匙串或 `~/.email-agent-mcp/` 下的本地配置文件中。Agent Email 从不存储原始密码。

### 我可以同时连接多个邮箱吗？

可以。您可以同时配置 Microsoft 365 和 Gmail。读取操作默认使用您的主邮箱；当配置了多个邮箱时，写入操作需要指定目标邮箱。

## 开发

```bash
npm ci
npm run build
npm run lint --workspaces --if-present
npm run test:run
npm run check:spec-coverage
```

## 相关项目

- [Safe DOCX Suite](https://github.com/UseJunior/safe-docx) -- 使用编程代理精确编辑 Word 文档
- [Open Agreements](https://github.com/open-agreements/open-agreements) -- 使用编程代理填写标准法律模板

## 隐私

Agent Email 完全在您的本地机器上运行。邮件凭据存储在您操作系统的钥匙串（MSAL）和本地配置文件中。Agent Email 本身不会将任何邮件内容发送到外部服务器。

## 治理

- [贡献指南](CONTRIBUTING.md)
- [行为准则](CODE_OF_CONDUCT.md)
- [安全策略](SECURITY.md)
- [更新日志](CHANGELOG.md)
