export const PET_ALWAYS_ON_TOP_LS_KEY = "always-on-top";
export const PET_CLICK_THROUGH_LS_KEY = "click-through";
const DEFAULT_CLICK_THROUGH = false;

/** 与右键「透明度」子菜单一致。 */
export const PET_OPACITY_OPTIONS = [
  { key: "full", label: "不透明", percent: "100%", value: 1.0 },
  { key: "high", label: "较透明", percent: "85%", value: 0.85 },
  { key: "mid", label: "半透明", percent: "70%", value: 0.7 },
  { key: "low", label: "很透明", percent: "55%", value: 0.55 },
] as const;

export const PET_OPACITY_LS_KEY = "pet-opacity";
const DEFAULT_OPACITY = 1.0;
const DEFAULT_ALWAYS_ON_TOP = true;

export function readStoredAlwaysOnTop(): boolean {
  if (typeof localStorage === "undefined") return DEFAULT_ALWAYS_ON_TOP;
  const raw = localStorage.getItem(PET_ALWAYS_ON_TOP_LS_KEY);
  if (raw == null || raw === "") return DEFAULT_ALWAYS_ON_TOP;
  return raw === "true";
}

export function writeStoredAlwaysOnTop(enabled: boolean): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(PET_ALWAYS_ON_TOP_LS_KEY, enabled ? "true" : "false");
  } catch {
    /* ignore */
  }
}

function snapStoredOpacityToPreset(raw: string | null): number {
  if (raw == null || raw === "") return DEFAULT_OPACITY;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_OPACITY;
  let best = DEFAULT_OPACITY;
  let bestD = Infinity;
  for (const o of PET_OPACITY_OPTIONS) {
    const d = Math.abs(n - o.value);
    if (d < bestD) {
      bestD = d;
      best = o.value;
    }
  }
  return best;
}

export function readInitialPetOpacity(): number {
  if (typeof localStorage === "undefined") return DEFAULT_OPACITY;
  return snapStoredOpacityToPreset(localStorage.getItem(PET_OPACITY_LS_KEY));
}

export function opacityToMenuKey(value: number): string {
  for (const o of PET_OPACITY_OPTIONS) {
    if (Math.abs(value - o.value) < 1e-6) return o.key;
  }
  return "full";
}

export function readStoredClickThrough(): boolean {
  if (typeof localStorage === "undefined") return DEFAULT_CLICK_THROUGH;
  const raw = localStorage.getItem(PET_CLICK_THROUGH_LS_KEY);
  if (raw == null || raw === "") return DEFAULT_CLICK_THROUGH;
  return raw === "true";
}

export function writeStoredClickThrough(enabled: boolean): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(PET_CLICK_THROUGH_LS_KEY, enabled ? "true" : "false");
  } catch {
    /* ignore */
  }
}

export function writeStoredPetOpacity(value: number): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(PET_OPACITY_LS_KEY, String(value));
  } catch {
    /* ignore */
  }
}
