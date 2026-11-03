// Copies the config page's static files (HTML, CSS, fonts, icons) next to its compiled script.
import { cpSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "dist", "renderer", "config");

mkdirSync(out, { recursive: true });

for (const file of ["index.html", "style.css"]) {
    cpSync(join(root, "src", "renderer", "config", file), join(out, file));
}

cpSync(join(root, "assets", "fonts"), join(out, "fonts"), { recursive: true });
cpSync(join(root, "assets", "icon.svg"), join(out, "icon.svg"));

// Dictate anywhere's pill (src/main/dictation/anywhere.ts). It takes its font from the config page's folder.
const pill = join(root, "dist", "renderer", "anywhere");

mkdirSync(pill, { recursive: true });

for (const file of ["index.html", "style.css"]) {
    cpSync(join(root, "src", "renderer", "anywhere", file), join(pill, file));
}
