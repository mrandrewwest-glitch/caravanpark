#!/usr/bin/env node
'use strict';

// Builds the browser demo. Bundles the real engine (demo-web/engine-entry.js) with esbuild and inlines it into
// demo-web/template.html. Outputs:
//   demo-web/OnSite-demo.html     standalone page (open it in a browser, or host it anywhere)
//   dist/onsite-demo.fragment.html  same page without <html>/<head>/<body>, for publishing as an Artifact
const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

const root = path.join(__dirname, '..');
const shims = path.join(root, 'demo-web', 'shims');

async function build() {
  const out = await esbuild.build({
    entryPoints: [path.join(root, 'demo-web', 'engine-entry.js')],
    bundle: true, minify: true, format: 'iife', globalName: 'OnSiteEngine', platform: 'browser', target: 'es2020', write: false,
    inject: [path.join(shims, 'globals.js')],
    alias: { crypto: path.join(shims, 'crypto.js'), fs: path.join(shims, 'empty.js') },
    legalComments: 'none', logLevel: 'warning',
  });
  const engine = out.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
  const template = fs.readFileSync(path.join(root, 'demo-web', 'template.html'), 'utf8');
  if (!template.includes('/*ENGINE*/')) throw new Error('template.html is missing the /*ENGINE*/ marker');
  const fragment = template.replace('/*ENGINE*/', () => engine);
  const standalone = `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n</head>\n<body>\n${fragment}\n</body>\n</html>\n`;
  fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(root, 'dist', 'onsite-demo.fragment.html'), fragment);
  fs.writeFileSync(path.join(root, 'demo-web', 'OnSite-demo.html'), standalone);
  return { engineBytes: engine.length, standaloneBytes: standalone.length };
}

if (require.main === module) {
  build().then((r) => console.log(`built demo-web/OnSite-demo.html (${Math.round(r.standaloneBytes / 1024)} KB; engine ${Math.round(r.engineBytes / 1024)} KB)`)).catch((e) => { console.error(e.message); process.exit(1); });
}
module.exports = { build };
