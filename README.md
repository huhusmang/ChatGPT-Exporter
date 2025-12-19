# ChatGPT Exporter

一个用于批量导出 ChatGPT 对话记录的工具，支持个人空间和团队空间的对话导出，可导出为 JSON 或 Markdown 格式。

## 功能特性

- 📦 批量导出所有对话记录
- ✅ 支持选择特定对话导出（搜索/筛选/勾选）
- 🏢 支持个人空间和团队空间（Team Workspace）
- 📄 支持 JSON 和 Markdown 两种导出格式
- 🔄 自动清理引用标记，保持内容整洁
- ⏰ 支持定时提醒导出（Chrome 扩展）
- 🎯 智能文件命名（标题 + 对话 ID）
- ⚡️ 优化大量对话的加载性能

## 使用方法

本项目提供两种使用方式，可根据需求选择：

### 方法一：Chrome 扩展（推荐）

Chrome 扩展提供更完整的功能，包括定时自动提醒、弹窗界面等。

#### 安装步骤

1. 下载 Release 中的 `ChatGPT-Exporter.zip` 到本地
2. 打开 Chrome 浏览器，进入 `chrome://extensions/`
3. 开启右上角的"开发者模式"
4. 点击"加载已解压的扩展程序"
5. 选择项目中的 `chrome-extension` 文件夹
6. 安装完成后，扩展图标会出现在工具栏

#### 使用说明

**手动导出：**
- 访问 ChatGPT 网站后，在弹窗中选择导出选项
- 可选择“导出全部”或“选择对话导出”（支持搜索/筛选）

**设置定时：**
- 点击扩展图标，进入设置页面
- 配置定时提醒计划（每日、每周等）
- 启用后将在指定时间自动提醒导出

### 方法二：Tampermonkey 脚本

如果不想安装扩展，可以使用 Tampermonkey 脚本，功能相对简化但同样实用。

**[👉 点击这里直接安装脚本 (GreasyFork)](https://greasyfork.org/zh-CN/scripts/556233-chatgpt-universal-exporter-markdown-support)**

#### 安装步骤

1. 安装 [Tampermonkey](https://www.tampermonkey.net/) 浏览器扩展
2. 点击上方安装链接
3. 在弹出的页面中点击 "安装" 即可

#### 手动安装步骤

1. 安装 [Tampermonkey](https://www.tampermonkey.net/) 浏览器扩展
2. 打开 `Tampermonkey.js` 文件
3. 复制全部内容
4. 点击 Tampermonkey 图标 → "添加新脚本"
5. 粘贴代码并保存
6. 访问 ChatGPT 网站，脚本会自动运行

#### 使用说明

- 访问 ChatGPT 后，页面右下角会出现 "Export Conversations" 按钮
- 点击按钮，选择导出模式：
  - **个人空间**：导出个人对话
  - **团队空间**：导出团队工作区对话（需选择具体工作区）
- 选择导出方式（导出全部 / 选择对话导出）
- 确认后开始批量下载

**相关文件：**
- `Tampermonkey.js` - 完整的用户脚本

## 核心功能说明

### Token 获取
脚本会自动捕获 ChatGPT 的 Access Token 和 Device ID，用于 API 调用认证。

### 对话提取
- 遍历对话的消息树结构（`mapping`）
- 过滤系统消息和隐藏消息
- 清理引用标记（如 `cite` 标签）
- 按时间顺序整理用户和助手的对话

### 文件命名
生成格式：`对话标题_对话ID短码.json/md`
- 自动清理文件名中的非法字符
- 使用对话 ID 后缀避免重名
- 未命名对话使用 "Untitled Conversation"

### 导出格式

**JSON 格式：**
完整的对话数据结构，包含所有元数据和消息树。

**Markdown 格式：**
```markdown
# User
用户的问题内容

# Assistant
助手的回复内容
```

## 技术架构

### Chrome 扩展架构
- **Manifest V3**：使用最新的扩展规范
- **Background Service Worker**：处理定时任务和消息传递
- **Content Scripts**：注入页面脚本，与 ChatGPT 交互
- **Popup & Options**：提供用户界面

### 通信机制
1. `inject-exporter.js` 注入 `exporter.user.js` 到页面上下文
2. `auto-export.js` 通过 `postMessage` 与注入脚本通信
3. Background 脚本通过 `chrome.runtime.sendMessage` 触发导出

### API 调用
- `/api/auth/session` - 获取 Access Token
- `/backend-api/conversations` - 获取对话列表
- `/backend-api/conversation/{id}` - 获取对话详情
- `/backend-api/gizmos/snorlax/sidebar` - 获取项目列表（团队空间）

## 注意事项

1. **登录状态**：使用前需要登录 ChatGPT
2. **网络请求**：导出过程会发起大量 API 请求，请耐心等待
3. **浏览器限制**：批量下载可能触发浏览器的下载提示
4. **团队空间**：需要有相应工作区的访问权限
5. **Token 有效期**：如果导出失败，尝试刷新页面重新获取 Token

## 常见问题

**Q: 导出时提示"无法获取 Access Token"？**  
A: 刷新 ChatGPT 页面，或打开任意一个对话后再试。

**Q: 团队空间导出失败？**  
A: 确认你有该工作区的访问权限，并且已正确选择工作区 ID。

**Q: 导出的 Markdown 文件内容不完整？**  
A: 脚本会自动过滤系统消息和隐藏消息，只保留用户和助手的可见对话。

**Q: 可以导出特定时间段的对话吗？**  
A: 当前版本暂不支持按时间段筛选；可先用“选择对话导出”结合搜索/筛选手动勾选需要的对话。

## 致谢

本项目核心逻辑基于 [ChatGPT Universal Exporter](https://greasyfork.org/zh-CN/scripts/538495-chatgpt-universal-exporter) (v8.2.0) 开发。

**原作者：** Alex Mercer, Hanashiro, WenDavid

在此基础上，本项目进行了以下增强与封装：
1.  **新增格式支持**：在原有 JSON 导出功能的基础上，增加了 Markdown (.md) 格式的导出支持，方便在笔记软件中直接查看。
2.  **Chrome 扩展封装**：将用户脚本封装为标准的 Chrome 浏览器扩展，提供了独立的配置弹窗和后台运行能力。
3.  **选择对话导出**：新增“选择对话导出”功能，支持搜索/筛选/勾选需要的对话，并导出为 ZIP 文件。

## 许可证

本项目仅供学习和个人使用，请遵守 OpenAI 的服务条款。

## 贡献

欢迎提交 Issue 和 Pull Request 来改进这个项目。
