import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  buildCiteKeyLookup,
  extractCitationKeyFromExtra,
  isHiddenEntryName,
  isSyncRunning,
  lookupByCiteKey,
  normalizePathForCompare,
  syncMarkdownLinks,
  type SyncProgress,
} from "../src/modules/linker.ts";

const originalGlobals = {
  Zotero: (globalThis as Record<string, any>).Zotero,
  IOUtils: (globalThis as Record<string, any>).IOUtils,
  PathUtils: (globalThis as Record<string, any>).PathUtils,
};

afterEach(() => {
  for (const [key, value] of Object.entries(originalGlobals)) {
    if (value === undefined) {
      delete (globalThis as Record<string, any>)[key];
    } else {
      (globalThis as Record<string, any>)[key] = value;
    }
  }
});

function installRuntimeMocks(options: {
  baseDir?: string;
  isWin?: boolean;
  isMac?: boolean;
  canonicalPaths?: Record<string, string>;
  dirs?: Record<string, string[]>;
  stats?: Record<string, { type: string } | Error>;
  items?: Array<{
    id: number;
    regular?: boolean;
    deleted?: boolean;
    citationKey?: string | Error;
    extra?: string;
    attachments?: Array<{
      id: number;
      deleted?: boolean;
      isAttachment?: boolean;
      linkMode?: number;
      attachmentPath?: string;
      resolvedPath?: string | false;
    }>;
  }>;
  linkFromFile?: (opts: {
    file: string;
    parentItemID: number;
    title: string;
    contentType: string;
  }) => Promise<void>;
}) {
  const dirs = options.dirs ?? {};
  const stats = options.stats ?? {};
  const items = options.items ?? [];
  const itemById = new Map<number, any>();

  const zoteroItems = items.map((entry) => {
    const attIDs = (entry.attachments ?? []).map((att) => {
      itemById.set(att.id, {
        id: att.id,
        deleted: Boolean(att.deleted),
        isAttachment: () => att.isAttachment ?? true,
        attachmentLinkMode: att.linkMode ?? 2,
        attachmentPath: att.attachmentPath ?? "",
        getFilePathAsync: async () => att.resolvedPath ?? false,
      });
      return att.id;
    });

    const itemObj = {
      id: entry.id,
      deleted: Boolean(entry.deleted),
      isRegularItem: () => entry.regular ?? true,
      getField: (field: string) => {
        if (field === "citationKey") {
          if (entry.citationKey instanceof Error) {
            throw entry.citationKey;
          }
          return entry.citationKey ?? "";
        }
        if (field === "extra") {
          return entry.extra ?? "";
        }
        return "";
      },
      getAttachments: () => attIDs,
    };
    itemById.set(entry.id, itemObj);
    return itemObj;
  });

  (globalThis as Record<string, any>).PathUtils = {
    join: (...parts: string[]) => parts.join("/").replace(/\/+/g, "/"),
    filename: (filePath: string) => {
      const cleaned = filePath.replace(/\/+$/, "");
      const idx = cleaned.lastIndexOf("/");
      return idx >= 0 ? cleaned.slice(idx + 1) : cleaned;
    },
  };

  (globalThis as Record<string, any>).IOUtils = {
    stat: async (targetPath: string) => {
      const val = stats[targetPath];
      if (!val) {
        throw new Error(`Not found: ${targetPath}`);
      }
      if (val instanceof Error) {
        throw val;
      }
      return val;
    },
    getChildren: async (dirPath: string) => dirs[dirPath] ?? [],
  };

  (globalThis as Record<string, any>).Zotero = {
    isWin: options.isWin ?? false,
    isMac: options.isMac ?? false,
    File: options.canonicalPaths
      ? {
          pathToFile: (targetPath: string) => {
            const resolved = options.canonicalPaths![targetPath] ?? targetPath;
            const fileObj = {
              path: targetPath,
              get target(): string {
                throw new Error("NS_ERROR_FILE_INVALID_PATH");
              },
              normalize: () => {
                fileObj.path = resolved;
              },
            };
            return fileObj;
          },
        }
      : undefined,
    Prefs: {
      get: (key: string) =>
        key === "baseAttachmentPath" ? options.baseDir : undefined,
    },
    Libraries: {
      userLibraryID: 1,
    },
    Items: {
      getAll: async () => zoteroItems,
      getAsync: async (ids: number[]) =>
        ids.map((id) => itemById.get(id)).filter(Boolean),
    },
    Attachments: {
      LINK_MODE_LINKED_FILE: 2,
      getBaseDirectoryRelativePath: (filePath: string) =>
        options.baseDir && filePath.startsWith(`${options.baseDir}/`)
          ? `attachments:${filePath.slice(options.baseDir.length + 1)}`
          : false,
      linkFromFile: options.linkFromFile ?? (async () => {}),
    },
    logError: () => {},
  };
}

describe("linker pure helpers", () => {
  describe("isHiddenEntryName", () => {
    it("returns true for dot-prefixed entries", () => {
      assert.equal(isHiddenEntryName(".git"), true);
      assert.equal(isHiddenEntryName(".DS_Store"), true);
      assert.equal(isHiddenEntryName(".obsidian"), true);
      assert.equal(isHiddenEntryName("."), true);
      assert.equal(isHiddenEntryName(".."), true);
    });

    it("returns false for regular and empty names", () => {
      assert.equal(isHiddenEntryName("Smith2020"), false);
      assert.equal(isHiddenEntryName("notes.md"), false);
      assert.equal(isHiddenEntryName("a.b"), false);
      assert.equal(isHiddenEntryName(""), false);
    });
  });

  describe("extractCitationKeyFromExtra", () => {
    it("extracts citation key case-insensitively", () => {
      assert.equal(
        extractCitationKeyFromExtra("Citation Key: Smith2020"),
        "Smith2020",
      );
      assert.equal(
        extractCitationKeyFromExtra("citation key: alice_2021"),
        "alice_2021",
      );
      assert.equal(
        extractCitationKeyFromExtra("CITATION KEY:   Bob-2022  "),
        "Bob-2022",
      );
      assert.equal(
        extractCitationKeyFromExtra("  Citation   Key : foo:bar_2023 "),
        "foo:bar_2023",
      );
    });

    it("extracts citation key from multi-line extra fields with LF or CRLF", () => {
      const extra =
        "tex.note: important\r\nCitation Key: MultiLine2024\r\nDOI: 10.1000/xyz";
      assert.equal(extractCitationKeyFromExtra(extra), "MultiLine2024");
    });

    it("returns null when missing, empty, or malformed", () => {
      assert.equal(extractCitationKeyFromExtra(""), null);
      assert.equal(extractCitationKeyFromExtra("DOI: 10.1000/xyz"), null);
      assert.equal(extractCitationKeyFromExtra("Citation Key:   "), null);
      assert.equal(
        extractCitationKeyFromExtra("Other Citation Key: Ignored2020"),
        null,
      );
    });
  });

  describe("normalizePathForCompare", () => {
    it("normalizes slashes, collapses duplicates, and trims trailing slashes", () => {
      assert.equal(
        normalizePathForCompare("/Users//theta///notes/", false),
        "/Users/theta/notes",
      );
      assert.equal(
        normalizePathForCompare("C:\\Users\\Alice\\Docs\\", true),
        "c:/users/alice/docs",
      );
      assert.equal(
        normalizePathForCompare("C:\\Users\\Alice\\Docs\\", false),
        "C:/Users/Alice/Docs",
      );
    });

    it("preserves UNC prefix and root paths", () => {
      assert.equal(
        normalizePathForCompare("\\\\server\\share\\\\sub\\", true),
        "//server/share/sub",
      );
      assert.equal(normalizePathForCompare("/", false), "/");
      assert.equal(normalizePathForCompare("///", false), "/");
      assert.equal(normalizePathForCompare("C:\\", true), "c:/");
      assert.equal(normalizePathForCompare("C:/", false), "C:/");
      assert.equal(normalizePathForCompare("", true), "");
    });
  });

  describe("buildCiteKeyLookup and lookupByCiteKey", () => {
    it("prefers exact matches over case-insensitive fallback", () => {
      const lookup = buildCiteKeyLookup([
        { citeKey: "Smith2020", item: "exact-upper" },
        { citeKey: "smith2020", item: "exact-lower" },
      ]);

      assert.deepEqual(lookupByCiteKey(lookup, "Smith2020"), ["exact-upper"]);
      assert.deepEqual(lookupByCiteKey(lookup, "smith2020"), ["exact-lower"]);
      assert.deepEqual(lookupByCiteKey(lookup, "SMITH2020"), [
        "exact-upper",
        "exact-lower",
      ]);
    });

    it("falls back to case-insensitive match when exact has no match", () => {
      const lookup = buildCiteKeyLookup([{ citeKey: "Doe2021", item: 42 }]);

      assert.deepEqual(lookupByCiteKey(lookup, "doe2021"), [42]);
      assert.deepEqual(lookupByCiteKey(lookup, "DOE2021"), [42]);
    });

    it("returns all items for duplicate cite keys", () => {
      const lookup = buildCiteKeyLookup([
        { citeKey: "Dup2022", item: "item-1" },
        { citeKey: "Dup2022", item: "item-2" },
        { citeKey: "Other2022", item: "item-3" },
      ]);

      assert.deepEqual(lookupByCiteKey(lookup, "Dup2022"), [
        "item-1",
        "item-2",
      ]);
      assert.deepEqual(lookupByCiteKey(lookup, "dup2022"), [
        "item-1",
        "item-2",
      ]);
    });

    it("ignores empty entries and returns empty array for unmatched keys", () => {
      const lookup = buildCiteKeyLookup([
        { citeKey: "   ", item: "ignored" },
        { citeKey: "", item: "also-ignored" },
        { citeKey: "Valid2023", item: "valid" },
      ]);

      assert.deepEqual(lookupByCiteKey(lookup, ""), []);
      assert.deepEqual(lookupByCiteKey(lookup, "   "), []);
      assert.deepEqual(lookupByCiteKey(lookup, "Missing2023"), []);
    });
  });

  describe("isSyncRunning", () => {
    it("defaults to false without Zotero runtime", () => {
      assert.equal(isSyncRunning(), false);
    });
  });
});

describe("syncMarkdownLinks runtime flow (mocked)", () => {
  it("returns no-base-dir when baseAttachmentPath is unset", async () => {
    installRuntimeMocks({ baseDir: "   " });

    const result = await syncMarkdownLinks();
    assert.deepEqual(result, {
      status: "no-base-dir",
      baseDir: undefined,
      scannedFiles: 0,
      linked: 0,
      skipped: 0,
      unmatched: 0,
      failed: 0,
      errors: [],
    });
    assert.equal(isSyncRunning(), false);
  });

  it("returns base-dir-missing when base directory does not exist", async () => {
    installRuntimeMocks({
      baseDir: "/vault/missing",
      stats: { "/vault/missing": new Error("ENOENT") },
    });

    const result = await syncMarkdownLinks();
    assert.deepEqual(result, {
      status: "base-dir-missing",
      baseDir: "/vault/missing",
      scannedFiles: 0,
      linked: 0,
      skipped: 0,
      unmatched: 0,
      failed: 0,
      errors: [],
    });
    assert.equal(isSyncRunning(), false);
  });

  it("guards against concurrent sync runs", async () => {
    let releaseStat!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseStat = resolve;
    });

    installRuntimeMocks({ baseDir: "/vault" });
    (globalThis as Record<string, any>).IOUtils.stat = async () => {
      await gate;
      return { type: "directory" };
    };

    const firstPromise = syncMarkdownLinks();
    assert.equal(isSyncRunning(), true);

    const secondResult = await syncMarkdownLinks();
    assert.equal(secondResult.status, "already-running");

    releaseStat();
    const firstResult = await firstPromise;
    assert.equal(firstResult.status, "completed");
    assert.equal(isSyncRunning(), false);
  });

  it("links matching items, handles duplicates, skips already linked, and records failures", async () => {
    const linkedCalls: Array<{
      file: string;
      parentItemID: number;
      title: string;
      contentType: string;
    }> = [];
    const progressEvents: SyncProgress[] = [];

    installRuntimeMocks({
      baseDir: "/vault",
      dirs: {
        "/vault": [
          "/vault/.obsidian",
          "/vault/Smith2020",
          "/vault/Dup2021",
          "/vault/Unmatched2022",
        ],
        "/vault/Smith2020": [],
        "/vault/Dup2021": [],
        "/vault/Unmatched2022": [],
      },
      stats: {
        "/vault": { type: "directory" },
        "/vault/.obsidian": { type: "directory" },
        "/vault/Smith2020": { type: "directory" },
        "/vault/Smith2020/Smith2020.md": { type: "regular" },
        "/vault/Dup2021": { type: "directory" },
        "/vault/Dup2021/Dup2021.md": { type: "regular" },
        "/vault/Unmatched2022": { type: "directory" },
        "/vault/Unmatched2022/Unmatched2022.md": { type: "regular" },
      },
      items: [
        {
          id: 1,
          citationKey: new Error("Invalid field"),
          extra: "Citation Key: Smith2020",
          attachments: [
            {
              id: 101,
              linkMode: 2,
              attachmentPath: "attachments:Smith2020/Smith2020.md",
            },
          ],
        },
        {
          id: 2,
          citationKey: "Dup2021",
        },
        {
          id: 3,
          citationKey: "Dup2021",
        },
      ],
      linkFromFile: async (opts) => {
        if (opts.parentItemID === 3) {
          throw new Error("Disk read-only");
        }
        linkedCalls.push(opts);
      },
    });

    const result = await syncMarkdownLinks((p) => progressEvents.push(p));

    assert.equal(result.status, "completed");
    assert.equal(result.baseDir, "/vault");
    assert.equal(result.scannedFiles, 3);
    assert.equal(result.linked, 1);
    assert.equal(result.skipped, 1);
    assert.equal(result.unmatched, 1);
    assert.equal(result.failed, 1);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0], /Dup2021 \(item 3\): Disk read-only/);

    assert.deepEqual(linkedCalls, [
      {
        file: "/vault/Dup2021/Dup2021.md",
        parentItemID: 2,
        title: "Dup2021.md",
        contentType: "text/markdown",
      },
    ]);
    assert.equal(progressEvents[0].phase, "scanning");
    assert.equal(progressEvents[1].phase, "indexing");
    assert.equal(progressEvents.filter((p) => p.phase === "linking").length, 3);
  });

  it("deduplicates existing attachments with differing casing when Zotero.isMac is true", async () => {
    const linkedCalls: Array<{ file: string; parentItemID: number }> = [];

    installRuntimeMocks({
      baseDir: "/vault",
      isMac: true,
      dirs: {
        "/vault": ["/vault/Smith2020"],
        "/vault/Smith2020": [],
      },
      stats: {
        "/vault": { type: "directory" },
        "/vault/Smith2020": { type: "directory" },
        "/vault/Smith2020/Smith2020.md": { type: "regular" },
      },
      items: [
        {
          id: 1,
          citationKey: "Smith2020",
          attachments: [
            {
              id: 101,
              linkMode: 2,
              attachmentPath: "attachments:smith2020/smith2020.md",
            },
          ],
        },
      ],
      linkFromFile: async (opts) => {
        linkedCalls.push({
          file: opts.file,
          parentItemID: opts.parentItemID,
        });
      },
    });

    const result = await syncMarkdownLinks();

    assert.equal(result.status, "completed");
    assert.equal(result.scannedFiles, 1);
    assert.equal(result.skipped, 1);
    assert.equal(result.linked, 0);
    assert.deepEqual(linkedCalls, []);
  });

  it("skips symlink cycles via canonical path resolution during scan", async () => {
    const linkedCalls: Array<{ file: string; parentItemID: number }> = [];

    installRuntimeMocks({
      baseDir: "/vault",
      canonicalPaths: {
        "/vault/LoopDir": "/vault",
        "/vault/Smith2020/BackToVault": "/vault",
      },
      dirs: {
        "/vault": ["/vault/Smith2020", "/vault/LoopDir"],
        "/vault/Smith2020": ["/vault/Smith2020/BackToVault"],
        "/vault/LoopDir": ["/vault/LoopDir/Smith2020"],
        "/vault/Smith2020/BackToVault": [
          "/vault/Smith2020/BackToVault/Smith2020",
        ],
      },
      stats: {
        "/vault": { type: "directory" },
        "/vault/Smith2020": { type: "directory" },
        "/vault/Smith2020/Smith2020.md": { type: "regular" },
        "/vault/LoopDir": { type: "directory" },
        "/vault/LoopDir/LoopDir.md": { type: "regular" },
        "/vault/Smith2020/BackToVault": { type: "directory" },
        "/vault/Smith2020/BackToVault/BackToVault.md": { type: "regular" },
      },
      items: [
        {
          id: 10,
          citationKey: "Smith2020",
        },
      ],
      linkFromFile: async (opts) => {
        linkedCalls.push({
          file: opts.file,
          parentItemID: opts.parentItemID,
        });
      },
    });

    const result = await syncMarkdownLinks();

    assert.equal(result.status, "completed");
    assert.equal(result.scannedFiles, 1);
    assert.equal(result.linked, 1);
    assert.deepEqual(linkedCalls, [
      { file: "/vault/Smith2020/Smith2020.md", parentItemID: 10 },
    ]);
  });
});
