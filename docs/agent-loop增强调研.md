# Agent 逻辑能力增强 · 调研与路线(v1,2026-09-30)

> 回答两个问题:①现在是否只能操作单页?②如何增强 agent 的逻辑能力——自研增强 loop,还是引入 pi 这类强 agent?

---

## 1. 现状:多页能力的真实边界

**不是只能单页,但只支持「顺序型」跨页。** 代码盘点结论:

| 能力 | 现状 |
|---|---|
| 多标签页工具 | ✅ 已有 `open_tab` / `switch_tab` / `close_tab` / 标签页列表 |
| 跨页上下文 | ✅ 每步状态里会列出「其他可用标签页」(标题+URL),模型可以自主切换 |
| 多 Page 管理 | ✅ browserContext 维护 Page 映射(`_getOrCreatePage`),切换即重新附加 debugger |
| 并行操作 | ❌ 一次只聚焦一个"当前页",没有并行 |
| 跨页任务编排 | ❌ 没有子任务分解/队列结构,复杂跨页流程全靠模型自己隐式编排 |
| 跨步骤工作记忆 | ⚠️ 有雏形(`cache_content` 动作),没有持久化的共享 scratchpad |

典型「从 A 页采集数据 → 到 B 页填表」的顺序流程现在就能跑;失败的是**长链路、多目标、需要中途汇总和自校验**的复杂任务——这不是"单页"限制,是 loop 的逻辑结构限制。

---

## 2. pi 是什么(调研结论)

- **确认身份**:Mario Zechner(badlogic)的极简编码 agent。仓库 badlogic/pi-mono,已迁移/更名为 **earendil-works/pi**("home of the Pi agent harness"),MIT,TypeScript,活跃(v0.73.x)。热度来源:Armin Ronacher 2026-01 文章,pi 已成为 **OpenClaw 的底层 harness**(部分细节未核实)。
- **架构**:monorepo 四件套——`pi-ai`(统一多模型 LLM API)、`pi-agent-core`(工具执行+校验+**事件流式 agent loop**)、`pi-tui`(终端 UI)、`pi-agent`(通用 agent,transport 抽象/状态管理)。默认只有 read/write/edit/bash 四个工具,**行为尽量靠扩展机制而非堆内置工具**;MCP 靠扩展适配(未核实)。
- **能否直接引入**:**不能在 MV3 里跑**——它是 Node CLI,依赖终端与文件系统。`pi-ai` + `pi-agent-core` 近乎纯 TS+fetch,理论可抽离移植(未验证),但工程量不小且收益主要是"思想"而非代码。
- **值得移植的思想**:①极简工具注册 + 统一事件流 loop;②扩展/技能承载行为(与我们 Skill 系统同构,验证了方向);③会话持久化与回放(我们已有 replay 雏形);④系统提示按需组装。

---

## 3. 2026 年主流浏览器 agent 的 loop 模式

browser-use(可选 planner 周期重规划、消息摘要做工作记忆、多标签、并行多 agent,另有 workflow-use 确定性工作流)、stagehand(act/observe/extract 原语 + 失败自愈)、Claude for Chrome(规划-执行分离 + 站点白名单 + 敏感操作确认 + 注入分类器)、OpenAI ChatGPT agent/Atlas(云端虚拟浏览器 + watch mode 人审)。

**共性模式**:分解 → 执行 → 观察 → 反思/重规划 → scratchpad 记忆 → 失败恢复 → 敏感操作确认。

nanobrowser 上游仍为 planner+navigator 双模块,未见多标签编排/任务队列的标志性 release。

---

## 4. 三条路线对比

| 路线 | 可行性 | 成本 | 收益 | 结论 |
|---|---|---|---|---|
| **A. 自研增强 loop** | 高,完全留在现有架构(LangChain + side panel 宿主) | 中(纯我们自己的代码) | 子任务分解 + 工作记忆 + 反思重规划,覆盖 90% 填报/采集场景 | **推荐,近期做** |
| B. 引入 pi 本体 | 低:无法进 MV3;仅可作伴生进程的 Node 侧内核 | 高(伴生进程 + 双端维护) | 与 A 大量重叠 | 不引入本体,只移植思想 |
| C. 本地伴生进程(native messaging / CDP 桥) | 中,代表:browser-use 官方扩展、chrome-devtools-mcp | 高(native host 安装、跨平台、版本同步) | 能力上限最高(Playwright、真并行、无 MV3 限制) | 二期后备,等真实需求 |

---

## 5. 推荐方案:Agent Loop v2(自研增强,分四步)

1. **子任务分解**(核心):Planner 输出结构化 `subtasks[]`(每个含目标、涉及页面、成功标准),Executor 按队列逐个派发 Navigator 执行,单个子任务独立"执行→观察→自校验",失败带着失败上下文回到 Planner 重新分解(最多重分解 N 次)。
2. **共享工作记忆(scratchpad)**:把 `cache_content` 雏形升级为持久化 blackboard(chrome.storage),跨子任务/跨页面共享"已采集数据、已填写字段、待确认项";每轮注入模型。
3. **反思式失败恢复**:动作失败不再只是重试,而是把"失败动作 + 页面状态摘要"喂回 Planner,产出修正动作(替代盲目 retry)。
4. **跨页流程 Skill 化**:把「跨页采集」「A 页查 B 页填」做成内置 Skill(约束翻页/切换时机与数据交接格式),引导模型稳定使用多页工具。

**配套**:复杂任务建议 Planner/Navigator 都用 `deepseek-v4-pro`(牺牲速度换逻辑,做成会话级开关);保持最大步数/失败上限与高危确认机制不变。

**预估**:第 1+2 步约 1.5~2 周(改 planner schema + executor 队列 + scratchpad 存储),第 3 步 ~3 天,第 4 步 ~2 天。

---

## 附:pi 相关链接

- pi 仓库:github.com/badlogic/pi-mono → earendil-works/pi
- 背景文章:mariozechner.at(2025-11 复盘)、lucumr.pocoo.org(2026-01)
- browser-use:github.com/browser-use/browser-use;workflow-use:github.com/browser-use/workflow-use
- stagehand:github.com/browserbase/stagehand
- Claude for Chrome:anthropic.com/news/claude-for-chrome
- MV3 约束:developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle;native messaging 同站
