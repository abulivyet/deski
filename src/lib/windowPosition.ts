import { availableMonitors, getCurrentWindow, LogicalPosition } from "@tauri-apps/api/window";
import { petLog, petWarn } from "./petDebug";

export const PET_WINDOW_POS_LS_KEY = "pet-window-pos";

export type StoredWindowPosition = { x: number; y: number };

export type LogicalClampBounds = {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
};

export function readStoredWindowPosition(): StoredWindowPosition | null {
  if (typeof localStorage === "undefined") return null;
  const raw = localStorage.getItem(PET_WINDOW_POS_LS_KEY);
  if (raw == null || raw === "") return null;
  try {
    const data = JSON.parse(raw) as unknown;
    if (data === null || typeof data !== "object") return null;
    const { x, y } = data as Record<string, unknown>;
    if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y)) {
      return null;
    }
    return { x, y };
  } catch {
    return null;
  }
}

export function writeStoredWindowPosition(x: number, y: number): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(PET_WINDOW_POS_LS_KEY, JSON.stringify({ x, y }));
  } catch {
    /* ignore quota / private mode */
  }
}

/** Union of all monitor work areas in logical coordinates for the current window scale. */
export async function getLogicalClampBounds(
  winLogicalW: number,
  winLogicalH: number,
): Promise<LogicalClampBounds | null> {
  const monitors = await availableMonitors();
  if (monitors.length === 0) return null;

  const scale = await getCurrentWindow().scaleFactor();
  const physW = winLogicalW * scale;
  const physH = winLogicalH * scale;

  let minPhysX = Infinity;
  let minPhysY = Infinity;
  let maxPhysX = -Infinity;
  let maxPhysY = -Infinity;
  for (const m of monitors) {
    const wa = m.workArea;
    minPhysX = Math.min(minPhysX, wa.position.x);
    minPhysY = Math.min(minPhysY, wa.position.y);
    maxPhysX = Math.max(maxPhysX, wa.position.x + wa.size.width);
    maxPhysY = Math.max(maxPhysY, wa.position.y + wa.size.height);
  }

  return {
    minX: minPhysX / scale,
    minY: minPhysY / scale,
    maxX: (maxPhysX - physW) / scale,
    maxY: (maxPhysY - physH) / scale,
  };
}

export function clampToLogicalBounds(
  x: number,
  y: number,
  bounds: LogicalClampBounds | null,
): StoredWindowPosition {
  if (bounds == null) return { x, y };
  const minX = Math.min(bounds.minX, bounds.maxX);
  const maxX = Math.max(bounds.minX, bounds.maxX);
  const minY = Math.min(bounds.minY, bounds.maxY);
  const maxY = Math.max(bounds.minY, bounds.maxY);
  return {
    x: Math.min(Math.max(x, minX), maxX),
    y: Math.min(Math.max(y, minY), maxY),
  };
}

export async function clampLogicalWindowPosition(
  x: number,
  y: number,
  winLogicalW: number,
  winLogicalH: number,
): Promise<StoredWindowPosition> {
  const bounds = await getLogicalClampBounds(winLogicalW, winLogicalH);
  return clampToLogicalBounds(x, y, bounds);
}

export async function applyWindowPosition(
  x: number,
  y: number,
  winLogicalW: number,
  winLogicalH: number,
): Promise<StoredWindowPosition> {
  const clamped = await clampLogicalWindowPosition(x, y, winLogicalW, winLogicalH);
  await getCurrentWindow().setPosition(new LogicalPosition(clamped.x, clamped.y));
  return clamped;
}

export async function persistCurrentWindowPosition(
  winLogicalW: number,
  winLogicalH: number,
): Promise<void> {
  try {
    const win = getCurrentWindow();
    const outer = await win.outerPosition();
    const scale = await win.scaleFactor();
    const logical = outer.toLogical(scale);
    const clamped = await clampLogicalWindowPosition(logical.x, logical.y, winLogicalW, winLogicalH);
    writeStoredWindowPosition(clamped.x, clamped.y);
    petLog("window position saved", clamped);
  } catch (e) {
    petWarn("window position save failed", {
      err: e instanceof Error ? e.message : String(e),
    });
  }
}
