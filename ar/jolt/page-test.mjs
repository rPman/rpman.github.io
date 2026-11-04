/* Проверка spike-страницы ar-jolt.html в headless-Chrome.
 *
 *   node ar/jolt/page-test.mjs
 *
 * В отличие от ar/page-test.mjs страница грузит ES-модуль (`<script type="module">` +
 * jolt-physics.wasm-compat.js), а модули из file:// Chrome не пускает (CORS, opaque origin).
 * Поэтому каталог раздаётся локальным http-сервером — ровно как на Pages, только короче.
 * Страница сама печатает JSON-отчёт в <pre id="report"> через window.__js, кадры смотрятся
 * скриншотами, а исключения боевого rAF-цикла ловятся в <pre id="shotError">.
 */
import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join, extname, normalize } from 'node:path';
const run = promisify(execFile);

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const pageFile = join(project, 'ar-jolt.html');
if (!existsSync(pageFile)) throw new Error('нет страницы: ' + pageFile);
const TMP = '/tmp/arhands';
mkdirSync(TMP, { recursive: true });
const CH = process.env.CHROME || (process.env.HOME + '/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome');
if (!existsSync(CH)) throw new Error('нет chrome: ' + CH);

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm', '.json': 'application/json', '.map': 'application/json' };

/* ---------------------------------- драйвер проверок --------------------- */
const driver = `
<script>
(async function () {
  var checks = [], exc = null, info0 = null;
  function ok(name, cond, detail) { checks.push({ name: name, ok: !!cond, detail: detail }); }
  var DT = 1 / 72, FR = 0.011, R = 0.075, r = 0.03, PAD = 0.008;
  var T = { x: 0.30, y: 0, z: 0 };                 // центр бублика на сцене
  function one(f) { window.__js.step(1, f); return window.__js.info(); }
  function finger(buf, i, x, y, z) { buf[i * 4] = x; buf[i * 4 + 1] = y; buf[i * 4 + 2] = z; buf[i * 4 + 3] = FR; }
  try {
    // сам модуль появляется быстро; ждём именно его, а не готовности wasm (у неё свой промис)
    for (var w = 0; w < 100 && !(window.__js && window.__js.readyPromise); w++) {
      await new Promise(function (res) { setTimeout(res, 10); });
    }
    var H = window.__js;
    if (!H || !H.readyPromise) throw new Error('страница не объявила window.__js');
    await H.readyPromise;                       // тут реально компилируется wasm, таймеров нет
    if (!H.ready) throw new Error('jolt не поднялся');
    H.freeze(true);                                 // шагаем сами, rAF-цикл не мешает
    H.cfg({ handPad: PAD });
    H.park('sphere', -4, 0, 0);
    H.park('cube', 0, 4, 0);                        // вне кадра: их контакты не мешают паре
    info0 = H.info();

    // A. палец насквозь по оси дырки: материала на пути нет -> контактов быть не должно
    var z = -0.30, touchedAt = null, closest = 9, anInf = null;
    for (var f = 0; f < 240; f++) {
      z += 0.0025;
      var ia = one(function (buf) { finger(buf, 0, T.x, T.y, z); buf[4] = NaN; });
      var t = H.body('torus');
      closest = Math.min(closest, Math.hypot(ia.fingers[0].x - t.x, ia.fingers[0].y - t.y, ia.fingers[0].z - t.z));
      if (touchedAt === null && ia.contacts > 0) { touchedAt = ia.fingers[0].z; anInf = ia; }
    }
    ok('палец проходит сквозь отверстие бублика (в браузере)', touchedAt === null,
      'контактов на пути нет, самое близкое приближение к центру ' + closest.toFixed(4) +
      ' м при дырке ' + (R - r).toFixed(3) + '; шар-прокси дал бы контакт с |z| < 0.109');
    var tA = H.body('torus');
    ok('сквозь дырку бублик не сдвигается', Math.abs(tA.x - T.x) < 1e-3 && Math.abs(tA.z) < 1e-3,
      'тор=' + JSON.stringify({ x: +tA.x.toFixed(4), z: +tA.z.toFixed(4) }));

    // B. контроль на тех же телах: по экватору материал есть — контакт обязан быть
    var x = T.x - 0.30, first = null;
    for (var f2 = 0; f2 < 300 && first === null; f2++) {
      x += 0.001;
      var ib = one(function (buf) { finger(buf, 0, x, T.y, T.z); buf[4] = NaN; });
      if (ib.contacts > 0) {
        var tb = H.body('torus');
        first = { gap: tb.x - ib.fingers[0].x, contacts: ib.contacts, pen: ib.pen };
      }
    }
    ok('контроль: палец цепляет материал бублика', first !== null,
      first === null ? 'контакта нет' : 'зазор=' + first.gap.toFixed(4) +
      ' истина=' + (R + r + FR + PAD).toFixed(4) + ' (граница формы + handPad), pen=' + first.pen.toFixed(4));

    // C. бублик едет за пальцем: зазор = граница формы, скорость = скорость пальца
    var vx = 0.4, vs = 0;
    for (var f3 = 0; f3 < 200; f3++) {
      x += vx * DT;
      var ic = one(function (buf) { finger(buf, 0, x, T.y, T.z); buf[4] = NaN; });
      if (f3 > 170) vs = ic.bodies.filter(function (b) { return b.id === 'torus'; })[0].speed;
    }
    var tc2 = H.body('torus'), fp = H.info().fingers[0];
    ok('бублик поехал за пальцем', tc2.x > T.x + 0.05, 'x=' + tc2.x.toFixed(3));
    ok('зазор рука->бублик = внешняя граница формы',
      Math.abs((tc2.x - fp.x) - (R + r + FR)) < 0.012,
      'зазор=' + (tc2.x - fp.x).toFixed(4) + ' истина=' + (R + r + FR).toFixed(4));
    ok('скорость бублика = скорость пальца', Math.abs(vs - vx) < 0.1, 'v=' + vs.toFixed(3));

    // D. два пальца внахлёст: слой рука<->рука выключен -> ни одного контакта
    var before = H.info().contacts;
    var last = null;
    for (var f4 = 0; f4 < 40; f4++) {
      last = one(function (buf) { finger(buf, 0, -0.1, 0, 0); finger(buf, 1, -0.09, 0, 0); });
    }
    ok('рука<->рука выключена слоями (два пальца внахлёст, контактов нет)',
      last.contacts === 0, 'контактов в кадре ' + last.contacts + ' (до опыта было ' + before + ')');

    // E. точки касания доезжают до сцены: страница рисует их красными шариками
    H.park('torus', T.x, T.y, T.z);              // после C бублик улетел — вернуть на место
    var tx = T.x, eInfo = null;
    for (var f5 = 0; f5 < 6; f5++) {
      // впиться в материал на 4 мм: граница формы + радиус пальца − 0.004
      eInfo = one(function (buf) { finger(buf, 0, tx - (R + r + FR - 0.004), 0, 0); finger(buf, 1, NaN, NaN, NaN); });
    }
    ok('манifold-ы доходят до сцены: контакты и точки касания на месте',
      eInfo.contacts > 0 && H.touchDots() > 0,
      'контактов ' + eInfo.contacts + ', точек нарисовано ' + H.touchDots() +
      ', pen=' + eInfo.pen.toFixed(4));
    ok('всё конечно', H.info().bodies.every(function (b) {
      return isFinite(b.x) && isFinite(b.y) && isFinite(b.z) && isFinite(b.speed); }), JSON.stringify(H.info().bodies));
  } catch (err) {
    exc = String(err && err.stack || err);
  }
  document.getElementById('report').textContent =
    JSON.stringify({ checks: checks, exc: exc, info0: info0 }, null, 1);
})();
<\/script>`;

/* Скриншот «палец в дырке»: боевой цикл страницы, курсор наведён в центр отверстия бублика. */
const shotDriver = `
<script>
  window.addEventListener('error', function (e) {
    var d = document.createElement('pre');
    d.id = 'shotError';
    d.textContent = e.message + ' @ ' + e.filename + ':' + e.lineno;
    document.body.appendChild(d);
  });
  window.addEventListener('load', function () {
    var cv = document.querySelector('canvas');
    var t = 0;
    setInterval(function () {
      t += 0.03;
      var x = window.innerWidth * (0.672 + 0.003 * Math.sin(t));   // мир x=0.30 = центр бублика
      var y = window.innerHeight * 0.5;
      cv.dispatchEvent(new PointerEvent('pointermove', { clientX: x, clientY: y, bubbles: true }));
    }, 16);
  });
<\/script>`;

/* Диагностика кадра: рисует ли рендерер вообще и видны ли фигуры. Скриншот сам по себе
 * ни о чём не говорит — чёрным он бывает и при пустом рендере, и когда камера мимо. */
const diagDriver = `
<script>
(async function () {
  var checks = [], exc = null;
  function ok(name, cond, detail) { checks.push({ name: name, ok: !!cond, detail: detail }); }
  try {
    for (var w = 0; w < 100 && !(window.__js && window.__js.readyPromise); w++) {
      await new Promise(function (r) { setTimeout(r, 10); });
    }
    var H = window.__js;
    if (!H || !H.readyPromise) throw new Error('страница не объявила window.__js');
    await H.readyPromise;
    var p = await H.painted();                                   // свой кадр, без rAF
    var d = H.diag();
    ok('рендерер рисует сцену', d.calls > 0 && d.tris > 0, JSON.stringify(d));
    ok('на кадре есть фигуры (кадр не прозрачный)',
      p.n > 0 && p.lit / p.n > 0.01,
      'закрашено ' + p.lit + ' из ' + p.n + (p.n ? ' = ' + (100 * p.lit / p.n).toFixed(1) + '%' : ''));
  } catch (e) { exc = String(e && e.stack || e); }
  document.getElementById('report').textContent = JSON.stringify({ checks: checks, exc: exc }, null, 1);
})();
<\/script>`;

/* ---------------------------------- http-сервер -------------------------- */
const html = readFileSync(pageFile, 'utf8');
const pages = {
  '/spike-test.html': html.replace('</body>', driver + '\n</body>'),
  '/spike-shot.html': html.replace('</body>', shotDriver + '\n</body>'),
  '/spike-diag.html': html.replace('</body>', diagDriver + '\n</body>'),
};
const server = createServer((req, res) => {
  const path = decodeURIComponent(req.url.split('?')[0]);
  let body, type;
  if (pages[path]) { body = Buffer.from(pages[path]); type = MIME['.html']; }
  else {
    const abs = normalize(join(project, path));
    if (!abs.startsWith(project) || !existsSync(abs)) { res.writeHead(404); res.end('нет ' + path); return; }
    body = readFileSync(abs);
    type = MIME[extname(abs)] || 'application/octet-stream';
  }
  res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = 'http://127.0.0.1:' + server.address().port;

const flags = ['--headless=new', '--no-sandbox', '--disable-gpu-sandbox',
  '--enable-unsafe-swiftshader', '--use-angle=swiftshader'];
// СИНХРОННЫЙ запуск chrome нельзя: http-сервер живёт в этом же процессе и должен отвечать
// на запросы страницы, иначе взаимное ожидание (страница ждёт скрипт, скрипт ждёт chrome).
async function chrome(extra) {
  const { stdout } = await run(CH, flags.concat(extra), { maxBuffer: 1 << 26, timeout: 120000 });
  return stdout;
}

let dom;
try {
  dom = await chrome(['--virtual-time-budget=60000', '--dump-dom', base + '/spike-test.html']);
} catch (err) {
  console.log('FAIL не удалось запустить chrome: ' + String(err).slice(0, 400));
  server.close();
  process.exit(1);
}
const m = dom.match(/<pre id="report"[^>]*>([\s\S]*?)<\/pre>/);
if (!m) {
  console.log('FAIL в дампе нет отчёта. Фрагмент DOM:\n' + dom.slice(0, 2000));
  process.exit(1);
}
const rep = JSON.parse(m[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
let fails = 0;
for (const c of rep.checks) {
  console.log((c.ok ? 'ok   ' : 'FAIL ') + c.name + '   [' + c.detail + ']');
  if (!c.ok) fails++;
}
if (rep.exc) { console.log('FAIL исключение: ' + rep.exc); fails++; }
if (!rep.info0 || rep.info0.numBodies < 5) {
  console.log('FAIL фигур в мире меньше, чем должно быть: ' + JSON.stringify(rep.info0));
  fails++;
} else console.log('ok   мир собран: тел ' + rep.info0.numBodies + ', фигур ' + rep.info0.bodies.length);

for (const [pg, png] of [['/ar-jolt.html', 'jolt_start.png'], ['/spike-shot.html', 'jolt_hole.png']]) {
  try {
    await chrome(['--window-size=1280,720', '--virtual-time-budget=25000',
      '--screenshot=' + join(TMP, png), base + pg]);
    const kb = readFileSync(join(TMP, png)).length / 1024;
    console.log('скриншот: ' + join(TMP, png) + ' (' + kb.toFixed(0) + ' КБ)');
    if (kb < 8) { console.log('FAIL скриншот почти пустой — кадр не отрисован'); fails++; }
  } catch (err) {
    console.log('FAIL не удалось снять ' + png + ': ' + String(err).slice(0, 200));
    fails++;
  }
}
try {
  const shotDom = await chrome(['--virtual-time-budget=20000', '--dump-dom', base + '/spike-shot.html']);
  const shotErr = shotDom.match(/<pre id="shotError"[^>]*>([\s\S]*?)<\/pre>/);
  if (shotErr) { console.log('FAIL кадр превью бросает исключение: ' + shotErr[1]); fails++; }
  else console.log('боевой кадр: в rAF-цикле исключений нет');
} catch (err) {
  console.log('FAIL не удалось проверить боевой кадр: ' + String(err).slice(0, 200));
  fails++;
}

try {
  const diagDom = await chrome(['--virtual-time-budget=30000', '--dump-dom', base + '/spike-diag.html']);
  const dm = diagDom.match(/<pre id="report"[^>]*>([\s\S]*?)<\/pre>/);
  if (!dm || !dm[1].trim()) { console.log('FAIL диагностика кадра ничего не сообщила'); fails++; }
  else {
    const drep = JSON.parse(dm[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
    for (const c of drep.checks) {
      console.log((c.ok ? 'ok   ' : 'FAIL ') + c.name + '   [' + c.detail + ']');
      if (!c.ok) fails++;
    }
    if (drep.exc) { console.log('FAIL исключение в диагностике: ' + drep.exc); fails++; }
  }
} catch (err) {
  console.log('FAIL не удалось снять диагностику кадра: ' + String(err).slice(0, 200));
  fails++;
}

server.close();
console.log(fails ? '\n' + fails + ' FAIL' : '\nall passed');
process.exit(fails ? 1 : 0);
