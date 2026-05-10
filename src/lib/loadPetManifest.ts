import { dirname, isAbsolute, join, normalize } from "@tauri-apps/api/path";
import { readFile, readTextFile } from "@tauri-apps/plugin-fs";
import type { PetManifest } from "../types/pet";
import { petError, petLog } from "./petDebug";

function parseManifest(data: unknown): PetManifest {
  if (data === null || typeof data !== "object") {
    throw new Error("Pet manifest is not a JSON object");
  }
  const m = data as Record<string, unknown>;
  if (typeof m.id !== "string" || !m.id) {
    throw new Error('Pet manifest missing string field "id"');
  }
  if (typeof m.displayName !== "string" || !m.displayName) {
    throw new Error('Pet manifest missing string field "displayName"');
  }
  if (typeof m.spritesheetPath !== "string" || !m.spritesheetPath) {
    throw new Error('Pet manifest missing string field "spritesheetPath"');
  }
  return {
    id: m.id,
    displayName: m.displayName,
    description: typeof m.description === "string" ? m.description : undefined,
    spritesheetPath: m.spritesheetPath,
  };
}

export type LoadedPet = {
  manifest: PetManifest;
  /** URL for PetWidget `src` (bundled HTTP path, or `blob:` from disk). */
  spritesheetSrc: string;
  /** Call when switching pets or unmounting so `blob:` URLs are revoked. */
  disposeSpritesheet?: () => void;
};

/**
 * `open()` may return a single string, a one-element array, or a `file://` URL depending on platform / plugin version.
 */
export function normalizeOpenDialogPath(selected: string | string[] | null | undefined): string | null {
  if (selected == null) return null;
  const first = Array.isArray(selected) ? (selected[0] ?? null) : selected;
  if (first == null || first === "") return null;
  const t = String(first).trim();
  if (Array.isArray(selected)) {
    petLog("normalizeOpenDialogPath: dialog returned array, using first entry", { length: selected.length });
  }
  if (!t.startsWith("file:")) return t;
  try {
    const u = new URL(t);
    let p = decodeURIComponent(u.pathname);
    // file:///C:/foo -> pathname /C:/foo; strip leading slash before drive letter on Windows
    if (/^\/[a-zA-Z]:\//.test(p)) p = p.slice(1);
    petLog("normalizeOpenDialogPath: file URL → path", { from: t.slice(0, 80), to: p.slice(0, 120) });
    return p;
  } catch {
    return t;
  }
}

function mimeForSpritesheet(absPath: string): string {
  const lower = absPath.toLowerCase();
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  return "application/octet-stream";
}

/**
 * Load a PetDex-style manifest (metadata only; animation layout comes from codexPetAtlas).
 */
export async function loadPetManifest(petId: string): Promise<PetManifest> {
  const url = `/pets/${encodeURIComponent(petId)}/pet.json`;
  let res: Response;
  try {
    res = await fetch(url);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`Network error loading pet manifest ${url}: ${msg}`);
  }
  if (!res.ok) {
    throw new Error(`Failed to load pet manifest (${res.status} ${res.statusText}): ${url}`);
  }
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new Error(`Pet manifest is not valid JSON: ${url}`);
  }
  try {
    return parseManifest(json);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`${msg} (${url})`);
  }
}

/** Absolute URL for the spritesheet under `/pets/{petId}/`. */
export function getPetSpritesheetUrl(petId: string, manifest: PetManifest): string {
  const rel = manifest.spritesheetPath.replace(/^\/+/, "");
  return `/pets/${encodeURIComponent(petId)}/${rel}`;
}

/**
 * Read `pet.json` from disk (Tauri) and resolve spritesheet path relative to that file's directory.
 */
export async function loadPetFromPath(petJsonPathRaw: string): Promise<LoadedPet> {
  petLog("loadPetFromPath: start", { petJsonPathRaw: petJsonPathRaw.slice(0, 200) });
  const petJsonPath = await normalize(normalizeOpenDialogPath(petJsonPathRaw) ?? petJsonPathRaw);
  petLog("loadPetFromPath: normalized pet.json path", { petJsonPath: petJsonPath.slice(0, 200) });
  let raw: string;
  try {
    raw = await readTextFile(petJsonPath);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    petError("loadPetFromPath: readTextFile failed", { petJsonPath, msg });
    throw new Error(`Failed to read pet manifest file ${petJsonPath}: ${msg}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    petError("loadPetFromPath: JSON.parse failed", { petJsonPath });
    throw new Error(`Pet manifest is not valid JSON: ${petJsonPath}`);
  }
  const manifest = parseManifest(json);
  const sheet = manifest.spritesheetPath.trim();
  const absSpritesheet = await isAbsolute(sheet);
  const spritesheetAbsPath = absSpritesheet
    ? await normalize(sheet)
    : await join(await dirname(petJsonPath), sheet.replace(/^[/\\]+/, ""));
  petLog("loadPetFromPath: manifest + spritesheet", {
    id: manifest.id,
    displayName: manifest.displayName,
    spritesheetPathInJson: sheet.slice(0, 160),
    spritesheetResolvedAbsolute: spritesheetAbsPath.slice(0, 200),
    spritesheetPathWasAbsolute: absSpritesheet,
  });
  let bytes: Uint8Array;
  try {
    bytes = await readFile(spritesheetAbsPath);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    petError("loadPetFromPath: readFile spritesheet failed", { spritesheetAbsPath, msg });
    throw new Error(`Failed to read spritesheet ${spritesheetAbsPath}: ${msg}`);
  }
  const spritesheetSrc = URL.createObjectURL(
    new Blob([bytes], { type: mimeForSpritesheet(spritesheetAbsPath) }),
  );
  petLog("loadPetFromPath: ok", {
    bytes: bytes.byteLength,
    spritesheetSrcPrefix: spritesheetSrc.slice(0, 48),
  });
  return {
    manifest,
    spritesheetSrc,
    disposeSpritesheet: () => URL.revokeObjectURL(spritesheetSrc),
  };
}
