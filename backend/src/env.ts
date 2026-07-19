// Minimal .env loader (no dependency): imported FIRST from index.ts so every
// other module sees the variables at import time. Real environment variables
// always win over .env values.
import { readFileSync } from "fs";

try {
  const text = readFileSync(new URL("../.env", import.meta.url), "utf8");
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && !line.trimStart().startsWith("#") && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2];
    }
  }
} catch {
  /* no .env file — rely on the real environment */
}
