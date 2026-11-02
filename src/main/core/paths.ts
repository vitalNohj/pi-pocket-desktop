import { join } from "node:path";

export const ROOT = join(__dirname, "..", "..", "..");
export const ASSETS = join(ROOT, "assets");
export const RENDERER = join(ROOT, "dist", "renderer");

export function preloadPath(name: string): string {
    return join(ROOT, "dist", "preload", `${name}.js`);
}
