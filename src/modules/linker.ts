export interface MarkdownCandidate {
  citeKey: string;
  filePath: string;
}

export interface SyncProgress {
  phase: "scanning" | "indexing" | "linking";
  current?: number;
  total?: number;
}

export interface SyncResult {
  status: "completed" | "already-running" | "no-base-dir" | "base-dir-missing";
  baseDir?: string;
  scannedFiles: number;
  linked: number;
  skipped: number;
  unmatched: number;
  failed: number;
  errors: string[];
}

export interface CiteKeyLookup<T> {
  exact: Map<string, T[]>;
  lower: Map<string, T[]>;
}

interface RuntimeIOStat {
  type?: string;
  size?: number;
}

interface RuntimeIOUtils {
  stat(path: string): Promise<RuntimeIOStat>;
  getChildren(path: string): Promise<string[]>;
}

interface RuntimePathUtils {
  join(...parts: string[]): string;
  filename(path: string): string;
}

const MAX_DEPTH = 32;

let syncing = false;

export function isSyncRunning(): boolean {
  return syncing;
}

export function isHiddenEntryName(name: string): boolean {
  return name.startsWith(".");
}

export function extractCitationKeyFromExtra(extra: string): string | null {
  if (!extra) {
    return null;
  }
  const lines = extra.split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^\s*citation\s+key\s*:\s*(.+?)\s*$/i);
    if (match && match[1]) {
      const key = match[1].trim();
      if (key) {
        return key;
      }
    }
  }
  return null;
}

export function normalizePathForCompare(
  filePath: string,
  caseInsensitive: boolean,
): string {
  if (!filePath) {
    return "";
  }
  let normalized = filePath.replace(/\\/g, "/");
  const isUnc = /^\/\/[^/]/.test(normalized);
  if (isUnc) {
    normalized = "//" + normalized.slice(2).replace(/\/+/g, "/");
  } else {
    normalized = normalized.replace(/\/+/g, "/");
  }

  if (
    normalized.length > 1 &&
    normalized !== "//" &&
    !/^[a-zA-Z]:\/$/.test(normalized)
  ) {
    normalized = normalized.replace(/\/+$/, "");
  }

  if (caseInsensitive) {
    normalized = normalized.toLowerCase();
  }
  return normalized;
}

export function buildCiteKeyLookup<T>(
  entries: Array<{ citeKey: string; item: T }>,
): { exact: Map<string, T[]>; lower: Map<string, T[]> } {
  const exact = new Map<string, T[]>();
  const lower = new Map<string, T[]>();

  for (const entry of entries) {
    const key = entry.citeKey.trim();
    if (!key) {
      continue;
    }

    let exactList = exact.get(key);
    if (!exactList) {
      exactList = [];
      exact.set(key, exactList);
    }
    exactList.push(entry.item);

    const lowerKey = key.toLowerCase();
    let lowerList = lower.get(lowerKey);
    if (!lowerList) {
      lowerList = [];
      lower.set(lowerKey, lowerList);
    }
    lowerList.push(entry.item);
  }

  return { exact, lower };
}

export function lookupByCiteKey<T>(
  lookup: { exact: Map<string, T[]>; lower: Map<string, T[]> },
  citeKey: string,
): T[] {
  const key = citeKey.trim();
  if (!key) {
    return [];
  }

  const exactMatches = lookup.exact.get(key);
  if (exactMatches && exactMatches.length > 0) {
    return exactMatches;
  }

  const lowerMatches = lookup.lower.get(key.toLowerCase());
  if (lowerMatches && lowerMatches.length > 0) {
    return lowerMatches;
  }

  return [];
}

function getIOUtils(): RuntimeIOUtils {
  const io =
    (globalThis as Record<string, any>).IOUtils ??
    (Zotero.getMainWindow() as any)?.IOUtils;
  if (!io) {
    throw new Error("IOUtils is not available");
  }
  return io as RuntimeIOUtils;
}

function getPathUtils(): RuntimePathUtils {
  const pu =
    (globalThis as Record<string, any>).PathUtils ??
    (Zotero.getMainWindow() as any)?.PathUtils;
  if (!pu) {
    throw new Error("PathUtils is not available");
  }
  return pu as RuntimePathUtils;
}

function logError(err: unknown): void {
  try {
    if (
      typeof Zotero !== "undefined" &&
      typeof Zotero.logError === "function"
    ) {
      Zotero.logError(err as Error);
    }
  } catch {
    // Ignore logging failures
  }
  try {
    if (
      typeof ztoolkit !== "undefined" &&
      typeof ztoolkit?.log === "function"
    ) {
      ztoolkit.log(err);
    }
  } catch {
    // Ignore logging failures
  }
}

function reportProgress(
  onProgress: ((progress: SyncProgress) => void) | undefined,
  progress: SyncProgress,
): void {
  if (!onProgress) {
    return;
  }
  try {
    onProgress(progress);
  } catch (err) {
    logError(err);
  }
}

export async function getBaseAttachmentDir(): Promise<
  | { ok: true; baseDir: string }
  | { ok: false; status: "no-base-dir" | "base-dir-missing"; baseDir?: string }
> {
  const rawBaseDir = Zotero.Prefs.get("baseAttachmentPath");
  const baseDir = typeof rawBaseDir === "string" ? rawBaseDir.trim() : "";
  if (!baseDir) {
    return { ok: false, status: "no-base-dir" };
  }

  const ioUtils = getIOUtils();
  try {
    const stat = await ioUtils.stat(baseDir);
    if (stat?.type === "directory") {
      return { ok: true, baseDir };
    }
  } catch {
    // Directory does not exist or cannot be stated
  }

  return { ok: false, status: "base-dir-missing", baseDir };
}

export function isCaseInsensitiveOS(): boolean {
  return Boolean(Zotero.isWin || Zotero.isMac);
}

function resolveCanonicalPath(targetPath: string): string {
  try {
    if (typeof Zotero?.File?.pathToFile === "function") {
      const file = Zotero.File.pathToFile(targetPath);
      file.normalize();
      return file.path || targetPath;
    }
  } catch {
    // Fall back to lexical path if normalization fails or Zotero.File is unavailable
  }
  return targetPath;
}

async function scanMarkdownFiles(
  baseDir: string,
): Promise<MarkdownCandidate[]> {
  const ioUtils = getIOUtils();
  const pathUtils = getPathUtils();
  const caseInsensitive = isCaseInsensitiveOS();

  const stack: Array<{ dir: string; depth: number }> = [
    { dir: baseDir, depth: 0 },
  ];
  const visited = new Set<string>();
  const candidates: MarkdownCandidate[] = [];

  while (stack.length > 0) {
    const current = stack.pop()!;
    const canonicalDir = resolveCanonicalPath(current.dir);
    const normalizedDir = normalizePathForCompare(
      canonicalDir,
      caseInsensitive,
    );
    if (visited.has(normalizedDir)) {
      continue;
    }
    visited.add(normalizedDir);

    let children: string[];
    try {
      children = await ioUtils.getChildren(current.dir);
    } catch (err) {
      logError(err);
      continue;
    }

    for (const childPath of children) {
      const name = pathUtils.filename(childPath);
      if (!name || isHiddenEntryName(name)) {
        continue;
      }

      let entryStat: RuntimeIOStat;
      try {
        entryStat = await ioUtils.stat(childPath);
      } catch {
        continue;
      }

      if (entryStat?.type !== "directory") {
        continue;
      }

      const childCanonicalDir = resolveCanonicalPath(childPath);
      const childNormalizedDir = normalizePathForCompare(
        childCanonicalDir,
        caseInsensitive,
      );
      if (visited.has(childNormalizedDir)) {
        continue;
      }

      const candidateMd = pathUtils.join(childPath, `${name}.md`);
      try {
        const mdStat = await ioUtils.stat(candidateMd);
        if (mdStat?.type === "regular") {
          candidates.push({
            citeKey: name,
            filePath: candidateMd,
          });
        }
      } catch {
        // Ignore missing or unreadable markdown file inside folder
      }

      if (current.depth < MAX_DEPTH) {
        stack.push({ dir: childPath, depth: current.depth + 1 });
      }
    }
  }

  return candidates;
}

export function getItemCitationKey(item: Zotero.Item): string | null {
  try {
    const nativeKey = item.getField("citationKey" as any) as unknown;
    if (typeof nativeKey === "string" && nativeKey.trim()) {
      return nativeKey.trim();
    }
  } catch {
    // citationKey field may not exist on this Zotero version or item type
  }

  try {
    const extra = String(item.getField("extra") || "");
    return extractCitationKeyFromExtra(extra);
  } catch {
    return null;
  }
}

async function buildLibraryCiteKeyLookup(
  libraryID: number,
): Promise<CiteKeyLookup<Zotero.Item>> {
  const items = await Zotero.Items.getAll(libraryID, true, false, false);
  const entries: Array<{ citeKey: string; item: Zotero.Item }> = [];

  for (const item of items) {
    if (!item.isRegularItem() || item.deleted) {
      continue;
    }
    const citeKey = getItemCitationKey(item);
    if (citeKey) {
      entries.push({ citeKey, item });
    }
  }

  return buildCiteKeyLookup(entries);
}

export async function isAlreadyLinked(
  parentItem: Zotero.Item,
  targetFilePath: string,
  caseInsensitive: boolean,
): Promise<boolean> {
  const attIDs = parentItem.getAttachments(false);
  if (!attIDs || attIDs.length === 0) {
    return false;
  }

  const normalizedTarget = normalizePathForCompare(
    targetFilePath,
    caseInsensitive,
  );
  let normalizedRelative = "";
  try {
    const rawRelative =
      Zotero.Attachments.getBaseDirectoryRelativePath(targetFilePath);
    if (typeof rawRelative === "string" && rawRelative) {
      normalizedRelative = normalizePathForCompare(
        rawRelative,
        caseInsensitive,
      );
    }
  } catch {
    // Ignore errors computing relative path
  }

  const attachments = await Zotero.Items.getAsync(attIDs);
  for (const att of attachments) {
    if (!att || att.deleted || !att.isAttachment()) {
      continue;
    }
    if (att.attachmentLinkMode !== Zotero.Attachments.LINK_MODE_LINKED_FILE) {
      continue;
    }

    if (att.attachmentPath) {
      const normalizedAttPath = normalizePathForCompare(
        att.attachmentPath,
        caseInsensitive,
      );
      if (
        normalizedAttPath === normalizedTarget ||
        (normalizedRelative && normalizedAttPath === normalizedRelative)
      ) {
        return true;
      }
    }

    try {
      const resolvedPath = await att.getFilePathAsync();
      if (typeof resolvedPath === "string" && resolvedPath) {
        const normalizedResolved = normalizePathForCompare(
          resolvedPath,
          caseInsensitive,
        );
        if (
          normalizedResolved === normalizedTarget ||
          (normalizedRelative && normalizedResolved === normalizedRelative)
        ) {
          return true;
        }
      }
    } catch {
      // Ignore attachment path resolution errors
    }
  }

  return false;
}

export async function syncMarkdownLinks(
  onProgress?: (progress: SyncProgress) => void,
): Promise<SyncResult> {
  if (syncing) {
    return {
      status: "already-running",
      scannedFiles: 0,
      linked: 0,
      skipped: 0,
      unmatched: 0,
      failed: 0,
      errors: [],
    };
  }

  syncing = true;
  try {
    const baseDirCheck = await getBaseAttachmentDir();
    if (!baseDirCheck.ok) {
      return {
        status: baseDirCheck.status,
        baseDir: baseDirCheck.baseDir,
        scannedFiles: 0,
        linked: 0,
        skipped: 0,
        unmatched: 0,
        failed: 0,
        errors: [],
      };
    }

    const { baseDir } = baseDirCheck;
    reportProgress(onProgress, { phase: "scanning" });
    const candidates = await scanMarkdownFiles(baseDir);
    const scannedFiles = candidates.length;

    if (scannedFiles === 0) {
      return {
        status: "completed",
        baseDir,
        scannedFiles: 0,
        linked: 0,
        skipped: 0,
        unmatched: 0,
        failed: 0,
        errors: [],
      };
    }

    reportProgress(onProgress, { phase: "indexing" });
    const lookup = await buildLibraryCiteKeyLookup(
      Zotero.Libraries.userLibraryID,
    );

    let linked = 0;
    let skipped = 0;
    let unmatched = 0;
    let failed = 0;
    const errors: string[] = [];

    const total = candidates.length;
    const caseInsensitive = isCaseInsensitiveOS();

    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i];
      reportProgress(onProgress, {
        phase: "linking",
        current: i + 1,
        total,
      });

      const matchedItems = lookupByCiteKey(lookup, candidate.citeKey);
      if (matchedItems.length === 0) {
        unmatched++;
        continue;
      }

      for (const item of matchedItems) {
        try {
          const alreadyLinked = await isAlreadyLinked(
            item,
            candidate.filePath,
            caseInsensitive,
          );
          if (alreadyLinked) {
            skipped++;
            continue;
          }

          await Zotero.Attachments.linkFromFile({
            file: candidate.filePath,
            parentItemID: item.id,
            title: `${candidate.citeKey}.md`,
            contentType: "text/markdown",
          });
          linked++;
        } catch (err) {
          failed++;
          const message = err instanceof Error ? err.message : String(err);
          errors.push(`${candidate.citeKey} (item ${item.id}): ${message}`);
          logError(err);
        }
      }
    }

    return {
      status: "completed",
      baseDir,
      scannedFiles,
      linked,
      skipped,
      unmatched,
      failed,
      errors,
    };
  } finally {
    syncing = false;
  }
}
