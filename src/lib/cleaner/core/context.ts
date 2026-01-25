import type sharp from "sharp";

export type SharpFn = typeof sharp;

export interface CleanerContext {
  pixels: Uint8Array;
  changed: Uint8Array;
  width: number;
  height: number;
  info: {
    width: number;
    height: number;
  };
  isComplexScene: boolean;
  sharp: SharpFn;
}
