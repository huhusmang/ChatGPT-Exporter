# ChatGPT Exporter

一个用于批量导出 ChatGPT 对话记录的工具，支持个人空间、项目空间和团队空间。每个对话同时导出为 JSON（完整备份）和 Markdown（方便阅读），打包成一个 ZIP 文件。

## 功能特性

- 📦 批量导出全部对话，个人空间的导出包含项目中的对话
- ✅ 选择特定对话导出（搜索、按范围/归档状态/日期筛选、Shift 连选）
- 🔁 增量导出：只导出上次导出后新建或更新过的对话
- 🏢 支持个人空间、项目空间（按项目分文件夹）和团队空间（Team / Business）
- 📄 同时导出 JSON 和 Markdown，Markdown 带 YAML front matter
- 📎 可选导出上传的附件、可见图片和 GPT 生成的文件
- 🛡️ 单个对话失败不影响其他对话，问题记录在 ZIP 内的错误报告中
- ⏳ 遇到限流自动等待重试；导出过程中可以随时停止
- 🌓 界面跟随 ChatGPT 的深色模式，窄屏可用
- ⏰ Chrome 扩展支持定时提醒导出，并提示新版本

## 使用方法

本项目提供两种使用方式，导出功能完全相同。

### 方法一：Tampermonkey 脚本（推荐，可自动更新）

**[👉 点击这里直接安装脚本 (GreasyFork)](https://greasyfork.org/zh-CN/scripts/556233-chatgpt-universal-exporter-markdown-support)**

1. 安装 [Tampermonkey](https://www.tampermonkey.net/) 浏览器扩展
2. 点击上方安装链接，在弹出的页面中点击"安装"

也可以手动安装：打开 `Tampermonkey.js`，复制全部内容，在 Tampermonkey 中"添加新脚本"后粘贴保存。

安装后访问 ChatGPT，页面右边缘会出现一个圆形的悬浮导出按钮：

- **点击**：打开导出弹窗
- **拖动**：可拖到任意位置，位置会被记住；拖近左右边缘会自动吸附，空闲 2.5 秒后半隐藏
- **右键**：重置到默认位置
- **导出中点击**：停止当前导出

### 方法二：Chrome 扩展

Chrome 扩展额外提供定时提醒和新版本提示。

1. 下载 [最新 Release](https://github.com/huhusmang/ChatGPT-Exporter/releases/latest) 中的 `ChatGPT-Exporter.zip` 并解压
2. 打开 `chrome://extensions/`，开启右上角的"开发者模式"
3. 点击"加载已解压的扩展程序"，选择解压出来的 `chrome-extension` 文件夹

使用：打开 chatgpt.com 后点击工具栏中的扩展图标，再点击"导出"。在扩展的设置页可以配置每日或每周提醒（提醒只发通知，不会自动导出）。

以"加载已解压"方式安装的扩展不会自动更新。弹窗检测到新版本时会显示提示，下载新版本解压后覆盖原文件夹，再在扩展页点击刷新即可。

### 导出选项

- **导出全部**：先读取完整对话列表，再逐个导出，右下角的任务面板显示进度，可以随时点击"停止导出"
- **选择对话导出**：在列表中搜索、筛选并勾选需要的对话；按住 Shift 点击可以连续选择
- **同时下载附件**：会明显增加导出时间和 ZIP 体积，默认关闭
- **增量导出**：只对"导出全部"生效。记录保存在当前浏览器（按账户区分），换浏览器或点击"清除导出记录"后会重新导出全部对话

## 导出内容

ZIP 文件名形如 `chatgpt_personal_backup_2026-09-12.zip`（增量导出为 `incremental`，选择导出为 `selected`），内容包括：

- `对话标题_对话ID短码.json`：接口返回的完整对话数据，包含所有分支，是最可靠的备份
- `对话标题_对话ID短码.md`：当前显示分支的用户和助手消息
- `对话标题_对话ID短码_files/`：开启附件下载时的附件
- `项目名/`：项目中的对话
- `attachment-export-report.json`：开启附件下载时的附件统计和失败原因
- `export-error-report.json`：只在有对话失败、列表获取失败或导出被停止时出现

Markdown 格式示例：

```markdown
---
title: "对话标题"
conversation_id: "6789abcd-..."
created: "2026-09-01T08:00:00.000Z"
updated: "2026-09-02T10:30:00.000Z"
url: "https://chatgpt.com/c/6789abcd-..."
exported_by: "ChatGPT Exporter v1.6.0"
---

# User
用户的问题内容

# Assistant
助手的回复内容
```

## 注意事项

1. **登录状态**：使用前需要登录 ChatGPT
2. **请求频率**：导出会逐个请求对话详情，每个请求之间有间隔。对话很多时需要较长时间，遇到限流会自动等待重试
3. **账户**：个人空间和项目空间使用页面当前所选的账户；团队空间需要有相应工作区的访问权限
4. **网络请求**：脚本只请求 ChatGPT 自己的接口。Chrome 扩展的弹窗还会请求 GitHub API 检查新版本（每 12 小时最多一次）

## 常见问题

**Q: 提示"无法获取 Access Token"？**
A: 刷新 ChatGPT 页面，或打开任意一个对话后再试。

**Q: 导出提前停止了？**
A: 连续限流（429）或登录过期（401）时会停止，已导出的对话照常打包。原因写在结果面板和 `export-error-report.json` 中。等几分钟后可以用增量导出继续，已导出的对话会被跳过。

**Q: 有的对话在 ZIP 里只有 JSON 没有 Markdown？**
A: Markdown 或附件处理失败时只保留 JSON，并在 `export-error-report.json` 中记为"部分成功"。欢迎附上报告提交 Issue。

**Q: Markdown 内容比网页上少？**
A: Markdown 只包含当前显示分支中用户和助手的可见消息，系统消息、工具调用和其他分支只保存在 JSON 中。

**Q: 团队空间导出失败？**
A: 确认你有该工作区的访问权限，并且已正确选择工作区 ID。

## 技术说明

### 项目结构

- `Tampermonkey.js`：唯一的源码，同时作为油猴脚本发布
- `chrome-extension/exporter.user.js`：由构建脚本从 `Tampermonkey.js` 生成，**不要手动修改**
- `chrome-extension/`：扩展的其余部分（弹窗、设置页、定时提醒、注入脚本）
- `scripts/`：构建和版本号脚本
- `tests/`：基于 jsdom 的端到端测试，用假的 ChatGPT 接口驱动真实的导出流程

### 扩展的工作方式

1. `content/inject-exporter.js` 把 `jszip.min.js` 和 `exporter.user.js` 注入页面，使脚本能使用页面的登录状态
2. 点击弹窗中的"导出"时，弹窗向 `content/auto-export.js` 发消息，后者通过 `postMessage` 让页面脚本打开导出弹窗
3. 后台 Service Worker 只负责定时提醒通知

### 使用的接口

- `/api/auth/session`：获取 Access Token
- `/backend-api/conversations`：对话列表（含已归档）
- `/backend-api/conversation/{id}`：对话详情
- `/backend-api/gizmos/snorlax/sidebar`：项目列表
- `/backend-api/gizmos/{id}/conversations`：项目内的对话列表
- `/backend-api/files/download/{id}`、`/backend-api/conversation/{id}/interpreter/download`：附件

## 开发与发布

需要 Node.js 20 以上。

```bash
npm install
npm run build   # 修改 Tampermonkey.js 后重新生成扩展脚本
npm test        # 运行测试
npm run check   # 检查生成文件是否最新、版本号是否一致，并运行测试（CI 同样执行）
```

只在 `Tampermonkey.js` 中修改代码，然后运行 `npm run build`。只有油猴脚本需要的代码用 `// @build:userscript-only-start` 和 `// @build:userscript-only-end` 包起来，构建扩展版时会被去掉。

发布新版本：

1. 在 `CHANGELOG.md` 顶部写好新版本的说明（`## 1.6.1`）
2. 运行 `npm run version:set 1.6.1`，同步修改所有版本号并重新生成扩展脚本
3. 运行 `npm run check`，提交改动
4. 打标签并推送：`git tag v1.6.1 && git push origin main v1.6.1`

推送标签后，GitHub Actions 会再次校验，然后创建 Release（说明取自 CHANGELOG），附上扩展 ZIP 和油猴脚本。GreasyFork 如果配置了同步，会自动从仓库更新脚本。

## 致谢

本项目核心逻辑基于 [ChatGPT Universal Exporter](https://greasyfork.org/zh-CN/scripts/538495-chatgpt-universal-exporter) (v8.2.0) 开发。

**原作者：** Alex Mercer, Hanashiro, WenDavid

在此基础上，本项目进行了以下增强与封装：
1.  **新增格式支持**：在原有 JSON 导出功能的基础上，增加了 Markdown (.md) 格式的导出支持，方便在笔记软件中直接查看。
2.  **Chrome 扩展封装**：将用户脚本封装为标准的 Chrome 浏览器扩展，提供了独立的配置弹窗和定时提醒。
3.  **选择对话导出**：新增"选择对话导出"功能，支持搜索/筛选/勾选需要的对话，并导出为 ZIP 文件。

## 许可证

本项目仅供学习和个人使用，请遵守 OpenAI 的服务条款。

## 贡献

欢迎提交 Issue 和 Pull Request 来改进这个项目。提交前请运行 `npm run check`。
