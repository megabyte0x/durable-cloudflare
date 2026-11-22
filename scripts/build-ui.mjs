import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { build } from "esbuild";
import { copyFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { zyzz } from "zyzz/esbuild";

for (const path of ["public/assets", "public/app.js", "public/app.css", "public/how-it-works.js", "public/how-it-works.css", "public/chatgpt.js", "public/chatgpt.css", "public/claude.js", "public/claude.css", "public/stage.js", "public/stage.css", "public/dock.js", "public/dock.css", "public/zyzz-assets", "public/zyzz.css", "public/zyzz.css.map", "public/zyzz.js"]) await rm(path, { force: true, recursive: true });
// python.wasm starts from python.data, which the Worker can't hold in its bundle, so it ships as a static
// asset that nanocode-ts's App fetches from env.ASSETS at /nanocode-ts/python.data, once per isolate.
await rm("public/nanocode-ts", { force: true, recursive: true });
const pythonData = "node_modules/nanocode-ts/dist/python.data";
const pythonDataSize = await stat(pythonData).then(file => file.size, () => undefined);
if (pythonDataSize !== undefined) {
  if (pythonDataSize > 25 * 1024 * 1024) throw new Error(pythonData + " is " + pythonDataSize + " bytes, over the 25 MiB a static asset may hold");
  await mkdir("public/nanocode-ts", { recursive: true });
  await copyFile(pythonData, "public/nanocode-ts/python.data");
}
await build({
  assetNames: "assets/[name]-[hash]",
  bundle: true,
  chunkNames: "assets/[name]-[hash]",
  entryNames: "[name]",
  entryPoints: { app: "ui/app.tsx", chatgpt: "ui/chatgpt.tsx", claude: "ui/claude.tsx", stage: "ui/stage.ts", dock: "ui/dock.tsx" },
  format: "esm",
  jsx: "automatic",
  loader: { ".wasm": "file", ".woff2": "file" },
  minify: true,
  outdir: "public",
  platform: "browser",
  plugins: [zyzz()],
  splitting: true,
  target: "es2022",
});

await writeFile("public/version.json", JSON.stringify({
  commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  nanocodeTs: JSON.parse(await readFile("package.json", "utf8")).dependencies["nanocode-ts"],
  wasmSha256: createHash("sha256").update(await readFile("node_modules/nanocode-ts/dist/nanocode_wasm.wasm")).digest("hex"),
}));
