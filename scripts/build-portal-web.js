#!/usr/bin/env node
'use strict';

// Builds the static owner-portal demo: the real portal UI plus the real portal API/auth/data code (bundled with
// esbuild, Express replaced by a tiny router shim), inlined into one HTML file. Fake data is generated in the page.
//   portal-web/OnSite-portal-demo.html   standalone page
//   dist/onsite-portal-demo.fragment.html  same without <html>/<head>/<body>, for publishing as an Artifact
const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

const root = path.join(__dirname, '..');
const shims = path.join(root, 'demo-web', 'shims');
const esc = (s) => s.replace(/<\/(script|style)/gi, '<\\/$1');

async function build() {
  const out = await esbuild.build({
    entryPoints: [path.join(root, 'portal-web', 'entry.js')],
    bundle: true, minify: true, format: 'iife', globalName: 'OnSitePortal', platform: 'browser', target: 'es2020', write: false,
    inject: [path.join(shims, 'globals.js')],
    alias: { crypto: path.join(shims, 'crypto.js'), fs: path.join(shims, 'empty.js'), express: path.join(root, 'portal-web', 'express-shim.js') },
    external: ['@aws-sdk/*'], define: { 'process.env.NODE_ENV': '"demo"' }, legalComments: 'none', logLevel: 'warning',
  });
  const engine = esc(out.outputFiles[0].text);
  let css = fs.readFileSync(path.join(root, 'portal', 'portal.css'), 'utf8');
  // Follow the viewer's theme setting (data-theme) as well as the OS preference when hosted as an Artifact.
  const dark = /@media \(prefers-color-scheme: dark\) \{\s*:root \{([^}]*)\}\s*\}/.exec(css);
  if (!dark) throw new Error('portal.css dark block not found');
  css = css.replace(dark[0], `@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {${dark[1]}} }\n:root[data-theme="dark"] {${dark[1]}}`);
  css = esc(css);
  const ui = esc(fs.readFileSync(path.join(root, 'portal', 'portal.js'), 'utf8'));
  const template = fs.readFileSync(path.join(root, 'portal-web', 'template.html'), 'utf8');
  const fragment = template.replace('/*CSS*/', () => css).replace('/*ENGINE*/', () => engine).replace('/*UI*/', () => ui);
  for (const m of ['/*CSS*/', '/*ENGINE*/', '/*UI*/']) if (fragment.includes(m) && template.split(m).length > 2) throw new Error('marker repeated: ' + m);
  const standalone = `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n</head>\n<body>\n${fragment}\n</body>\n</html>\n`;
  fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(root, 'dist', 'onsite-portal-demo.fragment.html'), fragment);
  fs.writeFileSync(path.join(root, 'portal-web', 'OnSite-portal-demo.html'), standalone);
  return standalone.length;
}

if (require.main === module) build().then((b) => console.log(`built portal-web/OnSite-portal-demo.html (${Math.round(b / 1024)} KB)`)).catch((e) => { console.error(e.message); process.exit(1); });
module.exports = { build };
