import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

export const communityRoot = fileURLToPath(new URL("../", import.meta.url));
const repoRoot = path.dirname(communityRoot.replace(/\/$/, ""));
export const generatedRoot = path.join(communityRoot, ".runtime", "2.35.30");
export const insertionAnchor = "T=(0,p.getFrameParent)()??window.location.href;";
export const insertion = "globalThis.__konkrCommunityPrepare(i,S);";
const digest = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
export const localFontReplacements = [
  ["url(https://fonts.gstatic.com/s/roboto/v30/KFOmCnqEu92Fr1Mu72xKOzY.woff2) format('woff2')", "local(Arial)"],
  ["url(https://fonts.gstatic.com/s/cinzel/v23/8vIU7ww63mVu7gtR-kwKxNvkNOjw-tbnfY3lDQ.woff2) format('woff2')", "local(Georgia)"],
] as const;

export function guardedPatch(source: string, expectedHash: string): string {
  if (createHash("sha256").update(source).digest("hex") !== expectedHash) {
    throw new Error("Original main bundle checksum mismatch; refusing to patch");
  }
  if (source.split(insertionAnchor).length !== 2) throw new Error("Expected exactly one bootstrap anchor");
  let result = source.replace(insertionAnchor, insertionAnchor + insertion);
  for (const [remote, local] of localFontReplacements) {
    if (result.split(remote).length !== 2) throw new Error("Expected exactly one pinned web-font source");
    result = result.replace(remote, local);
  }
  return result;
}

export async function withPreparationLock<T>(lock: string, operation: () => Promise<T>, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { await mkdir(lock); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (Date.now() >= deadline) throw new Error(`Runtime preparation lock is busy or stale: ${lock}. Confirm no preparer is running before removing it.`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  try {
    await writeFile(path.join(lock, "owner.json"), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    return await operation();
  } finally {
    // Only the process that acquired this lock releases it. A timeout never
    // steals/deletes an active or potentially crashed process's lock.
    await rm(lock, { recursive: true, force: true });
  }
}

export async function prepareRuntime(): Promise<string> {
  const manifestText = await readFile(path.join(communityRoot, "runtime/manifest.json"), "utf8");
  const manifest = JSON.parse(manifestText);
  const sourceRoot = path.join(repoRoot, manifest.sourceDirectory);
  // Verify ALL copied files before touching previous generated output.
  for (const [relative, expected] of Object.entries(manifest.files)) {
    const contents = await readFile(path.join(sourceRoot, relative));
    if (createHash("sha256").update(contents).digest("hex") !== expected) {
      throw new Error(`Runtime input checksum mismatch: ${relative}`);
    }
  }
  // Refuse unpinned additions; otherwise copying an asset tree could introduce drift.
  const assetFiles = await readdir(path.join(sourceRoot, "assets"), { recursive: true, withFileTypes: true });
  for (const file of assetFiles.filter((file) => file.isFile())) {
    const relative = path.relative(sourceRoot, path.join(file.parentPath, file.name));
    if (!(relative in manifest.files)) throw new Error(`Unpinned runtime asset: ${relative}`);
  }
  const main = guardedPatch(await readFile(path.join(sourceRoot, manifest.main), "utf8"), manifest.files[manifest.main]);
  await mkdir(path.dirname(generatedRoot), { recursive: true });
  const fingerprint = digest(manifestText + await readFile(fileURLToPath(import.meta.url), "utf8")
    + await readFile(path.join(communityRoot, "runtime/bootstrap.ts"), "utf8")
    + await readFile(path.join(communityRoot, "package-lock.json"), "utf8"));
  return withPreparationLock(generatedRoot + ".preparation-lock", async () => {
    try {
      const cached = JSON.parse(await readFile(path.join(generatedRoot, ".preparation.json"), "utf8"));
      const outputFiles = [...Object.keys(manifest.files), "bootstrap.js", "index.html"].sort();
      if (cached.fingerprint === fingerprint && JSON.stringify(Object.keys(cached.outputs).sort()) === JSON.stringify(outputFiles)) {
        let matches = true;
        for (const [relative, expected] of Object.entries(cached.outputs)) {
          if (digest(await readFile(path.join(generatedRoot, relative))) !== expected) { matches = false; break; }
        }
        if (matches) return generatedRoot;
      }
    } catch { /* Missing/incomplete output is rebuilt while holding the lock. */ }
    await rm(generatedRoot, { recursive: true, force: true });
    await mkdir(generatedRoot);
    await cp(path.join(sourceRoot, "assets"), path.join(generatedRoot, "assets"), { recursive: true });
    const loginTemplate = path.join(generatedRoot, "assets/html/login-buttons.html");
    const loginHTML = await readFile(loginTemplate, "utf8");
    const remoteIcons = / src='https:\/\/www\.gstatic\.com\/firebasejs\/ui\/2\.0\.0\/images\/auth\/(?:google|facebook|mail)\.svg'/g;
    if ([...loginHTML.matchAll(remoteIcons)].length !== 3) throw new Error("Unexpected login icon template");
    await writeFile(loginTemplate, loginHTML.replace(remoteIcons, ""));
    await cp(path.join(sourceRoot, manifest.vendor), path.join(generatedRoot, manifest.vendor));
    await writeFile(path.join(generatedRoot, manifest.main), main);
    // A standalone addon bundle runs before the original vendor/main scripts.
    // https://esbuild.github.io/api/#build
    await build({ entryPoints: [path.join(communityRoot, "runtime/bootstrap.ts")], bundle: true,
      platform: "browser", format: "iife", target: "es2023", outfile: path.join(generatedRoot, "bootstrap.js") });
    await writeFile(path.join(generatedRoot, "index.html"), `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data: blob:; media-src 'self' data: blob:; font-src 'self'; frame-src 'self'; worker-src 'none'; object-src 'none'; base-uri 'self'; form-action 'none'">
<title>Konkr community reference</title><link rel="icon" href="data:,"><style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#132e3b;color:white}#phaser-game{width:100%;height:100%}.hidden{display:none!important}#status{position:absolute;inset:40% 10%;text-align:center}#news-box{position:absolute;max-width:260px}#file-drop-zone{position:absolute;inset:0;pointer-events:auto}#file-drop-zone *{pointer-events:none}</style>
<script defer src="bootstrap.js"></script><script defer src="${manifest.vendor}"></script><script defer src="${manifest.main}"></script></head>
<body><div id="loader"></div><article id="status">Loading local game reference…</article><div id="phaser-game" class="hidden"></div><div id="news-box"><article id="news-box-body"></article></div><div id="file-drop-zone" class="hidden"><div>Import map</div></div></body></html>`);
    const outputs: Record<string, string> = {};
    for (const relative of [...Object.keys(manifest.files), "bootstrap.js", "index.html"]) {
      outputs[relative] = digest(await readFile(path.join(generatedRoot, relative)));
    }
    await writeFile(path.join(generatedRoot, ".preparation.json"), JSON.stringify({ fingerprint, outputs }));
    return generatedRoot;
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(await prepareRuntime());
}
