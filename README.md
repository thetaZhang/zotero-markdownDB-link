# Zotero MarkdownDB Link

[![Zotero 8–11](https://img.shields.io/badge/Zotero-8%20--%2011-green?style=flat-square&logo=zotero&logoColor=CC2936)](https://www.zotero.org)
[![License: AGPL-3.0-or-later](https://img.shields.io/badge/License-AGPL--3.0--or--later-blue?style=flat-square)](LICENSE)

English | [简体中文](doc/README-zhCN.md)

**Zotero MarkdownDB Link** connects Zotero items with a local Markdown paper database (such as an Obsidian vault) stored under Zotero's **Linked Attachment Base Directory**, and optionally parses selected Zotero PDF attachments into Markdown + images locally via **MinerU 4.x**.

## Features

### 1. Sync MarkdownDB Links

- **Recursive Vault Scan**: Scans Zotero's `baseAttachmentPath` recursively across nested category folders (skips `.`-prefixed hidden entries like `.git` / `.obsidian`, enforces max depth `32`, and guards against symlink cycles via canonical path resolution).
- **Convention Matching**: Matches `<CiteKey>/<CiteKey>.md` where the Markdown filename equals its immediate parent folder name.
- **Citation Key Indexing**: Indexes non-deleted regular top-level items in **My Library** using Zotero's native `citationKey` field (Zotero 8+) with fallback to `Citation Key: ...` in `Extra`. Prefers exact match, falls back to case-insensitive match when no exact match exists, and links to all items sharing a duplicate CiteKey.
- **Deduplication**: Checks existing linked-file attachments (comparing both `attachmentPath` and resolved `getFilePathAsync()`, case-insensitively on macOS/Windows) and links missing files via `Zotero.Attachments.linkFromFile` with `contentType: "text/markdown"`.

### 2. Parse Selected PDFs with Local MinerU

- **On-Demand Local Server**: Starts a temporary local `mineru-kit api-server` bound to `127.0.0.1` on an ephemeral free port, shares loaded models across the selected batch, and shuts the server down automatically when the batch completes, is canceled, encounters an error, or when Zotero/the plugin shuts down.
- **Compatible Output Layout**: Extracts only `markdown.md` (renamed to `<CiteKey>.md`) and `images/` into `<baseAttachmentPath>/<CiteKey>/`, discarding intermediate `middle_json.json` / `structured_content.json` files, then links `<CiteKey>.md` to the Zotero item.
- **Smart Selection & Deduplication**:
  - Selecting a regular item uses its best local PDF (`getBestAttachment()` with fallback to the first existing local PDF attachment).
  - Selecting a PDF child attachment parses that exact PDF and links the result to its parent regular item (overriding parent fallback if both are selected).
  - Non-My-Library items, standalone attachments, items missing a valid local PDF, or items without a filesystem-safe CiteKey are skipped safely and summarized.
- **Conflict Policy**:
  - With overwrite **disabled** (default): items already linked to `<CiteKey>.md` (including in nested category folders) are skipped; if `<baseAttachmentPath>/<CiteKey>/<CiteKey>.md` already exists on disk without a link, it is linked directly without invoking MinerU. If nothing requires parsing, the MinerU server is not started.
  - With overwrite **enabled**: re-parses with MinerU, safely stages and swaps `<CiteKey>.md` and `images/` (with rollback on error), and ensures the Zotero link exists.
- **Fault Tolerance & Cancellation**: Single-item failures are logged and skipped without aborting remaining papers. Clicking the MinerU toolbar button or menu item while a batch is running prompts to cancel the active job, preserves already-completed outputs, and stops the temporary server immediately.

## Expected Directory Layout

```text
<Linked Attachment Base Directory>/
├── .obsidian/                  # Ignored (dot-prefixed hidden directories)
├── Smith2020/
│   ├── Smith2020.md            # Matched & linked as "Smith2020.md"
│   └── images/                 # Extracted figures referenced by Smith2020.md
└── MachineLearning/
    └── Doe2024/
        ├── Doe2024.md          # Nested category folders are also discovered
        └── images/
```

## Prerequisites & Installation

1. **Configure Zotero's Linked Attachment Base Directory**:
   - Open **Zotero Settings → Advanced → Files and Folders → Linked Attachment Base Directory** and choose your Markdown database root folder.
2. **Ensure Items Have Citation Keys**:
   - Populate Zotero's native **Citation Key** field (Zotero 8+) or `Citation Key: <key>` in **Extra** (for example via Better BibTeX).
   - Note: CiteKeys used as folder names must not contain path-unsafe characters (`/ \ : < > " | ? *` or trailing `.`).
3. **(Optional) Install MinerU 4.x for Local PDF Parsing**:
   ```bash
   uv tool install "mineru>=4.0,<5"
   mineru-kit models download --tier basic
   ```
   Verify `mineru-kit --help` works in your terminal (typically installed at `~/.local/bin/mineru-kit`).
4. **Install the Plugin**:
   - Download or build `.scaffold/build/zotero-markdown-db-link.xpi`.
   - In Zotero: **Tools → Plugins → ⚙️ → Install Add-on From File...** and select the `.xpi` file.

## Usage

- **Sync MarkdownDB Links**:
  - Click the **Sync MarkdownDB Links** button on the Zotero items toolbar (next to Add Note), or select **Tools → Sync MarkdownDB Links**.
- **Parse Selected PDFs with MinerU**:
  - Select one or more items (or PDF attachments) in **My Library**, then trigger via:
    - **Right-click item menu → Parse Selected PDFs with MinerU**
    - **Items toolbar → Parse Selected PDFs with MinerU** button
    - **Tools → Parse Selected PDFs with MinerU**
  - A persistent progress window tracks startup, per-paper parsing (`i/N: CiteKey`), server shutdown, and the final summary.
  - To cancel an in-progress batch, click the MinerU toolbar button or Tools menu item again and confirm cancellation.

## Plugin Settings

Open **Zotero Settings → Zotero MarkdownDB Link** (backed by `extensions.zotero.markdowndblink.*`):

| Setting                         | Preference Key    | Default | Description                                                                                                                                                                          |
| ------------------------------- | ----------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Parse tier**                  | `mineruTier`      | `basic` | MinerU quality tier: `flash`, `basic`, `standard`, or `advanced`.                                                                                                                    |
| **Overwrite existing Markdown** | `mineruOverwrite` | `false` | Re-parse and replace existing `<CiteKey>/<CiteKey>.md` and `images/` instead of skipping/reusing.                                                                                    |
| **MinerU executable path**      | `mineruPath`      | `""`    | Full path to `mineru-kit`. Leave blank to auto-detect `~/.local/bin/mineru-kit`, `/opt/homebrew/bin/mineru-kit`, `/usr/local/bin/mineru-kit`, `~/.cargo/bin/mineru-kit`, and `PATH`. |
| **Per-file parse timeout (s)**  | `mineruTimeout`   | `300`   | Timeout per PDF in seconds (clamped to `30–3600`).                                                                                                                                   |

## Development & Testing

```bash
# Install dependencies
npm install

# Build XPI (.scaffold/build/zotero-markdown-db-link.xpi) and run tsc --noEmit
npm run build

# Check formatting and lint rules
npm run lint:check

# Run unit tests (Node 22+ native TypeScript stripping, mocked Zotero/MinerU runtime)
node --experimental-strip-types --test test/linker.unit.test.ts test/mineru.unit.test.ts
```

For hot-reload development with Zotero, copy `.env.example` to `.env`, configure your local Zotero binary and dev profile, and run `npm start`.

## License

[AGPL-3.0-or-later](LICENSE)

## Acknowledgements

- Built with [zotero-plugin-template](https://github.com/windingwind/zotero-plugin-template), [zotero-plugin-toolkit](https://github.com/windingwind/zotero-plugin-toolkit), and [zotero-plugin-scaffold](https://github.com/northword/zotero-plugin-scaffold).
- Local PDF parsing powered by [MinerU](https://github.com/opendatalab/MinerU).
