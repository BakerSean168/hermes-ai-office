import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entry = path.join(root, "dashboard", "src", "index.js");
const outfile = path.join(root, "dashboard", "dist", "index.js");
const options = {
  entryPoints: [entry],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: ["es2020"],
  legalComments: "none",
  charset: "utf8",
  sourcemap: false,
  outfile,
  write: false,
};

const result = await build(options);
const output = result.outputFiles?.[0]?.text;
if (typeof output !== "string") throw new Error("dashboard build produced no JavaScript output");

if (process.argv.includes("--check")) {
  const current = fs.existsSync(outfile) ? fs.readFileSync(outfile, "utf8") : "";
  if (current !== output) {
    console.error("dashboard/dist/index.js is stale; run node hermes-ai-office/scripts/build-dashboard.mjs");
    process.exit(1);
  }
} else {
  fs.writeFileSync(outfile, output, "utf8");
}
