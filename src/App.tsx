import { useCallback, useEffect, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";
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

/** 1 = atlas 原始格子大小；略小于 1 让桌宠占屏更小。 */
const PET_DISPLAY_SCALE = 0.72;

/** Screen distance before a pointer gesture counts as a drag (not a click). */
const DRAG_THRESHOLD_PX = 6;
/** Ignore horizontal sign flips until |dx| from gesture start exceeds this (reduces jitter). */
const RUN_FLIP_DEADZONE_PX = 10;

/** Random auto-walk delay range (ms). */
const AUTO_WALK_MIN_MS = 8000;
const AUTO_WALK_MAX_MS = 20000;
/** Auto-walk run duration (ms). */
const AUTO_WALK_RUN_MS = 2000;

export default function App() {
  const [manifest, setManifest] = useState<PetManifest | null>(null);
  const [spritesheetSrc, setSpritesheetSrc] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const hoveringRef = useRef(false);
  const pointerDownRef = useRef(false);
  const isDraggingRef = useRef(false);
  const movedDistanceRef = useRef(0);
  const gestureStartRef = useRef<{ sx: number; sy: number } | null>(null);
  const startDraggingCalledRef = useRef(false);
  const lastRunAnimRef = useRef<CodexPetAnimationName | null>(null);

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

  const resumeHoverIfHovered = useCallback(() => {
    if (!hoveringRef.current) return;
    petDispatch({
      type: "animation.play",
      animation: ANIMATIONS.waving,
      mode: "loop",
      source: "user",
    });
  }, [petDispatch]);

  const onPetAction = useCallback(
    (action: PetAction<CodexPetAnimationName>) => {
      petDispatch(action);
      if (action.type !== "animation.complete") return;
      const done = action.animation;
      if (
        done &&
        (done === ANIMATIONS.jumping ||
          done === ANIMATIONS.failed ||
          done === ANIMATIONS.review ||
          done === ANIMATIONS.running ||
          done === ANIMATIONS.waving)
      ) {
        resumeHoverIfHovered();
      }
      if (done) {
        scheduleNextAutoWalk();
      }
    },
    [petDispatch, resumeHoverIfHovered, scheduleNextAutoWalk],
  );

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
      resumeHoverIfHovered();
      scheduleNextAutoWalk();
    };

    window.addEventListener("pointerdown", onPointerDownCapture, true);
    return () => window.removeEventListener("pointerdown", onPointerDownCapture, true);
  }, [pet.animation.mode, pet.animation.name, petDispatch, resumeHoverIfHovered, scheduleNextAutoWalk]);

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
    const n = pet.animation.name;
    if (n === ANIMATIONS.idle || n === ANIMATIONS.waiting) {
      petDispatch({
        type: "animation.play",
        animation: ANIMATIONS.waving,
        mode: "loop",
        source: "user",
      });
    }
  }, [pet.animation.name, petDispatch]);

  const onPointerLeave = useCallback(() => {
    hoveringRef.current = false;
    if (pointerDownRef.current) return;
    if (pet.animation.name === ANIMATIONS.waving) {
      petDispatch({
        type: "animation.set",
        animation: ANIMATIONS.idle,
        source: "user",
      });
    }
  }, [pet.animation.name, petDispatch]);

  const onPetPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      clearAutoWalkTimers();

      pointerDownRef.current = true;
      isDraggingRef.current = false;
      movedDistanceRef.current = 0;
      startDraggingCalledRef.current = false;
      lastRunAnimRef.current = null;
      gestureStartRef.current = { sx: e.screenX, sy: e.screenY };

      const start = gestureStartRef.current;

      const onMove = (ev: PointerEvent) => {
        if (!start) return;
        const dx = ev.screenX - start.sx;
        const dy = ev.screenY - start.sy;
        const dist = Math.hypot(dx, dy);
        movedDistanceRef.current = dist;

        if (dist < DRAG_THRESHOLD_PX) return;

        if (!isDraggingRef.current) {
          isDraggingRef.current = true;
        }

        let run: CodexPetAnimationName;
        if (!lastRunAnimRef.current) {
          run = dx >= 0 ? ANIMATIONS.runRight : ANIMATIONS.runLeft;
        } else if (Math.abs(dx) < RUN_FLIP_DEADZONE_PX) {
          run = lastRunAnimRef.current;
        } else {
          run = dx >= 0 ? ANIMATIONS.runRight : ANIMATIONS.runLeft;
        }

        if (lastRunAnimRef.current !== run) {
          lastRunAnimRef.current = run;
          petDispatch({
            type: "animation.play",
            animation: run,
            mode: "loop",
            source: "user",
          });
        }

        if (isTauri() && !startDraggingCalledRef.current) {
          startDraggingCalledRef.current = true;
          void getCurrentWindow().startDragging();
        }
      };

      const finish = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", finish);
        window.removeEventListener("pointercancel", finish);

        pointerDownRef.current = false;
        gestureStartRef.current = null;
        lastRunAnimRef.current = null;
        startDraggingCalledRef.current = false;

        const wasDrag = isDraggingRef.current;
        isDraggingRef.current = false;
        movedDistanceRef.current = 0;

        if (wasDrag) {
          petDispatch({
            type: "animation.set",
            animation: ANIMATIONS.idle,
            source: "user",
          });
          resumeHoverIfHovered();
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

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", finish);
      window.addEventListener("pointercancel", finish);
    },
    [petDispatch, resumeHoverIfHovered, scheduleNextAutoWalk, clearAutoWalkTimers],
  );

  const onContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    if (!isTauri()) return;
    void invoke("show_context_menu", { x: e.clientX, y: e.clientY });
  }, []);

  return (
    <div className="app-shell" data-pet-root onContextMenu={onContextMenu}>
      <div
        className="pet-drag-area"
        onPointerDown={onPetPointerDown}
        onPointerEnter={onPointerEnter}
        onPointerLeave={onPointerLeave}
      >
        {manifest !== null && spritesheetSrc !== null ? (
          <PetWidget<CodexPetAnimationName>
            key={spritesheetSrc}
            src={spritesheetSrc}
            atlas={codexPetAtlas}
            animation={pet.animation}
            position={pet.position}
            pin={pet.pin}
            draggable={false}
            scale={PET_DISPLAY_SCALE}
            boundsPadding={8}
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
  );
}
