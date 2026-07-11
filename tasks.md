# ChatGPT Exporter 原文件增量备份任务拆分

本任务拆分对应 `plan.md`。执行时保持小提交，每项完成后运行其验证，不要把所有改动压成一个提交。

## Phase 1：验证文件系统链路与定义数据契约

### Task 1.1：验证扩展目录句柄能力

**目标**：在目标 Chromium 中验证扩展页面能选择目录、把 `FileSystemDirectoryHandle` 保存到扩展 origin 的 IndexedDB、重新加载后取回、查询权限并写入文件。

**改动**：创建最小的 File Writer 页面和脚本；不接入正式导出流程。

**验收**：

- 用户点击一次选择目录。
- 能创建、覆盖并关闭一个测试文件。
- 重新打开扩展页面后能取回句柄。
- 能区分 `granted`、`prompt`、`denied`。
- 验证失败时记录实际限制，并采用“每个新任务选一次目录”的降级，不改成逐文件下载。

**建议提交**：`feat: add extension file system capability probe`

### Task 1.2：定义设置和 manifest 模块

**目标**：增加版本化设置与 manifest 的纯逻辑模块。

**改动**：新增 `utils/export-settings.js`、`utils/export-manifest.js` 及测试。

**验收**：

- 默认并发 2、硬上限 4、最大尝试 3。
- manifest 状态转换和统计有测试。
- 未知 schema 版本拒绝写入。
- 不保存 Token、目录绝对路径或完整对话正文。

**建议提交**：`feat: define incremental export settings and manifest`

## Phase 2：实现安全 File Writer

### Task 2.1：实现目录选择和权限管理

**目标**：由扩展自身保存目录句柄，提供选择、查询、重新授权和清除操作。

**改动**：完善 File Writer，并向设置页暴露最小消息接口。

**验收**：

- 选择器只在用户点击时调用。
- 导出前实际验证 readwrite 权限。
- 权限失效不会循环弹框。
- IndexedDB 错误返回结构化错误。

**建议提交**：`feat: persist and validate backup directory access`

### Task 2.2：实现受限文件写入 API

**目标**：支持创建任务目录、对话目录、写 JSON/Markdown/附件、写 manifest 和报告。

**验收**：

- 拒绝绝对路径、`..` 和非预期文件类型。
- 所有 writable stream 都正确关闭；错误时正确 abort 或报告。
- 文件关闭前绝不返回 committed。
- 写入错误包含任务和文件类别，但不包含凭证。
- 可重复写入同一路径以支持恢复。

**建议提交**：`feat: add constrained original-file writer`

## Phase 3：设置页与导出入口

### Task 3.1：扩展设置页增加本地备份配置

**目标**：让用户配置输出模式、目录、并发、重试和增量策略。

**验收**：

- 能选择、测试、重新授权和清除目录。
- 显示目录名称与权限状态，不显示绝对路径。
- 输入值经过 normalize，无法突破并发硬上限。
- 现有定时提醒设置不受影响。

**建议提交**：`feat: add original-file export settings`

### Task 3.2：导出对话框增加输出模式

**目标**：选择“原文件目录”时检查 File Writer 与目录权限；ZIP 模式沿用旧路径。

**验收**：

- 未配置目录时引导至设置，不开始任务。
- 权限失效时提示重新授权。
- ZIP 模式行为无回归。
- Tampermonkey 不显示不可用的固定目录选项。

**建议提交**：`feat: expose original-file export mode`

## Phase 4：单条对话原文件落盘

### Task 4.1：把对话转换与 ZIP 容器解耦

**目标**：让 JSON、Markdown 和附件结果可以交给 ZIP sink 或 directory sink，而不是直接调用 `zip.file()`。

**验收**：

- 转换函数返回明确的数据对象或调用统一 sink 接口。
- Markdown 输出与当前版本一致。
- 附件文件名冲突规则保持稳定。
- 旧 ZIP sink 通过回归验证。

**建议提交**：`refactor: decouple conversation export from zip storage`

### Task 4.2：实现 directory sink 和单条提交协议

**目标**：每条对话写完立即更新 manifest 并释放内存。

**验收**：

- JSON、Markdown、附件写入约定目录。
- 单附件失败不阻止 JSON/Markdown 提交，并写入附件失败报告。
- 写文件失败时该对话不进入 completed。
- 成功后不在任务集合中保留对话正文或附件 Buffer。

**建议提交**：`feat: commit each conversation directly to backup directory`

## Phase 5：可靠请求与失败隔离

### Task 5.1：实现统一 fetch 重试策略

**目标**：为列表、对话和附件请求提供可测试的重试层。

**验收**：

- 网络错误、408、429 和指定 5xx 重试。
- 遵循 `Retry-After`，否则指数退避加抖动。
- 404 不重试。
- 401/403 只刷新一次 Token，仍失败返回 fatal auth error。
- 日志不包含 Token 和带签名附件 URL。

**建议提交**：`feat: add bounded retry policy for export requests`

### Task 5.2：实现有界 worker pool 与共享限流冷却

**目标**：默认并发 2，单条最终失败后继续后续任务。

**验收**：

- 活跃对话任务从不超过配置值或硬上限 4。
- 429 会暂停所有 worker 领取新网络任务。
- 单条失败写入 failed 列表并继续。
- fatal auth 和目录写入错误会暂停整个任务，而不是批量标失败。

**建议提交**：`feat: add resilient bounded export queue`

## Phase 6：增量更新和断点续传

### Task 6.1：实现未变化跳过与安全覆盖

**目标**：使用 conversation ID 和 update_time 做增量备份。

**验收**：

- update_time 相同不请求详情。
- update_time 增大时覆盖原目录并更新 manifest。
- 本地存在但源端缺失的对话不会自动删除。
- “始终覆盖”策略按定义工作。

**建议提交**：`feat: support incremental conversation updates`

### Task 6.2：实现任务发现与恢复

**目标**：读取未完成 manifest，继续未提交对话。

**验收**：

- completed 和 unchanged 不会重复处理。
- manifest 未提交的部分文件会被重新生成。
- 用户可以继续或新建任务，不能无提示覆盖。
- manifest schema 不支持时只读提示。

**建议提交**：`feat: resume interrupted directory exports`

### Task 6.3：实现暂停与停止状态机

**目标**：支持暂停、继续、安全停止和立即停止。

**验收**：

- 暂停后不领取新任务。
- 安全停止等待活跃任务提交。
- 立即停止不破坏已提交文件。
- 状态写入 manifest，刷新后可恢复。

**建议提交**：`feat: add export pause and safe-stop controls`

## Phase 7：报告、文档和大规模验收

### Task 7.1：完善进度 UI 与报告

**目标**：显示实时统计，生成 `export-report.json` 与 `failed-conversations.json`。

**验收**：

- discovered、completed、unchanged、failed、remaining 统计一致。
- UI 显示重试、暂停和目录状态。
- 报告足以定位失败 ID、状态码和尝试次数。
- 报告不包含 Token、Cookie 或签名下载 URL。

**建议提交**：`feat: add incremental export progress and reports`

### Task 7.2：1000 条规模与故障注入测试

**目标**：证明内存有界且恢复正确。

**验收**：

- 用模拟 API 完成 1000 条任务。
- 已完成总数增长时，内存不会保留全部历史对话内容。
- 注入 404、429、500、网络断开、无效 JSON、附件失败和磁盘写入失败。
- 在随机位置终止并恢复，最终没有遗漏或重复提交。
- 回归验证个人、团队、项目和 ZIP 导出。

**建议提交**：`test: cover large incremental exports and recovery`

### Task 7.3：更新用户文档和版本

**目标**：记录功能边界、权限行为、恢复流程和兼容性。

**验收**：

- README 说明首次目录选择和可能的重新授权。
- 说明 Chromium 支持边界及 Tampermonkey 差异。
- 说明安全停止和本地目录结构。
- manifest、注入脚本与 content script 的版本保持一致。

**建议提交**：`docs: document original-file incremental backups`

## 最终完成定义

- 1000 条对话可直接写入固定目录，不需要最终整体打包。
- 每条成功后都有可独立读取的 JSON/Markdown/附件。
- 任意单条永久失败不阻止后续导出。
- 页面刷新或浏览器重启后可以从 manifest 恢复。
- 权限或磁盘写入故障不会把未写完的数据标为成功。
- 原 ZIP 功能仍可使用。
- 文档、测试和版本号同步完成。
