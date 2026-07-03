#!/usr/bin/env node
// Patch the pinned OpenChamber web bundle for Home Assistant Ingress.
// The upstream app is built for origin-root hosting; HA serves add-ons under
// /api/hassio_ingress/<token>, so root-relative assets and API URLs need help.

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

function fail(message) {
  console.error(`OpenChamber ingress patch failed: ${message}`);
  process.exit(1);
}

function replaceOnce(content, search, replacement, label) {
  const count = content.split(search).length - 1;
  if (count !== 1) {
    fail(`${label} expected 1 match, found ${count}`);
  }
  return content.replace(search, replacement);
}

function writeIfChanged(filePath, content) {
  const current = fs.readFileSync(filePath, "utf8");
  if (current !== content) {
    fs.writeFileSync(filePath, content);
  }
}

const globalRoot = execFileSync("npm", ["root", "-g"], {
  encoding: "utf8",
}).trim();
const packageRoot = path.join(globalRoot, "@openchamber", "web");
const distDir = path.join(packageRoot, "dist");
const assetsDir = path.join(distDir, "assets");
const indexPath = path.join(distDir, "index.html");

if (!fs.existsSync(indexPath)) {
  fail(`index.html not found at ${indexPath}`);
}
if (!fs.existsSync(assetsDir)) {
  fail(`assets directory not found at ${assetsDir}`);
}

let html = fs.readFileSync(indexPath, "utf8");
html = html.replace(/\s*<script\b[^>]*\bdata-ha-ingress-runtime\b[^>]*>[\s\S]*?<\/script>/g, "");

// Make initial static assets relative to the current iframe URL. The browser
// then requests them under /api/hassio_ingress/<token>/..., which Supervisor
// forwards back to this add-on.
html = html
  .replace(/\b(href|src)="\/(assets\/[^"#?]+(?:[?#][^"]*)?)"/g, '$1="$2"')
  .replace(/\bhref="\/(favicon[^"#?]*(?:[?#][^"]*)?)"/g, 'href="$1"')
  .replace(/\bhref="\/(apple-touch-icon[^"#?]*(?:[?#][^"]*)?)"/g, 'href="$1"');
writeIfChanged(indexPath, html);

const jsFiles = fs.readdirSync(assetsDir)
  .filter((name) => name.endsWith(".js"))
  .map((name) => path.join(assetsDir, name));

const apiBuilderReplacement = "const o=t?e.trim().replace(/^\\/+/,\"\"):qo(e);if(!t)return Jo(o,r);const n=new URL(o,`${t}/`);";

let patchedRuntimeUrl = false;
let patchedApiBuilder = false;
let patchedServiceWorker = false;

for (const filePath of jsFiles) {
  let content = fs.readFileSync(filePath, "utf8");
  const original = content;

  if (content.includes('try{return new URL(e,`${r.replace(/\\/+$/,"")}/`).toString()}catch{return e}}')) {
    content = replaceOnce(
      content,
      'try{return new URL(e,`${r.replace(/\\/+$/,"")}/`).toString()}catch{return e}}',
      'try{return new URL(e.replace(/^\\/+/,""),`${r.replace(/\\/+$/,"")}/`).toString()}catch{return e}}',
      "runtime URL builder"
    );
    patchedRuntimeUrl = true;
  }

  if (content.includes('const o=qo(e);if(!t)return Jo(o,r);const n=new URL(o,`${t}/`);')) {
    content = replaceOnce(
      content,
      'const o=qo(e);if(!t)return Jo(o,r);const n=new URL(o,`${t}/`);',
      apiBuilderReplacement,
      "API URL builder"
    );
    patchedApiBuilder = true;
  }

  if (content.includes('if("serviceWorker"in navigator){')) {
    content = replaceOnce(
      content,
      'if("serviceWorker"in navigator){',
      'if(false&&"serviceWorker"in navigator){',
      "service worker registration"
    );
    patchedServiceWorker = true;
  }

  if (content !== original) {
    fs.writeFileSync(filePath, content);
  }
}

if (!patchedRuntimeUrl) {
  fail("runtime URL builder pattern not found");
}
if (!patchedApiBuilder) {
  fail("API URL builder pattern not found");
}
if (!patchedServiceWorker) {
  fail("service worker registration pattern not found");
}

console.log("OpenChamber bundle patched for Home Assistant Ingress");
