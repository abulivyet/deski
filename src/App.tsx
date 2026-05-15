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

/** Random auto-walk delay range (ms). */
const AUTO_WALK_MIN_MS = 8000;
const AUTO_WALK_MAX_MS = 20000;
/** Auto-walk run duration (ms). */
const AUTO_WALK_RUN_MS = 2000;

export default function App() {
  const [manifest, setManifest] = useState<PetManifest | null>(null);
  const [spritesheetSrc, setSpritesheetSrc] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [petUserScale, setPetUserScale] = useState(() => readInitialPetUserScale());

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
  const autoWalkRunTimerRef = useRef<number | null>(null);
  const petAnimRef = useRef<{ name: CodexPetAnimationName; mode: "loop" | "once" }>({
    name: ANIMATIONS.idle,
    mode: "loop",
  });

  const spritesheetDisposeRef = useRef<(() => void) | null>(null);
  const releaseSpritesheet = useCallback(() => {
    spritesheetDisposeRef.current?.();
    spritesheetDisposeRef.current = null;
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoadError(null);
    setManifest(null);
    setSpritesheetSrc(null);

    const loadBundled = async () => {
      petLog("startup: loading bundled pet", { petId: "dropout-bear" });
      const m = await loadPetManifest("dropout-bear");
      if (cancelled) return;
      releaseSpritesheet();
      setManifest(m);
      setSpritesheetSrc(getPetSpritesheetUrl("dropout-bear", m));
      setLoadError(null);
      petLog("startup: bundled ready", { id: m.id, src: getPetSpritesheetUrl("dropout-bear", m) });
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

  const { pet, petDispatch } = usePetController<CodexPetAnimationName>({
    initialState: {
      animation: { name: ANIMATIONS.idle, mode: "loop" },
      pin: "center",
    },
    defaultAnimation: ANIMATIONS.idle,
    waitingAnimation: ANIMATIONS.waiting,
    waitingAfterMs: 10_000,
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

  const clearAutoWalkTimers = useCallback(() => {
    if (autoScheduleTimerRef.current != null) {
      window.clearTimeout(autoScheduleTimerRef.current);
      autoScheduleTimerRef.current = null;
    }
    if (autoWalkRunTimerRef.current != null) {
      window.clearTimeout(autoWalkRunTimerRef.current);
      autoWalkRunTimerRef.current = null;
    }
  }, []);

  const scheduleNextAutoWalk = useCallback(() => {
    if (autoScheduleTimerRef.current != null) {
      window.clearTimeout(autoScheduleTimerRef.current);
      autoScheduleTimerRef.current = null;
    }
    const delay = AUTO_WALK_MIN_MS + Math.random() * (AUTO_WALK_MAX_MS - AUTO_WALK_MIN_MS);
    autoScheduleTimerRef.current = window.setTimeout(() => {
      autoScheduleTimerRef.current = null;
      if (hoveringRef.current || pointerDownRef.current || isDraggingRef.current) {
        scheduleNextAutoWalk();
        return;
      }
      const { name, mode } = petAnimRef.current;
      if (name !== ANIMATIONS.idle || mode !== "loop") {
        scheduleNextAutoWalk();
        return;
      }
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
        scheduleNextAutoWalk();
      }, AUTO_WALK_RUN_MS);
    }, delay);
  }, [petDispatch]);

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
      void getCurrentWindow()
        .setSize(new LogicalSize(w, h))
        .catch((err) => {
          console.error("[pet-scale] setSize failed", err);
        });
    }, WINDOW_RESIZE_DEBOUNCE_MS);
    return () => window.clearTimeout(tid);
  }, [petDisplayWidthPx, petStageHeightPx]);

  useEffect(() => {
    if (!isTauri()) return;
    const key = scaleToMenuKey(petUserScale);
    void invoke("sync_pet_size_menu_selection", { key }).catch(() => {
      /* ignore */
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅挂载时与 Rust 菜单勾选对齐
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
              console.log("[change-pet] step:before loadPetFromPath()", { selected: selected.slice(0, 240) });
              const loaded = await loadPetFromPath(selected);
              console.log("[change-pet] step:after loadPetFromPath()", {
                manifestId: loaded.manifest.id,
                displayName: loaded.manifest.displayName,
                spritesheetSrcPrefix: loaded.spritesheetSrc.slice(0, 64),
              });
              releaseSpritesheet();
              console.log("[change-pet] step:after releaseSpritesheet()");
              spritesheetDisposeRef.current = loaded.disposeSpritesheet ?? null;
              console.log("[change-pet] step:after assign spritesheetDisposeRef", {
                hasDispose: Boolean(loaded.disposeSpritesheet),
              });
              setManifest(loaded.manifest);
              setSpritesheetSrc(loaded.spritesheetSrc);
              console.log("[change-pet] step:after setManifest + setSpritesheetSrc (scheduled)");
              localStorage.setItem(PET_JSON_PATH_LS_KEY, selected);
              console.log("[change-pet] step:after localStorage.setItem", { key: PET_JSON_PATH_LS_KEY });
              setLoadError(null);
              console.log("[change-pet] step:after setLoadError(null) — done");
            } catch (e: unknown) {
              const msg = e instanceof Error ? e.message : String(e);
              console.log("[change-pet] step:catch loadPetFromPath / apply", {
                selected: selected.slice(0, 240),
                error: msg,
              });
              setLoadError(msg);
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
  }, [petDispatch, releaseSpritesheet, setManifest, setSpritesheetSrc, setLoadError]);

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
      sessionActiveRef.current = true;

      void (async () => {
        try {
          if (isTauri()) {
            const appWindow = getCurrentWindow();
            const outer = await appWindow.outerPosition();
            const scaleFactor = await appWindow.scaleFactor();
            const logical = outer.toLogical(scaleFactor);
            console.log("[deski-drag] pointerdown outerPosition", {
              physical: { x: outer.x, y: outer.y },
              scaleFactor,
              logical: { x: logical.x, y: logical.y },
              mouse: { x: e.screenX, y: e.screenY },
            });
            if (generation !== gestureGenerationRef.current) return;
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

        const nextX = d.windowX + dx;
        const nextY = d.windowY + dy;
        console.log("[deski-drag] pointermove", { dx, dy, nextX, nextY });

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
        isDraggingRef.current = false;
        lastDirectionRef.current = null;
        pointerDownRef.current = false;

        if (!hadDragStart) {
          gestureGenerationRef.current += 1;
          return;
        }

        if (didDrag) {
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
    if (!isTauri()) return;
    void invoke("show_context_menu", { x: e.clientX, y: e.clientY });
  }, []);

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
              boundsPadding={{ top: 8, right: 8, left: 8, bottom: 18 }}
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
