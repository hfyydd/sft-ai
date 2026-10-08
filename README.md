# SFT AI 助手

团队内部使用的 AI 浏览器助手 Chrome 扩展:侧边栏对话 + 读取页面/PDF + 操控浏览器(点击、填表、翻页)。

基于开源项目 [nanobrowser](https://github.com/nanobrowser/nanobrowser)(Apache-2.0)二次开发。

## 核心能力

- 侧边栏对话:点扩展图标即开,全中文界面
- 读取页面:HTML 正文;pdf.js 支持本地/在线 PDF 全文提取(含扫描 OCR 件)
- 操控浏览器:CDP 真实点击/输入/翻页/切标签页,多步骤跨页任务(工作记忆)
- 模型接入:OpenAI 兼容端点(DeepSeek / 本地 WPS-Comate 代理 / 任意兼容服务)
- Skill 系统:内置页面摘要、表格提取、自动填表、跨页任务等技能,支持自定义

## 构建与运行

```bash
pnpm install
pnpm build     # 产物在 dist/,Chrome/Edge 加载"已解压的扩展程序"指向该目录
pnpm dev       # 开发模式(自动重建)
```

模型配置:扩展设置 → 模型 → 添加供应商(OpenAI 兼容 baseURL + Key,或本地代理)。

## 文档

- docs/技术方案.md —— 架构、调研、进度记录
- docs/M1-上手指南.md —— 安装、配置、验收

## 安全说明

内部工具,仓库为私有。API Key 只保存在浏览器本地存储,不进仓库。
