# ChatGPT Exporter 原文件增量备份计划

## 1. 目标

把现有“全部对话先放入内存，最后生成一个 ZIP”的批量导出流程，改造成适合约 1000 条及以上对话的原文件增量备份：

- 用户选择一个固定备份目录。
- 每完成一条对话就立即写入 JSON、Markdown 和附件原文件。
- 单条失败经过有限重试后跳过，不中断整个任务。
- 使用检查点支持暂停、页面刷新或浏览器重启后的断点续传。
- 对未变化的对话执行增量跳过，对已变化的对话安全更新。
- 保留现有 ZIP 导出作为兼容模式，不在本次删除。

## 2. 当前问题与代码位置

当前核心流程位于：

- `Tampermonkey.js`
- `chrome-extension/exporter.user.js`

`exportConversations()` 依次获取对话并把内容加入内存中的 `JSZip`，全部处理完成后才调用 `generateAsync()`。这会产生三个问题：

1. 任意 `getConversation()` 异常会冒泡到整个导出的最外层 `catch`，后续任务停止。
2. 对话、Markdown 和附件会随总量长期留在内存中，1000 条规模下存在明显的内存与最终压缩失败风险。
3. 在最终 ZIP 生成前没有持久化检查点，页面关闭或崩溃会丢失本轮全部进度。

当前附件下载已经按单附件捕获错误，可以沿用其失败隔离思想，但需要补充重试、并发限制和原文件写入。

## 3. 范围

### 3.1 本次实现

- Chrome 扩展中的固定目录选择、授权检查和目录句柄持久化。
- 原文件目录模式。
- 每条对话完成后立即落盘。
- 对话级重试、失败隔离和有界并发。
- manifest 检查点、任务恢复、暂停和安全停止。
- 增量更新策略。
- 导出结果与失败报告。
- 现有 ZIP 路径的回归保护。

### 3.2 本次不实现

- 把所有原文件重新合并成一个 ZIP。
- Firefox、Safari 的固定目录支持。
- 云盘、WebDAV 或对象存储同步。
- 多台设备之间的任务状态同步。
- 自动删除用户目录中的历史备份。
- Tampermonkey 的持久固定目录能力。Tampermonkey 继续使用现有 ZIP 下载；原文件模式先作为 Chrome 扩展能力交付。

## 4. 推荐用户体验

### 4.1 设置页

在扩展设置页增加“本地备份”区域：

- 输出模式：`原文件目录（推荐）` / `ZIP（兼容）`。
- 备份目录：选择目录、重新授权、清除目录。
- 目录状态：可写、需要授权、不可用。
- 请求并发：默认 2，允许 1 到 4。
- 单条最大尝试次数：默认 3。
- 附件下载：沿用现有开关。
- 重复对话策略：`未变化则跳过` / `始终覆盖`。
- “测试写入”按钮：创建并删除一个小型测试文件，验证实际写权限。

目录选择必须由用户点击触发。目录句柄可保存，但每次导出前仍须调用 `queryPermission({ mode: 'readwrite' })`。权限失效时应显示“重新授权”，不能在后台无限弹出选择器。

### 4.2 启动导出

如果发现同一目录存在未完成任务，显示三个动作：

- 继续上次任务：按 manifest 跳过已提交对话。
- 新建任务：创建新的任务子目录。
- 取消。

不提供“静默覆盖未完成任务”。

### 4.3 运行状态

至少展示：

- 已处理数 / 总数。
- 成功、未变化跳过、失败、剩余。
- 当前正在处理的对话数量。
- 当前重试数量及最近错误。
- 已写入目录名称。
- 暂停、继续、安全停止、立即停止。

“安全停止”停止领取新任务，等待当前任务写入完成后更新 manifest；“立即停止”允许放弃尚未提交的当前任务，但不影响已经落盘的对话。

## 5. 输出结构

每次新任务创建独立目录：

```text
ChatGPT-Exporter/
└── backup-2026-07-11-153000/
    ├── manifest.json
    ├── export-report.json
    ├── failed-conversations.json
    └── conversations/
        ├── 对话标题__<conversation-id>/
        │   ├── conversation.json
        │   ├── conversation.md
        │   └── attachments/
        │       ├── image.png
        │       └── document.pdf
        └── 另一条对话__<conversation-id>/
            ├── conversation.json
            ├── conversation.md
            └── attachments/
```

目录名由清理后的标题和完整 conversation ID 组成。标题仅用于可读性，ID 是唯一身份。非法字符、保留名称和过长名称必须清理；建议标题部分截断到 80 个 Unicode 字符。

## 6. Manifest 数据契约

`manifest.json` 建议采用版本化结构：

```json
{
  "schema_version": 1,
  "exporter_version": "<extension-version>",
  "task_id": "<uuid>",
  "status": "running",
  "created_at": "<iso-time>",
  "updated_at": "<iso-time>",
  "mode": "personal",
  "workspace_id": null,
  "options": {
    "include_attachments": true,
    "conversation_concurrency": 2,
    "max_attempts": 3,
    "existing_policy": "skip_unchanged"
  },
  "totals": {
    "discovered": 1000,
    "completed": 0,
    "unchanged": 0,
    "failed": 0
  },
  "conversations": {
    "<conversation-id>": {
      "status": "completed",
      "source_update_time": 0,
      "directory": "conversations/<directory-name>",
      "completed_at": "<iso-time>",
      "attachment_failures": []
    }
  }
}
```

状态限定为 `running`、`paused`、`completed`、`stopped`。对话状态限定为 `completed`、`unchanged`、`failed`。不要把待处理的 1000 个完整对话对象写入 manifest，只保留必要元数据，避免频繁重写过大的文件。

`failed-conversations.json` 保存最终失败项的 ID、标题、项目、HTTP 状态、尝试次数和最终错误。`export-report.json` 在任务结束或安全停止时生成面向用户的摘要。

## 7. 单条对话的提交协议

每条对话必须作为独立事务处理：

1. 从 API 获取对话详情。
2. 解析 JSON 和 Markdown。
3. 下载附件；单附件失败只进入报告。
4. 创建或获取目标对话目录。
5. 写入 `conversation.json`。
6. 写入 `conversation.md`。
7. 写入附件文件。
8. 所有 writable stream 成功 `close()` 后，将该对话标记为 completed 并重写 manifest。
9. 释放该对话的对象、附件缓冲区和临时数据。

manifest 不得先于文件提交。若页面在步骤 4 至 7 之间终止，该对话在 manifest 中仍未完成，恢复时重新处理并覆盖相同文件。

更新已有对话时，必须先把新文件完整写入，再更新 manifest。File System Access API 没有可依赖的跨浏览器目录事务，因此恢复逻辑必须容忍部分文件已经被覆盖：manifest 未提交即重做，最终结果仍收敛到一致状态。

## 8. 增量更新规则

以 conversation ID 定位历史记录，以源列表中的 `update_time` 判断变化：

- manifest 中存在 completed 且 `source_update_time` 相同：标记 unchanged，不请求详情。
- `update_time` 增大：重新获取并覆盖该对话目录内容。
- manifest 中不存在：正常导出。
- 历史对话已从服务器消失：本次不自动删除本地数据，只在报告中标记 source_missing。

用户选择“始终覆盖”时忽略时间比较，但仍使用相同的安全提交协议。

## 9. 请求、重试和并发

实现统一的 `fetchWithRetry()`：

- 默认最多 3 次尝试，而不是失败后额外重试 3 次。
- 对网络异常、408、429、500、502、503、504 重试。
- 优先遵循合法的 `Retry-After`。
- 否则使用指数退避和随机抖动，例如 1、2、4 秒附近。
- 401/403 只允许刷新一次 Access Token；仍失败则停止任务并要求重新登录，不能把 1000 条全部标为失败。
- 404 和其他确定性客户端错误不重试，记录后跳过。
- 错误对象包含 URL 类别、conversation ID、HTTP 状态、尝试次数和 cause，但不得记录 Access Token。

对话 worker pool 默认并发 2，硬上限 4。遇到 429 时设置共享冷却截止时间，所有 worker 在领取下一次网络任务前等待，避免各 worker 独立重试持续撞限流。

附件下载在单条对话内部默认串行。未来若增加附件并发，必须保证“对话并发 × 附件并发”的总请求上限受控。

## 10. 当前扩展架构与安全边界

第一版直接在已经运行导出器的 ChatGPT 页面上下文使用 File System Access API。这样可以避免把大 JSON、Markdown 和附件通过 Chrome runtime 消息复制或 base64 化，也保证目录选择器可以由导出按钮的用户手势直接触发。目录句柄保存在当前页面 origin 的 IndexedDB 中，并且只使用代码生成的任务目录和文件路径。

这是一个明确的安全取舍：页面 origin 下的脚本理论上可以访问同源 IndexedDB。后续若要提高隔离级别，可以把目录句柄迁移到扩展 origin 的 File Writer 页面，再通过受限的 transferable `ArrayBuffer` 通道传输单条文件数据；该迁移不属于本次最小可用版本。

```text
页面主世界 exporter.user.js
  ├─ 调用 ChatGPT API、解析对话、生成 JSON/Markdown
  ├─ 在用户手势链路调用 showDirectoryPicker
  ├─ 当前页面 origin 的 IndexedDB 保存目录句柄
  └─ 直接创建目录、写入原文件、更新 manifest 与报告
```

`chrome.runtime` 消息在 Chrome 中使用 JSON 序列化，不适合直接发送 Blob。实现时优先建立扩展 iframe 与 content script/page 的受控 `postMessage` 通道，使用 transferable `ArrayBuffer`。如果选用其他通道，必须先用实际大文件验证不会发生 base64 膨胀或消息尺寸瓶颈。

所有路径仍必须由代码生成，禁止接受 `..`、绝对路径或用户输入的任意相对路径。若后续迁移到扩展 File Writer，再增加父页面 origin 与 task token 校验。

## 11. 文件与模块建议

预计改动超过 8 个文件：

- `chrome-extension/manifest.json`
- `chrome-extension/pages/options.html`
- `chrome-extension/pages/options.js`
- `chrome-extension/styles/options.css`
- `chrome-extension/content/auto-export.js`
- `chrome-extension/exporter.user.js`
- 视测试结构新增测试文件
- `README.md`

`Tampermonkey.js` 只同步与 ZIP 路径共享且必要的重试/失败隔离修复；不为其实现扩展目录句柄存储。

## 12. 验证与验收

### 12.1 自动验证

- manifest schema 与状态转换。
- 路径清理和标题重复。
- update_time 相同跳过、变更覆盖。
- 404 跳过，429/5xx/网络错误重试。
- 429 触发共享冷却。
- 401 刷新一次后停止。
- worker 数不超过配置上限。
- 文件写完前不提交 manifest。
- manifest 写入失败时对话保持未完成。
- 恢复时重做未提交项且不重复 completed 项。
- 现有 ZIP 导出仍能运行。

### 12.2 手工验收

- 选择目录后连续写入至少 20 条，不再出现逐文件弹框。
- Chrome 重启后检查目录权限状态；权限失效时只要求一次重新授权。
- 模拟处理过程中刷新页面，能够从 manifest 继续。
- 真实或模拟 1000 条导出，观察内存不随已完成总数持续增长。
- 随机打开 JSON、Markdown 和附件，确认内容有效。
- 成功、unchanged、failed 数量之和与已处理数量一致。
- 暂停、安全停止和立即停止符合定义。
- 磁盘写满或目录被移除时暂停任务，不把当前项标记 completed。

## 13. 发布与回滚

- 原文件模式初始作为显式可选模式发布，稳定后再设为大量导出的默认推荐。
- 保留原 ZIP 路径，因此回滚只需关闭或隐藏原文件模式入口，不涉及用户数据迁移。
- manifest 必须带 `schema_version`；未知更高版本只能只读提示，不能擅自覆盖。
- 不自动修改或删除用户已有备份目录。
- 更新 README，说明 Chromium 限制、目录权限恢复方式和安全停止要求。

## 14. 风险与关键假设

- 浏览器可能撤销目录权限；每次任务前必须检查，不能承诺永久静默授权。
- 极大单附件仍可能导致单条任务内存过高。第一版应至少在写入前检查已知 Content-Length，并设置可配置或明确的安全提示；后续可改为流式传输。
- 页面关闭时不能保证异步写入完成，因此必须提供安全停止。
- 方案假设页面上下文能够持久化并重新取得目录句柄。当前实现启动时异步恢复句柄，在导出点击链路中请求写权限；如果浏览器撤销权限，会要求重新选择一次目录，而不是每个文件弹框。

## 15. 推荐实施顺序

按 `tasks.md` 的阶段实施。每个阶段必须独立可验证和可提交；任何阶段都不能依赖下一阶段才能保持现有 ZIP 功能可用。
