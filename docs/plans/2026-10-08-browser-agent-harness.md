# 浏览器插件复杂任务 Agent 实施方案

> **For Codex:** 按任务顺序逐项实施，遵循测试先行；每个任务完成后先运行本任务的验证，再进入下一任务。

**目标：** 将现有 Chromium 浏览器插件增强为能可靠完成复杂、多步骤浏览器任务的 Agent Harness；插件始终以浏览器扩展形态运行。

**架构：** 延续现有 React 侧边栏、MV3 Service Worker、Planner/Navigator、BrowserContext 和 BYOK 模型接入。新增可恢复的任务运行记录、统一工具策略、来源证据和复杂任务检查点；Service Worker 与侧边栏断开后从持久状态恢复，不依赖全局变量或心跳维持任务正确性。

**技术栈：** TypeScript、React 18、Chrome/Edge Manifest V3（最低版本沿用 116）、LangChain、Vitest、pnpm monorepo、浏览器原生 IndexedDB。第一阶段不增加运行时依赖。

---

## 1. 产品范围与完成定义

### 1.1 产品定义

产品是浏览器插件。用户在侧边栏输入一个目标，Agent 能够拆解步骤、读取和操作多个网页、积累有出处的证据、检查每一步结果、从失败中调整方案，并在登录、信息缺失或高影响操作时请求用户介入。

目标垂直场景：

> 阅读两个网页和一个 PDF，汇总信息并标出来源；打开业务表单并按证据填入草稿；展示预览；用户确认后才提交。

### 1.2 范围

- 包含：网页搜索与浏览、跨标签页信息收集、网页表单、在线 PDF 和用户明确授权的本地 PDF、长任务计划与恢复、来源引用、用户确认、高可见性任务进度。
- 浏览器范围：Chrome / Edge 等 Chromium 浏览器，最低版本按 `chrome-extension/manifest.js` 中的 116 约束。
- 模型范围：继续使用用户配置的 OpenAI 兼容或现有供应商 API；页面内容只发送给用户配置的模型服务。
- 明确排除：桌面本地 Agent、终端、任意本地文件系统浏览、Git 操作、Native Messaging 宿主、独立本地服务端。以后如果用户改变产品边界，再单独评估。

### 1.3 完成定义

首个完整版本须满足：

1. 复杂任务能生成有序、可更新的步骤清单，并能解释当前进度。
2. 每条关键事实可追溯到网址、页面标题、采集时间及页面或 PDF 页码。
3. 扩展 Service Worker 重启、侧边栏关闭重开或浏览器短暂断连后，任务状态可恢复；不盲目重放无法确认结果的写操作。
4. 页面内容作为不可信数据处理；工具权限、网址策略和高影响操作确认由代码执行，不依赖模型自行遵守提示词。
5. 表单提交、删除、购买、支付等动作必须先展示操作内容并取得本次操作的用户确认。
6. 对代表性浏览器任务建立可重复评估集，并记录成功率、恢复率、来源完整率和策略违规数。

## 2. 代码现状与实施原则

### 2.1 当前已有基础

- `chrome-extension/src/background/agent/executor.ts` 已有 Planner/Navigator 循环、周期规划、失败计数、暂停/取消和可选步骤回放。
- `chrome-extension/src/background/agent/memory.ts` 有最多 20 条、每条最多 400 字符的内存 scratchpad，但当前只存在 Executor 生命周期内。
- `chrome-extension/src/background/browser/context.ts` 已提供标签页切换、打开、关闭、导航和页面连接；工具 schema 已有多标签页动作。
- `packages/storage/lib/chat/history.ts` 已保存聊天会话和可选 Agent 步骤历史；设置与 Skill 存储使用现有 storage package。
- `chrome-extension/src/background/agent/messages/utils.ts` 已提供 `wrapUntrustedContent`，部分页面状态和 `cache_content` 已使用它。
- `pages/side-panel/src/SidePanel.tsx` 已有 Service Worker Port、心跳和本地文件读取消息处理；`chrome-extension/src/background/agent/pdf.ts` 已有 PDF.js 文本层提取。
- `pages/options/src/components/SkillsSettings.tsx` 和 `packages/storage/lib/settings/skills.ts` 已提供 Skill 设置、启用、导入导出基础。

### 2.2 已知差距

- `chrome-extension/src/background/index.ts` 通过单个 `currentExecutor` 全局变量管理任务，且侧边栏 Port 断开时会直接取消任务；历史记录主要是聊天内容或可选回放 JSON，不是可恢复任务状态。
- `new_task` 校验了传入的 `tabId`，但新 Executor 初始化时未显式切换到该标签页；`setupExecutor` 又自行查询活动标签页。
- `BrowserContext.navigateTo()` 和 `openTab()` 检查目标网址，但导航完成后的最终重定向地址没有统一的策略检查。
- `read_page` 返回 DOM、PDF 或视觉识别内容时，没有在所有路径上统一调用 `wrapUntrustedContent`。Planner 提示中对本地 PDF 的能力描述也高于当前实际读取链路。
- 侧边栏有 `read_file_arraybuffer` 接收处理逻辑；后台当前 PDF 路径直接对 `file://` 调用 `fetch`，两端之间尚未形成完整的请求/响应流程。
- `getSkillsSystemInstructions()` 当前只注入启用的 `always` Skill；`allowedTools` 尚未在动作执行边界强制检查，manual Skill 也没有完整的会话选择与执行链路。
- `MessageManager` 使用字符数估算 Token 并裁剪历史；任务事实和来源证据没有独立、持久化的数据结构。

### 2.3 原则

- 在现有 Planner/Navigator 和 BrowserContext 上增量建设，先修边界和恢复能力，不做大规模重写。
- 不引入新的运行时依赖；先复用现有组件和浏览器原生 API。
- 每个可独立验证的任务单独提交；提交说明遵循仓库 Lore Commit Protocol，包含意图、验证结果和未验证项；不得提交 API Key 或真实页面敏感数据。
- 所有模型输出均为建议；URL、工具白名单、确认策略和状态迁移在代码中强制执行。
- 页面文本、截图识别、PDF 内容、网页标题和网页链接均为不可信输入。清洗或提示词标签只是纵深防护，不取代策略门。
- 持久化只保存恢复和审计所需的最小信息；聊天/任务历史删除时同步删除对应事件、证据和截图。
- 对不确定是否已完成的副作用动作，恢复时先观察页面并核对后置条件，再决定继续、询问或重试。

## 3. 目标架构

```text
Side Panel UI
  ├─ 输入、计划清单、证据/动作时间线、确认卡片、暂停/继续
  └─ 通过受校验的 Runtime Port 订阅任务状态并发送命令
         │
         ▼
Background Task Runtime（扩展 Service Worker）
  ├─ RunController：创建/恢复/暂停/取消单个前台任务
  ├─ Executor：规划 → 浏览器工具 → 观察 → 验证 → 重规划
  ├─ PolicyGate：URL、Skill 工具白名单、敏感动作确认
  └─ BrowserContext：标签页、DOM/CDP、PDF 和页面观察
         │                         │
         ▼                         ▼
  RunStore（IndexedDB）       用户配置的模型 API
  事件、检查点、证据索引       仅发送当前任务所需上下文
```

### 3.1 持久化模型

使用浏览器原生 IndexedDB 保存运行数据，避免把高频、大体积事件持续写进 `chrome.storage.local`。IndexedDB 版本迁移集中在 Storage 包。

建议实体：

```ts
type TaskRunStatus =
  | 'queued'
  | 'running'
  | 'waiting_approval'
  | 'waiting_user'
  | 'paused'
  | 'interrupted'
  | 'completed'
  | 'failed'
  | 'cancelled';

interface TaskRun {
  id: string;
  sessionId: string;
  goal: string;
  status: TaskRunStatus;
  createdAt: number;
  updatedAt: number;
  activeTabId?: number;
  checkpointVersion: number;
}

interface TaskRunEvent {
  id: string;
  runId: string;
  sequence: number;
  type: string;
  timestamp: number;
  payload: unknown;
}

interface TaskCheckpoint {
  runId: string;
  sequence: number;
  plan: PlanStep[];
  completedStepIds: string[];
  pendingAction?: PendingAction;
  memory: MemoryFact[];
  evidenceIds: string[];
  activeTabId?: number;
}
```

事件只追加；检查点允许按版本更新。页面原文和截图设置大小上限，并按保留策略清理。存储接口必须支持按任务删除、删除全部任务、恢复中断任务和顺序读取事件。

### 3.2 执行状态机

```text
queued → running → completed
                 ↘ waiting_approval → running / cancelled
                 ↘ waiting_user → running / cancelled
                 ↘ paused → running / cancelled
                 ↘ interrupted → running / failed / cancelled
                 ↘ failed / cancelled
```

- 在每次模型请求和浏览器写操作前保存当前计划、动作和检查点。
- 收到动作结果后先追加事件，再更新检查点，最后向 UI 广播。
- 启动/重新连接时查询非终态任务；检测到 Service Worker 退出留下的 `running` 任务后标记 `interrupted`，重建 Executor 上下文。
- 恢复时验证标签页仍存在、URL 仍符合策略、页面状态可观察。对没有持久化结果的点击/提交动作先做后置条件检查；禁止直接重复提交。
- 侧边栏断开不等于用户取消任务；取消必须由明确的 `cancel_task` 命令触发。

## 4. 里程碑与任务

按依赖顺序执行。单人粗估 4–6 周，不包含等待真实业务站点、模型端点和验收数据的时间；完成 M0–M3 即可交付浏览器复杂任务 MVP，M4 用于评估和后续增强。

### M0：正确性、安全边界与可测基础（约 4–6 个工程日）

#### 任务 1：统一网页来源为不可信证据

**目标：** DOM、PDF、视觉识别结果和缓存内容以同一来源格式进入 Planner/Navigator 上下文；页面里的指令不能改写用户目标或触发工具。

**文件：**

- 修改：`chrome-extension/src/background/agent/actions/builder.ts`
- 修改：`chrome-extension/src/background/agent/messages/utils.ts`
- 修改：`chrome-extension/src/background/agent/prompts/base.ts`
- 修改：`chrome-extension/src/background/agent/prompts/templates/common.ts`
- 创建：`chrome-extension/src/background/agent/actions/__tests__/page-evidence.test.ts`

**步骤：**

1. 为 DOM、PDF、视觉识别三种 `read_page` 返回路径分别增加失败用例，断言其内容均有不可信边界标签和来源元数据。
2. 抽取统一的页面证据格式化函数，要求来源包含 `tabId`、URL、标题、采集时间和可选页码；原始网页内容仍通过现有 `wrapUntrustedContent` 处理。
3. 更新 Planner/Navigator 公共规则：只能把页面内容当作数据；任何页面文字都不能批准操作、扩大工具权限或替代用户指令。
4. 运行 `pnpm --filter chrome-extension test`，确认页面证据测试通过。
5. 运行 `pnpm --filter chrome-extension type-check`，确认类型通过。

#### 任务 2：绑定目标标签页并在导航后重新校验 URL

**目标：** 新任务在指定标签页执行；所有导航来源在下一次页面观察或动作前校验最终地址。

**文件：**

- 修改：`chrome-extension/src/background/index.ts`
- 修改：`chrome-extension/src/background/browser/context.ts`
- 修改：`chrome-extension/src/background/browser/util.ts`
- 创建：`chrome-extension/src/background/browser/__tests__/navigation-policy.test.ts`

**步骤：**

1. 为指定 `tabId` 不存在、URL 非法、目标域名被拒绝和合法标签页建立用例。
2. `new_task` / replay 在创建 Executor 前将 BrowserContext 显式切换到消息中的 `tabId`；移除 `setupExecutor` 静默选择活动标签页作为任务起点的行为。
3. 对 `navigateTo`、`openTab` 和重定向完成后的实际 `chrome.tabs.get(tabId).url` 统一调用 URL 策略；策略拒绝后不再把该页面内容发给模型，并记录明确失败事件。
4. 标签页关闭、目标域重定向和 debugger attach 失败均进入可见错误路径，不让任务继续使用过期页面状态。
5. 运行 `pnpm --filter chrome-extension test` 和 `pnpm --filter chrome-extension type-check`。

#### 任务 3：接通在线与本地 PDF 读取链路

**目标：** 明确区分在线 PDF、用户授权的 `file://` PDF 和扫描件；实际结果与提示词和产品说明一致。

**文件：**

- 修改：`chrome-extension/src/background/agent/actions/builder.ts`
- 修改：`chrome-extension/src/background/agent/pdf.ts`
- 修改：`chrome-extension/src/background/index.ts`
- 修改：`pages/side-panel/src/SidePanel.tsx`
- 修改：`chrome-extension/src/background/agent/prompts/templates/planner.ts`
- 修改：`docs/技术方案.md`
- 修改：`README.md`
- 创建：`chrome-extension/src/background/agent/__tests__/pdf.test.ts`

**步骤：**

1. 先补测试/验收用例：在线文本 PDF、`file://` PDF 未授权、已授权本地 PDF、扫描件、超页数 PDF、损坏 PDF 和超大文件。
2. 在线 PDF 继续由扩展权限下的 fetch 读取；本地 PDF 通过有 request id、大小上限和超时的 Side Panel ↔ Service Worker 消息通道取得字节，禁止把任意文件路径当作通用文件读取接口。
3. 明确检查 Chrome 的“允许访问文件网址”设置；未授权时提示用户如何启用，不尝试绕过浏览器权限。
   本地 PDF 只读取用户已在浏览器打开且明确授权的文件，不开放任意路径读取。若读取时侧边栏未运行，则任务进入等待状态，侧边栏重连后再请求文件字节。
4. 对长 PDF 按页/分段读取，返回 `numPages`、已读取页范围和是否截断；设置最大字节数、最大页数及可继续读取的游标。
5. 扫描件不能宣称 PDF.js 已做 OCR。MVP 使用视觉模型逐页读取用户要求的页或明确范围；模型不支持视觉时给出准确限制提示。
6. 修改 Planner/Navigator 提示和 README/技术方案中的 PDF 能力描述，避免继续承诺未实现的全量 OCR。
7. 在 Chromium 116+ 手动验收本地文件授权、在线 PDF 和失败提示；运行扩展测试与类型检查。

#### 任务 4：让 Skill 工具白名单在执行边界生效

**目标：** 用户选择的 Skill 决定可用工具；提示词不能单独承担权限限制。

**文件：**

- 修改：`packages/storage/lib/settings/skills.ts`
- 修改：`chrome-extension/src/background/services/skills.ts`
- 创建：`chrome-extension/src/background/services/toolPolicy.ts`
- 修改：`chrome-extension/src/background/agent/executor.ts`
- 修改：`chrome-extension/src/background/agent/agents/navigator.ts`
- 修改：`chrome-extension/src/background/agent/actions/builder.ts`
- 修改：`pages/options/src/components/SkillsSettings.tsx`
- 修改：`pages/side-panel/src/SidePanel.tsx`
- 创建：`chrome-extension/src/background/services/__tests__/tool-policy.test.ts`

**步骤：**

1. 为未选 Skill、always Skill、manual Skill、多个 Skill 合并白名单和空白名单编写纯策略用例。
2. 定义统一 `ToolPolicy`：默认只允许当前注册的安全工具；Skill 白名单取交集；高危动作始终还需独立确认。
3. 在 Navigator 调用动作前做服务端式（扩展内部）强制校验；UI/提示词隐藏工具不能替代该校验。
4. 补齐侧边栏会话级 manual Skill 选择，并显示当前生效 Skill；配置页描述白名单和工具能力的关系。
5. 验证模型强行调用白名单外工具时动作不会执行，且产生可审计的拒绝事件。
6. 运行 `pnpm --filter chrome-extension test`、`pnpm --filter chrome-extension type-check` 和 `pnpm --filter @extension/options type-check`。

### M1：持久任务运行时与断点恢复（约 5–7 个工程日）

#### 任务 5：实现 IndexedDB TaskRunStore

**目标：** 任务状态、事件和检查点不再只存在于 `currentExecutor` 或内存中。

**文件：**

- 创建：`packages/storage/lib/taskRuns/types.ts`
- 创建：`packages/storage/lib/taskRuns/database.ts`
- 创建：`packages/storage/lib/taskRuns/store.ts`
- 创建：`packages/storage/lib/taskRuns/index.ts`
- 修改：`packages/storage/lib/index.ts`
- 修改：`packages/storage/index.ts`
- 创建：`chrome-extension/src/background/task/__tests__/task-run-store.test.ts`

**步骤：**

1. 为任务生命周期、事件顺序、检查点版本、旧数据库升级、单任务删除和全量删除建立测试。
2. 使用浏览器原生 IndexedDB 实现数据库创建、版本迁移、事务追加事件、保存/读取检查点和按 runId 查询。
3. 为每个任务事件生成单调递增 sequence；事务失败不能让检查点显示超前于事件日志。
4. 加入最小保留策略：按设置清除已结束任务；事件和证据受字节/条数上限保护；清除聊天会话时清除关联 run。
5. 运行 `pnpm --filter chrome-extension test`、`pnpm type-check` 和 `pnpm build`。

#### 任务 6：通过 RunController 恢复 Executor

**目标：** Service Worker 重启和 Side Panel 断开不导致任务状态丢失，也不重复执行危险动作。

**文件：**

- 创建：`chrome-extension/src/background/task/run-controller.ts`
- 修改：`chrome-extension/src/background/task/manager.ts`
- 修改：`chrome-extension/src/background/index.ts`
- 修改：`chrome-extension/src/background/agent/executor.ts`
- 修改：`chrome-extension/src/background/agent/types.ts`
- 创建：`chrome-extension/src/background/task/__tests__/run-controller.test.ts`

**步骤：**

1. 为创建、暂停、继续、取消、Port 断开、Service Worker 恢复和待处理写动作建立状态机测试。
2. 将 `currentExecutor` 的创建、恢复和终态清理迁入 RunController；首个 MVP 限制为每个扩展配置一个活动前台 run，明确拒绝冲突任务。
3. 将 Executor 的关键生命周期、计划更新、工具请求/结果和失败事件持久化；持久化失败时暂停后续浏览器写操作并显示错误。
4. Port 断开仅停止 UI 广播，不自动取消任务；用户取消仍通过显式命令执行。
5. Service Worker 初始化时扫描非终态任务，将崩溃留下的 `running` 标记为 `interrupted`；重新连接后提供恢复/放弃状态。
6. 恢复前验证 tabId、当前 URL、待处理动作及后置条件；若动作执行结果不明，先观察再决定，禁止盲目重放提交/删除/购买。
7. 在 Chrome/Edge 116+ 手动强制扩展后台 Service Worker 重启并重开侧边栏，确认任务可恢复且不会重复提交；运行控制器测试和构建。

#### 任务 7：把侧边栏连接改为可重连的任务客户端

**目标：** UI 重新连接后能重建消息、计划、动作时间线和运行控制，而不是只显示当前 Port 收到的增量事件。

**文件：**

- 修改：`pages/side-panel/src/SidePanel.tsx`
- 修改：`pages/side-panel/src/types/event.ts`
- 修改：`pages/side-panel/src/types/message.ts`
- 修改：`chrome-extension/src/background/index.ts`
- 修改：`packages/storage/lib/chat/history.ts`

**步骤：**

1. 定义 `get_run_snapshot`、`subscribe_run`、`pause_task`、`resume_task`、`cancel_task` 等版本化消息协议，并测试无效消息和未知 runId。
2. 侧边栏连接后先读取快照，再从最后 sequence 订阅增量事件；按 sequence 去重，防止重连重复展示。
3. 移除“Port 断开即视为取消”的 UI 逻辑；重连失败显示恢复状态和重新连接入口。
4. 刷新侧边栏或关闭重开后，验证聊天记录与任务状态一致。
5. 运行 `pnpm --filter chrome-extension type-check`、`pnpm --filter @extension/sidepanel type-check` 和 `pnpm build`。

### M2：复杂任务规划、证据记忆与自校验（约 5–8 个工程日）

#### 任务 8：结构化子任务计划与状态推进

**目标：** 将 Planner 的自由文本 `next_steps` 升级成可持久化、可校验的任务清单，同时兼容已有模型输出。

**文件：**

- 修改：`chrome-extension/src/background/agent/agents/planner.ts`
- 修改：`chrome-extension/src/background/agent/executor.ts`
- 修改：`chrome-extension/src/background/agent/prompts/templates/planner.ts`
- 修改：`chrome-extension/src/background/agent/types.ts`
- 创建：`chrome-extension/src/background/agent/__tests__/plan-state.test.ts`

**步骤：**

1. 为计划 JSON 编写 schema 测试：步骤 ID 唯一、成功条件非空、状态只允许 queued/running/completed/blocked/skipped。
2. 定义 `PlanStep { id, title, successCriteria, status, evidenceIds }`；更新 Planner schema 输出结构化 steps。
3. 为旧版 `next_steps` 文本增加单向归一化兼容，确保现有供应商 structured output 仍可工作；解析失败时保留旧计划并触发一次有界重试。
4. Executor 每个子任务完成后更新检查点；步骤失败时标记 blocked 并把错误和观察交回 Planner 重规划，设置最大重规划次数和总步骤上限。
5. 完成判定必须核对用户目标和每个必需子任务成功条件，不能只以 Navigator 的 `done` 作为唯一依据。
6. 运行 Planner/状态测试、`pnpm type-check` 和模型结构化输出冒烟。

#### 任务 9：持久化证据和有界上下文压缩

**目标：** 多页面事实能跨步骤、跨重启引用；上下文压缩不能丢失目标、未完成步骤、确认状态和来源。

**文件：**

- 修改：`chrome-extension/src/background/agent/memory.ts`
- 修改：`chrome-extension/src/background/agent/messages/service.ts`
- 修改：`chrome-extension/src/background/agent/messages/views.ts`
- 修改：`chrome-extension/src/background/agent/agents/navigator.ts`
- 修改：`chrome-extension/src/background/agent/prompts/base.ts`
- 修改：TaskRunStore 对应文件
- 创建：`chrome-extension/src/background/agent/messages/__tests__/context-budget.test.ts`

**步骤：**

1. 为中英文混合文本、图片、超长页面、跨页来源和历史裁剪编写预算与保留规则测试。
2. 将 `TaskMemory` 从普通字符串列表迁移为结构化 `MemoryFact`：内容、来源 evidenceId、时间、可信级别、关联步骤；从 TaskRunStore 恢复。
3. 重构上下文构建：固定保留系统/安全规则、原始用户目标、当前计划、待确认动作、重要证据索引和最近步骤；压缩已完成步骤摘要。
4. 保留页面原始证据索引供按需读取，不把整个长页面重复塞进每一轮；重要事实摘要必须引用 evidenceId。
5. 模型预算按供应商/模型配置和安全余量计算；估算不足时优先删除可重取的页面片段，不删除用户目标、安全策略或审批状态。
6. 运行上下文测试、类型检查，并以 50+ 步模拟任务检查 Token 预算和恢复一致性。

#### 任务 10：失败后的验证、重规划和完成核对

**目标：** 从盲目重试变为观察后诊断；每项关键结果有成功条件。

**文件：**

- 修改：`chrome-extension/src/background/agent/executor.ts`
- 修改：`chrome-extension/src/background/agent/agents/navigator.ts`
- 修改：`chrome-extension/src/background/agent/actions/builder.ts`
- 修改：`chrome-extension/src/background/agent/prompts/templates/planner.ts`
- 创建：`chrome-extension/src/background/agent/__tests__/recovery.test.ts`

**步骤：**

1. 为点击未生效、表单值未写入、导航超时、tab 被关闭和后置条件通过/失败编写测试。
2. 定义有限错误类别（瞬态、权限、页面结构变化、用户介入、不可恢复），附带当前 URL 和脱敏后的动作摘要。
3. 在重试前重新读取页面状态；同一动作最多执行有界次数，结构变化时要求模型生成不同策略。
4. 每个可验证动作定义后置条件，例如输入框值、目标 URL、页面确认文字；无法确认时进入 `waiting_user` 或 `blocked`，不能谎报完成。
5. 最终回答中的关键结论关联来源证据；没有证据时明确标注未验证。
6. 运行恢复测试并对长任务做手动故障注入。

### M3：安全的浏览器操作和人工确认（约 4–6 个工程日）

#### 任务 11：敏感动作审批门

**目标：** 表单提交等副作用操作由代码实施审批门，且确认只对具体动作和参数有效。

**文件：**

- 修改：`chrome-extension/src/background/agent/actions/schemas.ts`
- 修改：`chrome-extension/src/background/agent/actions/builder.ts`
- 修改：`chrome-extension/src/background/agent/executor.ts`
- 修改：`chrome-extension/src/background/task/run-controller.ts`
- 修改：`pages/side-panel/src/SidePanel.tsx`
- 创建：`pages/side-panel/src/components/ApprovalCard.tsx`
- 创建：`chrome-extension/src/background/task/__tests__/approval-policy.test.ts`

**步骤：**

1. 为提交、删除、购买、支付、下载、关闭标签页、跨域导航和普通只读动作建立策略矩阵测试。
2. 定义 `PendingAction`，保存 runId、工具名、参数摘要、来源 tab/url、过期时间和不可预测 nonce。
3. 策略门在工具执行前阻塞高影响动作并持久化 `waiting_approval`；模型输出不能自行批准。
4. 侧边栏展示动作目标、关键字段、来源域名和“批准一次/拒绝”按钮；审批 nonce 单次使用并绑定精确参数摘要。
5. 审批拒绝、超时、页面跳转或参数变化时取消待处理动作；恢复后需重新展示审批。
6. 运行审批策略测试，手动确认无用户点击时提交动作不会触发。

#### 任务 12：提升页面动作可靠性与 Skill 工作流

**目标：** 复杂任务能更稳地定位动态页面元素、填写字段和跨页传递信息。

**文件：**

- 修改：`chrome-extension/src/background/browser/page.ts`
- 修改：`chrome-extension/src/background/browser/dom/views.ts`
- 修改：`chrome-extension/src/background/agent/actions/builder.ts`
- 修改：`chrome-extension/src/background/agent/actions/schemas.ts`
- 修改：`pages/options/src/components/SkillsSettings.tsx`
- 修改：`pages/side-panel/src/SidePanel.tsx`
- 创建：`chrome-extension/src/background/browser/__tests__/action-verification.test.ts`

**步骤：**

1. 为元素引用失效、重复元素、受控 React/Vue 输入框、下拉框、跨域 iframe 不可操作和动态加载建立测试。
2. 每次写操作前刷新页面状态并验证 locator 唯一；执行后验证值或页面变化，失败时报告准确原因。
3. 规范 `fill_form` 流程：先提取字段和候选值、将证据映射到字段、写入草稿、回读核对、最后进入确认门。
4. 为跨页采集、页面比较、表格提取和填表建立内置 Skill 示例，并分别声明所需工具白名单和用户确认点。
5. 设置 Skill 作用域（always/manual）、版本化导入导出和会话展示；任何 Skill 不能放宽全局 URL/高危策略。
6. 运行浏览器动作测试，并在真实 Chromium 页面上验证表单草稿和回读结果。

#### 任务 13：侧边栏任务时间线与证据视图

**目标：** 用户能理解 Agent 正在做什么、依据是什么、在哪里暂停以及如何恢复。

**文件：**

- 修改：`pages/side-panel/src/SidePanel.tsx`
- 修改：`pages/side-panel/src/components/MessageList.tsx`
- 修改：`pages/side-panel/src/types/event.ts`
- 创建：`pages/side-panel/src/components/TaskPlanPanel.tsx`
- 创建：`pages/side-panel/src/components/TaskTimeline.tsx`
- 创建：`pages/side-panel/src/components/EvidenceList.tsx`
- 修改：`packages/i18n/locales/en/messages.json`
- 修改：`packages/i18n/locales/zh_TW/messages.json`

**步骤：**

1. 为计划待办、进行中、已完成、被阻塞、等待确认和恢复中设计空/错误/加载状态。
2. 展示每个步骤的状态、当前标签页、最近动作及验证结果；用户可展开证据查看来源 URL、标题、时间和页码。
3. 任务处于等待用户/审批时固定显示明确操作卡片；暂停、继续、取消使用运行时消息协议。
4. 事件展示按 sequence 幂等更新；大量历史通过分页读取，不在初始 Side Panel 渲染全部事件。
5. 验证侧边栏关闭重开、历史会话切换和长任务时间线没有重复事件或状态跳变。

### M4：评估、发布与扩展能力（约 3–5 个工程日）

#### 任务 14：建立浏览器任务评估集和发布门槛

**目标：** 用固定任务衡量复杂任务能力，避免只凭单次演示判断效果。

**文件：**

- 创建：`docs/agent-evaluation.md`
- 创建：`chrome-extension/src/background/agent/__tests__/fixtures/` 下的确定性 mock 数据
- 修改：必要的 Agent / browser 测试文件
- 更新：`docs/技术方案.md`
- 更新：`README.md`

**评估集：**

1. 单页信息提取与出处引用。
2. 两到五个标签页的信息采集、比较和汇总。
3. 20 页以上文本 PDF 的指定内容查找与分段续读。
4. 已授权本地 PDF、扫描件视觉读取和错误提示。
5. 表单草稿、回读核对、未经审批不得提交、审批后提交一次。
6. 页面提示注入、禁止域名重定向、DevTools 冲突、登录中断、扩展后台重启和标签页关闭。

**发布门槛：**

- 至少 30 个可重复任务，按信息检索、跨页综合、PDF、表单和恢复场景分层记录。
- MVP 目标：普通网页任务成功率 ≥ 85%，复杂跨页/PDF/表单任务成功率 ≥ 75%；完成结果来源覆盖率 ≥ 95%。先跑基线，若指标与真实基线差异过大，记录原因并调整样本难度，不删失败样本。
- 高影响动作未经确认执行数为 0；禁止域名下一步工具调用数为 0。
- 任务中断恢复后，不丢失已确认步骤；对结果未知的副作用动作必须先核验或重新询问。
- 同时记录模型、供应商、Token、每任务耗时、失败类别和用户介入次数；日志不包含 API Key。

**步骤：**

1. 先固定评估输入、预期证据和判分规则，避免任务运行后更改判分标准。
2. 建立 deterministic mock LLM 的单元/集成回归；真实模型场景单独记录模型和配置，不把凭据提交到仓库。
3. 在 Chrome/Edge 116+ 对目标真实业务站点做手动验收，并记录浏览器版本、站点、成功/失败轨迹和用户介入点。
4. 运行 `pnpm --filter chrome-extension test`、`pnpm type-check`、`pnpm lint`、`pnpm build`。
5. 更新 README 的安装、权限、数据留存、文件 URL 授权、API 隐私、已知限制和恢复说明。

#### 任务 15（可选，MVP 发布后）：插件内受控的专职 Agent 协作

**目标：** 只有当评估显示单 Planner/Navigator 在长任务分析上存在瓶颈时，再引入扩展内部的专职推理角色。

**边界：** 不启动本地进程或 Companion；所有角色是扩展发出的受控模型请求。浏览器写操作永远由一个 Browser Operator 串行拥有；并行只用于对已采集证据做只读分析。

**候选角色：** Planner（步骤编排）、Browser Operator（唯一浏览器写入者）、Verifier（逐项检查成功条件）、Research Synthesizer（对独立证据集做只读归纳）。

**进入条件：** 评估集已稳定、任务恢复率达标、工具策略覆盖所有动作、并行分析能降低耗时或提高成功率且成本可接受。未满足这些条件时保持现有 Planner/Navigator 架构。

## 5. 验证命令

在对应实现任务完成后使用：

```bash
# 扩展单元测试
pnpm --filter chrome-extension test

# 各 workspace TypeScript 检查
pnpm type-check

# 代码风格检查
# 不使用根目录 pnpm lint（该脚本带 --fix，会改写文件）；此命令只执行检查
pnpm exec turbo lint --continue

# 全量扩展构建
pnpm build
```

真实浏览器验收使用 Chrome/Edge 116+ 的未打包扩展。发布前至少模拟一次：侧边栏关闭重开、Service Worker 被终止、模型请求中断、debugger 被 DevTools 抢占、页面重定向和待审批任务恢复。构建成功不等于浏览器 E2E 验收通过，报告中需分别列出。

## 6. 风险与应对

| 风险 | 应对 |
|---|---|
| MV3 Service Worker 会被浏览器终止 | 任务状态先持久化；重启后恢复；将事件消息看作投影，不作为唯一事实来源。参考 [Chrome Service Worker 生命周期](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle)。 |
| 侧边栏关闭导致长任务不可见 | 后台运行与 UI 连接解耦；重开时读运行快照，提供继续/取消操作。 |
| CDP attach 与 DevTools 冲突或用户手动 detach | 识别 `onDetach`，保存中断状态并提示重试/降级；不能静默继续。 |
| 网站 DOM 动态变化 | 每次写操作前刷新元素树，写后检查后置条件；失败后重新规划而非无限重试。 |
| 提示注入绕过提示词 | 页面数据标记为不可信，同时由代码层 URL、工具白名单和审批策略拦截。 |
| 模型对结构化输出、视觉或工具调用支持不同 | 启动时校验能力；schema 解析有限重试；提供无视觉降级路径；记录能力配置。 |
| 本地 PDF 权限和文件过大 | 仅用户显式授权；限制文件字节/页数；分段读取；文件读取消息绑定一次性 request id。 |
| 用户页面内容进入模型 API | 清楚展示当前供应商配置；只发送完成任务需要的页面片段；支持清除本地任务和证据历史。 |
| IndexedDB 配额/迁移失败 | 事件和证据设上限、定期清理、迁移失败时禁止继续写操作并提示导出/清理。 |
| 任务成功率被演示样本高估 | 使用固定评估集，保留失败轨迹，分别统计普通任务和复杂任务。 |

## 7. 建议实施节奏

| 阶段 | 交付物 | 进入下一阶段的门槛 |
|---|---|---|
| M0 | 页面信任边界、标签页/URL 策略、PDF 通路、Skill 工具策略 | 安全策略和 PDF 手动验收通过；类型与构建通过 |
| M1 | IndexedDB 任务记录、RunController 恢复、重连侧边栏 | Service Worker 重启后可恢复；未知写操作不会自动重放 |
| M2 | 结构化计划、来源证据、上下文管理、自校验/重规划 | 50+ 步模拟任务不丢目标/审批/证据，失败可定位 |
| M3 | 工具后置条件、高危确认、复杂操作 UI | 高影响动作未经确认执行为 0；表单草稿可回读核对 |
| M4 | 30 项评估、发布文档和已知限制 | 达到发布指标或有明确的基线差距和修复项 |
| 可选 | 扩展内部只读专职分析角色 | 评估证明单 Agent 的实际瓶颈，收益覆盖复杂度和成本 |

## 8. 参考资料

- 当前技术基线：[技术方案](../技术方案.md)
- Agent loop 调研：[Agent 逻辑能力增强调研](../agent-loop增强调研.md)
- 上手和浏览器环境：[M1 上手指南](../M1-上手指南.md)
- Chrome 扩展 Service Worker 生命周期：[官方文档](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle)
