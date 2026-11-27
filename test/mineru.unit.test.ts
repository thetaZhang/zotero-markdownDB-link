import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import * as fsp from "node:fs/promises";
import { registerHooks } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      specifier.startsWith(".") &&
      !specifier.endsWith(".ts") &&
      !specifier.endsWith(".js") &&
      !specifier.endsWith(".json") &&
      context.parentURL
    ) {
      const candidate = new URL(`${specifier}.ts`, context.parentURL);
      if (existsSync(fileURLToPath(candidate))) {
        return nextResolve(candidate.href, context);
      }
    }
    return nextResolve(specifier, context);
  },
});

const {
  DEFAULT_MINERU_OVERWRITE,
  DEFAULT_MINERU_TIER,
  DEFAULT_MINERU_TIMEOUT_SECONDS,
  MAX_MINERU_TIMEOUT_SECONDS,
  MINERU_TIERS,
  MIN_MINERU_TIMEOUT_SECONDS,
  PREFS_PREFIX,
  getMinerUSettings,
  getPrefKey,
  setMinerUPref,
} = await import("../src/modules/prefs.ts");

const {
  buildServerArgs,
  cancelActiveMinerUParse,
  isAllowedZipExtractPath,
  isMinerUParseRunning,
  isSafeCiteKeyForPath,
  normalizeZipEntryPath,
  parseSelectedItemsWithMinerU,
  sanitizeUploadFileName,
  stopActiveMinerUServer,
} = await import("../src/modules/mineru.ts");

import type {
  MinerUParseProgress,
  MinerURuntimeDeps,
  MinerUSubprocessProcess,
  MinerUZigReader,
} from "../src/modules/mineru.ts";

const originalGlobals = {
  Zotero: (globalThis as Record<string, any>).Zotero,
  IOUtils: (globalThis as Record<string, any>).IOUtils,
  PathUtils: (globalThis as Record<string, any>).PathUtils,
};

const tempDirsToCleanup: string[] = [];

afterEach(async () => {
  await stopActiveMinerUServer();
  for (const [key, value] of Object.entries(originalGlobals)) {
    if (value === undefined) {
      delete (globalThis as Record<string, any>)[key];
    } else {
      (globalThis as Record<string, any>)[key] = value;
    }
  }
  while (tempDirsToCleanup.length > 0) {
    const dir = tempDirsToCleanup.pop()!;
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

async function makeTempDir(): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "zotero-mineru-test-"));
  tempDirsToCleanup.push(dir);
  return dir;
}

function installNodeFSRuntime(options: {
  baseDir?: string;
  isWin?: boolean;
  isMac?: boolean;
  userLibraryID?: number;
  prefs?: Record<string, any>;
  itemsById?: Map<number, any>;
  linkFromFile?: (opts: {
    file: string;
    parentItemID: number;
    title: string;
    contentType: string;
  }) => Promise<void>;
}) {
  const prefsStore: Record<string, any> = {
    ...(options.prefs ?? {}),
  };
  if (options.baseDir !== undefined) {
    prefsStore.baseAttachmentPath = options.baseDir;
  }

  const itemsById = options.itemsById ?? new Map<number, any>();

  (globalThis as Record<string, any>).PathUtils = {
    join: (...parts: string[]) => path.join(...parts),
    filename: (filePath: string) => path.basename(filePath),
    parent: (filePath: string) => path.dirname(filePath),
  };

  (globalThis as Record<string, any>).IOUtils = {
    stat: async (targetPath: string) => {
      const st = await fsp.stat(targetPath);
      return {
        type: st.isDirectory()
          ? "directory"
          : st.isFile()
            ? "regular"
            : "other",
        size: st.size,
      };
    },
    read: async (targetPath: string) => {
      const buf = await fsp.readFile(targetPath);
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    },
    write: async (targetPath: string, data: Uint8Array) => {
      await fsp.mkdir(path.dirname(targetPath), { recursive: true });
      await fsp.writeFile(targetPath, data);
      return data.byteLength;
    },
    makeDirectory: async (
      dirPath: string,
      opts?: { createAncestors?: boolean; ignoreExisting?: boolean },
    ) => {
      await fsp.mkdir(dirPath, {
        recursive: opts?.createAncestors ?? true,
      });
    },
    move: async (src: string, dest: string) => {
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await fsp.rename(src, dest);
    },
    remove: async (
      targetPath: string,
      opts?: { recursive?: boolean; ignoreAbsent?: boolean },
    ) => {
      await fsp.rm(targetPath, {
        recursive: Boolean(opts?.recursive),
        force: Boolean(opts?.ignoreAbsent),
      });
    },
    getChildren: async (dirPath: string) => {
      const entries = await fsp.readdir(dirPath);
      return entries.map((name) => path.join(dirPath, name));
    },
  };

  (globalThis as Record<string, any>).Zotero = {
    isWin: options.isWin ?? false,
    isMac: options.isMac ?? false,
    File: {
      pathToFile: (targetPath: string) => ({
        path: targetPath,
        normalize: () => {},
      }),
    },
    Prefs: {
      get: (key: string) => prefsStore[key],
      set: (key: string, value: any) => {
        prefsStore[key] = value;
      },
    },
    Libraries: {
      userLibraryID: options.userLibraryID ?? 1,
    },
    Items: {
      getAsync: async (ids: number | number[]) => {
        if (Array.isArray(ids)) {
          return ids.map((id) => itemsById.get(id)).filter(Boolean);
        }
        return itemsById.get(ids) ?? null;
      },
    },
    Attachments: {
      LINK_MODE_IMPORTED_FILE: 0,
      LINK_MODE_LINKED_FILE: 2,
      LINK_MODE_LINKED_URL: 3,
      getBaseDirectoryRelativePath: (filePath: string) =>
        options.baseDir && filePath.startsWith(`${options.baseDir}${path.sep}`)
          ? `attachments:${filePath.slice(options.baseDir.length + 1)}`
          : false,
      linkFromFile: options.linkFromFile ?? (async () => {}),
    },
    logError: () => {},
  };

  return { prefsStore };
}

function makeMockAttachment(options: {
  id: number;
  libraryID?: number;
  deleted?: boolean;
  parentItemID?: number | false;
  parentItem?: any;
  contentType?: string;
  linkMode?: number;
  attachmentPath?: string;
  filePath?: string | false;
}) {
  return {
    id: options.id,
    libraryID: options.libraryID ?? 1,
    deleted: Boolean(options.deleted),
    parentItemID: options.parentItemID ?? false,
    parentItem: options.parentItem,
    attachmentContentType: options.contentType ?? "application/pdf",
    attachmentLinkMode: options.linkMode ?? 0,
    attachmentPath: options.attachmentPath ?? "",
    isRegularItem: () => false,
    isAttachment: () => true,
    getFilePathAsync: async () => options.filePath ?? false,
  };
}

function makeMockRegularItem(options: {
  id: number;
  libraryID?: number;
  deleted?: boolean;
  citationKey?: string | Error;
  extra?: string;
  bestAttachment?: any;
  attachments?: any[];
  itemsById?: Map<number, any>;
}) {
  const atts = options.attachments ?? [];
  for (const att of atts) {
    options.itemsById?.set(att.id, att);
  }
  const item = {
    id: options.id,
    libraryID: options.libraryID ?? 1,
    deleted: Boolean(options.deleted),
    isRegularItem: () => true,
    isAttachment: () => false,
    getField: (field: string) => {
      if (field === "citationKey") {
        if (options.citationKey instanceof Error) {
          throw options.citationKey;
        }
        return options.citationKey ?? "";
      }
      if (field === "extra") {
        return options.extra ?? "";
      }
      return "";
    },
    getBestAttachment: async () => options.bestAttachment ?? false,
    getAttachments: () => atts.map((a) => a.id),
    saveTx: async () => {
      throw new Error("saveTx should not be called by MinerU linking");
    },
  };
  options.itemsById?.set(item.id, item);
  return item;
}

function makeMockPipe(chunks: string[]) {
  let idx = 0;
  return {
    readString: async () => {
      if (idx < chunks.length) {
        return chunks[idx++];
      }
      return "";
    },
  };
}

function makeRunningServerProcess(options?: {
  stdoutChunks?: string[];
  stderrChunks?: string[];
  onKill?: () => void;
}): MinerUSubprocessProcess {
  let resolveWait!: (val: { exitCode: number }) => void;
  const waitPromise = new Promise<{ exitCode: number }>((resolve) => {
    resolveWait = resolve;
  });
  let killed = false;
  return {
    stdout: makeMockPipe(options?.stdoutChunks ?? []),
    stderr: makeMockPipe(options?.stderrChunks ?? []),
    wait: () => waitPromise,
    kill: async () => {
      options?.onKill?.();
      if (!killed) {
        killed = true;
        resolveWait({ exitCode: 0 });
      }
    },
  };
}

function createSyncFakeZipReader(
  entries: Record<string, string | Uint8Array | null>,
  fsSync: typeof import("node:fs"),
): MinerUZigReader {
  const keys = Object.keys(entries);
  let idx = 0;
  return {
    open: () => {
      idx = 0;
    },
    findEntries: () => ({
      hasMore: () => idx < keys.length,
      getNext: () => keys[idx++],
    }),
    getEntry: (name: string) => ({
      isDirectory: name.endsWith("/") || entries[name] === null,
    }),
    extract: (name: string, outFile: any) => {
      const content = entries[name];
      if (content === null || content === undefined) {
        throw new Error(`Missing zip entry: ${name}`);
      }
      const data =
        typeof content === "string" ? Buffer.from(content, "utf8") : content;
      const outPath = outFile.path as string;
      fsSync.mkdirSync(path.dirname(outPath), { recursive: true });
      fsSync.writeFileSync(outPath, data);
    },
    close: () => {},
  };
}

describe("prefs", () => {
  it("exposes constants and builds pref keys", () => {
    assert.equal(PREFS_PREFIX, "extensions.zotero.markdowndblink");
    assert.deepEqual(MINERU_TIERS, ["flash", "basic", "standard", "advanced"]);
    assert.equal(DEFAULT_MINERU_TIER, "basic");
    assert.equal(DEFAULT_MINERU_OVERWRITE, false);
    assert.equal(DEFAULT_MINERU_TIMEOUT_SECONDS, 300);
    assert.equal(MIN_MINERU_TIMEOUT_SECONDS, 30);
    assert.equal(MAX_MINERU_TIMEOUT_SECONDS, 3600);
    assert.equal(
      getPrefKey("mineruTier"),
      "extensions.zotero.markdowndblink.mineruTier",
    );
  });

  it("reads defaults and validates/clamps settings from global prefs", () => {
    const prefs: Record<string, any> = {};
    const calls: Array<{ key: string; global: boolean | undefined }> = [];
    (globalThis as Record<string, any>).Zotero = {
      Prefs: {
        get: (key: string, global?: boolean) => {
          calls.push({ key, global });
          return prefs[key];
        },
        set: (key: string, val: any) => {
          prefs[key] = val;
        },
      },
    };

    assert.deepEqual(getMinerUSettings(), {
      tier: "basic",
      overwrite: false,
      executablePath: "",
      timeoutSeconds: 300,
    });
    assert.equal(
      calls.every((c) => c.global === true),
      true,
    );

    prefs[getPrefKey("mineruTier")] = "invalid-tier";
    prefs[getPrefKey("mineruOverwrite")] = 1;
    prefs[getPrefKey("mineruPath")] = "  /opt/homebrew/bin/mineru-kit  ";
    prefs[getPrefKey("mineruTimeout")] = 5;
    assert.deepEqual(getMinerUSettings(), {
      tier: "basic",
      overwrite: true,
      executablePath: "/opt/homebrew/bin/mineru-kit",
      timeoutSeconds: 30,
    });

    prefs[getPrefKey("mineruTier")] = "advanced";
    prefs[getPrefKey("mineruTimeout")] = 9999;
    assert.equal(getMinerUSettings().tier, "advanced");
    assert.equal(getMinerUSettings().timeoutSeconds, 3600);

    prefs[getPrefKey("mineruTimeout")] = Number.NaN;
    assert.equal(getMinerUSettings().timeoutSeconds, 300);
  });

  it("writes sanitized global preferences via setMinerUPref", () => {
    const setCalls: Array<{ key: string; value: any; global?: boolean }> = [];
    (globalThis as Record<string, any>).Zotero = {
      Prefs: {
        get: () => undefined,
        set: (key: string, value: any, global?: boolean) => {
          setCalls.push({ key, value, global });
        },
      },
    };

    setMinerUPref("tier", "standard");
    setMinerUPref("tier", "bogus" as any);
    setMinerUPref("overwrite", true);
    setMinerUPref("executablePath", "  /usr/local/bin/mineru-kit  ");
    setMinerUPref("timeoutSeconds", 10);
    setMinerUPref("timeoutSeconds", 5000);
    setMinerUPref("timeoutSeconds", 120.6);

    assert.deepEqual(setCalls, [
      {
        key: "extensions.zotero.markdowndblink.mineruTier",
        value: "standard",
        global: true,
      },
      {
        key: "extensions.zotero.markdowndblink.mineruTier",
        value: "basic",
        global: true,
      },
      {
        key: "extensions.zotero.markdowndblink.mineruOverwrite",
        value: true,
        global: true,
      },
      {
        key: "extensions.zotero.markdowndblink.mineruPath",
        value: "/usr/local/bin/mineru-kit",
        global: true,
      },
      {
        key: "extensions.zotero.markdowndblink.mineruTimeout",
        value: 30,
        global: true,
      },
      {
        key: "extensions.zotero.markdowndblink.mineruTimeout",
        value: 3600,
        global: true,
      },
      {
        key: "extensions.zotero.markdowndblink.mineruTimeout",
        value: 121,
        global: true,
      },
    ]);
  });
});

describe("mineru pure helpers", () => {
  it("validates isSafeCiteKeyForPath", () => {
    assert.equal(isSafeCiteKeyForPath("Smith2020"), true);
    assert.equal(isSafeCiteKeyForPath("Smith_2020-a"), true);
    assert.equal(isSafeCiteKeyForPath("a..b"), true);

    assert.equal(isSafeCiteKeyForPath(""), false);
    assert.equal(isSafeCiteKeyForPath("   "), false);
    assert.equal(isSafeCiteKeyForPath(" Smith2020 "), false);
    assert.equal(isSafeCiteKeyForPath("."), false);
    assert.equal(isSafeCiteKeyForPath(".."), false);
    assert.equal(isSafeCiteKeyForPath("Smith2020."), false);
    assert.equal(isSafeCiteKeyForPath("../evil"), false);
    assert.equal(isSafeCiteKeyForPath("a/b"), false);
    assert.equal(isSafeCiteKeyForPath("a\\b"), false);
    assert.equal(isSafeCiteKeyForPath("foo:bar_2023"), false);
    assert.equal(isSafeCiteKeyForPath("C:foo"), false);
    assert.equal(isSafeCiteKeyForPath("CON"), false);
    assert.equal(isSafeCiteKeyForPath("nul.md"), false);
    assert.equal(isSafeCiteKeyForPath("bad\0key"), false);
    assert.equal(isSafeCiteKeyForPath("bad*key"), false);
  });

  it("sanitizes upload file names", () => {
    assert.equal(sanitizeUploadFileName("Smith2020"), "Smith2020.pdf");
    assert.equal(sanitizeUploadFileName("foo:bar_2023"), "foo_bar_2023.pdf");
    assert.equal(sanitizeUploadFileName("Smith2020.pdf"), "Smith2020.pdf");
    assert.equal(sanitizeUploadFileName("..."), "document.pdf");
    assert.equal(sanitizeUploadFileName(""), "document.pdf");
  });

  it("normalizes and filters ZIP entry paths", () => {
    assert.equal(normalizeZipEntryPath("markdown.md"), "markdown.md");
    assert.equal(normalizeZipEntryPath("./markdown.md"), "markdown.md");
    assert.equal(normalizeZipEntryPath("images/fig1.png"), "images/fig1.png");
    assert.equal(
      normalizeZipEntryPath("images//sub/fig2.jpg"),
      "images/sub/fig2.jpg",
    );

    assert.equal(normalizeZipEntryPath("../evil.md"), null);
    assert.equal(normalizeZipEntryPath("images/../../evil.png"), null);
    assert.equal(normalizeZipEntryPath("/etc/passwd"), null);
    assert.equal(normalizeZipEntryPath("images\\fig1.png"), null);
    assert.equal(normalizeZipEntryPath("C:markdown.md"), null);
    assert.equal(normalizeZipEntryPath("C:/markdown.md"), null);
    assert.equal(normalizeZipEntryPath("images/"), null);
    assert.equal(normalizeZipEntryPath(""), null);
    assert.equal(normalizeZipEntryPath("bad\0.md"), null);

    assert.equal(isAllowedZipExtractPath("markdown.md"), true);
    assert.equal(isAllowedZipExtractPath("images/fig1.png"), true);
    assert.equal(isAllowedZipExtractPath("images/sub/fig2.png"), true);
    assert.equal(isAllowedZipExtractPath("middle_json.json"), false);
    assert.equal(isAllowedZipExtractPath("structured_content.json"), false);
    assert.equal(isAllowedZipExtractPath("images"), false);
    assert.equal(isAllowedZipExtractPath("other.md"), false);
  });

  it("builds expected server CLI arguments", () => {
    assert.deepEqual(
      buildServerArgs({ port: 41234, tier: "standard", timeoutSeconds: 600 }),
      [
        "api-server",
        "--host",
        "127.0.0.1",
        "--port",
        "41234",
        "--tier",
        "standard",
        "--concurrency",
        "1",
        "--task-timeout",
        "600",
        "--retention-seconds",
        "300",
      ],
    );
    assert.deepEqual(
      buildServerArgs({
        port: 41234,
        tier: "basic",
        timeoutSeconds: 300,
        uploadDir: "/tmp/mineru-upload",
      }),
      [
        "api-server",
        "--host",
        "127.0.0.1",
        "--port",
        "41234",
        "--tier",
        "basic",
        "--concurrency",
        "1",
        "--task-timeout",
        "300",
        "--retention-seconds",
        "300",
        "--upload-dir",
        "/tmp/mineru-upload",
      ],
    );
  });
});

describe("parseSelectedItemsWithMinerU", () => {
  it("returns no-selection for empty selection and handles missing base dir", async () => {
    installNodeFSRuntime({});
    const emptyRes = await parseSelectedItemsWithMinerU([]);
    assert.equal(emptyRes.status, "no-selection");

    const dummyItem = makeMockRegularItem({ id: 1, citationKey: "Smith2020" });
    installNodeFSRuntime({ baseDir: "   " });
    const noBaseRes = await parseSelectedItemsWithMinerU([dummyItem as any]);
    assert.equal(noBaseRes.status, "no-base-dir");

    const tempRoot = await makeTempDir();
    installNodeFSRuntime({ baseDir: path.join(tempRoot, "missing") });
    const missingBaseRes = await parseSelectedItemsWithMinerU([
      dummyItem as any,
    ]);
    assert.equal(missingBaseRes.status, "base-dir-missing");
  });

  it("resolves targets, deduplicates preferring explicit PDF, skips invalid, and handles pre-server conflicts without starting server", async () => {
    const baseDir = await makeTempDir();
    const pdfDir = await makeTempDir();
    const pdfA = path.join(pdfDir, "a.pdf");
    const pdfB = path.join(pdfDir, "b.pdf");
    const pdfFallback = path.join(pdfDir, "fallback.pdf");
    const pdfExisting = path.join(pdfDir, "existing.pdf");
    await fsp.writeFile(pdfA, "PDF-A");
    await fsp.writeFile(pdfB, "PDF-B");
    await fsp.writeFile(pdfFallback, "PDF-FALLBACK");
    await fsp.writeFile(pdfExisting, "PDF-EXISTING");

    // Pre-existing markdown on disk for Disk2022 (not linked yet)
    await fsp.mkdir(path.join(baseDir, "Disk2022"), { recursive: true });
    const diskMdPath = path.join(baseDir, "Disk2022", "Disk2022.md");
    await fsp.writeFile(diskMdPath, "# Disk2022");

    const itemsById = new Map<number, any>();

    // Parent 1: has best PDF A, plus explicit PDF B selected directly
    const attA = makeMockAttachment({
      id: 101,
      parentItemID: 1,
      filePath: pdfA,
    });
    const attB = makeMockAttachment({
      id: 102,
      parentItemID: 1,
      filePath: pdfB,
    });
    const mdAtt1 = makeMockAttachment({
      id: 103,
      parentItemID: 1,
      contentType: "text/markdown",
      linkMode: 2,
      attachmentPath: "attachments:other/Already2020.md",
    });
    const parent1 = makeMockRegularItem({
      id: 1,
      citationKey: "Already2020",
      bestAttachment: attA,
      attachments: [attA, attB, mdAtt1],
      itemsById,
    });
    attB.parentItem = parent1;

    // Parent 2: best attachment missing on disk, falls back to first existing local PDF
    const missingBest = makeMockAttachment({
      id: 201,
      parentItemID: 2,
      filePath: path.join(pdfDir, "missing.pdf"),
    });
    const fallbackAtt = makeMockAttachment({
      id: 202,
      parentItemID: 2,
      filePath: pdfFallback,
    });
    const mdAtt2 = makeMockAttachment({
      id: 203,
      parentItemID: 2,
      contentType: "text/markdown",
      linkMode: 2,
      attachmentPath: path.join(baseDir, "Fallback2021", "Fallback2021.md"),
    });
    const parent2 = makeMockRegularItem({
      id: 2,
      citationKey: "Fallback2021",
      bestAttachment: missingBest,
      attachments: [missingBest, fallbackAtt, mdAtt2],
      itemsById,
    });

    // Parent 3: Disk2022 has existing .md on disk -> linked without MinerU
    const att3 = makeMockAttachment({
      id: 301,
      parentItemID: 3,
      filePath: pdfExisting,
    });
    const parent3 = makeMockRegularItem({
      id: 3,
      citationKey: "Disk2022",
      bestAttachment: att3,
      attachments: [att3],
      itemsById,
    });

    // Invalid items: non-My-Library, standalone attachment, missing citeKey, unsafe citeKey, missing PDF
    const groupItem = makeMockRegularItem({
      id: 4,
      libraryID: 2,
      citationKey: "Group2023",
      bestAttachment: att3,
      itemsById,
    });
    const standaloneAtt = makeMockAttachment({
      id: 5,
      parentItemID: false,
      filePath: pdfA,
    });
    const noCiteKeyItem = makeMockRegularItem({
      id: 6,
      citationKey: "",
      bestAttachment: att3,
      itemsById,
    });
    const unsafeCiteKeyItem = makeMockRegularItem({
      id: 7,
      citationKey: "../Escape",
      bestAttachment: att3,
      itemsById,
    });
    const noPdfItem = makeMockRegularItem({
      id: 8,
      citationKey: "NoPdf2024",
      itemsById,
    });

    const linkedCalls: Array<{
      file: string;
      parentItemID: number;
      title: string;
      contentType: string;
    }> = [];
    let subprocessCalled = false;

    installNodeFSRuntime({
      baseDir,
      isMac: true,
      itemsById,
      linkFromFile: async (opts) => {
        linkedCalls.push(opts);
      },
    });

    const res = await parseSelectedItemsWithMinerU(
      [
        parent1 as any,
        attB as any,
        parent2 as any,
        parent3 as any,
        groupItem as any,
        standaloneAtt as any,
        noCiteKeyItem as any,
        unsafeCiteKeyItem as any,
        noPdfItem as any,
      ],
      undefined,
      {
        settings: {
          tier: "basic",
          overwrite: false,
          executablePath: "",
          timeoutSeconds: 300,
        },
        deps: {
          getSubprocess: () => {
            subprocessCalled = true;
            throw new Error("Should not spawn server when nothing to parse");
          },
        },
      },
    );

    assert.equal(subprocessCalled, false);
    assert.equal(res.status, "completed");
    assert.equal(res.totalSelected, 9);
    assert.equal(res.skippedExisting, 2); // Already2020 (filename match) + Fallback2021
    assert.equal(res.linkedExisting, 1); // Disk2022
    assert.equal(res.skippedInvalid, 5);
    assert.equal(res.parsed, 0);
    assert.equal(res.failed, 0);
    assert.deepEqual(linkedCalls, [
      {
        file: diskMdPath,
        parentItemID: 3,
        title: "Disk2022.md",
        contentType: "text/markdown",
      },
    ]);
  });

  it("prefers explicitly selected child PDF over parent getBestAttachment during parse", async () => {
    const baseDir = await makeTempDir();
    const pdfDir = await makeTempDir();
    const bestPdfPath = path.join(pdfDir, "best.pdf");
    const explicitPdfPath = path.join(pdfDir, "explicit.pdf");
    await fsp.writeFile(bestPdfPath, "BEST-PDF-CONTENT");
    await fsp.writeFile(explicitPdfPath, "EXPLICIT-PDF-BYTES");

    const itemsById = new Map<number, any>();
    const attBest = makeMockAttachment({
      id: 11,
      parentItemID: 10,
      filePath: bestPdfPath,
    });
    const attExplicit = makeMockAttachment({
      id: 12,
      parentItemID: 10,
      filePath: explicitPdfPath,
    });
    const parent = makeMockRegularItem({
      id: 10,
      citationKey: "Explicit2025",
      bestAttachment: attBest,
      attachments: [attBest, attExplicit],
      itemsById,
    });
    attExplicit.parentItem = parent;

    const fakeBinDir = await makeTempDir();
    const fakeBin = path.join(fakeBinDir, "mineru-kit");
    await fsp.writeFile(fakeBin, "");

    let uploadedBodyText = "";
    const fsSync = await import("node:fs");

    installNodeFSRuntime({ baseDir, itemsById });

    const res = await parseSelectedItemsWithMinerU(
      [parent as any, attExplicit as any],
      undefined,
      {
        settings: {
          tier: "basic",
          overwrite: false,
          executablePath: fakeBin,
          timeoutSeconds: 120,
        },
        deps: {
          findFreePort: () => 45555,
          getHomeDir: () => fakeBinDir,
          createZipReader: () =>
            createSyncFakeZipReader({ "markdown.md": "# Explicit" }, fsSync),
          getSubprocess: () => ({
            pathSearch: async () => null,
            call: async () => makeRunningServerProcess(),
          }),
          fetch: async (url, init) => {
            if (url.endsWith("/v1/health")) {
              return {
                ok: true,
                status: 200,
                json: async () => ({ status: "ok" }),
                text: async () => "",
                arrayBuffer: async () => new ArrayBuffer(0),
              };
            }
            if (url.endsWith("/v1/tasks") && init?.method === "POST") {
              return {
                ok: true,
                status: 202,
                json: async () => ({
                  task_id: "t-explicit",
                  status: "waiting-file",
                  files: [
                    {
                      file_id: "file-1",
                      file_name: "Explicit2024.pdf",
                      status: "waiting-file",
                      upload: {
                        url: "http://127.0.0.1:45555/upload/1",
                        headers: { "Content-Type": "application/octet-stream" },
                        expires_at: 9999999999,
                      },
                    },
                  ],
                }),
                text: async () => "",
                arrayBuffer: async () => new ArrayBuffer(0),
              };
            }
            if (url.includes("/upload/1") && init?.method === "PUT") {
              uploadedBodyText = Buffer.from(init.body as Uint8Array).toString(
                "utf8",
              );
              return {
                ok: true,
                status: 200,
                json: async () => ({}),
                text: async () => "",
                arrayBuffer: async () => new ArrayBuffer(0),
              };
            }
            if (url.endsWith("/v1/tasks/t-explicit")) {
              return {
                ok: true,
                status: 200,
                json: async () => ({
                  task_id: "t-explicit",
                  status: "completed",
                  files: [
                    {
                      file_id: "file-1",
                      file_name: "Explicit2024.pdf",
                      status: "completed",
                      result_url: "http://127.0.0.1:45555/result/1.zip",
                    },
                  ],
                }),
                text: async () => "",
                arrayBuffer: async () => new ArrayBuffer(0),
              };
            }
            if (url.includes("/result/1.zip")) {
              return {
                ok: true,
                status: 200,
                json: async () => ({}),
                text: async () => "",
                arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
              };
            }
            throw new Error(`Unexpected fetch: ${url}`);
          },
        },
      },
    );

    assert.equal(res.status, "completed");
    assert.equal(res.parsed, 1);
    assert.equal(uploadedBodyText, "EXPLICIT-PDF-BYTES");
  });

  it("handles configured executable missing, auto-probing, early server exit, and 503 error.code", async () => {
    const baseDir = await makeTempDir();
    const pdfDir = await makeTempDir();
    const pdfPath = path.join(pdfDir, "paper.pdf");
    await fsp.writeFile(pdfPath, "PDF-DATA");

    const itemsById = new Map<number, any>();
    const att = makeMockAttachment({
      id: 2,
      parentItemID: 1,
      filePath: pdfPath,
    });
    const item = makeMockRegularItem({
      id: 1,
      citationKey: "Probe2024",
      bestAttachment: att,
      itemsById,
    });

    installNodeFSRuntime({ baseDir, itemsById });

    // 1. Configured path missing -> mineru-not-found (even if pathSearch would succeed)
    const missingConfigRes = await parseSelectedItemsWithMinerU(
      [item as any],
      undefined,
      {
        settings: {
          tier: "basic",
          overwrite: false,
          executablePath: path.join(baseDir, "nonexistent-mineru-kit"),
          timeoutSeconds: 300,
        },
        deps: {
          getSubprocess: () => ({
            pathSearch: async () => "/usr/bin/mineru-kit",
            call: async () => {
              throw new Error("should not call");
            },
          }),
        },
      },
    );
    assert.equal(missingConfigRes.status, "mineru-not-found");

    // 2. Auto-probe finds ~/.local/bin/mineru-kit, server exits immediately -> server-start-failed with stderr tail
    const fakeHome = await makeTempDir();
    const localBin = path.join(fakeHome, ".local", "bin", "mineru-kit");
    await fsp.mkdir(path.dirname(localBin), { recursive: true });
    await fsp.writeFile(localBin, "");

    let spawnedCommand = "";
    let serverKilled = false;
    const earlyExitRes = await parseSelectedItemsWithMinerU(
      [item as any],
      undefined,
      {
        settings: {
          tier: "basic",
          overwrite: false,
          executablePath: "",
          timeoutSeconds: 300,
        },
        deps: {
          getHomeDir: () => fakeHome,
          findFreePort: () => 45556,
          getSubprocess: () => ({
            pathSearch: async () => null,
            call: async (opts) => {
              spawnedCommand = opts.command;
              return {
                stdout: makeMockPipe([]),
                stderr: makeMockPipe(["x".repeat(5000), "FATAL_BOOT_ERR"]),
                wait: async () => ({ exitCode: 2 }),
                kill: async () => {
                  serverKilled = true;
                },
              };
            },
          }),
          fetch: async () => {
            throw new Error("ECONNREFUSED");
          },
        },
      },
    );
    assert.equal(spawnedCommand, localBin);
    assert.equal(earlyExitRes.status, "server-start-failed");
    assert.match(earlyExitRes.error ?? "", /FATAL_BOOT_ERR/);
    assert.ok((earlyExitRes.error ?? "").length <= 4200);
    assert.equal(serverKilled, true);

    // 3. Health 503 with non-empty error.code fails immediately
    let healthCalls = 0;
    const healthFailRes = await parseSelectedItemsWithMinerU(
      [item as any],
      undefined,
      {
        settings: {
          tier: "basic",
          overwrite: false,
          executablePath: localBin,
          timeoutSeconds: 300,
        },
        deps: {
          findFreePort: () => 45557,
          getSubprocess: () => ({
            pathSearch: async () => null,
            call: async () => makeRunningServerProcess(),
          }),
          fetch: async () => {
            healthCalls++;
            return {
              ok: false,
              status: 503,
              json: async () => ({
                error: {
                  code: "MISSING_API_KEY",
                  message: "No token configured",
                },
              }),
              text: async () => "",
              arrayBuffer: async () => new ArrayBuffer(0),
            };
          },
        },
      },
    );
    assert.equal(healthCalls, 1);
    assert.equal(healthFailRes.status, "server-start-failed");
    assert.match(healthFailRes.error ?? "", /MISSING_API_KEY/);
  });

  it("runs full MinerU HTTP flow, selective ZIP staging, overwrite swap, and linking", async () => {
    const baseDir = await makeTempDir();
    const pdfDir = await makeTempDir();
    const pdfPath = path.join(pdfDir, "smith.pdf");
    await fsp.writeFile(pdfPath, "RAW-PDF-BYTES");

    // Pre-existing files for overwrite=true test
    const targetDir = path.join(baseDir, "Smith2020");
    await fsp.mkdir(path.join(targetDir, "images"), { recursive: true });
    await fsp.writeFile(path.join(targetDir, "Smith2020.md"), "OLD-MD");
    await fsp.writeFile(path.join(targetDir, "images", "stale.png"), "STALE");

    const itemsById = new Map<number, any>();
    const attPdf = makeMockAttachment({
      id: 2,
      parentItemID: 1,
      filePath: pdfPath,
    });
    const attExistingMd = makeMockAttachment({
      id: 3,
      parentItemID: 1,
      contentType: "text/markdown",
      linkMode: 2,
      attachmentPath: path.join(targetDir, "Smith2020.md"),
    });
    const item = makeMockRegularItem({
      id: 1,
      citationKey: "Smith2020",
      bestAttachment: attPdf,
      attachments: [attPdf, attExistingMd],
      itemsById,
    });

    const fakeBinDir = await makeTempDir();
    const fakeBin = path.join(fakeBinDir, "mineru-kit");
    await fsp.writeFile(fakeBin, "");

    const linkedCalls: any[] = [];
    const progressEvents: MinerUParseProgress[] = [];
    const fetchLog: Array<{
      method: string;
      url: string;
      headers?: any;
      body?: any;
    }> = [];
    let pollCount = 0;
    let killCount = 0;

    installNodeFSRuntime({
      baseDir,
      itemsById,
      linkFromFile: async (opts) => {
        linkedCalls.push(opts);
      },
    });

    const fsSync = await import("node:fs");
    let capturedUploadDir = "";

    const res = await parseSelectedItemsWithMinerU(
      [item as any],
      (p) => progressEvents.push(p),
      {
        settings: {
          tier: "advanced",
          overwrite: true,
          executablePath: fakeBin,
          timeoutSeconds: 450,
        },
        deps: {
          findFreePort: () => 46123,
          sleep: async () => {},
          createZipReader: () =>
            createSyncFakeZipReader(
              {
                "images/": null,
                "markdown.md": "# Parsed Smith2020\n![fig](images/fig1.png)",
                "images/fig1.png": new Uint8Array([137, 80, 78, 71]),
                "middle_json.json": '{"ignored": true}',
                "structured_content.json": '{"ignored": true}',
              },
              fsSync,
            ),
          getSubprocess: () => ({
            pathSearch: async () => null,
            call: async (opts) => {
              assert.ok(opts.workdir && existsSync(opts.workdir));
              capturedUploadDir = opts.workdir;
              assert.deepEqual(opts.arguments, [
                "api-server",
                "--host",
                "127.0.0.1",
                "--port",
                "46123",
                "--tier",
                "advanced",
                "--concurrency",
                "1",
                "--task-timeout",
                "450",
                "--retention-seconds",
                "300",
                "--upload-dir",
                capturedUploadDir,
              ]);
              let resolveWait!: (val: { exitCode: number }) => void;
              const waitPromise = new Promise<{ exitCode: number }>((r) => {
                resolveWait = r;
              });
              return {
                stdout: makeMockPipe(["server started\n"]),
                stderr: makeMockPipe([]),
                wait: () => waitPromise,
                kill: async () => {
                  killCount++;
                  resolveWait({ exitCode: 0 });
                },
              };
            },
          }),
          fetch: async (url, init) => {
            fetchLog.push({
              method: init?.method ?? "GET",
              url,
              headers: init?.headers,
              body: init?.body,
            });
            if (url === "http://127.0.0.1:46123/v1/health") {
              return {
                ok: true,
                status: 200,
                json: async () => ({ status: "ok" }),
                text: async () => "",
                arrayBuffer: async () => new ArrayBuffer(0),
              };
            }
            if (
              url === "http://127.0.0.1:46123/v1/tasks" &&
              init?.method === "POST"
            ) {
              const payload = JSON.parse(String(init.body));
              assert.equal(payload.tier, "advanced");
              assert.deepEqual(payload.output_formats, ["default"]);
              assert.equal(payload.files[0].file_name, "Smith2020.pdf");
              assert.equal(payload.files[0].bytes, "RAW-PDF-BYTES".length);
              return {
                ok: true,
                status: 202,
                json: async () => ({
                  task_id: "task-1",
                  status: "waiting-file",
                  files: [
                    {
                      file_id: "file-1",
                      file_name: "Smith2020.pdf",
                      status: "waiting-file",
                      upload: {
                        url: "http://127.0.0.1:46123/upload/task-1",
                        headers: {
                          "Content-Type": "application/octet-stream",
                          "X-Upload-Token": "secret-123",
                        },
                        expires_at: 9999999999,
                      },
                    },
                  ],
                }),
                text: async () => "",
                arrayBuffer: async () => new ArrayBuffer(0),
              };
            }
            if (url === "http://127.0.0.1:46123/upload/task-1") {
              assert.equal(init?.headers?.["X-Upload-Token"], "secret-123");
              assert.equal(
                Buffer.from(init?.body as Uint8Array).toString("utf8"),
                "RAW-PDF-BYTES",
              );
              return {
                ok: true,
                status: 200,
                json: async () => ({}),
                text: async () => "",
                arrayBuffer: async () => new ArrayBuffer(0),
              };
            }
            if (url === "http://127.0.0.1:46123/v1/tasks/task-1") {
              pollCount++;
              const status = pollCount < 3 ? "running" : "completed";
              return {
                ok: true,
                status: 200,
                json: async () => ({
                  task_id: "task-1",
                  status,
                  files: [
                    {
                      file_id: "file-1",
                      file_name: "Smith2020.pdf",
                      status,
                      result_url:
                        status === "completed"
                          ? "http://127.0.0.1:46123/results/task-1.zip"
                          : undefined,
                    },
                  ],
                }),
                text: async () => "",
                arrayBuffer: async () => new ArrayBuffer(0),
              };
            }
            if (url === "http://127.0.0.1:46123/results/task-1.zip") {
              return {
                ok: true,
                status: 200,
                json: async () => ({}),
                text: async () => "",
                arrayBuffer: async () => new Uint8Array([80, 75, 3, 4]).buffer,
              };
            }
            throw new Error(`Unexpected fetch URL: ${url}`);
          },
        },
      },
    );

    assert.equal(res.status, "completed");
    assert.equal(res.parsed, 1);
    assert.equal(res.failed, 0);
    assert.equal(pollCount, 3);
    assert.equal(killCount, 1);
    // Already linked, so overwrite should not create duplicate attachment
    assert.deepEqual(linkedCalls, []);

    const mdContent = await fsp.readFile(
      path.join(targetDir, "Smith2020.md"),
      "utf8",
    );
    assert.equal(mdContent, "# Parsed Smith2020\n![fig](images/fig1.png)");
    assert.equal(existsSync(path.join(targetDir, "images", "fig1.png")), true);
    // Stale image and ignored JSONs must not exist
    assert.equal(
      existsSync(path.join(targetDir, "images", "stale.png")),
      false,
    );
    assert.equal(existsSync(path.join(targetDir, "middle_json.json")), false);
    assert.equal(
      existsSync(path.join(targetDir, "structured_content.json")),
      false,
    );

    // Temp staging and server upload directories should be cleaned up
    assert.equal(existsSync(capturedUploadDir), false);
    const baseEntries = await fsp.readdir(baseDir);
    assert.equal(
      baseEntries.some(
        (name) =>
          name.startsWith(".mineru-tmp-") || name.startsWith(".mineru-upload-"),
      ),
      false,
    );

    const phases = progressEvents.map((e) => e.phase);
    assert.ok(phases.includes("resolving"));
    assert.ok(phases.includes("starting-server"));
    assert.ok(phases.includes("parsing"));
    assert.ok(phases.includes("extracting"));
    assert.ok(phases.includes("linking"));
    assert.ok(phases.includes("stopping-server"));
  });

  it("tolerates per-item failure including unsafe ZIP traversal and continues remaining items", async () => {
    const baseDir = await makeTempDir();
    const pdfDir = await makeTempDir();
    const pdf1 = path.join(pdfDir, "bad.pdf");
    const pdf2 = path.join(pdfDir, "good.pdf");
    await fsp.writeFile(pdf1, "BAD-PDF");
    await fsp.writeFile(pdf2, "GOOD-PDF");

    const itemsById = new Map<number, any>();
    const att1 = makeMockAttachment({
      id: 11,
      parentItemID: 1,
      filePath: pdf1,
    });
    const att2 = makeMockAttachment({
      id: 22,
      parentItemID: 2,
      filePath: pdf2,
    });
    const item1 = makeMockRegularItem({
      id: 1,
      citationKey: "Bad2020",
      bestAttachment: att1,
      itemsById,
    });
    const item2 = makeMockRegularItem({
      id: 2,
      citationKey: "Good2021",
      bestAttachment: att2,
      itemsById,
    });

    const fakeBinDir = await makeTempDir();
    const fakeBin = path.join(fakeBinDir, "mineru-kit");
    await fsp.writeFile(fakeBin, "");

    const linkedCalls: any[] = [];
    const fsSync = await import("node:fs");
    let zipCall = 0;

    installNodeFSRuntime({
      baseDir,
      itemsById,
      linkFromFile: async (opts) => {
        linkedCalls.push(opts);
      },
    });

    let taskSeq = 0;
    const res = await parseSelectedItemsWithMinerU(
      [item1 as any, item2 as any],
      undefined,
      {
        settings: {
          tier: "basic",
          overwrite: false,
          executablePath: fakeBin,
          timeoutSeconds: 300,
        },
        deps: {
          findFreePort: () => 46124,
          sleep: async () => {},
          createZipReader: () => {
            zipCall++;
            if (zipCall === 1) {
              return createSyncFakeZipReader(
                {
                  "markdown.md": "# Bad",
                  "../escape.txt": "EVIL",
                },
                fsSync,
              );
            }
            return createSyncFakeZipReader(
              { "markdown.md": "# Good2021" },
              fsSync,
            );
          },
          getSubprocess: () => ({
            pathSearch: async () => null,
            call: async () => makeRunningServerProcess(),
          }),
          fetch: async (url, init) => {
            if (url.endsWith("/v1/health")) {
              return {
                ok: true,
                status: 200,
                json: async () => ({ status: "ok" }),
                text: async () => "",
                arrayBuffer: async () => new ArrayBuffer(0),
              };
            }
            if (url.endsWith("/v1/tasks") && init?.method === "POST") {
              taskSeq++;
              return {
                ok: true,
                status: 202,
                json: async () => ({
                  task_id: `t-${taskSeq}`,
                  status: "waiting-file",
                  files: [
                    {
                      file_id: `f-${taskSeq}`,
                      file_name: "paper.pdf",
                      status: "waiting-file",
                      upload: {
                        url: `http://127.0.0.1:46124/up/${taskSeq}`,
                        headers: { "Content-Type": "application/octet-stream" },
                        expires_at: 9999999999,
                      },
                    },
                  ],
                }),
                text: async () => "",
                arrayBuffer: async () => new ArrayBuffer(0),
              };
            }
            if (url.includes("/up/")) {
              return {
                ok: true,
                status: 200,
                json: async () => ({}),
                text: async () => "",
                arrayBuffer: async () => new ArrayBuffer(0),
              };
            }
            if (url.includes("/v1/tasks/t-")) {
              const id = url.endsWith("t-1") ? "1" : "2";
              return {
                ok: true,
                status: 200,
                json: async () => ({
                  task_id: `t-${id}`,
                  status: "completed",
                  files: [
                    {
                      file_id: `f-${id}`,
                      file_name: "paper.pdf",
                      status: "completed",
                      result_url: `http://127.0.0.1:46124/dl/${id}.zip`,
                    },
                  ],
                }),
                text: async () => "",
                arrayBuffer: async () => new ArrayBuffer(0),
              };
            }
            if (url.includes("/dl/")) {
              return {
                ok: true,
                status: 200,
                json: async () => ({}),
                text: async () => "",
                arrayBuffer: async () => new Uint8Array([1, 2]).buffer,
              };
            }
            throw new Error(`Unexpected url: ${url}`);
          },
        },
      },
    );

    assert.equal(res.status, "completed");
    assert.equal(res.failed, 1);
    assert.equal(res.parsed, 1);
    assert.equal(res.errors.length, 1);
    assert.match(res.errors[0], /Bad2020 \(item 1\): Unsafe ZIP entry path/);
    assert.equal(existsSync(path.join(baseDir, "Bad2020")), false);
    assert.equal(
      existsSync(path.join(baseDir, "Good2021", "Good2021.md")),
      true,
    );
    assert.equal(linkedCalls.length, 1);
    assert.equal(linkedCalls[0].parentItemID, 2);
  });

  it("guards against concurrent runs and supports immediate cancellation stopping the server", async () => {
    const baseDir = await makeTempDir();
    const pdfDir = await makeTempDir();
    const pdfPath = path.join(pdfDir, "cancel.pdf");
    await fsp.writeFile(pdfPath, "PDF");

    const itemsById = new Map<number, any>();
    const att = makeMockAttachment({
      id: 2,
      parentItemID: 1,
      filePath: pdfPath,
    });
    const item = makeMockRegularItem({
      id: 1,
      citationKey: "Cancel2025",
      bestAttachment: att,
      itemsById,
    });

    const fakeBinDir = await makeTempDir();
    const fakeBin = path.join(fakeBinDir, "mineru-kit");
    await fsp.writeFile(fakeBin, "");

    let releasePoll!: () => void;
    const pollGate = new Promise<void>((r) => {
      releasePoll = r;
    });
    let taskCancelCalled = false;
    let serverKilled = false;

    installNodeFSRuntime({ baseDir, itemsById });

    const runPromise = parseSelectedItemsWithMinerU([item as any], undefined, {
      settings: {
        tier: "basic",
        overwrite: false,
        executablePath: fakeBin,
        timeoutSeconds: 300,
      },
      deps: {
        findFreePort: () => 46125,
        getSubprocess: () => ({
          pathSearch: async () => null,
          call: async () => {
            let resolveWait!: (val: { exitCode: number }) => void;
            const waitPromise = new Promise<{ exitCode: number }>((r) => {
              resolveWait = r;
            });
            return {
              stdout: makeMockPipe([]),
              stderr: makeMockPipe([]),
              wait: () => waitPromise,
              kill: async () => {
                serverKilled = true;
                resolveWait({ exitCode: 143 });
              },
            };
          },
        }),
        fetch: async (url, init) => {
          if (url.endsWith("/v1/health")) {
            return {
              ok: true,
              status: 200,
              json: async () => ({ status: "ok" }),
              text: async () => "",
              arrayBuffer: async () => new ArrayBuffer(0),
            };
          }
          if (url.endsWith("/v1/tasks") && init?.method === "POST") {
            return {
              ok: true,
              status: 202,
              json: async () => ({
                task_id: "t-cancel",
                status: "waiting-file",
                files: [
                  {
                    file_id: "f-cancel",
                    file_name: "Cancel2025.pdf",
                    status: "waiting-file",
                    upload: {
                      url: "http://127.0.0.1:46125/up",
                      headers: { "Content-Type": "application/octet-stream" },
                      expires_at: 9999999999,
                    },
                  },
                ],
              }),
              text: async () => "",
              arrayBuffer: async () => new ArrayBuffer(0),
            };
          }
          if (url.endsWith("/up")) {
            return {
              ok: true,
              status: 200,
              json: async () => ({}),
              text: async () => "",
              arrayBuffer: async () => new ArrayBuffer(0),
            };
          }
          if (url.endsWith("/v1/tasks/t-cancel") && init?.method !== "POST") {
            releasePoll();
            // Hang poll fetch until aborted by cancelActiveMinerUParse
            return await new Promise(() => {});
          }
          if (url.endsWith("/v1/tasks/t-cancel/cancel")) {
            taskCancelCalled = true;
            return {
              ok: true,
              status: 200,
              json: async () => ({ status: "canceled" }),
              text: async () => "",
              arrayBuffer: async () => new ArrayBuffer(0),
            };
          }
          throw new Error(`Unexpected fetch: ${url}`);
        },
      },
    });

    assert.equal(isMinerUParseRunning(), true);
    const secondRun = await parseSelectedItemsWithMinerU([item as any]);
    assert.equal(secondRun.status, "already-running");

    await pollGate;
    const cancelAccepted = cancelActiveMinerUParse();
    assert.equal(cancelAccepted, true);

    const res = await runPromise;
    assert.equal(res.status, "canceled");
    assert.equal(taskCancelCalled, true);
    assert.equal(serverKilled, true);
    assert.equal(isMinerUParseRunning(), false);
    assert.equal(cancelActiveMinerUParse(), false);
  });

  it("supports pathSearch probe, injected extractZip, and direct stopActiveMinerUServer", async () => {
    const baseDir = await makeTempDir();
    const pdfDir = await makeTempDir();
    const pdfPath = path.join(pdfDir, "injected.pdf");
    await fsp.writeFile(pdfPath, "PDF-INJECTED");

    const itemsById = new Map<number, any>();
    const att = makeMockAttachment({
      id: 2,
      parentItemID: 1,
      filePath: pdfPath,
    });
    const item = makeMockRegularItem({
      id: 1,
      citationKey: "Injected2025",
      bestAttachment: att,
      itemsById,
    });

    const linkedCalls: any[] = [];
    installNodeFSRuntime({
      baseDir,
      itemsById,
      linkFromFile: async (opts) => {
        linkedCalls.push(opts);
      },
    });

    let spawnedCmd = "";
    const res = await parseSelectedItemsWithMinerU([item as any], undefined, {
      settings: {
        tier: "flash",
        overwrite: false,
        executablePath: "",
        timeoutSeconds: 60,
      },
      deps: {
        getHomeDir: () => "",
        findFreePort: () => 46126,
        sleep: async () => {},
        extractZip: async ({ stageDir, citeKey }) => {
          const mdPath = path.join(stageDir, `${citeKey}.md`);
          await fsp.writeFile(mdPath, "# Injected");
          return { markdownFilePath: mdPath };
        },
        getSubprocess: () => ({
          pathSearch: async () => "/opt/custom/bin/mineru-kit",
          call: async (opts) => {
            spawnedCmd = opts.command;
            return makeRunningServerProcess();
          },
        }),
        fetch: async (url, init) => {
          if (url.endsWith("/v1/health")) {
            return {
              ok: true,
              status: 200,
              json: async () => ({ status: "ok" }),
              text: async () => "",
              arrayBuffer: async () => new ArrayBuffer(0),
            };
          }
          if (url.endsWith("/v1/tasks") && init?.method === "POST") {
            return {
              ok: true,
              status: 202,
              json: async () => ({
                task_id: "t-inj",
                status: "waiting-file",
                files: [
                  {
                    file_id: "f-inj",
                    file_name: "Injected2025.pdf",
                    status: "waiting-file",
                    upload: {
                      url: "http://127.0.0.1:46126/up",
                      headers: { "Content-Type": "application/octet-stream" },
                      expires_at: 9999999999,
                    },
                  },
                ],
              }),
              text: async () => "",
              arrayBuffer: async () => new ArrayBuffer(0),
            };
          }
          if (url.endsWith("/up")) {
            return {
              ok: true,
              status: 200,
              json: async () => ({}),
              text: async () => "",
              arrayBuffer: async () => new ArrayBuffer(0),
            };
          }
          if (url.endsWith("/v1/tasks/t-inj")) {
            return {
              ok: true,
              status: 200,
              json: async () => ({
                task_id: "t-inj",
                status: "completed",
                files: [
                  {
                    file_id: "f-inj",
                    file_name: "Injected2025.pdf",
                    status: "completed",
                    result_url: "http://127.0.0.1:46126/dl.zip",
                  },
                ],
              }),
              text: async () => "",
              arrayBuffer: async () => new ArrayBuffer(0),
            };
          }
          if (url.endsWith("/dl.zip")) {
            return {
              ok: true,
              status: 200,
              json: async () => ({}),
              text: async () => "",
              arrayBuffer: async () => new Uint8Array([9, 9]).buffer,
            };
          }
          throw new Error(`Unexpected url: ${url}`);
        },
      },
    });

    assert.equal(spawnedCmd, "/opt/custom/bin/mineru-kit");
    assert.equal(res.status, "completed");
    assert.equal(res.parsed, 1);
    assert.equal(linkedCalls.length, 1);

    // Direct stopActiveMinerUServer when starting server
    let releaseHealth!: () => void;
    const healthReached = new Promise<void>((r) => {
      releaseHealth = r;
    });
    let killedOnShutdown = false;
    const shutdownPromise = parseSelectedItemsWithMinerU(
      [item as any],
      undefined,
      {
        settings: {
          tier: "flash",
          overwrite: true,
          executablePath: "",
          timeoutSeconds: 60,
        },
        deps: {
          getHomeDir: () => "",
          findFreePort: () => 46127,
          getSubprocess: () => ({
            pathSearch: async () => "/opt/custom/bin/mineru-kit",
            call: async () =>
              makeRunningServerProcess({
                onKill: () => {
                  killedOnShutdown = true;
                },
              }),
          }),
          fetch: async () => {
            releaseHealth();
            return await new Promise(() => {});
          },
        },
      },
    );

    await healthReached;
    await stopActiveMinerUServer();
    const shutdownRes = await shutdownPromise;
    assert.equal(killedOnShutdown, true);
    assert.equal(shutdownRes.status, "canceled");
    assert.equal(isMinerUParseRunning(), false);
  });

  it("surfaces files[0].error.message on failed tasks and handles task timeout", async () => {
    const baseDir = await makeTempDir();
    const pdfDir = await makeTempDir();
    const pdfPath = path.join(pdfDir, "err.pdf");
    await fsp.writeFile(pdfPath, "PDF-ERR");

    const itemsById = new Map<number, any>();
    const att1 = makeMockAttachment({
      id: 2,
      parentItemID: 1,
      filePath: pdfPath,
    });
    const item1 = makeMockRegularItem({
      id: 1,
      citationKey: "FailMsg2025",
      bestAttachment: att1,
      itemsById,
    });
    const att2 = makeMockAttachment({
      id: 4,
      parentItemID: 3,
      filePath: pdfPath,
    });
    const item2 = makeMockRegularItem({
      id: 3,
      citationKey: "Timeout2025",
      bestAttachment: att2,
      itemsById,
    });

    const fakeBinDir = await makeTempDir();
    const fakeBin = path.join(fakeBinDir, "mineru-kit");
    await fsp.writeFile(fakeBin, "");

    installNodeFSRuntime({ baseDir, itemsById });

    let fakeNow = 1000;
    let taskSeq = 0;
    const res = await parseSelectedItemsWithMinerU(
      [item1 as any, item2 as any],
      undefined,
      {
        settings: {
          tier: "basic",
          overwrite: false,
          executablePath: fakeBin,
          timeoutSeconds: 30,
        },
        deps: {
          findFreePort: () => 46128,
          now: () => fakeNow,
          sleep: async () => {
            fakeNow += 35_000;
          },
          getSubprocess: () => ({
            pathSearch: async () => null,
            call: async () => makeRunningServerProcess(),
          }),
          fetch: async (url, init) => {
            if (url.endsWith("/v1/health")) {
              return {
                ok: true,
                status: 200,
                json: async () => ({ status: "ok" }),
                text: async () => "",
                arrayBuffer: async () => new ArrayBuffer(0),
              };
            }
            if (url.endsWith("/v1/tasks") && init?.method === "POST") {
              taskSeq++;
              return {
                ok: true,
                status: 202,
                json: async () => ({
                  task_id: `t-${taskSeq}`,
                  status: "waiting-file",
                  files: [
                    {
                      file_id: `f-${taskSeq}`,
                      file_name: "err.pdf",
                      status: "waiting-file",
                      upload: {
                        url: `http://127.0.0.1:46128/up/${taskSeq}`,
                        headers: { "Content-Type": "application/octet-stream" },
                        expires_at: 9999999999,
                      },
                    },
                  ],
                }),
                text: async () => "",
                arrayBuffer: async () => new ArrayBuffer(0),
              };
            }
            if (url.includes("/up/")) {
              return {
                ok: true,
                status: 200,
                json: async () => ({}),
                text: async () => "",
                arrayBuffer: async () => new ArrayBuffer(0),
              };
            }
            if (url.endsWith("/v1/tasks/t-1")) {
              return {
                ok: true,
                status: 200,
                json: async () => ({
                  task_id: "t-1",
                  status: "failed",
                  files: [
                    {
                      file_id: "f-1",
                      file_name: "err.pdf",
                      status: "failed",
                      error: {
                        code: "file_corrupted",
                        message: "Corrupted PDF stream",
                      },
                    },
                  ],
                }),
                text: async () => "",
                arrayBuffer: async () => new ArrayBuffer(0),
              };
            }
            if (url.endsWith("/v1/tasks/t-2")) {
              return {
                ok: true,
                status: 200,
                json: async () => ({
                  task_id: "t-2",
                  status: "running",
                  files: [
                    {
                      file_id: "f-2",
                      file_name: "err.pdf",
                      status: "running",
                    },
                  ],
                }),
                text: async () => "",
                arrayBuffer: async () => new ArrayBuffer(0),
              };
            }
            throw new Error(`Unexpected url: ${url}`);
          },
        },
      },
    );

    assert.equal(res.status, "completed");
    assert.equal(res.failed, 2);
    assert.match(res.errors[0], /Corrupted PDF stream/);
    assert.doesNotMatch(res.errors[0], /\[object Object\]/);
    assert.match(res.errors[1], /timed out after 30s/);
  });

  it("rolls back images safely when moving markdown fails (with and without new images)", async () => {
    const baseDir = await makeTempDir();
    const pdfDir = await makeTempDir();
    const pdfPath = path.join(pdfDir, "rb.pdf");
    await fsp.writeFile(pdfPath, "PDF-RB");

    const targetDir = path.join(baseDir, "Rollback2025");
    await fsp.mkdir(path.join(targetDir, "images"), { recursive: true });
    await fsp.writeFile(path.join(targetDir, "Rollback2025.md"), "ORIGINAL-MD");
    await fsp.writeFile(
      path.join(targetDir, "images", "orig.png"),
      "ORIGINAL-IMG",
    );

    const itemsById = new Map<number, any>();
    const att = makeMockAttachment({
      id: 2,
      parentItemID: 1,
      filePath: pdfPath,
    });
    const item = makeMockRegularItem({
      id: 1,
      citationKey: "Rollback2025",
      bestAttachment: att,
      itemsById,
    });

    const fakeBinDir = await makeTempDir();
    const fakeBin = path.join(fakeBinDir, "mineru-kit");
    await fsp.writeFile(fakeBin, "");

    const fsSync = await import("node:fs");
    let zipMode: "with-images" | "no-images" = "with-images";

    const runWithMoveFailure = async () => {
      installNodeFSRuntime({ baseDir, itemsById });
      const origMove = (globalThis as Record<string, any>).IOUtils.move;
      (globalThis as Record<string, any>).IOUtils.move = async (
        src: string,
        dest: string,
      ) => {
        if (dest === path.join(targetDir, "Rollback2025.md")) {
          throw new Error("EACCES writing markdown");
        }
        return await origMove(src, dest);
      };

      return await parseSelectedItemsWithMinerU([item as any], undefined, {
        settings: {
          tier: "basic",
          overwrite: true,
          executablePath: fakeBin,
          timeoutSeconds: 60,
        },
        deps: {
          findFreePort: () => 46129,
          sleep: async () => {},
          createZipReader: () =>
            zipMode === "with-images"
              ? createSyncFakeZipReader(
                  {
                    "markdown.md": "NEW-MD",
                    "images/new.png": new Uint8Array([1, 2]),
                  },
                  fsSync,
                )
              : createSyncFakeZipReader({ "markdown.md": "NEW-MD" }, fsSync),
          getSubprocess: () => ({
            pathSearch: async () => null,
            call: async () => makeRunningServerProcess(),
          }),
          fetch: async (url, init) => {
            if (url.endsWith("/v1/health")) {
              return {
                ok: true,
                status: 200,
                json: async () => ({ status: "ok" }),
                text: async () => "",
                arrayBuffer: async () => new ArrayBuffer(0),
              };
            }
            if (url.endsWith("/v1/tasks") && init?.method === "POST") {
              return {
                ok: true,
                status: 202,
                json: async () => ({
                  task_id: "t-rb",
                  status: "waiting-file",
                  files: [
                    {
                      file_id: "f-rb",
                      file_name: "rb.pdf",
                      status: "waiting-file",
                      upload: {
                        url: "http://127.0.0.1:46129/up",
                        headers: { "Content-Type": "application/octet-stream" },
                        expires_at: 9999999999,
                      },
                    },
                  ],
                }),
                text: async () => "",
                arrayBuffer: async () => new ArrayBuffer(0),
              };
            }
            if (url.endsWith("/up")) {
              return {
                ok: true,
                status: 200,
                json: async () => ({}),
                text: async () => "",
                arrayBuffer: async () => new ArrayBuffer(0),
              };
            }
            if (url.endsWith("/v1/tasks/t-rb")) {
              return {
                ok: true,
                status: 200,
                json: async () => ({
                  task_id: "t-rb",
                  status: "completed",
                  files: [
                    {
                      file_id: "f-rb",
                      file_name: "rb.pdf",
                      status: "completed",
                      result_url: "http://127.0.0.1:46129/dl.zip",
                    },
                  ],
                }),
                text: async () => "",
                arrayBuffer: async () => new ArrayBuffer(0),
              };
            }
            if (url.endsWith("/dl.zip")) {
              return {
                ok: true,
                status: 200,
                json: async () => ({}),
                text: async () => "",
                arrayBuffer: async () => new Uint8Array([1]).buffer,
              };
            }
            throw new Error(`Unexpected url: ${url}`);
          },
        },
      });
    };

    // Case 1: new ZIP has images -> new images must be cleaned up and original images restored
    zipMode = "with-images";
    const r1 = await runWithMoveFailure();
    assert.equal(r1.failed, 1);
    assert.equal(
      await fsp.readFile(path.join(targetDir, "Rollback2025.md"), "utf8"),
      "ORIGINAL-MD",
    );
    assert.equal(
      await fsp.readFile(path.join(targetDir, "images", "orig.png"), "utf8"),
      "ORIGINAL-IMG",
    );
    assert.equal(existsSync(path.join(targetDir, "images", "new.png")), false);

    // Case 2: new ZIP has no images -> original images must still be restored
    zipMode = "no-images";
    const r2 = await runWithMoveFailure();
    assert.equal(r2.failed, 1);
    assert.equal(
      await fsp.readFile(path.join(targetDir, "images", "orig.png"), "utf8"),
      "ORIGINAL-IMG",
    );
  });

  it("removes stale images when overwrite ZIP has no images and links new path despite nested basename match", async () => {
    const baseDir = await makeTempDir();
    const pdfDir = await makeTempDir();
    const pdfPath = path.join(pdfDir, "noimg.pdf");
    await fsp.writeFile(pdfPath, "PDF-NOIMG");

    const targetDir = path.join(baseDir, "NoImg2025");
    await fsp.mkdir(path.join(targetDir, "images"), { recursive: true });
    await fsp.writeFile(path.join(targetDir, "images", "old.png"), "OLD-IMG");

    const nestedOldMd = path.join(
      baseDir,
      "Category",
      "NoImg2025",
      "NoImg2025.md",
    );
    const itemsById = new Map<number, any>();
    const attPdf = makeMockAttachment({
      id: 2,
      parentItemID: 1,
      filePath: pdfPath,
    });
    const attNestedMd = makeMockAttachment({
      id: 3,
      parentItemID: 1,
      contentType: "text/markdown",
      linkMode: 2,
      attachmentPath: nestedOldMd,
    });
    const item = makeMockRegularItem({
      id: 1,
      citationKey: "NoImg2025",
      bestAttachment: attPdf,
      attachments: [attPdf, attNestedMd],
      itemsById,
    });

    const fakeBinDir = await makeTempDir();
    const fakeBin = path.join(fakeBinDir, "mineru-kit");
    await fsp.writeFile(fakeBin, "");

    const linkedCalls: any[] = [];
    installNodeFSRuntime({
      baseDir,
      itemsById,
      linkFromFile: async (opts) => {
        linkedCalls.push(opts);
      },
    });
    const fsSync = await import("node:fs");

    const res = await parseSelectedItemsWithMinerU([item as any], undefined, {
      settings: {
        tier: "basic",
        overwrite: true,
        executablePath: fakeBin,
        timeoutSeconds: 60,
      },
      deps: {
        findFreePort: () => 46130,
        sleep: async () => {},
        createZipReader: () =>
          createSyncFakeZipReader({ "markdown.md": "# Clean NoImg" }, fsSync),
        getSubprocess: () => ({
          pathSearch: async () => null,
          call: async () => makeRunningServerProcess(),
        }),
        fetch: async (url, init) => {
          if (url.endsWith("/v1/health")) {
            return {
              ok: true,
              status: 200,
              json: async () => ({ status: "ok" }),
              text: async () => "",
              arrayBuffer: async () => new ArrayBuffer(0),
            };
          }
          if (url.endsWith("/v1/tasks") && init?.method === "POST") {
            return {
              ok: true,
              status: 202,
              json: async () => ({
                task_id: "t-noimg",
                status: "waiting-file",
                files: [
                  {
                    file_id: "f-noimg",
                    file_name: "noimg.pdf",
                    status: "waiting-file",
                    upload: {
                      url: "http://127.0.0.1:46130/up",
                      headers: { "Content-Type": "application/octet-stream" },
                      expires_at: 9999999999,
                    },
                  },
                ],
              }),
              text: async () => "",
              arrayBuffer: async () => new ArrayBuffer(0),
            };
          }
          if (url.endsWith("/up")) {
            return {
              ok: true,
              status: 200,
              json: async () => ({}),
              text: async () => "",
              arrayBuffer: async () => new ArrayBuffer(0),
            };
          }
          if (url.endsWith("/v1/tasks/t-noimg")) {
            return {
              ok: true,
              status: 200,
              json: async () => ({
                task_id: "t-noimg",
                status: "completed",
                files: [
                  {
                    file_id: "f-noimg",
                    file_name: "noimg.pdf",
                    status: "completed",
                    result_url: "http://127.0.0.1:46130/dl.zip",
                  },
                ],
              }),
              text: async () => "",
              arrayBuffer: async () => new ArrayBuffer(0),
            };
          }
          if (url.endsWith("/dl.zip")) {
            return {
              ok: true,
              status: 200,
              json: async () => ({}),
              text: async () => "",
              arrayBuffer: async () => new Uint8Array([1]).buffer,
            };
          }
          throw new Error(`Unexpected url: ${url}`);
        },
      },
    });

    assert.equal(res.status, "completed");
    assert.equal(res.parsed, 1);
    assert.equal(existsSync(path.join(targetDir, "images")), false);
    assert.equal(
      await fsp.readFile(path.join(targetDir, "NoImg2025.md"), "utf8"),
      "# Clean NoImg",
    );
    assert.deepEqual(linkedCalls, [
      {
        file: path.join(targetDir, "NoImg2025.md"),
        parentItemID: 1,
        title: "NoImg2025.md",
        contentType: "text/markdown",
      },
    ]);
  });

  it("fails fast on mid-batch server crash without retrying subsequent items", async () => {
    const baseDir = await makeTempDir();
    const pdfDir = await makeTempDir();
    const pdfPath = path.join(pdfDir, "crash.pdf");
    await fsp.writeFile(pdfPath, "PDF-CRASH");

    const itemsById = new Map<number, any>();
    const att1 = makeMockAttachment({
      id: 2,
      parentItemID: 1,
      filePath: pdfPath,
    });
    const item1 = makeMockRegularItem({
      id: 1,
      citationKey: "Crash1",
      bestAttachment: att1,
      itemsById,
    });
    const att2 = makeMockAttachment({
      id: 4,
      parentItemID: 3,
      filePath: pdfPath,
    });
    const item2 = makeMockRegularItem({
      id: 3,
      citationKey: "Crash2",
      bestAttachment: att2,
      itemsById,
    });

    const fakeBinDir = await makeTempDir();
    const fakeBin = path.join(fakeBinDir, "mineru-kit");
    await fsp.writeFile(fakeBin, "");

    installNodeFSRuntime({ baseDir, itemsById });

    let triggerCrash!: (res: { exitCode: number }) => void;
    const crashWait = new Promise<{ exitCode: number }>((r) => {
      triggerCrash = r;
    });
    let taskCreateCalls = 0;

    const res = await parseSelectedItemsWithMinerU(
      [item1 as any, item2 as any],
      undefined,
      {
        settings: {
          tier: "basic",
          overwrite: false,
          executablePath: fakeBin,
          timeoutSeconds: 60,
        },
        deps: {
          findFreePort: () => 46131,
          getSubprocess: () => ({
            pathSearch: async () => null,
            call: async () => ({
              stdout: makeMockPipe([]),
              stderr: makeMockPipe([]),
              wait: () => crashWait,
              kill: async () => {},
            }),
          }),
          fetch: async (url, init) => {
            if (url.endsWith("/v1/health")) {
              return {
                ok: true,
                status: 200,
                json: async () => ({ status: "ok" }),
                text: async () => "",
                arrayBuffer: async () => new ArrayBuffer(0),
              };
            }
            if (url.endsWith("/v1/tasks") && init?.method === "POST") {
              taskCreateCalls++;
              return {
                ok: true,
                status: 202,
                json: async () => ({
                  task_id: "t-crash",
                  status: "waiting-file",
                  files: [
                    {
                      file_id: "f-crash",
                      file_name: "crash.pdf",
                      status: "waiting-file",
                      upload: {
                        url: "http://127.0.0.1:46131/up",
                        headers: { "Content-Type": "application/octet-stream" },
                        expires_at: 9999999999,
                      },
                    },
                  ],
                }),
                text: async () => "",
                arrayBuffer: async () => new ArrayBuffer(0),
              };
            }
            if (url.endsWith("/up")) {
              return {
                ok: true,
                status: 200,
                json: async () => ({}),
                text: async () => "",
                arrayBuffer: async () => new ArrayBuffer(0),
              };
            }
            if (url.endsWith("/v1/tasks/t-crash")) {
              // Simulate server crashing mid-poll
              triggerCrash({ exitCode: 137 });
              return await new Promise(() => {});
            }
            throw new Error(`Unexpected url: ${url}`);
          },
        },
      },
    );

    assert.equal(res.status, "completed");
    assert.equal(res.failed, 2);
    assert.equal(taskCreateCalls, 1);
    assert.match(res.errors[0], /exited unexpectedly/);
    assert.match(res.errors[1], /exited unexpectedly \(code 137\)/);
  });
});
