export const PET_RECENT_LS_KEY = "pet-recent";
export const RECENT_PETS_MAX = 5;

/** 与 Rust `LoadPetPayload` / `load-pet` 事件字段一致。 */
export type LoadPetPayload = {
  kind: "disk" | "bundled";
  petJsonPath?: string;
  bundledId?: string;
  displayName: string;
  id: string;
};

export type RecentPetEntry = LoadPetPayload & {
  lastUsedAt: number;
};

export const BUNDLED_PETS: readonly { id: string; displayName: string }[] = [
  { id: "dropout-bear", displayName: "Dropout Bear" },
  { id: "boba", displayName: "Boba" },
] as const;

function parseRecentList(raw: string | null): RecentPetEntry[] {
  if (raw == null || raw === "") return [];
  try {
    const data = JSON.parse(raw) as unknown;
    if (!Array.isArray(data)) return [];
    const out: RecentPetEntry[] = [];
    for (const item of data) {
      if (item === null || typeof item !== "object") continue;
      const o = item as Record<string, unknown>;
      const kind = o.kind;
      if (kind !== "disk" && kind !== "bundled") continue;
      const id = typeof o.id === "string" ? o.id : "";
      const displayName = typeof o.displayName === "string" ? o.displayName : "";
      if (!id || !displayName) continue;
      const lastUsedAt = typeof o.lastUsedAt === "number" ? o.lastUsedAt : 0;
      if (kind === "disk") {
        const petJsonPath = typeof o.petJsonPath === "string" ? o.petJsonPath : "";
        if (!petJsonPath) continue;
        out.push({ kind: "disk", petJsonPath, id, displayName, lastUsedAt });
      } else {
        const bundledId = typeof o.bundledId === "string" ? o.bundledId : "";
        if (!bundledId) continue;
        out.push({ kind: "bundled", bundledId, id, displayName, lastUsedAt });
      }
    }
    return out;
  } catch {
    return [];
  }
}

export function readRecentPets(): RecentPetEntry[] {
  if (typeof localStorage === "undefined") return [];
  return parseRecentList(localStorage.getItem(PET_RECENT_LS_KEY));
}

export function writeRecentPets(entries: RecentPetEntry[]): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(PET_RECENT_LS_KEY, JSON.stringify(entries.slice(0, RECENT_PETS_MAX)));
  } catch {
    /* ignore */
  }
}

function sameEntry(a: RecentPetEntry, b: LoadPetPayload): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "disk") return a.petJsonPath === b.petJsonPath;
  return a.bundledId === b.bundledId;
}

/** 成功加载后写入最近列表（去重、置顶、截断）。 */
export function pushRecentPet(entry: LoadPetPayload): void {
  const now = Date.now();
  const next: RecentPetEntry = { ...entry, lastUsedAt: now };
  const rest = readRecentPets().filter((e) => !sameEntry(e, entry));
  writeRecentPets([next, ...rest]);
}

export function removeRecentPet(entry: LoadPetPayload): void {
  writeRecentPets(readRecentPets().filter((e) => !sameEntry(e, entry)));
}

/** 发给 Rust 同步「最近使用」菜单（仅前 RECENT_PETS_MAX 条）。 */
export function recentPetsForMenuSync(): LoadPetPayload[] {
  return readRecentPets().map(({ kind, petJsonPath, bundledId, displayName, id }) => ({
    kind,
    petJsonPath,
    bundledId,
    displayName,
    id,
  }));
}

export function loadPetPayloadFromBundledId(bundledId: string): LoadPetPayload | null {
  const meta = BUNDLED_PETS.find((p) => p.id === bundledId);
  if (!meta) return null;
  return {
    kind: "bundled",
    bundledId: meta.id,
    id: meta.id,
    displayName: meta.displayName,
  };
}

export function loadPetPayloadFromDiskPath(
  petJsonPath: string,
  manifest: { id: string; displayName: string },
): LoadPetPayload {
  return {
    kind: "disk",
    petJsonPath,
    id: manifest.id,
    displayName: manifest.displayName,
  };
}
