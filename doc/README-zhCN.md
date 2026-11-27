# Zotero MarkdownDB Link

[![Zotero 8–11](https://img.shields.io/badge/Zotero-8%20--%2011-green?style=flat-square&logo=zotero&logoColor=CC2936)](https://www.zotero.org)
[![License: AGPL-3.0-or-later](https://img.shields.io/badge/License-AGPL--3.0--or--later-blue?style=flat-square)](../LICENSE)

[English](../README.md) | 简体中文

**Zotero MarkdownDB Link** 用于将 Zotero 文库条目与本地 **链接附件根目录**（Linked Attachment Base Directory，例如 Obsidian 笔记库）中的 Markdown 文献笔记库双向打通，并支持选中 Zotero 中的论文 PDF 后调用本地 **MinerU 4.x** 自动解析生成 Markdown 与图片、按规范存放并关联到对应论文。

## 核心功能

### 1. 同步已有 MarkdownDB 链接

- **递归扫描目录**：从 Zotero 设置中的 `baseAttachmentPath` 出发递归扫描多级分类子目录（自动跳过 `.git`、`.obsidian` 等 `.` 开头的隐藏目录，限制最大深度 `32`，并通过规范路径校验防止符号链接循环）。
- **目录命名约定**：匹配 `<CiteKey>/<CiteKey>.md`（Markdown 文件名与所在直接父文件夹名一致）。
- **引用键索引**：索引 **我的文库（My Library）** 中未删除的常规顶层条目，优先读取 Zotero 8+ 原生 `citationKey` 字段，回退读取 `Extra` 中的 `Citation Key: ...`。匹配时精确匹配优先，无精确匹配时回退至大小写不敏感匹配；若存在重复 CiteKey，会链接到所有对应条目。
- **去重建链**：比对已有链接附件（同时检查 `attachmentPath` 与 `getFilePathAsync()`，在 macOS/Windows 上大小写不敏感），仅为缺失项通过 `Zotero.Attachments.linkFromFile` 创建 `text/markdown` 链接附件。

### 2. 选中论文 PDF 调用本地 MinerU 解析并链接

- **按需启停本地服务**：在随机空闲环回端口上临时拉起 `mineru-kit api-server`，批量复用已加载模型逐篇解析；批次完成、用户取消、发生错误或 Zotero 退出/插件停用时立即关闭该临时服务端，不干扰全局 `mineru` 服务。
- **兼容的输出结构**：仅保留 `markdown.md`（重命名为 `<CiteKey>.md`）与 `images/` 到 `<链接附件根目录>/<CiteKey>/`，自动丢弃 `middle_json.json` 与 `structured_content.json` 等中间文件，并立即链接到对应 Zotero 条目。
- **选中规则与边界处理**：
  - 选中父条目时：优先取 `getBestAttachment()` 指向的本地 PDF，若不可用则回退到第一个本地存在的 PDF 附件。
  - 直接选中 PDF 子附件时：解析该指定 PDF 并归属、链接到其父条目（同时选中父条目和子附件时自动去重并优先使用显式选中的 PDF）。
  - 自动跳过非 My Library 条目、无父条目的孤立附件、缺失本地 PDF 或缺少安全 CiteKey 的条目，并在末尾汇总提示。
- **冲突处理策略**：
  - **默认不覆盖**（`mineruOverwrite = false`）：若条目已链接同名 `<CiteKey>.md`（含位于子分类目录中的情况）则直接跳过；若 `<链接附件根目录>/<CiteKey>/<CiteKey>.md` 已存在于磁盘但尚未在 Zotero 建立链接，则跳过 MinerU 解析直接补建链接。若全部待处理条目均无需解析，不会启动 MinerU 服务。
  - **开启覆盖**（`mineruOverwrite = true`）：重新调用 MinerU 解析，经临时目录暂存并原子替换 `<CiteKey>.md` 与 `images/`（失败时自动回滚原有文件），并确保 Zotero 链接附件存在。
- **单篇容错与随时取消**：单篇解析失败会记录错误并继续处理其余论文；解析进行中再次点击工具栏按钮或菜单入口可确认取消当前任务，保留已完成篇目的文件与链接，并立刻关闭临时 MinerU 服务。

## 预期目录结构

```text
<链接附件根目录>/
├── .obsidian/                  # 自动跳过（以 . 开头的隐藏目录）
├── Smith2020/
│   ├── Smith2020.md            # 匹配并链接为 "Smith2020.md"
│   └── images/                 # MinerU 提取的图片资源（供 Smith2020.md 相对路径引用）
└── MachineLearning/
    └── Doe2024/
        ├── Doe2024.md          # 支持放在任意多层分类子目录中
        └── images/
```

## 前置条件与安装

1. **配置 Zotero 链接附件根目录**：
   - 打开 **Zotero 设置 → 高级 → 文件和文件夹 → 链接附件根目录**，设置为你的 Markdown 笔记库根目录。
2. **确保论文条目具有 Citation Key**：
   - 填写 Zotero 8+ 原生 **Citation Key** 字段，或在 **其它（Extra）** 中包含 `Citation Key: <key>`（如通过 Better BibTeX 生成）。
   - 注意：用作文件夹名的 CiteKey 不能包含路径非法字符（`/ \ : < > " | ? *` 或末尾 `.`）。
3. **（可选）安装本地 MinerU 4.x（用于 PDF 解析）**：
   ```bash
   uv tool install "mineru>=4.0,<5"
   mineru-kit models download --tier basic
   ```
   确保终端可执行 `mineru-kit --help`（默认通常位于 `~/.local/bin/mineru-kit`）。
4. **安装插件**：
   - 获取或自行构建 `.scaffold/build/zotero-markdown-db-link.xpi`。
   - 在 Zotero 中打开 **工具（Tools）→ 插件（Plugins）→ ⚙️ → 从文件安装附加组件（Install Add-on From File...）**，选择 `.xpi` 文件完成安装。

## 使用方法

- **同步已有 MarkdownDB 链接**：
  - 点击条目列表工具栏上的 **同步 MarkdownDB 链接** 图标（位于“添加笔记”按钮右侧），或点击菜单 **工具 → 同步 MarkdownDB 链接**。
- **使用 MinerU 解析选中的论文 PDF**：
  - 在 **我的文库** 中选中一篇或多篇论文条目（或 PDF 附件），通过以下任一入口触发：
    - **条目右键菜单 → 使用 MinerU 解析 PDF 并链接 Markdown**
    - **条目工具栏 → 使用 MinerU 解析选中 PDF** 图标按钮
    - **工具 → 使用 MinerU 解析选中 PDF**
  - 常驻进度浮窗会实时显示服务启动、逐篇解析进度（`i/N: CiteKey`）、服务关闭及最终汇总统计。
  - 若需中途取消，再次点击工具栏按钮或 Tools 菜单项并在确认弹窗中确认即可。

## 插件设置

打开 **Zotero 设置 → Zotero MarkdownDB Link**（对应首选项前缀 `extensions.zotero.markdowndblink.*`）：

| 设置项                    | 首选项键名        | 默认值  | 说明                                                                                                                                                                    |
| ------------------------- | ----------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **解析精度等级**          | `mineruTier`      | `basic` | MinerU 解析档位：`flash`（极速）、`basic`（基础）、`standard`（标准）、`advanced`（高级）。                                                                             |
| **覆盖已存在文件**        | `mineruOverwrite` | `false` | 开启后将强制重新解析并替换已有的 `<CiteKey>/<CiteKey>.md` 与 `images/`。                                                                                                |
| **MinerU 可执行文件路径** | `mineruPath`      | `""`    | `mineru-kit` 完整路径；留空时自动探测 `~/.local/bin/mineru-kit`、`/opt/homebrew/bin/mineru-kit`、`/usr/local/bin/mineru-kit`、`~/.cargo/bin/mineru-kit` 及系统 `PATH`。 |
| **单文件解析超时（秒）**  | `mineruTimeout`   | `300`   | 单篇 PDF 解析超时上限，允许范围 `30–3600` 秒。                                                                                                                          |

## 开发与测试

```bash
# 安装依赖
npm install

# 打包 XPI（输出到 .scaffold/build/zotero-markdown-db-link.xpi）并执行 tsc 类型检查
npm run build

# 代码格式与 ESLint 检查
npm run lint:check

# 运行单元测试（Node 22+ 原生类型剥离，使用 Mock 的 Zotero/MinerU 运行时）
node --experimental-strip-types --test test/linker.unit.test.ts test/mineru.unit.test.ts
```

如需热重载调试，可复制 `.env.example` 为 `.env`，填入本地 Zotero 可执行文件路径与开发配置文件（Profile），然后运行 `npm start`。

## 许可证

[AGPL-3.0-or-later](../LICENSE)

## 致谢

- 基于 [zotero-plugin-template](https://github.com/windingwind/zotero-plugin-template)、[zotero-plugin-toolkit](https://github.com/windingwind/zotero-plugin-toolkit) 与 [zotero-plugin-scaffold](https://github.com/northword/zotero-plugin-scaffold) 构建。
- 本地 PDF 解析由 [MinerU](https://github.com/opendatalab/MinerU) 提供支持。
