/* Сборка единого самодостаточного файла ar-hands-sphere.html.
 *
 * Сеть не используется: UMD-сборку three.js r128 берём из первого <script> боевого
 * gta-city.html (тот же движок, что уже в проекте).
 *
 *   node ar/build.mjs [куда]        (по умолчанию ./ar-hands-sphere.html)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const project = resolve(here, '..');
const out = process.argv[2] ? resolve(process.argv[2]) : join(project, 'ar-hands-sphere.html');

function extractThree(sourceHtml) {
  const s = readFileSync(sourceHtml, 'utf8');
  const a = s.indexOf('<script>');
  const b = s.indexOf('</script>', a);
  if (a < 0 || b < 0) throw new Error('в ' + sourceHtml + ' нет ни одного <script>');
  const code = s.slice(a + 8, b);
  if (!code.includes('THREE') || !/["']128["']/.test(code)) {
    throw new Error('первый <script> в ' + sourceHtml + ' не похож на three.js r128');
  }
  return code;
}

const parts = {
  '/*__THREE__*/': extractThree(join(project, 'gta-city.html')),
  '/*__PHYS__*/': readFileSync(join(here, 'sphere-push.js'), 'utf8'),
  '/*__APP__*/': readFileSync(join(here, 'app.js'), 'utf8')
};

let html = readFileSync(join(here, 'template.html'), 'utf8');
for (const [marker, code] of Object.entries(parts)) {
  if (code.includes('</script>')) throw new Error('«</script>» внутри ' + marker);
  if (!html.includes(marker)) throw new Error('в шаблоне нет маркера ' + marker);
  html = html.replace(marker, () => code);
}

writeFileSync(out, html);
const kb = (n) => (n / 1024).toFixed(0) + ' КБ';
console.log('three.js  ' + kb(parts['/*__THREE__*/'].length));
console.log('физика    ' + kb(parts['/*__PHYS__*/'].length));
console.log('прилож.   ' + kb(parts['/*__APP__*/'].length));
console.log('→ ' + out + '  (' + kb(html.length) + ', ' + html.split('\n').length + ' строк)');
