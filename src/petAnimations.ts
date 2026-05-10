export const ANIMATIONS = {
  idle: "idle",
  runRight: "running-right",
  runLeft: "running-left",
  waving: "waving",
  jumping: "jumping",
  failed: "failed",
  waiting: "waiting",
  running: "running",
  review: "review",
} as const;

export type PetAnimationName = (typeof ANIMATIONS)[keyof typeof ANIMATIONS];
