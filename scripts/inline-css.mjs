/* Copies styles.css into index.html so the landing page has no render-blocking
 * stylesheet request. styles.css stays the single source of truth; run
 * `npm run build` after editing it (tests fail if the copy drifts). */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8').trim();
const htmlPath = path.join(root, 'index.html');
const html = fs.readFileSync(htmlPath, 'utf8');

const pattern = /<style id="app-css">[\s\S]*?<\/style>/;
if (!pattern.test(html)) {
  console.error('inline-css: <style id="app-css"> not found in index.html');
  process.exit(1);
}
const next = html.replace(pattern, '<style id="app-css">\n' + css + '\n</style>');

if (next === html) {
  console.log('inline-css: already up to date');
} else {
  fs.writeFileSync(htmlPath, next);
  console.log('inline-css: inlined ' + css.length + ' bytes of CSS into index.html');
}
