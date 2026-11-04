/* Ставит дату последней модификации каждой страницы перед ссылкой в index.html.
 *
 *   node ar/index-stamp.mjs
 *
 * Смысл: между `git push` и тем, как GitHub Pages отдаст новые файлы, проходит несколько
 * минут. По метке видно, какую именно сборку уже отдаёт Pages: метка обновилась — значит
 * перезастройка дошла.
 *
 * Метка = самый свежий коммит среди самой страницы И её скриптов (`<script src>`): правка
 * только `ar/jolt/ar-page.js` тоже меняет страницу, и иначе метка стояла бы на месте,
 * хотя публикация уже новая. Для файла, которого в git ещё нет, — время модификации на
 * диске. Скрипт идемпотентен: правит только span.stamp перед ссылкой, остальной текст
 * страницы — источник истины и остаётся как есть.
 */
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join, normalize } from 'node:path';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const indexPath = resolve(project, 'index.html');

function pad(n) { return String(n).padStart(2, '0'); }
function fmt(d) {
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
    ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

// Что тянет страница, кроме себя самой: соседние классические скрипты и модули.
function depsOf(rel) {
  const abs = resolve(project, rel);
  if (!existsSync(abs)) return [];
  return [...readFileSync(abs, 'utf8').matchAll(/<script[^>]*\bsrc="([^"]+)"/g)]
    .map((m) => normalize(join(dirname(rel), m[1])))
    .filter((p) => existsSync(resolve(project, p)));
}

// Время последнего касания файла: коммит, иначе mtime. Возвращает epoch в мс.
function touchedAt(rel) {
  let out = '';
  try {
    out = execFileSync('git', ['log', '-1', '--format=%ct', '--', rel],
      { cwd: project, encoding: 'utf8' }).trim();
  } catch (e) { out = ''; }
  if (out) return Number(out) * 1000;
  const abs = resolve(project, rel);
  return existsSync(abs) ? statSync(abs).mtimeMs : 0;
}

function newest(files) {
  let best = 0, bestFile = null;
  for (const f of files) {
    const t = touchedAt(f);
    if (t > best) { best = t; bestFile = f; }
  }
  return best ? { stamp: fmt(new Date(best)), by: bestFile } : null;
}

let html = readFileSync(indexPath, 'utf8');
const pages = [...new Set([...html.matchAll(/<a href="([^"]+\.html)"/g)].map((m) => m[1]))];
const report = [];
for (const rel of pages) {
  const info = newest([rel, ...depsOf(rel)]);
  if (!info) { report.push({ page: rel, stamp: null, note: 'нет ни в git, ни на диске' }); continue; }
  // Блок этой ссылки: <a href="…">…</a>. Перед ним обязан стоять span.stamp.
  const link = new RegExp('(<a href="' + rel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '")');
  if (!link.test(html)) continue;
  const before = html.slice(0, html.search(link));
  const after = html.slice(html.search(link));
  const cleaned = before.replace(/(?:<span class="stamp">[^<]*<\/span>\s*)+$/, '');
  html = cleaned + '<span class="stamp">' + info.stamp + '</span> ' + after;
  report.push({ page: rel, stamp: info.stamp, by: info.by });
}
writeFileSync(indexPath, html);
console.log(JSON.stringify({ file: 'index.html', updated: report }, null, 1));
