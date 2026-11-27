import {
  getBaseAttachmentDir,
  getItemCitationKey,
  isAlreadyLinked,
  isCaseInsensitiveOS,
  normalizePathForCompare,
} from "./linker";
import {
  getMinerUSettings,
  type MinerUSettings,
  type MinerUTier,
} from "./prefs";

export interface MinerUParseProgress {
  phase:
    | "resolving"
    | "starting-server"
    | "parsing"
    | "extracting"
    | "linking"
    | "stopping-server";
  current?: number;
  total?: number;
  citeKey?: string;
}

export interface MinerUParseResult {
  status:
    | "completed"
    | "canceled"
    | "already-running"
    | "no-selection"
    | "no-base-dir"
    | "base-dir-missing"
    | "mineru-not-found"
    | "server-start-failed";
  baseDir?: string;
  error?: string;
  totalSelected: number;
  parsed: number;
  linkedExisting: number;
  skippedExisting: number;
  skippedInvalid: number;
  failed: number;
  errors: string[];
}

export interface MinerUFetchResponse {
  ok: boolean;
  status: number;
  statusText?: string;
  json(): Promise<any>;
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export type MinerUFetch = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: any;
    signal?: AbortSignal;
  },
) => Promise<MinerUFetchResponse>;

export interface MinerUPipe {
  readString(): Promise<string>;
}

export interface MinerUSubprocessProcess {
  stdout?: MinerUPipe | null;
  stderr?: MinerUPipe | null;
  wait(): Promise<{ exitCode: number }>;
  kill(timeoutMs?: number): Promise<unknown> | unknown;
}

export interface MinerUSubprocess {
  call(options: {
    command: string;
    arguments: string[];
    workdir?: string;
    environment?: Record<string, string>;
    environmentAppend?: boolean;
    stdout?: "pipe" | "ignore";
    stderr?: "pipe" | "ignore";
  }): Promise<MinerUSubprocessProcess>;
  pathSearch(command: string): Promise<string | null>;
  getEnvironment?(): Record<string, string>;
}

export interface MinerUZigReaderEntry {
  isDirectory?: boolean;
}

export interface MinerUZigStringEnumerator {
  hasMore(): boolean;
  getNext(): string;
}

export interface MinerUZigReader {
  open(file: unknown): void;
  findEntries(pattern: string | null): MinerUZigStringEnumerator;
  getEntry(zipEntry: string): MinerUZigReaderEntry;
  extract(zipEntry: string, outFile: unknown): void;
  close(): void;
}

export interface MinerURuntimeDeps {
  fetch: MinerUFetch;
  getSubprocess: () => Promise<MinerUSubprocess> | MinerUSubprocess;
  findFreePort: () => Promise<number> | number;
  getHomeDir: () => string;
  createZipReader: () => MinerUZigReader;
  pathToFile: (filePath: string) => unknown;
  extractZip: (options: {
    zipBytes: Uint8Array;
    stageDir: string;
    citeKey: string;
  }) => Promise<{ markdownFilePath: string; imagesDirPath?: string }>;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  now: () => number;
  serverStartupTimeoutMs: number;
  healthPollIntervalMs: number;
  cancelRequestTimeoutMs: number;
}

interface RuntimeIOStat {
  type?: string;
  size?: number;
}

interface RuntimeIOUtils {
  stat(path: string): Promise<RuntimeIOStat>;
  read(path: string): Promise<Uint8Array>;
  write(path: string, data: Uint8Array): Promise<number>;
  makeDirectory(
    path: string,
    options?: { createAncestors?: boolean; ignoreExisting?: boolean },
  ): Promise<void>;
  move(sourcePath: string, destPath: string): Promise<void>;
  remove(
    path: string,
    options?: { recursive?: boolean; ignoreAbsent?: boolean },
  ): Promise<void>;
}

interface RuntimePathUtils {
  join(...parts: string[]): string;
  filename(path: string): string;
  parent?(path: string): string;
  tempDir?: string;
}

interface ResolvedTarget {
  parentItem: Zotero.Item;
  pdfAttachment: Zotero.Item;
  pdfPath: string;
  citeKey: string;
  explicitPdf: boolean;
}

const LOG_TAIL_MAX_CHARS = 4096;
const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
const DEFAULT_HEALTH_POLL_INTERVAL_MS = 200;
const DEFAULT_CANCEL_REQUEST_TIMEOUT_MS = 500;
const MIN_TASK_POLL_INTERVAL_MS = 500;
const MAX_TASK_POLL_INTERVAL_MS = 1500;
const WINDOWS_RESERVED_NAME_RE =
  /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$/i;

let parsing = false;
let activeAbortController: AbortController | null = null;
let activeServerStopPromise: Promise<void> | null = null;
let activeServerProcess: MinerUSubprocessProcess | null = null;
let activeServerWaitPromise: Promise<{ exitCode: number } | null> | null = null;
let activeTaskCancelFn: (() => Promise<void>) | null = null;

class ParseAbortError extends Error {
  constructor(message = "MinerU parse canceled") {
    super(message);
    this.name = "AbortError";
  }
}

export function isMinerUParseRunning(): boolean {
  return parsing;
}

export function cancelActiveMinerUParse(): boolean {
  if (!parsing || !activeAbortController) {
    return false;
  }
  if (!activeAbortController.signal.aborted) {
    activeAbortController.abort();
  }
  const cancelTask = activeTaskCancelFn;
  if (cancelTask) {
    void cancelTask().finally(() => {
      void stopActiveMinerUServer();
    });
  } else {
    void stopActiveMinerUServer();
  }
  return true;
}

export async function stopActiveMinerUServer(): Promise<void> {
  if (activeAbortController && !activeAbortController.signal.aborted) {
    activeAbortController.abort();
  }
  if (activeServerStopPromise) {
    await activeServerStopPromise;
    return;
  }
  const proc = activeServerProcess;
  if (!proc) {
    return;
  }

  const waitPromise = activeServerWaitPromise;
  activeServerStopPromise = (async () => {
    try {
      await Promise.resolve(proc.kill(1000));
    } catch {
      // Ignore errors when stopping already-exited server
    }
    if (waitPromise) {
      try {
        await Promise.race([waitPromise.catch(() => null), defaultSleep(1500)]);
      } catch {
        // Ignore wait errors during shutdown
      }
    }
    if (activeServerProcess === proc) {
      activeServerProcess = null;
      activeServerWaitPromise = null;
    }
  })().finally(() => {
    activeServerStopPromise = null;
  });

  await activeServerStopPromise;
}

function hasControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
}

export function isSafeCiteKeyForPath(citeKey: string): boolean {
  if (typeof citeKey !== "string" || citeKey.length === 0) {
    return false;
  }
  if (citeKey.trim() !== citeKey) {
    return false;
  }
  if (citeKey === "." || citeKey === ".." || citeKey.endsWith(".")) {
    return false;
  }
  if (
    /[/\\:<>|?*]/.test(citeKey) ||
    citeKey.includes('"') ||
    hasControlChars(citeKey)
  ) {
    return false;
  }
  if (/^[A-Za-z]:/.test(citeKey)) {
    return false;
  }
  if (WINDOWS_RESERVED_NAME_RE.test(citeKey)) {
    return false;
  }
  return true;
}

export function sanitizeUploadFileName(citeKey: string): string {
  const withoutExt = String(citeKey ?? "").replace(/\.pdf$/i, "");
  const sanitized = withoutExt
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^[._-]+|[._-]+$/g, "")
    .slice(0, 120);
  const base = sanitized || "document";
  return `${base}.pdf`;
}

export function normalizeZipEntryPath(entryName: string): string | null {
  if (typeof entryName !== "string" || entryName.length === 0) {
    return null;
  }
  if (hasControlChars(entryName)) {
    return null;
  }
  if (entryName.includes("\\")) {
    return null;
  }
  if (entryName.startsWith("/")) {
    return null;
  }
  if (/^[A-Za-z]:/.test(entryName)) {
    return null;
  }
  if (entryName.endsWith("/")) {
    return null;
  }

  const rawParts = entryName.split("/");
  const normalizedParts: string[] = [];
  for (const part of rawParts) {
    if (part === "..") {
      return null;
    }
    if (part === "" || part === ".") {
      continue;
    }
    normalizedParts.push(part);
  }

  if (normalizedParts.length === 0) {
    return null;
  }
  return normalizedParts.join("/");
}

export function isAllowedZipExtractPath(normalizedEntry: string): boolean {
  if (!normalizedEntry) {
    return false;
  }
  if (normalizedEntry === "markdown.md") {
    return true;
  }
  if (
    normalizedEntry.startsWith("images/") &&
    normalizedEntry.length > "images/".length
  ) {
    return true;
  }
  return false;
}

export function buildServerArgs(options: {
  port: number;
  tier: MinerUTier;
  timeoutSeconds: number;
  uploadDir?: string;
}): string[] {
  const args = [
    "api-server",
    "--host",
    "127.0.0.1",
    "--port",
    String(options.port),
    "--tier",
    options.tier,
    "--concurrency",
    "1",
    "--task-timeout",
    String(options.timeoutSeconds),
    "--retention-seconds",
    "300",
  ];
  if (options.uploadDir) {
    args.push("--upload-dir", options.uploadDir);
  }
  return args;
}

function getIOUtils(): RuntimeIOUtils {
  const io =
    (globalThis as Record<string, any>).IOUtils ??
    (typeof Zotero !== "undefined"
      ? (Zotero.getMainWindow?.() as any)?.IOUtils
      : undefined);
  if (!io) {
    throw new Error("IOUtils is not available");
  }
  return io as RuntimeIOUtils;
}

function getPathUtils(): RuntimePathUtils {
  const pu =
    (globalThis as Record<string, any>).PathUtils ??
    (typeof Zotero !== "undefined"
      ? (Zotero.getMainWindow?.() as any)?.PathUtils
      : undefined);
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
  onProgress: ((progress: MinerUParseProgress) => void) | undefined,
  progress: MinerUParseProgress,
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

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(new ParseAbortError());
  }
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new ParseAbortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function raceWithAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) {
    throw new ParseAbortError();
  }
  return await new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(new ParseAbortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (val) => {
        signal.removeEventListener("abort", onAbort);
        resolve(val);
      },
      (err) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

function getXPCOMClasses(): Record<string, any> | undefined {
  return (
    (globalThis as Record<string, any>).Cc ??
    (typeof Cc !== "undefined" ? Cc : undefined) ??
    (globalThis as Record<string, any>).Components?.classes ??
    (typeof Components !== "undefined" ? Components.classes : undefined)
  );
}

function getXPCOMInterfaces(): Record<string, any> | undefined {
  return (
    (globalThis as Record<string, any>).Ci ??
    (typeof Ci !== "undefined" ? Ci : undefined) ??
    (globalThis as Record<string, any>).Components?.interfaces ??
    (typeof Components !== "undefined" ? Components.interfaces : undefined)
  );
}

function getDefaultFetchAndAbort(): {
  fetchFn?: MinerUFetch;
  AbortControllerCtor: typeof AbortController;
} {
  const g = globalThis as Record<string, any>;
  if (
    typeof g.fetch === "function" &&
    typeof g.AbortController === "function"
  ) {
    return {
      fetchFn: (g.fetch as MinerUFetch).bind(globalThis),
      AbortControllerCtor: g.AbortController as typeof AbortController,
    };
  }
  const mainWin =
    typeof Zotero !== "undefined"
      ? (Zotero.getMainWindow?.() as Record<string, any> | null | undefined)
      : undefined;
  if (
    mainWin &&
    typeof mainWin.fetch === "function" &&
    typeof mainWin.AbortController === "function"
  ) {
    return {
      fetchFn: (mainWin.fetch as MinerUFetch).bind(mainWin),
      AbortControllerCtor: mainWin.AbortController as typeof AbortController,
    };
  }
  const fallbackFetch = g.fetch ?? mainWin?.fetch;
  const fallbackAbort = g.AbortController ?? mainWin?.AbortController;
  if (typeof fallbackAbort !== "function") {
    throw new Error("AbortController is not available");
  }
  return {
    fetchFn:
      typeof fallbackFetch === "function"
        ? (fallbackFetch as MinerUFetch)
        : undefined,
    AbortControllerCtor: fallbackAbort as typeof AbortController,
  };
}

async function getDefaultSubprocess(): Promise<MinerUSubprocess> {
  const cu =
    (globalThis as Record<string, any>).ChromeUtils ??
    (typeof ChromeUtils !== "undefined" ? ChromeUtils : undefined);
  if (!cu || typeof cu.importESModule !== "function") {
    throw new Error("ChromeUtils.importESModule is not available");
  }
  const mod = cu.importESModule("resource://gre/modules/Subprocess.sys.mjs");
  if (!mod?.Subprocess) {
    throw new Error("Subprocess.sys.mjs did not export Subprocess");
  }
  return mod.Subprocess as MinerUSubprocess;
}

function getDefaultFreePort(): number {
  const cc = getXPCOMClasses();
  const ci = getXPCOMInterfaces();
  if (!cc || !ci) {
    throw new Error("XPCOM Components.classes/interfaces is not available");
  }
  const socket = cc["@mozilla.org/network/server-socket;1"].createInstance(
    ci.nsIServerSocket,
  );
  try {
    socket.init(-1, true, -1);
    return Number(socket.port);
  } finally {
    try {
      socket.close();
    } catch {
      // Ignore close error
    }
  }
}

function getDefaultHomeDir(): string {
  try {
    const services =
      (globalThis as Record<string, any>).Services ??
      (typeof Services !== "undefined" ? Services : undefined);
    const ci = getXPCOMInterfaces();
    const homeFile = services?.dirsvc?.get("Home", ci?.nsIFile);
    if (homeFile?.path) {
      return String(homeFile.path);
    }
  } catch {
    // Fallback below
  }
  return "";
}

function getDefaultTempDir(
  pathUtils: RuntimePathUtils,
  fallbackDir: string,
): string {
  if (typeof pathUtils.tempDir === "string" && pathUtils.tempDir.trim()) {
    return pathUtils.tempDir.trim();
  }
  try {
    const services =
      (globalThis as Record<string, any>).Services ??
      (typeof Services !== "undefined" ? Services : undefined);
    const ci = getXPCOMInterfaces();
    const tmpFile = services?.dirsvc?.get("TmpD", ci?.nsIFile);
    if (tmpFile?.path) {
      return String(tmpFile.path);
    }
  } catch {
    // Fallback below
  }
  return fallbackDir;
}

function defaultCreateZipReader(): MinerUZigReader {
  const cc = getXPCOMClasses();
  const ci = getXPCOMInterfaces();
  if (!cc || !ci) {
    throw new Error(
      "XPCOM Components.classes/interfaces is not available for nsIZipReader",
    );
  }
  return cc["@mozilla.org/libjar/zip-reader;1"].createInstance(
    ci.nsIZipReader,
  ) as MinerUZigReader;
}

function defaultPathToFile(filePath: string): unknown {
  if (typeof Zotero?.File?.pathToFile === "function") {
    return Zotero.File.pathToFile(filePath);
  }
  throw new Error("Zotero.File.pathToFile is not available");
}

function createEmptyResult(
  status: MinerUParseResult["status"],
  totalSelected: number,
  extra?: Partial<MinerUParseResult>,
): MinerUParseResult {
  return {
    status,
    totalSelected,
    parsed: 0,
    linkedExisting: 0,
    skippedExisting: 0,
    skippedInvalid: 0,
    failed: 0,
    errors: [],
    ...extra,
  };
}

function isPdfAttachment(att: Zotero.Item): boolean {
  if (!att || att.deleted || !att.isAttachment()) {
    return false;
  }
  if (att.attachmentContentType === "application/pdf") {
    return true;
  }
  const pathVal =
    typeof att.attachmentPath === "string" ? att.attachmentPath : "";
  return !att.attachmentContentType && /\.pdf$/i.test(pathVal);
}

async function getExistingAttachmentFilePath(
  att: Zotero.Item,
  ioUtils: RuntimeIOUtils,
): Promise<string | null> {
  if (
    typeof Zotero?.Attachments?.LINK_MODE_LINKED_URL === "number" &&
    att.attachmentLinkMode === Zotero.Attachments.LINK_MODE_LINKED_URL
  ) {
    return null;
  }
  try {
    const filePath = await att.getFilePathAsync();
    if (typeof filePath !== "string" || !filePath) {
      return null;
    }
    const stat = await ioUtils.stat(filePath);
    if (stat?.type === "regular") {
      return filePath;
    }
  } catch {
    // Missing or unreadable attachment file
  }
  return null;
}

async function findParentPdfAttachment(
  parentItem: Zotero.Item,
  ioUtils: RuntimeIOUtils,
): Promise<{ pdfAttachment: Zotero.Item; pdfPath: string } | null> {
  try {
    const best = await parentItem.getBestAttachment();
    if (best && isPdfAttachment(best)) {
      const bestPath = await getExistingAttachmentFilePath(best, ioUtils);
      if (bestPath) {
        return { pdfAttachment: best, pdfPath: bestPath };
      }
    }
  } catch {
    // Fall back to scanning all attachments
  }

  const attIDs = parentItem.getAttachments(false);
  if (!attIDs || attIDs.length === 0) {
    return null;
  }
  const attachments = await Zotero.Items.getAsync(attIDs);
  for (const att of attachments) {
    if (!att || !isPdfAttachment(att)) {
      continue;
    }
    const filePath = await getExistingAttachmentFilePath(att, ioUtils);
    if (filePath) {
      return { pdfAttachment: att, pdfPath: filePath };
    }
  }
  return null;
}

async function resolveParentItemForAttachment(
  att: Zotero.Item,
): Promise<Zotero.Item | null> {
  const inlineParent = (att as any).parentItem as
    Zotero.Item | false | undefined;
  if (inlineParent && typeof inlineParent === "object") {
    return inlineParent;
  }
  const parentID = att.parentItemID;
  if (typeof parentID !== "number" || parentID <= 0) {
    return null;
  }
  const fetched = await Zotero.Items.getAsync([parentID]);
  return fetched?.[0] ?? null;
}

function getFileBaseName(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/").replace(/\/+$/, "");
  const slashIdx = normalized.lastIndexOf("/");
  const base = slashIdx >= 0 ? normalized.slice(slashIdx + 1) : normalized;
  const colonIdx = base.indexOf(":");
  if (base.startsWith("attachments:") && colonIdx >= 0) {
    return base.slice(colonIdx + 1);
  }
  return base;
}

async function hasLinkedMarkdownAttachment(
  parentItem: Zotero.Item,
  targetMdPath: string,
  citeKey: string,
  caseInsensitive: boolean,
): Promise<boolean> {
  if (await isAlreadyLinked(parentItem, targetMdPath, caseInsensitive)) {
    return true;
  }
  const attIDs = parentItem.getAttachments(false);
  if (!attIDs || attIDs.length === 0) {
    return false;
  }
  const expectedName = caseInsensitive
    ? `${citeKey}.md`.toLowerCase()
    : `${citeKey}.md`;
  const attachments = await Zotero.Items.getAsync(attIDs);
  for (const att of attachments) {
    if (!att || att.deleted || !att.isAttachment()) {
      continue;
    }
    if (att.attachmentLinkMode !== Zotero.Attachments.LINK_MODE_LINKED_FILE) {
      continue;
    }
    if (typeof att.attachmentPath === "string" && att.attachmentPath) {
      const name = normalizePathForCompare(
        getFileBaseName(att.attachmentPath),
        caseInsensitive,
      );
      if (name === expectedName) {
        return true;
      }
    }
    try {
      const resolvedPath = await att.getFilePathAsync();
      if (typeof resolvedPath === "string" && resolvedPath) {
        const name = normalizePathForCompare(
          getFileBaseName(resolvedPath),
          caseInsensitive,
        );
        if (name === expectedName) {
          return true;
        }
      }
    } catch {
      // Ignore attachment resolution error
    }
  }
  return false;
}

async function isRegularFile(
  filePath: string,
  ioUtils: RuntimeIOUtils,
): Promise<boolean> {
  try {
    const stat = await ioUtils.stat(filePath);
    return stat?.type === "regular";
  } catch {
    return false;
  }
}

async function probeMinerUExecutable(
  configuredPath: string,
  ioUtils: RuntimeIOUtils,
  pathUtils: RuntimePathUtils,
  subprocess: MinerUSubprocess,
  homeDir: string,
): Promise<string | null> {
  const trimmedConfigured = configuredPath.trim();
  if (trimmedConfigured) {
    return (await isRegularFile(trimmedConfigured, ioUtils))
      ? trimmedConfigured
      : null;
  }

  const isWin = Boolean(Zotero.isWin);
  const binName = isWin ? "mineru-kit.exe" : "mineru-kit";
  const candidates: string[] = [];

  if (homeDir) {
    candidates.push(pathUtils.join(homeDir, ".local", "bin", binName));
  }
  if (!isWin) {
    candidates.push(`/opt/homebrew/bin/${binName}`);
    candidates.push(`/usr/local/bin/${binName}`);
  }
  if (homeDir) {
    candidates.push(pathUtils.join(homeDir, ".cargo", "bin", binName));
  }

  for (const candidate of candidates) {
    if (await isRegularFile(candidate, ioUtils)) {
      return candidate;
    }
  }

  try {
    const found = await subprocess.pathSearch(binName);
    if (typeof found === "string" && found.trim()) {
      return found.trim();
    }
  } catch {
    // Ignore pathSearch failure
  }

  return null;
}

function buildAugmentedEnvironment(
  subprocess: MinerUSubprocess,
  pathUtils: RuntimePathUtils,
  homeDir: string,
): { environment: Record<string, string>; environmentAppend: boolean } {
  const isWin = Boolean(Zotero.isWin);
  const sep = isWin ? ";" : ":";
  let baseEnv: Record<string, string> | undefined;
  try {
    baseEnv = subprocess.getEnvironment?.();
  } catch {
    baseEnv = undefined;
  }

  const pathKey =
    baseEnv && "Path" in baseEnv && !("PATH" in baseEnv) ? "Path" : "PATH";
  const existingPath = baseEnv?.[pathKey] ?? "";
  const extraDirs: string[] = [];
  if (homeDir) {
    extraDirs.push(pathUtils.join(homeDir, ".local", "bin"));
    extraDirs.push(pathUtils.join(homeDir, ".cargo", "bin"));
  }
  if (!isWin) {
    extraDirs.push("/opt/homebrew/bin", "/usr/local/bin");
  }

  const existingParts = existingPath
    ? existingPath.split(sep).filter(Boolean)
    : [];
  const merged = [...existingParts];
  for (const dir of extraDirs) {
    if (!merged.includes(dir)) {
      merged.push(dir);
    }
  }
  const pathValue = merged.join(sep);

  if (baseEnv) {
    return {
      environment: { ...baseEnv, [pathKey]: pathValue },
      environmentAppend: false,
    };
  }
  return {
    environment: { [pathKey]: pathValue },
    environmentAppend: true,
  };
}

function appendTail(buffer: { value: string }, chunk: string): void {
  if (!chunk) {
    return;
  }
  const combined = buffer.value + chunk;
  buffer.value =
    combined.length > LOG_TAIL_MAX_CHARS
      ? combined.slice(combined.length - LOG_TAIL_MAX_CHARS)
      : combined;
}

function drainPipe(
  pipe: MinerUPipe | undefined | null,
  buffer: { value: string },
): Promise<void> {
  if (!pipe) {
    return Promise.resolve();
  }
  return (async () => {
    try {
      while (true) {
        const chunk = await pipe.readString();
        if (!chunk) {
          break;
        }
        appendTail(buffer, chunk);
      }
    } catch {
      // Pipe closed or errored on shutdown
    }
  })();
}

function extractParentDirPath(
  filePath: string,
  pathUtils: RuntimePathUtils,
): string {
  if (typeof pathUtils.parent === "function") {
    return pathUtils.parent(filePath);
  }
  const idx = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  return idx > 0 ? filePath.slice(0, idx) : filePath;
}

async function defaultExtractZip(options: {
  zipBytes: Uint8Array;
  stageDir: string;
  citeKey: string;
  ioUtils: RuntimeIOUtils;
  pathUtils: RuntimePathUtils;
  createZipReader: () => MinerUZigReader;
  pathToFile: (filePath: string) => unknown;
}): Promise<{ markdownFilePath: string; imagesDirPath?: string }> {
  const {
    zipBytes,
    stageDir,
    citeKey,
    ioUtils,
    pathUtils,
    createZipReader,
    pathToFile,
  } = options;

  const zipPath = pathUtils.join(stageDir, "result.zip");
  const outputDir = pathUtils.join(stageDir, "output");
  await ioUtils.makeDirectory(outputDir, {
    createAncestors: true,
    ignoreExisting: true,
  });
  await ioUtils.write(zipPath, zipBytes);

  const zipReader = createZipReader();
  let markdownExtracted = false;
  let imagesExtracted = false;
  const markdownFilePath = pathUtils.join(outputDir, `${citeKey}.md`);
  const imagesDirPath = pathUtils.join(outputDir, "images");

  try {
    zipReader.open(pathToFile(zipPath));
    const entries = zipReader.findEntries(null);
    while (entries.hasMore()) {
      const rawName = entries.getNext();
      const entry = zipReader.getEntry(rawName);
      if (entry?.isDirectory || rawName.endsWith("/")) {
        const dirParts = rawName.split("/");
        if (
          dirParts.includes("..") ||
          rawName.includes("\\") ||
          rawName.startsWith("/") ||
          /^[A-Za-z]:/.test(rawName)
        ) {
          throw new Error(`Unsafe ZIP directory entry: ${rawName}`);
        }
        continue;
      }

      const normalized = normalizeZipEntryPath(rawName);
      if (normalized === null) {
        throw new Error(`Unsafe ZIP entry path: ${rawName}`);
      }
      if (!isAllowedZipExtractPath(normalized)) {
        continue;
      }

      const destPath =
        normalized === "markdown.md"
          ? markdownFilePath
          : pathUtils.join(outputDir, ...normalized.split("/"));
      const parentDir = extractParentDirPath(destPath, pathUtils);
      await ioUtils.makeDirectory(parentDir, {
        createAncestors: true,
        ignoreExisting: true,
      });

      zipReader.extract(rawName, pathToFile(destPath));
      if (normalized === "markdown.md") {
        markdownExtracted = true;
      } else {
        imagesExtracted = true;
      }
    }
  } finally {
    try {
      zipReader.close();
    } catch {
      // Ignore close error
    }
  }

  if (!markdownExtracted) {
    throw new Error("MinerU result archive does not contain markdown.md");
  }

  return {
    markdownFilePath,
    imagesDirPath: imagesExtracted ? imagesDirPath : undefined,
  };
}

async function swapExtractedIntoTargetDir(options: {
  baseDir: string;
  citeKey: string;
  stageDir: string;
  markdownFilePath: string;
  imagesDirPath?: string;
  overwrite: boolean;
  ioUtils: RuntimeIOUtils;
  pathUtils: RuntimePathUtils;
}): Promise<string> {
  const {
    baseDir,
    citeKey,
    stageDir,
    markdownFilePath,
    imagesDirPath,
    overwrite,
    ioUtils,
    pathUtils,
  } = options;

  const targetDir = pathUtils.join(baseDir, citeKey);
  const targetMdPath = pathUtils.join(targetDir, `${citeKey}.md`);
  const targetImagesDir = pathUtils.join(targetDir, "images");
  const backupImagesDir = pathUtils.join(stageDir, "backup-images");

  await ioUtils.makeDirectory(targetDir, {
    createAncestors: true,
    ignoreExisting: true,
  });

  let existingImagesBackedUp = false;
  let newImagesMoved = false;
  try {
    const imagesStat = await ioUtils.stat(targetImagesDir).catch(() => null);
    if (imagesStat?.type === "directory" && (imagesDirPath || overwrite)) {
      await ioUtils.move(targetImagesDir, backupImagesDir);
      existingImagesBackedUp = true;
    }

    if (imagesDirPath) {
      await ioUtils.move(imagesDirPath, targetImagesDir);
      newImagesMoved = true;
    }

    await ioUtils.move(markdownFilePath, targetMdPath);
  } catch (err) {
    if (newImagesMoved) {
      await ioUtils
        .remove(targetImagesDir, { recursive: true, ignoreAbsent: true })
        .catch(() => undefined);
    }
    if (existingImagesBackedUp) {
      await ioUtils
        .move(backupImagesDir, targetImagesDir)
        .catch(() => undefined);
    }
    throw err;
  }

  return targetMdPath;
}

export async function parseSelectedItemsWithMinerU(
  items: Zotero.Item[],
  onProgress?: (progress: MinerUParseProgress) => void,
  options?: {
    settings?: Partial<MinerUSettings>;
    deps?: Partial<MinerURuntimeDeps>;
  },
): Promise<MinerUParseResult> {
  if (parsing) {
    return createEmptyResult("already-running", 0);
  }
  if (!Array.isArray(items) || items.length === 0) {
    return createEmptyResult("no-selection", 0);
  }

  parsing = true;
  let abortController: AbortController | null = null;
  let serverStarted = false;
  let serverUploadDir: string | null = null;
  let cleanupIoUtils: RuntimeIOUtils | null = null;

  try {
    const { fetchFn: realmFetch, AbortControllerCtor } =
      getDefaultFetchAndAbort();
    abortController = new AbortControllerCtor();
    activeAbortController = abortController;
    const signal = abortController.signal;

    const ioUtils = getIOUtils();
    cleanupIoUtils = ioUtils;
    const pathUtils = getPathUtils();
    const providedSettings = options?.settings;
    const hasAllSettings = Boolean(
      providedSettings &&
      providedSettings.tier !== undefined &&
      providedSettings.overwrite !== undefined &&
      providedSettings.executablePath !== undefined &&
      providedSettings.timeoutSeconds !== undefined,
    );
    const baseSettings = hasAllSettings
      ? (providedSettings as MinerUSettings)
      : getMinerUSettings();
    const rawSettings: MinerUSettings = {
      ...baseSettings,
      ...providedSettings,
    };
    const settings: MinerUSettings = {
      tier: rawSettings.tier,
      overwrite: Boolean(rawSettings.overwrite),
      executablePath:
        typeof rawSettings.executablePath === "string"
          ? rawSettings.executablePath.trim()
          : "",
      timeoutSeconds:
        typeof rawSettings.timeoutSeconds === "number" &&
        Number.isFinite(rawSettings.timeoutSeconds)
          ? Math.min(3600, Math.max(30, Math.round(rawSettings.timeoutSeconds)))
          : 300,
    };

    const fetchFn = options?.deps?.fetch ?? realmFetch;
    if (typeof fetchFn !== "function") {
      throw new Error("fetch is not available");
    }
    const sleepFn = options?.deps?.sleep ?? defaultSleep;
    const nowFn = options?.deps?.now ?? (() => Date.now());
    const startupTimeoutMs =
      options?.deps?.serverStartupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
    const healthPollIntervalMs =
      options?.deps?.healthPollIntervalMs ?? DEFAULT_HEALTH_POLL_INTERVAL_MS;
    const cancelRequestTimeoutMs =
      options?.deps?.cancelRequestTimeoutMs ??
      DEFAULT_CANCEL_REQUEST_TIMEOUT_MS;
    const homeDir = options?.deps?.getHomeDir?.() ?? getDefaultHomeDir();

    const totalSelected = items.length;
    let parsed = 0;
    let linkedExisting = 0;
    let skippedExisting = 0;
    let skippedInvalid = 0;
    let failed = 0;
    const errors: string[] = [];
    const baseDirCheck = await getBaseAttachmentDir();
    if (!baseDirCheck.ok) {
      return createEmptyResult(baseDirCheck.status, totalSelected, {
        baseDir: baseDirCheck.baseDir,
      });
    }
    const { baseDir } = baseDirCheck;
    const caseInsensitive = isCaseInsensitiveOS();

    reportProgress(onProgress, {
      phase: "resolving",
      current: 0,
      total: totalSelected,
    });

    const userLibraryID = Zotero.Libraries.userLibraryID;
    const targetsByParentId = new Map<number, ResolvedTarget>();

    for (let i = 0; i < items.length; i++) {
      if (signal.aborted) {
        return createEmptyResult("canceled", totalSelected, {
          baseDir,
          skippedInvalid,
        });
      }

      const item = items[i];
      reportProgress(onProgress, {
        phase: "resolving",
        current: i + 1,
        total: totalSelected,
      });

      if (!item || item.deleted || item.libraryID !== userLibraryID) {
        skippedInvalid++;
        continue;
      }

      if (item.isAttachment()) {
        if (!isPdfAttachment(item)) {
          skippedInvalid++;
          continue;
        }
        const pdfPath = await getExistingAttachmentFilePath(item, ioUtils);
        if (!pdfPath) {
          skippedInvalid++;
          continue;
        }
        const parentItem = await resolveParentItemForAttachment(item);
        if (
          !parentItem ||
          parentItem.deleted ||
          !parentItem.isRegularItem() ||
          parentItem.libraryID !== userLibraryID
        ) {
          skippedInvalid++;
          continue;
        }
        const citeKey = getItemCitationKey(parentItem);
        if (!citeKey || !isSafeCiteKeyForPath(citeKey)) {
          skippedInvalid++;
          continue;
        }

        const existing = targetsByParentId.get(parentItem.id);
        if (!existing || !existing.explicitPdf) {
          targetsByParentId.set(parentItem.id, {
            parentItem,
            pdfAttachment: item,
            pdfPath,
            citeKey,
            explicitPdf: true,
          });
        }
        continue;
      }

      if (!item.isRegularItem()) {
        skippedInvalid++;
        continue;
      }

      const citeKey = getItemCitationKey(item);
      if (!citeKey || !isSafeCiteKeyForPath(citeKey)) {
        skippedInvalid++;
        continue;
      }

      const existing = targetsByParentId.get(item.id);
      if (existing) {
        continue;
      }

      const pdfInfo = await findParentPdfAttachment(item, ioUtils);
      if (!pdfInfo) {
        skippedInvalid++;
        continue;
      }

      targetsByParentId.set(item.id, {
        parentItem: item,
        pdfAttachment: pdfInfo.pdfAttachment,
        pdfPath: pdfInfo.pdfPath,
        citeKey,
        explicitPdf: false,
      });
    }

    const targets = Array.from(targetsByParentId.values());
    const toParse: ResolvedTarget[] = [];

    for (const target of targets) {
      if (signal.aborted) {
        return createEmptyResult("canceled", totalSelected, {
          baseDir,
          linkedExisting,
          skippedExisting,
          skippedInvalid,
          failed,
          errors,
        });
      }

      const targetDir = pathUtils.join(baseDir, target.citeKey);
      const targetMdPath = pathUtils.join(targetDir, `${target.citeKey}.md`);

      if (!settings.overwrite) {
        const already = await hasLinkedMarkdownAttachment(
          target.parentItem,
          targetMdPath,
          target.citeKey,
          caseInsensitive,
        );
        if (already) {
          skippedExisting++;
          continue;
        }

        if (await isRegularFile(targetMdPath, ioUtils)) {
          try {
            await Zotero.Attachments.linkFromFile({
              file: targetMdPath,
              parentItemID: target.parentItem.id,
              title: `${target.citeKey}.md`,
              contentType: "text/markdown",
            });
            linkedExisting++;
          } catch (err) {
            failed++;
            const message = err instanceof Error ? err.message : String(err);
            errors.push(
              `${target.citeKey} (item ${target.parentItem.id}): ${message}`,
            );
            logError(err);
          }
          continue;
        }
      }

      toParse.push(target);
    }

    if (toParse.length === 0) {
      return createEmptyResult("completed", totalSelected, {
        baseDir,
        parsed,
        linkedExisting,
        skippedExisting,
        skippedInvalid,
        failed,
        errors,
      });
    }

    const subprocess = options?.deps?.getSubprocess
      ? await options.deps.getSubprocess()
      : await getDefaultSubprocess();

    const executablePath = await probeMinerUExecutable(
      settings.executablePath,
      ioUtils,
      pathUtils,
      subprocess,
      homeDir,
    );
    if (!executablePath) {
      return createEmptyResult("mineru-not-found", totalSelected, {
        baseDir,
        linkedExisting,
        skippedExisting,
        skippedInvalid,
        failed,
        errors,
      });
    }

    reportProgress(onProgress, { phase: "starting-server" });
    const port = options?.deps?.findFreePort
      ? await options.deps.findFreePort()
      : getDefaultFreePort();
    const tempParent = getDefaultTempDir(pathUtils, baseDir);
    serverUploadDir = pathUtils.join(
      tempParent,
      `.mineru-upload-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    );
    await ioUtils.makeDirectory(serverUploadDir, {
      createAncestors: true,
      ignoreExisting: true,
    });
    const serverArgs = buildServerArgs({
      port,
      tier: settings.tier,
      timeoutSeconds: settings.timeoutSeconds,
      uploadDir: serverUploadDir,
    });
    const envConfig = buildAugmentedEnvironment(subprocess, pathUtils, homeDir);

    let proc: MinerUSubprocessProcess;
    try {
      proc = await subprocess.call({
        command: executablePath,
        arguments: serverArgs,
        workdir: serverUploadDir,
        environment: envConfig.environment,
        environmentAppend: envConfig.environmentAppend,
        stdout: "pipe",
        stderr: "pipe",
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return createEmptyResult("server-start-failed", totalSelected, {
        baseDir,
        error: message,
        linkedExisting,
        skippedExisting,
        skippedInvalid,
        failed,
        errors,
      });
    }

    serverStarted = true;
    activeServerProcess = proc;

    const stdoutTail = { value: "" };
    const stderrTail = { value: "" };
    const stdoutDrain = drainPipe(proc.stdout, stdoutTail);
    const stderrDrain = drainPipe(proc.stderr, stderrTail);

    let serverExited = false;
    let serverExitCode: number | null = null;
    const waitPromise = proc
      .wait()
      .then((res) => {
        serverExited = true;
        serverExitCode =
          typeof res?.exitCode === "number" ? res.exitCode : null;
        return res ?? { exitCode: -1 };
      })
      .catch(() => {
        serverExited = true;
        return null;
      });
    activeServerWaitPromise = waitPromise;

    const baseUrl = `http://127.0.0.1:${port}`;
    const startupDeadline = nowFn() + startupTimeoutMs;
    let serverReady = false;
    let startupError: string | null = null;

    while (!signal.aborted && !serverExited) {
      try {
        const healthResp = await raceWithAbort(
          Promise.race([
            fetchFn(`${baseUrl}/v1/health`, { method: "GET", signal }),
            waitPromise.then(() => {
              throw new Error("Server exited before becoming ready");
            }),
          ]),
          signal,
        );

        if (healthResp.status === 200) {
          serverReady = true;
          break;
        }
        if (healthResp.status === 503) {
          let healthBody: any = null;
          try {
            healthBody = await healthResp.json();
          } catch {
            // Non-JSON 503 body; treat as transient unless error.code is present
          }
          const errCode = healthBody?.error?.code;
          if (typeof errCode === "string" && errCode.trim()) {
            const errMsg =
              typeof healthBody?.error?.message === "string" &&
              healthBody.error.message.trim()
                ? healthBody.error.message.trim()
                : errCode.trim();
            startupError = `${errCode.trim()}: ${errMsg}`;
            break;
          }
        }
      } catch (err) {
        if (err instanceof ParseAbortError || signal.aborted) {
          break;
        }
        // Connection refused / transient failure during server startup
      }

      if (serverExited || signal.aborted) {
        break;
      }
      if (nowFn() >= startupDeadline) {
        startupError = `Timed out waiting for mineru-kit health check (${startupTimeoutMs}ms)`;
        break;
      }

      try {
        await Promise.race([
          sleepFn(healthPollIntervalMs, signal),
          waitPromise.then(() => undefined),
        ]);
      } catch (err) {
        if (err instanceof ParseAbortError || signal.aborted) {
          break;
        }
      }
    }

    if (signal.aborted) {
      return createEmptyResult("canceled", totalSelected, {
        baseDir,
        linkedExisting,
        skippedExisting,
        skippedInvalid,
        failed,
        errors,
      });
    }

    if (!serverReady) {
      if (serverExited) {
        await Promise.race([
          Promise.allSettled([stdoutDrain, stderrDrain]),
          defaultSleep(100),
        ]);
      }
      const tail = stderrTail.value.trim() || stdoutTail.value.trim();
      const exitDesc =
        serverExitCode !== null
          ? `mineru-kit exited with code ${serverExitCode}`
          : "mineru-kit failed to start";
      const finalError =
        startupError || (tail ? `${exitDesc}: ${tail}` : exitDesc);
      return createEmptyResult("server-start-failed", totalSelected, {
        baseDir,
        error: finalError,
        linkedExisting,
        skippedExisting,
        skippedInvalid,
        failed,
        errors,
      });
    }

    const createZipReader =
      options?.deps?.createZipReader ?? defaultCreateZipReader;
    const pathToFile = options?.deps?.pathToFile ?? defaultPathToFile;

    let canceled = false;

    for (let i = 0; i < toParse.length; i++) {
      if (signal.aborted) {
        canceled = true;
        break;
      }

      const target = toParse[i];
      if (serverExited) {
        const crashErr = new Error(
          `mineru-kit exited unexpectedly (code ${serverExitCode ?? "unknown"}) before parsing ${target.citeKey}`,
        );
        failed++;
        errors.push(
          `${target.citeKey} (item ${target.parentItem.id}): ${crashErr.message}`,
        );
        logError(crashErr);
        continue;
      }
      const current = i + 1;
      const total = toParse.length;
      const stageDir = pathUtils.join(
        baseDir,
        `.mineru-tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      );

      let activeTaskId: string | null = null;
      let cancelPromise: Promise<void> | null = null;
      const sendTaskCancel = () => {
        if (!activeTaskId) {
          return Promise.resolve();
        }
        if (!cancelPromise) {
          const taskIdToCancel = activeTaskId;
          cancelPromise = (async () => {
            const cancelController = new AbortControllerCtor();
            const cancelTimer = setTimeout(
              () => cancelController.abort(),
              cancelRequestTimeoutMs,
            );
            try {
              await fetchFn(
                `${baseUrl}/v1/tasks/${encodeURIComponent(taskIdToCancel)}/cancel`,
                {
                  method: "POST",
                  signal: cancelController.signal,
                },
              );
            } catch {
              // Best-effort cancel only
            } finally {
              clearTimeout(cancelTimer);
            }
          })();
        }
        return cancelPromise;
      };

      const raceWithServerExit = <T>(promise: Promise<T>): Promise<T> =>
        Promise.race([
          promise,
          waitPromise.then(() => {
            throw new Error(
              `mineru-kit exited unexpectedly while parsing ${target.citeKey}`,
            );
          }),
        ]);

      try {
        reportProgress(onProgress, {
          phase: "parsing",
          current,
          total,
          citeKey: target.citeKey,
        });

        const pdfBytes = await raceWithAbort(
          ioUtils.read(target.pdfPath),
          signal,
        );
        if (!pdfBytes || pdfBytes.byteLength === 0) {
          throw new Error(`PDF file is empty: ${target.pdfPath}`);
        }

        const createResp = await raceWithAbort(
          raceWithServerExit(
            fetchFn(`${baseUrl}/v1/tasks`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                tier: settings.tier,
                output_formats: ["default"],
                files: [
                  {
                    file_name: sanitizeUploadFileName(target.citeKey),
                    bytes: pdfBytes.byteLength,
                  },
                ],
              }),
              signal,
            }),
          ),
          signal,
        );
        if (!createResp.ok) {
          throw new Error(
            `Failed to create MinerU task (HTTP ${createResp.status})`,
          );
        }

        const createData = await createResp.json();
        const taskId = createData?.task_id ?? createData?.id;
        const firstFile = createData?.files?.[0];
        const uploadSpec = firstFile?.upload ?? createData?.upload;
        const uploadUrl =
          uploadSpec?.url ??
          firstFile?.upload_url ??
          firstFile?.url ??
          createData?.upload_url;
        const uploadHeaders: Record<string, string> =
          uploadSpec?.headers ??
          firstFile?.upload_headers ??
          firstFile?.headers ??
          createData?.upload_headers ??
          createData?.headers ??
          {};

        if (typeof taskId !== "string" || !taskId) {
          throw new Error("MinerU task response missing task_id");
        }
        if (typeof uploadUrl !== "string" || !uploadUrl) {
          throw new Error("MinerU task response missing upload URL");
        }

        activeTaskId = taskId;
        activeTaskCancelFn = sendTaskCancel;

        const putResp = await raceWithAbort(
          raceWithServerExit(
            fetchFn(uploadUrl, {
              method: "PUT",
              headers: uploadHeaders,
              body: pdfBytes,
              signal,
            }),
          ),
          signal,
        );
        if (!putResp.ok) {
          throw new Error(`Failed to upload PDF (HTTP ${putResp.status})`);
        }

        const taskDeadline = nowFn() + settings.timeoutSeconds * 1000;
        let pollDelayMs = MIN_TASK_POLL_INTERVAL_MS;
        let resultUrl: string | null = null;

        while (true) {
          if (signal.aborted) {
            throw new ParseAbortError();
          }
          if (serverExited) {
            throw new Error(
              `mineru-kit exited unexpectedly while parsing ${target.citeKey}`,
            );
          }

          const taskResp = await raceWithAbort(
            raceWithServerExit(
              fetchFn(`${baseUrl}/v1/tasks/${encodeURIComponent(taskId)}`, {
                method: "GET",
                signal,
              }),
            ),
            signal,
          );
          if (!taskResp.ok) {
            throw new Error(
              `Failed to poll MinerU task ${taskId} (HTTP ${taskResp.status})`,
            );
          }

          const taskData = await taskResp.json();
          const taskFile = taskData?.files?.[0];
          const taskStatus = String(
            taskData?.status ?? taskData?.state ?? "",
          ).toLowerCase();

          if (
            taskStatus === "completed" ||
            taskStatus === "succeeded" ||
            taskStatus === "done"
          ) {
            const url =
              taskFile?.result_url ??
              taskData?.result_url ??
              taskData?.result?.url;
            if (typeof url !== "string" || !url) {
              throw new Error(
                `MinerU task ${taskId} completed without result_url`,
              );
            }
            resultUrl = url;
            break;
          }

          if (taskStatus === "failed") {
            const fileErr = taskFile?.error;
            const topErr = taskData?.error;
            const errMsg =
              fileErr?.message ??
              fileErr?.code ??
              (typeof fileErr === "string" ? fileErr : undefined) ??
              topErr?.message ??
              topErr?.code ??
              (typeof topErr === "string" ? topErr : undefined) ??
              taskData?.message ??
              "MinerU parsing failed";
            throw new Error(String(errMsg));
          }

          if (taskStatus === "canceled" || taskStatus === "cancelled") {
            if (signal.aborted) {
              throw new ParseAbortError();
            }
            throw new Error(`MinerU task ${taskId} was canceled`);
          }

          if (nowFn() >= taskDeadline) {
            throw new Error(
              `MinerU task ${taskId} timed out after ${settings.timeoutSeconds}s`,
            );
          }

          await raceWithAbort(
            raceWithServerExit(sleepFn(pollDelayMs, signal)),
            signal,
          );
          pollDelayMs = Math.min(
            MAX_TASK_POLL_INTERVAL_MS,
            Math.round(pollDelayMs * 1.5),
          );
        }

        activeTaskId = null;
        activeTaskCancelFn = null;

        const downloadResp = await raceWithAbort(
          raceWithServerExit(fetchFn(resultUrl, { method: "GET", signal })),
          signal,
        );
        if (!downloadResp.ok) {
          throw new Error(
            `Failed to download MinerU result (HTTP ${downloadResp.status})`,
          );
        }
        const zipBuf = await raceWithAbort(downloadResp.arrayBuffer(), signal);
        const zipBytes = new Uint8Array(zipBuf);

        reportProgress(onProgress, {
          phase: "extracting",
          current,
          total,
          citeKey: target.citeKey,
        });

        await ioUtils.makeDirectory(stageDir, {
          createAncestors: true,
          ignoreExisting: true,
        });

        const extracted = options?.deps?.extractZip
          ? await options.deps.extractZip({
              zipBytes,
              stageDir,
              citeKey: target.citeKey,
            })
          : await defaultExtractZip({
              zipBytes,
              stageDir,
              citeKey: target.citeKey,
              ioUtils,
              pathUtils,
              createZipReader,
              pathToFile,
            });

        const targetMdPath = await swapExtractedIntoTargetDir({
          baseDir,
          citeKey: target.citeKey,
          stageDir,
          markdownFilePath: extracted.markdownFilePath,
          imagesDirPath: extracted.imagesDirPath,
          overwrite: settings.overwrite,
          ioUtils,
          pathUtils,
        });

        reportProgress(onProgress, {
          phase: "linking",
          current,
          total,
          citeKey: target.citeKey,
        });

        const already = await isAlreadyLinked(
          target.parentItem,
          targetMdPath,
          caseInsensitive,
        );
        if (!already) {
          await Zotero.Attachments.linkFromFile({
            file: targetMdPath,
            parentItemID: target.parentItem.id,
            title: `${target.citeKey}.md`,
            contentType: "text/markdown",
          });
        }
        parsed++;
      } catch (err) {
        if (err instanceof ParseAbortError || signal.aborted) {
          await sendTaskCancel();
          canceled = true;
          break;
        }
        failed++;
        const message = err instanceof Error ? err.message : String(err);
        errors.push(
          `${target.citeKey} (item ${target.parentItem.id}): ${message}`,
        );
        logError(err);
      } finally {
        activeTaskCancelFn = null;
        await ioUtils
          .remove(stageDir, { recursive: true, ignoreAbsent: true })
          .catch(() => undefined);
      }
    }

    return createEmptyResult(
      canceled ? "canceled" : "completed",
      totalSelected,
      {
        baseDir,
        parsed,
        linkedExisting,
        skippedExisting,
        skippedInvalid,
        failed,
        errors,
      },
    );
  } finally {
    activeTaskCancelFn = null;
    if (serverStarted || activeServerProcess) {
      reportProgress(onProgress, { phase: "stopping-server" });
      await stopActiveMinerUServer();
    }
    if (serverUploadDir && cleanupIoUtils) {
      await cleanupIoUtils
        .remove(serverUploadDir, { recursive: true, ignoreAbsent: true })
        .catch(() => undefined);
    }
    if (activeAbortController === abortController) {
      activeAbortController = null;
    }
    parsing = false;
  }
}
