import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const apiSpecDir = path.dirname(fileURLToPath(import.meta.url));
const indexPath = path.resolve(apiSpecDir, "../api-zod/src/index.ts");
const contents = await readFile(indexPath, "utf8");
const conflictingBarrelExport = /^export \* from ['"]\.\/generated\/types['"];?\s*$/m;
const cleaned = contents.replace(conflictingBarrelExport, "").trimEnd() + "\n";
if (cleaned !== contents) await writeFile(indexPath, cleaned);