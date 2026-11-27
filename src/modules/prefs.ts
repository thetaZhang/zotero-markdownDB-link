export const PREFS_PREFIX = "extensions.zotero.markdowndblink";

export type MinerUTier = "flash" | "basic" | "standard" | "advanced";

export interface MinerUSettings {
  tier: MinerUTier;
  overwrite: boolean;
  executablePath: string;
  timeoutSeconds: number;
}

export const MINERU_TIERS: readonly MinerUTier[] = [
  "flash",
  "basic",
  "standard",
  "advanced",
];

export const DEFAULT_MINERU_TIER: MinerUTier = "basic";
export const DEFAULT_MINERU_OVERWRITE = false;
export const DEFAULT_MINERU_TIMEOUT_SECONDS = 300;
export const MIN_MINERU_TIMEOUT_SECONDS = 30;
export const MAX_MINERU_TIMEOUT_SECONDS = 3600;

export function getPrefKey(name: string): string {
  return `${PREFS_PREFIX}.${name}`;
}

function normalizeTier(value: unknown): MinerUTier {
  if (
    typeof value === "string" &&
    (MINERU_TIERS as readonly string[]).includes(value)
  ) {
    return value as MinerUTier;
  }
  return DEFAULT_MINERU_TIER;
}

function normalizeOverwrite(value: unknown): boolean {
  return Boolean(value);
}

function normalizeExecutablePath(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeTimeoutSeconds(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_MINERU_TIMEOUT_SECONDS;
  }
  const rounded = Math.round(value);
  return Math.min(
    MAX_MINERU_TIMEOUT_SECONDS,
    Math.max(MIN_MINERU_TIMEOUT_SECONDS, rounded),
  );
}

export function getMinerUSettings(): MinerUSettings {
  return {
    tier: normalizeTier(Zotero.Prefs.get(getPrefKey("mineruTier"), true)),
    overwrite: normalizeOverwrite(
      Zotero.Prefs.get(getPrefKey("mineruOverwrite"), true),
    ),
    executablePath: normalizeExecutablePath(
      Zotero.Prefs.get(getPrefKey("mineruPath"), true),
    ),
    timeoutSeconds: normalizeTimeoutSeconds(
      Zotero.Prefs.get(getPrefKey("mineruTimeout"), true),
    ),
  };
}

export function setMinerUPref<K extends keyof MinerUSettings>(
  key: K,
  value: MinerUSettings[K],
): void {
  switch (key) {
    case "tier":
      Zotero.Prefs.set(getPrefKey("mineruTier"), normalizeTier(value), true);
      break;
    case "overwrite":
      Zotero.Prefs.set(
        getPrefKey("mineruOverwrite"),
        normalizeOverwrite(value),
        true,
      );
      break;
    case "executablePath":
      Zotero.Prefs.set(
        getPrefKey("mineruPath"),
        normalizeExecutablePath(value),
        true,
      );
      break;
    case "timeoutSeconds":
      Zotero.Prefs.set(
        getPrefKey("mineruTimeout"),
        normalizeTimeoutSeconds(value),
        true,
      );
      break;
  }
}
