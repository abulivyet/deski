import { useCallback, useEffect, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow, LogicalPosition, LogicalSize } from "@tauri-apps/api/window";
import {
  PetWidget,
  codexPetAtlas,
  usePetController,
  type CodexPetAnimationName,
  type PetAction,
} from "codex-pets-react";
import {
  getPetSpritesheetUrl,
  loadPetFromPath,
  loadPetManifest,
  normalizeOpenDialogPath,
} from "./lib/loadPetManifest";
import { petError, petLog, petWarn } from "./lib/petDebug";
import {
  applyWindowPosition,
  clampToLogicalBounds,
  getLogicalClampBounds,
  persistCurrentWindowPosition,
  readStoredWindowPosition,
  type LogicalClampBounds,
} from "./lib/windowPosition";
import {
  loadPetPayloadFromBundledId,
  loadPetPayloadFromDiskPath,
  pushRecentPet,
  recentPetsForMenuSync,
  removeRecentPet,
  type LoadPetPayload,
} from "./lib/recentPets";
import {
  opacityToMenuKey,
  readInitialPetOpacity,
  readStoredAlwaysOnTop,
  readStoredClickThrough,
  writeStoredAlwaysOnTop,
  writeStoredClickThrough,
  writeStoredPetOpacity,
} from "./lib/windowSettings";
import { ANIMATIONS } from "./petAnimations";
import type { PetManifest } from "./types/pet";
import "./App.css";

const PET_JSON_PATH_LS_KEY = "petJsonPath";

const PET_SCALE_LS_KEY = "pet-scale";
const DEFAULT_SCALE = 1.0;
/** 历史显示基准；用户 100% = 1.0 在此基础上缩放。 */
const PET_DISPLAY_BASE_SCALE = 0.62;
/**
 * 精灵脚底相对 atlas 单元格可能略低；窗口/舞台高度在逻辑像素上略增，
 * 配合 PetWidget 底部 boundsPadding，减少 `overflow:hidden` 下裁脚。
 */
const PET_VIEWPORT_BOTTOM_BLEED_PX = 10;
/** pin=center 时通过不对称 padding 将精灵略向左移（逻辑 px）。 */
const PET_CENTER_NUDGE_LEFT_PX = 4;
const PET_BOUNDS_PADDING = {
  top: 8,
  right: 8 + PET_CENTER_NUDGE_LEFT_PX,
  left: Math.max(0, 8 - PET_CENTER_NUDGE_LEFT_PX),
  bottom: 18,
} as const;

/** 四档固定大小（与右键原生菜单一致）。 */
const PET_SIZE_OPTIONS = [
  { key: "small", label: "小", percent: "75%", scale: 0.75 },
  { key: "normal", label: "默认", percent: "100%", scale: 1.0 },
  { key: "large", label: "大", percent: "125%", scale: 1.25 },
  { key: "xlarge", label: "超大", percent: "150%", scale: 1.5 },
] as const;

/** 调整 Tauri 窗口逻辑尺寸的防抖（ms）。 */
const WINDOW_RESIZE_DEBOUNCE_MS = 150;

function snapStoredScaleToPreset(raw: string | null): number {
  if (raw == null || raw === "") return DEFAULT_SCALE;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_SCALE;
  let best = DEFAULT_SCALE;
  let bestD = Infinity;
  for (const o of PET_SIZE_OPTIONS) {
    const d = Math.abs(n - o.scale);
    if (d < bestD) {
      bestD = d;
      best = o.scale;
    }
  }
  return best;
}

function readInitialPetUserScale(): number {
  if (typeof localStorage === "undefined") return DEFAULT_SCALE;
  return snapStoredScaleToPreset(localStorage.getItem(PET_SCALE_LS_KEY));
}

function scaleToMenuKey(scale: number): string {
  for (const o of PET_SIZE_OPTIONS) {
    if (Math.abs(scale - o.scale) < 1e-6) return o.key;
  }
  return "normal";
}

/** Screen distance before a pointer gesture counts as a drag (not a click). */
const DRAG_THRESHOLD_PX = 6;

/** Random delay before next auto patrol (ms). */
const AUTO_WALK_MIN_MS = 8000;
const AUTO_WALK_MAX_MS = 20000;
/** Non-Tauri fallback: in-place run duration (ms). */
const AUTO_WALK_RUN_MS = 2000;
/** Tauri patrol duration (ms). */
const AUTO_PATROL_MIN_MS = 1800;
const AUTO_PATROL_MAX_MS = 3200;
/** Logical px/s along X. */
const AUTO_PATROL_SPEED_MIN = 60;
const AUTO_PATROL_SPEED_MAX = 100;
const AUTO_PATROL_EDGE_MARGIN = 24;

export default function App() {
  const [manifest, setManifest] = useState<PetManifest | null>(null);
  const [spritesheetSrc, setSpritesheetSrc] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [petUserScale, setPetUserScale] = useState(() => readInitialPetUserScale());
  const [petOpacity, setPetOpacity] = useState(() => readInitialPetOpacity());

  const petDisplayScale = PET_DISPLAY_BASE_SCALE * petUserScale;
  const petDisplayWidthPx = codexPetAtlas.cellWidth * petDisplayScale;
  const petDisplayHeightPx = codexPetAtlas.cellHeight * petDisplayScale;
  const petStageHeightPx = petDisplayHeightPx + PET_VIEWPORT_BOTTOM_BLEED_PX;

  const hoveringRef = useRef(false);
  /** One waving per hover session; reset on pointer leave. */
  const hoverTriggeredRef = useRef(false);
  const pointerDownRef = useRef(false);
  const isDraggingRef = useRef(false);
  const lastDirectionRef = useRef<CodexPetAnimationName | null>(null);
  const dragStartRef = useRef<{
    mouseX: number;
    mouseY: number;
    windowX: number;
    windowY: number;
  } | null>(null);
  const gestureGenerationRef = useRef(0);
  const sessionActiveRef = useRef(false);
  const persistEndDragRef = useRef<(() => void) | null>(null);
  const activeMoveRef = useRef<((ev: PointerEvent) => void) | null>(null);

  const autoScheduleTimerRef = useRef<number | null>(null);
  /** Non-Tauri in-place auto-walk timeout. */
  const autoWalkRunTimerRef = useRef<number | null>(null);
  const autoWalkFrameRef = useRef<number | null>(null);
  const autoWalkActiveRef = useRef(false);
  const autoWalkGenerationRef = useRef(0);
  const scheduleNextAutoWalkRef = useRef<() => void>(() => {
    /* assigned after scheduleNextAutoWalk is defined */
  });
  const petAnimRef = useRef<{ name: CodexPetAnimationName; mode: "loop" | "once" }>({
    name: ANIMATIONS.idle,
    mode: "loop",
  });

  const spritesheetDisposeRef = useRef<(() => void) | null>(null);
  const windowLogicalSizeRef = useRef({ w: 0, h: 0 });
  const windowPositionRestoredRef = useRef(false);
  const dragClampBoundsRef = useRef<LogicalClampBounds | null>(null);

  windowLogicalSizeRef.current = {
    w: Math.ceil(petDisplayWidthPx),
    h: Math.ceil(petStageHeightPx),
  };
  const releaseSpritesheet = useCallback(() => {
    spritesheetDisposeRef.current?.();
    spritesheetDisposeRef.current = null;
  }, []);

  const applyBundledPet = useCallback(
    async (bundledId: string) => {
      const m = await loadPetManifest(bundledId);
      releaseSpritesheet();
      setManifest(m);
      setSpritesheetSrc(getPetSpritesheetUrl(bundledId, m));
      setLoadError(null);
      localStorage.removeItem(PET_JSON_PATH_LS_KEY);
      const recentEntry = loadPetPayloadFromBundledId(bundledId);
      if (recentEntry) pushRecentPet(recentEntry);
      petLog("pet loaded (bundled)", { bundledId, id: m.id });
    },
    [releaseSpritesheet],
  );

  const applyDiskPet = useCallback(
    async (petJsonPath: string) => {
      const loaded = await loadPetFromPath(petJsonPath);
      releaseSpritesheet();
      spritesheetDisposeRef.current = loaded.disposeSpritesheet ?? null;
      setManifest(loaded.manifest);
      setSpritesheetSrc(loaded.spritesheetSrc);
      setLoadError(null);
      localStorage.setItem(PET_JSON_PATH_LS_KEY, petJsonPath);
      pushRecentPet(loadPetPayloadFromDiskPath(petJsonPath, loaded.manifest));
      petLog("pet loaded (disk)", {
        id: loaded.manifest.id,
        path: petJsonPath.slice(0, 200),
      });
    },
    [releaseSpritesheet],
  );

  useEffect(() => {
    let cancelled = false;
    setLoadError(null);
    setManifest(null);
    setSpritesheetSrc(null);

    const loadBundled = async (bundledId = "dropout-bear") => {
      petLog("startup: loading bundled pet", { petId: bundledId });
      const m = await loadPetManifest(bundledId);
      if (cancelled) return;
      releaseSpritesheet();
      setManifest(m);
      setSpritesheetSrc(getPetSpritesheetUrl(bundledId, m));
      setLoadError(null);
      petLog("startup: bundled ready", { id: m.id, src: getPetSpritesheetUrl(bundledId, m) });
    };

    const run = async () => {
      try {
        const saved =
          typeof localStorage !== "undefined"
            ? localStorage.getItem(PET_JSON_PATH_LS_KEY)
            : null;
        petLog("startup: localStorage petJsonPath", { saved: saved?.slice(0, 200) ?? null, isTauri: isTauri() });
        if (saved && isTauri()) {
          try {
            const loaded = await loadPetFromPath(saved);
            if (cancelled) {
              loaded.disposeSpritesheet?.();
              petLog("startup: disk load aborted (unmount)");
              return;
            }
            releaseSpritesheet();
            spritesheetDisposeRef.current = loaded.disposeSpritesheet ?? null;
            setManifest(loaded.manifest);
            setSpritesheetSrc(loaded.spritesheetSrc);
            setLoadError(null);
            pushRecentPet(loadPetPayloadFromDiskPath(saved, loaded.manifest));
            petLog("startup: disk pet ready", {
              id: loaded.manifest.id,
              spritesheetSrcPrefix: loaded.spritesheetSrc.slice(0, 48),
            });
          } catch (diskErr) {
            petWarn("startup: disk pet failed, falling back to bundled", {
              saved: saved.slice(0, 200),
              err: diskErr instanceof Error ? diskErr.message : String(diskErr),
            });
            localStorage.removeItem(PET_JSON_PATH_LS_KEY);
            await loadBundled();
          }
        } else {
          await loadBundled();
        }
      } catch (e: unknown) {
        if (!cancelled) {
          releaseSpritesheet();
          setManifest(null);
          setSpritesheetSrc(null);
          setLoadError(e instanceof Error ? e.message : String(e));
          petError("startup: fatal load error", e);
        }
      }
    };

    void run();
    return () => {
      cancelled = true;
      releaseSpritesheet();
    };
  }, [releaseSpritesheet]);

  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void listen<LoadPetPayload>("load-pet", (ev) => {
      const p = ev.payload;
      if (!p || typeof p.kind !== "string") return;
      void (async () => {
        try {
          if (p.kind === "bundled" && p.bundledId) {
            await applyBundledPet(p.bundledId);
          } else if (p.kind === "disk" && p.petJsonPath) {
            await applyDiskPet(p.petJsonPath);
          }
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          setLoadError(msg);
          removeRecentPet(p);
          petWarn("load-pet failed", { payload: p, err: msg });
        }
      })();
    }).then((fn) => {
      if (cancelled) fn();
      else {
        unlisten = fn;
        petLog("load-pet: listener registered");
      }
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [applyBundledPet, applyDiskPet]);

  const { pet, petDispatch } = usePetController<CodexPetAnimationName>({
    initialState: {
      animation: { name: ANIMATIONS.idle, mode: "loop" },
      pin: "center",
    },
    defaultAnimation: ANIMATIONS.idle,
    waitingAnimation: ANIMATIONS.waiting,
    /** 长于自动巡逻间隔，先巡逻再发呆。 */
    waitingAfterMs: 60_000,
  });

  /** New spritesheet / manifest: reset pose + animation so the swap is obvious and PetWidget remounts cleanly. */
  useEffect(() => {
    if (manifest === null || spritesheetSrc === null) return;
    petLog("pet state reset (manifest / spritesheet changed)", {
      manifestId: manifest.id,
      spritesheetSrcPrefix: spritesheetSrc.slice(0, 64),
    });
    hoverTriggeredRef.current = false;
    petDispatch({
      type: "state.reset",
      state: {
        animation: { name: ANIMATIONS.idle, mode: "loop" },
        pin: "center",
      },
    });
  }, [manifest?.id, spritesheetSrc, petDispatch]);

  petAnimRef.current = { name: pet.animation.name, mode: pet.animation.mode };

  const stopAutoPatrol = useCallback(
    (opts?: { toIdle?: boolean; reschedule?: boolean }) => {
      autoWalkGenerationRef.current += 1;
      if (autoWalkFrameRef.current != null) {
        cancelAnimationFrame(autoWalkFrameRef.current);
        autoWalkFrameRef.current = null;
      }
      autoWalkActiveRef.current = false;
      if (opts?.toIdle) {
        petDispatch({
          type: "animation.set",
          animation: ANIMATIONS.idle,
          source: "user",
        });
      }
      if (opts?.reschedule) {
        scheduleNextAutoWalkRef.current();
      }
    },
    [petDispatch],
  );

  const clearAutoWalkTimers = useCallback(() => {
    if (autoScheduleTimerRef.current != null) {
      window.clearTimeout(autoScheduleTimerRef.current);
      autoScheduleTimerRef.current = null;
    }
    if (autoWalkRunTimerRef.current != null) {
      window.clearTimeout(autoWalkRunTimerRef.current);
      autoWalkRunTimerRef.current = null;
    }
    const wasPatrol = autoWalkActiveRef.current;
    stopAutoPatrol({ toIdle: wasPatrol });
  }, [stopAutoPatrol]);

  const startAutoPatrol = useCallback(() => {
    if (hoveringRef.current || pointerDownRef.current || isDraggingRef.current) {
      scheduleNextAutoWalkRef.current();
      return;
    }
    const { name, mode } = petAnimRef.current;
    if (name !== ANIMATIONS.idle || mode !== "loop") {
      scheduleNextAutoWalkRef.current();
      return;
    }

    if (!isTauri()) {
      const run = Math.random() < 0.5 ? ANIMATIONS.runLeft : ANIMATIONS.runRight;
      petDispatch({
        type: "animation.play",
        animation: run,
        mode: "loop",
        source: "user",
      });
      if (autoWalkRunTimerRef.current != null) {
        window.clearTimeout(autoWalkRunTimerRef.current);
      }
      autoWalkRunTimerRef.current = window.setTimeout(() => {
        autoWalkRunTimerRef.current = null;
        petDispatch({
          type: "animation.set",
          animation: ANIMATIONS.idle,
          source: "user",
        });
        scheduleNextAutoWalkRef.current();
      }, AUTO_WALK_RUN_MS);
      return;
    }

    const patrolGen = ++autoWalkGenerationRef.current;
    autoWalkActiveRef.current = true;

    void (async () => {
      const win = getCurrentWindow();
      const { w, h } = windowLogicalSizeRef.current;

      let outer;
      let scaleFactor: number;
      let bounds: LogicalClampBounds | null;
      try {
        [outer, scaleFactor, bounds] = await Promise.all([
          win.outerPosition(),
          win.scaleFactor(),
          getLogicalClampBounds(w, h),
        ]);
      } catch (err) {
        petWarn("auto patrol: failed to read window state", {
          err: err instanceof Error ? err.message : String(err),
        });
        autoWalkActiveRef.current = false;
        scheduleNextAutoWalkRef.current();
        return;
      }

      if (patrolGen !== autoWalkGenerationRef.current || !autoWalkActiveRef.current) {
        autoWalkActiveRef.current = false;
        return;
      }

      if (bounds == null) {
        autoWalkActiveRef.current = false;
        const run = Math.random() < 0.5 ? ANIMATIONS.runLeft : ANIMATIONS.runRight;
        petDispatch({
          type: "animation.play",
          animation: run,
          mode: "loop",
          source: "user",
        });
        autoWalkRunTimerRef.current = window.setTimeout(() => {
          autoWalkRunTimerRef.current = null;
          if (patrolGen !== autoWalkGenerationRef.current) return;
          petDispatch({
            type: "animation.set",
            animation: ANIMATIONS.idle,
            source: "user",
          });
          scheduleNextAutoWalkRef.current();
        }, AUTO_WALK_RUN_MS);
        return;
      }

      const logicalPos = outer.toLogical(scaleFactor);
      let x = logicalPos.x;
      const y = logicalPos.y;

      const minX = Math.min(bounds.minX, bounds.maxX);
      const maxX = Math.max(bounds.minX, bounds.maxX);

      let dir: 1 | -1;
      if (x <= minX + AUTO_PATROL_EDGE_MARGIN) {
        dir = 1;
      } else if (x >= maxX - AUTO_PATROL_EDGE_MARGIN) {
        dir = -1;
      } else {
        dir = Math.random() < 0.5 ? 1 : -1;
      }

      const speed =
        AUTO_PATROL_SPEED_MIN +
        Math.random() * (AUTO_PATROL_SPEED_MAX - AUTO_PATROL_SPEED_MIN);
      const durationMs =
        AUTO_PATROL_MIN_MS + Math.random() * (AUTO_PATROL_MAX_MS - AUTO_PATROL_MIN_MS);
      const endTime = performance.now() + durationMs;
      let lastFrameTime = performance.now();
      let currentRunAnim: CodexPetAnimationName | null = null;

      const setRunDirection = (nextDir: 1 | -1) => {
        const anim = nextDir > 0 ? ANIMATIONS.runRight : ANIMATIONS.runLeft;
        if (currentRunAnim === anim) return;
        currentRunAnim = anim;
        petDispatch({
          type: "animation.play",
          animation: anim,
          mode: "loop",
          source: "user",
        });
      };

      const finishPatrol = (reschedule: boolean) => {
        if (autoWalkFrameRef.current != null) {
          cancelAnimationFrame(autoWalkFrameRef.current);
          autoWalkFrameRef.current = null;
        }
        if (!autoWalkActiveRef.current) {
          if (reschedule) scheduleNextAutoWalkRef.current();
          return;
        }
        autoWalkActiveRef.current = false;
        autoWalkGenerationRef.current += 1;
        petDispatch({
          type: "animation.set",
          animation: ANIMATIONS.idle,
          source: "user",
        });
        void persistCurrentWindowPosition(w, h);
        if (reschedule) {
          scheduleNextAutoWalkRef.current();
        }
      };

      const tick = (now: number) => {
        if (patrolGen !== autoWalkGenerationRef.current || !autoWalkActiveRef.current) {
          autoWalkFrameRef.current = null;
          return;
        }

        if (hoveringRef.current || pointerDownRef.current || isDraggingRef.current) {
          finishPatrol(true);
          return;
        }

        const dt = Math.min((now - lastFrameTime) / 1000, 0.05);
        lastFrameTime = now;

        if (now >= endTime) {
          finishPatrol(true);
          return;
        }

        x += dir * speed * dt;

        if (x <= minX) {
          x = minX;
          if (dir < 0) {
            dir = 1;
            setRunDirection(dir);
          }
        } else if (x >= maxX) {
          x = maxX;
          if (dir > 0) {
            dir = -1;
            setRunDirection(dir);
          }
        } else {
          if (x <= minX + AUTO_PATROL_EDGE_MARGIN && dir < 0) {
            dir = 1;
            setRunDirection(dir);
          } else if (x >= maxX - AUTO_PATROL_EDGE_MARGIN && dir > 0) {
            dir = -1;
            setRunDirection(dir);
          }
        }

        void win.setPosition(new LogicalPosition(x, y)).catch((err) => {
          console.error("[auto-patrol] setPosition failed", err);
        });

        autoWalkFrameRef.current = requestAnimationFrame(tick);
      };

      setRunDirection(dir);
      autoWalkFrameRef.current = requestAnimationFrame(tick);
    })();
  }, [petDispatch]);

  const scheduleNextAutoWalk = useCallback(() => {
    if (autoScheduleTimerRef.current != null) {
      window.clearTimeout(autoScheduleTimerRef.current);
      autoScheduleTimerRef.current = null;
    }
    const delay = AUTO_WALK_MIN_MS + Math.random() * (AUTO_WALK_MAX_MS - AUTO_WALK_MIN_MS);
    autoScheduleTimerRef.current = window.setTimeout(() => {
      autoScheduleTimerRef.current = null;
      startAutoPatrol();
    }, delay);
  }, [startAutoPatrol]);

  useEffect(() => {
    scheduleNextAutoWalkRef.current = scheduleNextAutoWalk;
  }, [scheduleNextAutoWalk]);

  const onPetAction = useCallback(
    (action: PetAction<CodexPetAnimationName>) => {
      petDispatch(action);
      if (action.type !== "animation.complete") return;
      const done = action.animation;
      if (done) {
        scheduleNextAutoWalk();
      }
    },
    [petDispatch, scheduleNextAutoWalk],
  );

  useEffect(() => {
    if (!isTauri()) return;
    const w = Math.ceil(petDisplayWidthPx);
    const h = Math.ceil(petStageHeightPx);
    const tid = window.setTimeout(() => {
      void (async () => {
        const win = getCurrentWindow();
        try {
          await win.setSize(new LogicalSize(w, h));
        } catch (err) {
          console.error("[pet-scale] setSize failed", err);
        }

        if (windowPositionRestoredRef.current) return;

        const stored = readStoredWindowPosition();
        if (stored == null) {
          windowPositionRestoredRef.current = true;
          return;
        }

        try {
          const applied = await applyWindowPosition(stored.x, stored.y, w, h);
          windowPositionRestoredRef.current = true;
          petLog("window position restored", applied);
        } catch (err) {
          petWarn("window position restore failed", {
            err: err instanceof Error ? err.message : String(err),
          });
          windowPositionRestoredRef.current = true;
        }
      })();
    }, WINDOW_RESIZE_DEBOUNCE_MS);
    return () => window.clearTimeout(tid);
  }, [petDisplayWidthPx, petStageHeightPx]);

  useEffect(() => {
    if (!isTauri()) return;
    const key = scaleToMenuKey(petUserScale);
    void invoke("sync_pet_size_menu_selection", { key }).catch(() => {
      /* ignore */
    });
    const opacityKey = opacityToMenuKey(petOpacity);
    void invoke("sync_pet_opacity_menu_selection", { key: opacityKey }).catch(() => {
      /* ignore */
    });
    void (async () => {
      const win = getCurrentWindow();
      const alwaysOnTop = readStoredAlwaysOnTop();
      try {
        await win.setAlwaysOnTop(alwaysOnTop);
        await invoke("sync_always_on_top_menu_selection", { enabled: alwaysOnTop });
        petLog("always-on-top restored", { enabled: alwaysOnTop });
      } catch (err) {
        petWarn("always-on-top restore failed", {
          err: err instanceof Error ? err.message : String(err),
        });
      }

      const clickThrough = readStoredClickThrough();
      try {
        await win.setIgnoreCursorEvents(clickThrough);
        await invoke("sync_click_through_menu_selection", { enabled: clickThrough });
        petLog("click-through restored", { enabled: clickThrough });
      } catch (err) {
        petWarn("click-through restore failed", {
          err: err instanceof Error ? err.message : String(err),
        });
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅挂载时与 Rust 菜单勾选对齐
  }, []);

  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    type AlwaysOnTopPayload = { enabled: boolean };
    void listen<AlwaysOnTopPayload>("window-always-on-top", (ev) => {
      const p = ev.payload;
      if (!p || typeof p.enabled !== "boolean") return;
      writeStoredAlwaysOnTop(p.enabled);
      petLog("always-on-top saved", { enabled: p.enabled });
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    type ClickThroughPayload = { enabled: boolean };
    void listen<ClickThroughPayload>("window-click-through", (ev) => {
      const p = ev.payload;
      if (!p || typeof p.enabled !== "boolean") return;
      writeStoredClickThrough(p.enabled);
      petLog("click-through saved", { enabled: p.enabled });
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    type PetSizePayload = { key: string; scale: number };
    void listen<PetSizePayload>("pet-size", (ev) => {
      const p = ev.payload;
      if (!p || typeof p.scale !== "number") return;
      setPetUserScale(p.scale);
      try {
        localStorage.setItem(PET_SCALE_LS_KEY, String(p.scale));
      } catch {
        /* ignore */
      }
    }).then((fn) => {
      if (cancelled) fn();
      else {
        unlisten = fn;
        petLog("pet-size: listener registered");
      }
    });
    return () => {
      cancelled = true;
      unlisten?.();
      petLog("pet-size: listener removed");
    };
  }, []);

  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    type PetOpacityPayload = { key: string; value: number };
    void listen<PetOpacityPayload>("pet-opacity", (ev) => {
      const p = ev.payload;
      if (!p || typeof p.value !== "number") return;
      setPetOpacity(p.value);
      writeStoredPetOpacity(p.value);
    }).then((fn) => {
      if (cancelled) fn();
      else {
        unlisten = fn;
        petLog("pet-opacity: listener registered");
      }
    });
    return () => {
      cancelled = true;
      unlisten?.();
      petLog("pet-opacity: listener removed");
    };
  }, []);

  useEffect(() => {
    const modeOnce = pet.animation.mode === "once";
    const name = pet.animation.name;
    const interruptible =
      modeOnce &&
      (name === ANIMATIONS.failed ||
        name === ANIMATIONS.review ||
        name === ANIMATIONS.running ||
        name === ANIMATIONS.waving);
    if (!interruptible) return;

    const onPointerDownCapture = (ev: PointerEvent) => {
      if (ev.button !== 0) return;
      petDispatch({
        type: "animation.set",
        animation: ANIMATIONS.idle,
        source: "user",
      });
      scheduleNextAutoWalk();
    };

    window.addEventListener("pointerdown", onPointerDownCapture, true);
    return () => window.removeEventListener("pointerdown", onPointerDownCapture, true);
  }, [pet.animation.mode, pet.animation.name, petDispatch, scheduleNextAutoWalk]);

  useEffect(() => {
    if (manifest === null) return;
    if (loadError !== null) return;
    scheduleNextAutoWalk();
    return () => {
      clearAutoWalkTimers();
    };
  }, [manifest, loadError, scheduleNextAutoWalk, clearAutoWalkTimers]);

  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void listen<string>("menu-action", (ev) => {
      clearAutoWalkTimers();
      console.log("[menu-action] received:", ev.payload);
      const rawId = typeof ev.payload === "string" ? ev.payload : "";
      /** Menu stack may prefix ids on some platforms; match the leaf segment. */
      const id = rawId.replace(/^.*[/\\]/, "") || rawId;
      petLog("menu-action", { rawId, id });
      switch (id) {
        case "waving":
          petDispatch({
            type: "animation.play",
            animation: ANIMATIONS.waving,
            mode: "once",
            then: ANIMATIONS.idle,
            source: "user",
          });
          break;
        case "running":
          petDispatch({
            type: "animation.play",
            animation: ANIMATIONS.running,
            mode: "once",
            then: ANIMATIONS.idle,
            source: "user",
          });
          break;
        case "review":
          petDispatch({
            type: "animation.play",
            animation: ANIMATIONS.review,
            mode: "once",
            then: ANIMATIONS.idle,
            source: "user",
          });
          break;
        case "failed":
          petDispatch({
            type: "animation.play",
            animation: ANIMATIONS.failed,
            mode: "once",
            then: ANIMATIONS.idle,
            source: "user",
          });
          break;
        case "change-pet":
          void (async () => {
            console.log("[change-pet] step:enter async handler");
            const picked = await open({
              multiple: false,
              filters: [{ name: "pet.json", extensions: ["json"] }],
            });
            console.log("[change-pet] step:after open()", {
              type: picked === null ? "null" : Array.isArray(picked) ? "array" : "string",
              preview: Array.isArray(picked)
                ? picked.map((p) => String(p).slice(0, 120))
                : picked === null
                  ? null
                  : String(picked).slice(0, 200),
            });
            const selected = normalizeOpenDialogPath(picked);
            console.log("[change-pet] step:after normalizeOpenDialogPath()", {
              selected: selected?.slice(0, 240) ?? null,
            });
            if (!selected) {
              console.log("[change-pet] step:exit (cancelled or empty path)");
              return;
            }
            try {
              await applyDiskPet(selected);
            } catch (e: unknown) {
              const msg = e instanceof Error ? e.message : String(e);
              setLoadError(msg);
              petWarn("change-pet failed", { selected: selected.slice(0, 240), err: msg });
            }
          })();
          break;
        default:
          if (id !== "" && id !== "quit") {
            petWarn("menu-action: unhandled id (no UI action)", { rawId, id });
          }
          break;
      }
    }).then((fn) => {
      if (cancelled) fn();
      else {
        unlisten = fn;
        petLog("menu-action: listener registered");
      }
    });
    return () => {
      cancelled = true;
      unlisten?.();
      petLog("menu-action: listener removed");
    };
  }, [petDispatch, applyDiskPet, clearAutoWalkTimers]);

  const onPointerEnter = useCallback(() => {
    hoveringRef.current = true;
    if (pointerDownRef.current) return;
    if (hoverTriggeredRef.current) return;
    const n = pet.animation.name;
    if (n !== ANIMATIONS.idle && n !== ANIMATIONS.waiting) return;
    hoverTriggeredRef.current = true;
    petDispatch({
      type: "animation.play",
      animation: ANIMATIONS.waving,
      mode: "once",
      then: ANIMATIONS.idle,
      source: "user",
    });
  }, [pet.animation.name, petDispatch]);

  const onPointerLeave = useCallback(() => {
    hoveringRef.current = false;
    hoverTriggeredRef.current = false;
    if (pointerDownRef.current) return;
    if (isDraggingRef.current) return;
    const { name, mode } = pet.animation;
    if (name === ANIMATIONS.waiting) return;
    if (name === ANIMATIONS.jumping && mode === "once") return;
    if (name === ANIMATIONS.review && mode === "once") return;
    if (name === ANIMATIONS.failed && mode === "once") return;
    if (name === ANIMATIONS.running && mode === "once") return;
    petDispatch({
      type: "animation.set",
      animation: ANIMATIONS.idle,
      source: "user",
    });
  }, [pet.animation.name, pet.animation.mode, petDispatch]);

  const onPetPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;

      if (persistEndDragRef.current) {
        const prevMove = activeMoveRef.current;
        if (prevMove) {
          window.removeEventListener("pointermove", prevMove);
        }
        window.removeEventListener("pointerup", persistEndDragRef.current);
        window.removeEventListener("mouseup", persistEndDragRef.current);
        window.removeEventListener("blur", persistEndDragRef.current);
        persistEndDragRef.current = null;
        activeMoveRef.current = null;
        sessionActiveRef.current = false;
        pointerDownRef.current = false;
        dragStartRef.current = null;
        isDraggingRef.current = false;
        lastDirectionRef.current = null;
        gestureGenerationRef.current += 1;
      }

      clearAutoWalkTimers();

      gestureGenerationRef.current += 1;
      const generation = gestureGenerationRef.current;

      pointerDownRef.current = true;
      isDraggingRef.current = false;
      lastDirectionRef.current = null;
      dragStartRef.current = null;
      dragClampBoundsRef.current = null;
      sessionActiveRef.current = true;

      void (async () => {
        try {
          if (isTauri()) {
            const appWindow = getCurrentWindow();
            const { w, h } = windowLogicalSizeRef.current;
            const [outer, scaleFactor, clampBounds] = await Promise.all([
              appWindow.outerPosition(),
              appWindow.scaleFactor(),
              getLogicalClampBounds(w, h),
            ]);
            const logical = outer.toLogical(scaleFactor);
            if (generation !== gestureGenerationRef.current) return;
            dragClampBoundsRef.current = clampBounds;
            dragStartRef.current = {
              mouseX: e.screenX,
              mouseY: e.screenY,
              windowX: logical.x,
              windowY: logical.y,
            };
          } else {
            if (generation !== gestureGenerationRef.current) return;
            dragStartRef.current = {
              mouseX: e.screenX,
              mouseY: e.screenY,
              windowX: 0,
              windowY: 0,
            };
          }
        } catch {
          if (generation !== gestureGenerationRef.current) return;
          dragStartRef.current = {
            mouseX: e.screenX,
            mouseY: e.screenY,
            windowX: 0,
            windowY: 0,
          };
        }
      })();

      const onMove = (ev: PointerEvent) => {
        const d = dragStartRef.current;
        if (!d) return;

        const dx = ev.screenX - d.mouseX;
        const dy = ev.screenY - d.mouseY;
        const dist = Math.hypot(dx, dy);
        if (dist < DRAG_THRESHOLD_PX) return;

        if (!isDraggingRef.current) {
          isDraggingRef.current = true;
        }

        const rawX = d.windowX + dx;
        const rawY = d.windowY + dy;
        const { x: nextX, y: nextY } = clampToLogicalBounds(
          rawX,
          rawY,
          dragClampBoundsRef.current,
        );

        if (isTauri()) {
          const appWindow = getCurrentWindow();
          void appWindow
            .setPosition(new LogicalPosition(nextX, nextY))
            .catch((err) => {
              console.error("[deski-drag] setPosition failed", err);
            });
        }

        const run = dx >= 0 ? ANIMATIONS.runRight : ANIMATIONS.runLeft;

        if (lastDirectionRef.current !== run) {
          lastDirectionRef.current = run;
          petDispatch({
            type: "animation.play",
            animation: run,
            mode: "loop",
            source: "user",
          });
        }
      };

      const endDrag = () => {
        if (!sessionActiveRef.current) return;
        sessionActiveRef.current = false;
        persistEndDragRef.current = null;
        activeMoveRef.current = null;

        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", endDrag);
        window.removeEventListener("mouseup", endDrag);
        window.removeEventListener("blur", endDrag);

        const hadDragStart = dragStartRef.current !== null;
        const didDrag = isDraggingRef.current;
        dragStartRef.current = null;
        dragClampBoundsRef.current = null;
        isDraggingRef.current = false;
        lastDirectionRef.current = null;
        pointerDownRef.current = false;

        if (!hadDragStart) {
          gestureGenerationRef.current += 1;
          return;
        }

        if (didDrag) {
          if (isTauri()) {
            const { w, h } = windowLogicalSizeRef.current;
            void persistCurrentWindowPosition(w, h);
          }
          petDispatch({
            type: "animation.set",
            animation: ANIMATIONS.idle,
            source: "user",
          });
          scheduleNextAutoWalk();
        } else {
          petDispatch({
            type: "animation.play",
            animation: ANIMATIONS.jumping,
            mode: "once",
            then: ANIMATIONS.idle,
            source: "user",
          });
        }
      };

      persistEndDragRef.current = endDrag;
      activeMoveRef.current = onMove;

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", endDrag);
      window.addEventListener("mouseup", endDrag);
      window.addEventListener("blur", endDrag);
    },
    [petDispatch, scheduleNextAutoWalk, clearAutoWalkTimers],
  );

  const onContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    clearAutoWalkTimers();
    if (!isTauri()) return;
    void (async () => {
      try {
        await invoke("sync_recent_pets_menu", { items: recentPetsForMenuSync() });
      } catch (err) {
        petWarn("sync_recent_pets_menu failed", {
          err: err instanceof Error ? err.message : String(err),
        });
      }
      await invoke("show_context_menu", { x: e.clientX, y: e.clientY });
    })();
  }, [clearAutoWalkTimers]);

  return (
    <div
      className="app"
      style={
        {
          "--pet-display-w": `${petDisplayWidthPx}px`,
          "--pet-display-h": `${petStageHeightPx}px`,
        } as React.CSSProperties
      }
    >
      <div
        className="pet-window-root"
        data-pet-root
        onContextMenu={onContextMenu}
      >
        <div
          className="pet-stage pet-container"
          style={{ opacity: petOpacity }}
          onPointerDown={onPetPointerDown}
          onPointerEnter={onPointerEnter}
          onPointerLeave={onPointerLeave}
        >
          <div className="pet-stage-sizer" aria-hidden />
          {manifest !== null && spritesheetSrc !== null ? (
            <PetWidget<CodexPetAnimationName>
              key={spritesheetSrc}
              src={spritesheetSrc}
              atlas={codexPetAtlas}
              animation={pet.animation}
              position={pet.position}
              pin={pet.pin}
              draggable={false}
              scale={petDisplayScale}
              boundsPadding={PET_BOUNDS_PADDING}
              className="pet-desk"
              ariaLabel={`${manifest.displayName} 桌宠`}
              onAction={onPetAction}
            />
          ) : loadError !== null ? (
            <div className="pet-load-error" role="alert">
              {loadError}
            </div>
          ) : (
            <div className="pet-load-placeholder" aria-busy="true">
              Loading pet…
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
