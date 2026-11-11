// Imports the official Azure Architecture Icons (service icons) into web/src/icons/azure/.
// Usage: npm run icons -- <path-to-Azure_Architecture_Icons.zip>
// Download the zip from https://learn.microsoft.com/azure/architecture/icons/
import AdmZip from "adm-zip";
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const zipPath = process.argv[2];
if (!zipPath) {
  console.error("Usage: npm run icons -- <path-to-Azure_Architecture_Icons.zip>");
  process.exit(1);
}
const out = resolve(fileURLToPath(new URL("../web/src/icons/azure", import.meta.url)));
mkdirSync(out, { recursive: true });

let count = 0;
for (const e of new AdmZip(zipPath).getEntries()) {
  if (e.isDirectory || !/\/Icons\/.+\.svg$/i.test(e.entryName) || /__MACOSX/.test(e.entryName)) continue;
  writeFileSync(resolve(out, basename(e.entryName)), e.getData());
  count++;
}
console.log(`Imported ${count} icons into ${out}`);
