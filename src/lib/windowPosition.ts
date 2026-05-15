import {
  availableMonitors,
  currentMonitor,
  getCurrentWindow,
  LogicalPosition,
  type Monitor,
} from "@tauri-apps/api/window";
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

/** Global physical work-area edges (workArea is relative to monitor on macOS). */
function workAreaGlobalPhysical(m: Monitor): {
  minPhysX: number;
  minPhysY: number;
  maxPhysX: number;
  maxPhysY: number;
} {
  const wa = m.workArea;
  const minPhysX = m.position.x + wa.position.x;
  const minPhysY = m.position.y + wa.position.y;
  return {
    minPhysX,
    minPhysY,
    maxPhysX: minPhysX + wa.size.width,
    maxPhysY: minPhysY + wa.size.height,
  };
}

function boundsFromMonitor(
  m: Monitor,
  winLogicalW: number,
  winLogicalH: number,
): LogicalClampBounds {
  const scale = m.scaleFactor;
  const { minPhysX, minPhysY, maxPhysX, maxPhysY } = workAreaGlobalPhysical(m);
  const physW = winLogicalW * scale;
  const physH = winLogicalH * scale;
  return {
    minX: minPhysX / scale,
    minY: minPhysY / scale,
    maxX: (maxPhysX - physW) / scale,
    maxY: (maxPhysY - physH) / scale,
  };
}

/** Logical outer size of the current window (matches setPosition / outerPosition space). */
export async function getWindowLogicalOuterSize(): Promise<{ w: number; h: number }> {
  const win = getCurrentWindow();
  const [outerSize, scale] = await Promise.all([win.outerSize(), win.scaleFactor()]);
  return {
    w: outerSize.width / scale,
    h: outerSize.height / scale,
  };
}

/**
 * Clamp bounds for the monitor the window is on (preferred), or union of all monitors.
 * Uses each monitor's scaleFactor and global work-area coordinates.
 */
export async function getLogicalClampBounds(
  winLogicalW: number,
  winLogicalH: number,
): Promise<LogicalClampBounds | null> {
  const focused = await currentMonitor();
  if (focused) {
    return boundsFromMonitor(focused, winLogicalW, winLogicalH);
  }

  const monitors = await availableMonitors();
  if (monitors.length === 0) return null;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const m of monitors) {
    const b = boundsFromMonitor(m, winLogicalW, winLogicalH);
    minX = Math.min(minX, b.minX);
    minY = Math.min(minY, b.minY);
    maxX = Math.max(maxX, b.maxX);
    maxY = Math.max(maxY, b.maxY);
  }

  return { minX, minY, maxX, maxY };
}

/** Bounds using the window's actual outer logical size. */
export async function getLogicalClampBoundsForWindow(): Promise<LogicalClampBounds | null> {
  const { w, h } = await getWindowLogicalOuterSize();
  return getLogicalClampBounds(w, h);
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
