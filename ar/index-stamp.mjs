/* Ставит дату последней модификации каждой страницы перед ссылкой в index.html.
 *
 *   node ar/index-stamp.mjs
 *
 * Смысл: между `git push` и тем, как GitHub Pages отдаст новые файлы, проходит несколько
 * минут. По метке видно, какую именно сборку уже отдаёт Pages: метка обновилась — значит
 * перезастройка дошла.
 *
 * Метка берётся из последнего коммита, который трогал файл (`git log -1` по пути): именно
 * это состояние и публикуется. Для файла, которого в git ещё нет, — время модификации на
 * диске. Скрипт идемпотентен: правит только span.stamp перед ссылкой, остальной текст
 * страницы — источник истины и остаётся как есть.
 */
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const indexPath = resolve(project, 'index.html');

function pad(n) { return String(n).padStart(2, '0'); }
function fmt(d) {
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
    ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

function lastTouched(rel) {
  let out = '';
  try {
    out = execFileSync('git', ['log', '-1', '--format=%cd', '--date=format:%Y-%m-%d %H:%M',
      '--', rel], { cwd: project, encoding: 'utf8' }).trim();
  } catch (e) { out = ''; }
  if (out) return out;
  const abs = resolve(project, rel);
  return existsSync(abs) ? fmt(new Date(statSync(abs).mtimeMs)) : null;
}

let html = readFileSync(indexPath, 'utf8');
const pages = [...new Set([...html.matchAll(/<a href="([^"]+\.html)"/g)].map((m) => m[1]))];
const report = [];
for (const rel of pages) {
  const stamp = lastTouched(rel);
  if (!stamp) { report.push({ page: rel, stamp: null, note: 'нет ни в git, ни на диске' }); continue; }
  // Блок этой ссылки: <a href="…">…</a>. Перед ним обязан стоять span.stamp.
  const link = new RegExp('(<a href="' + rel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '")');
  if (!link.test(html)) continue;
  const before = html.slice(0, html.search(link));
  const after = html.slice(html.search(link));
  const cleaned = before.replace(/(?:<span class="stamp">[^<]*<\/span>\s*)+$/, '');
  html = cleaned + '<span class="stamp">' + stamp + '</span> ' + after;
  report.push({ page: rel, stamp });
}
writeFileSync(indexPath, html);
console.log(JSON.stringify({ file: 'index.html', updated: report }, null, 1));
