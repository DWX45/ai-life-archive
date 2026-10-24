# AI 人生档案馆

一个本地优先的个人成长记录应用。用户以「事件 / 感受 / 收获」记录生活片段，通过年份、时间轴、标签与关键词回望成长，并使用 AI 生成单条批注、月度回顾、跨记忆连线、失败复盘和未来信件回信。

项目使用原生 HTML、CSS、JavaScript 构建，不依赖前端框架。用户档案保存在浏览器中，AI 请求由 Cloudflare Pages Functions 转发给用户自己的 DeepSeek API 或站点配置的智谱 GLM。

## 功能

- 复古档案馆风格的层次化导航和动画时间轴
- 事件、感受、收获三段式记录，以及日期、心情、标签和类型
- 本地保存图片与视频，支持缩略图、预览、编辑和删除
- 年份、月份、标签和关键词检索
- DeepSeek 与智谱 GLM 双模型选择
- AI 单条分析、月度回顾、时空连线、失败复盘和时间胶囊回信
- JSON 导入导出，媒体一并备份
- 60 秒请求超时、错误分类和模型切换入口

## 技术架构

```text
Browser
├─ HTML / CSS / Vanilla JavaScript
├─ localStorage: 档案、信件、AI 设置
└─ IndexedDB: 图片和视频
        │
        ▼
POST /api/ai
        │
        ▼
Cloudflare Pages Functions
├─ 用户 DeepSeek Key（请求头转发，不持久化）
└─ 服务端 ZHIPU_API_KEY
        │
        ▼
DeepSeek / 智谱 GLM
```

主要目录：

```text
├─ index.html
├─ css/style.css
├─ js/app.js
├─ functions/
│  ├─ _shared/ai-core.js
│  └─ api/ai.js
├─ netlify/functions/ai.js
└─ netlify.toml
```

Cloudflare 与 Netlify 入口共用 `functions/_shared/ai-core.js` 中的提示词、模型路由、超时和 JSON 容错逻辑。

## 本地运行

需要 Node.js 18 或更高版本。安装 Wrangler 后可同时预览页面和云函数：

```bash
npx wrangler pages dev . --project-name ai-life-archive
```

也可以运行：

```bash
npm run dev
```

仅在本地预览静态页面时，可使用任意静态文件服务器，但没有 `/api/ai`，AI 功能不可用。

## 双模型设置

网站每次打开时会要求选择 AI 服务：

- **自己的 DeepSeek API**：用户填写 Key 后，通过 DeepSeek `/models` 接口验证，生成请求固定使用 `deepseek-chat`。
- **自带智谱模型**：由站点服务端保存 `ZHIPU_API_KEY`，当前默认模型为 `glm-4-flash-250414`。

DeepSeek Key 只保存在用户当前浏览器的 `localStorage` 中，不包含在档案备份里。请求经 HTTPS 通过本站云函数转发，服务端不会持久化用户 Key。

## 配置智谱模型

先[创建智谱 API Key](https://bigmodel.cn/)，再将 Key 配置为 Cloudflare Pages 的服务端环境变量：

```bash
npx wrangler pages secret put ZHIPU_API_KEY --project-name ai-life-archive
```

可选环境变量：

- `ZHIPU_MODEL`：覆盖默认模型，默认值为 `glm-4-flash-250414`
- `ZHIPU_BASE_URL`：覆盖智谱 OpenAI 兼容接口地址

本地开发可使用 `.dev.vars` 保存环境变量。该文件已被 `.gitignore` 忽略，不能提交。

## 检查

```bash
npm run check
```

该命令会检查前端脚本、共享 AI 核心以及 Cloudflare/Netlify 函数入口的 JavaScript 语法。

## 数据与隐私

- 档案和信件保存在当前浏览器的 `localStorage`。
- 图片和视频保存在当前浏览器的 IndexedDB。
- 使用 AI 时，只发送当前任务所需的事件、感受、收获、标签或信件文字，不发送图片和视频。
- 清除浏览器数据会删除本地档案与媒体，建议定期导出 JSON 备份。
- 本地数据不会自动跨设备同步。
- `.env`、`.dev.vars`、`.wrangler/`、`.netlify/` 和投稿材料不会进入版本控制。

## 部署说明

项目默认面向 Cloudflare Pages。创建 Pages 项目、配置 `ZHIPU_API_KEY` 并执行部署后，即可通过相应平台域名访问。

本 GitHub 仓库仅用于源码展示，不启用 GitHub Pages；GitHub Pages 无法运行项目所需的 `/api/ai` 云函数。

## 许可证

[MIT License](LICENSE)
