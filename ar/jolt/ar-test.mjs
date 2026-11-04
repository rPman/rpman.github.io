/* Проверка AR-страницы ar-jolt-ar.html в headless-Chrome.
 *
 *   node ar/jolt/ar-test.mjs
 *
 * Иммерсивную сессию headless-Chrome не даёт (isSessionSupported → false), поэтому здесь
 * проверяется всё, что не требует шлема: мир собран, формы честные, палец проходит сквозь
 * отверстие и вводит шарик в кольцо, торможение и поводок не дают телу улететь, проба AR
 * не падает, кадр рисуется. Сам вход в AR и руки — только живой тест на шлеме.
 *
 * Отладочный луч на yokko.duckdns.org тестом ВЫКЛЮЧЕН: иначе прогоны замусоривают чужой
 * nginx access log.
 */
import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join, extname, normalize } from 'node:path';
const run = promisify(execFile);

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const pageFile = join(project, 'ar-jolt-ar.html');
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
  var DT = 1 / 72, FR = 0.011, R = 0.11, tube = 0.025, PAD = 0.008, LEASH = 0.9;
  function one(f) { window.__ja.step(1, f); return window.__ja.info(); }
  function fin(buf, i, x, y, z) { buf[i * 4] = x; buf[i * 4 + 1] = y; buf[i * 4 + 2] = z; buf[i * 4 + 3] = FR; }
  function off(buf, i) { buf[i * 4] = NaN; }
  try {
    for (var w = 0; w < 100 && !(window.__ja && window.__ja.readyPromise); w++) {
      await new Promise(function (res) { setTimeout(res, 10); });
    }
    var H = window.__ja;
    if (!H || !H.readyPromise) throw new Error('страница не объявила window.__ja');
    await H.readyPromise;                        // тут реально компилируется wasm, таймеров нет
    if (!H.ready) throw new Error('jolt не поднялся');
    H.cfg({ beacon: false, handPad: PAD, leash: 5 });   // поводок на время контактов снимаем
    H.freeze(true);
    H.park('sphere', -4, 0, 0);
    H.park('cube', 4, 0, 0);
    info0 = H.info();

    ok('проба AR не падает: в headless кнопка выключена',
      document.getElementById('enterAR').disabled === true,
      'кнопка: ' + JSON.stringify(document.getElementById('enterAR').textContent));

    // A. палец насквозь по оси кольца: материала на пути нет, контактов не будет
    var z = -0.35, touchedAt = null, closest = 9;
    for (var a = 0; a < 280; a++) {
      z += 0.0025;
      var ia = one(function (buf) { fin(buf, 0, 0, 0, z); off(buf, 1); });
      closest = Math.min(closest, Math.hypot(ia.fingers[0].x, ia.fingers[0].y));
      if (touchedAt === null && ia.contacts > 0) touchedAt = z;
    }
    var tA = H.body('torus');
    ok('палец проходит сквозь отверстие кольца', touchedAt === null,
      'контактов на пути нет; ось кольца пройдена на ' + closest.toFixed(4) +
      ' м от центра при дырке ' + (R - tube).toFixed(3) + ' м');
    ok('сквозь дырку кольцо не сдвигается', Math.abs(tA.x) < 1e-3 && Math.abs(tA.z) < 1e-3,
      'кольцо=' + JSON.stringify({ x: +tA.x.toFixed(4), z: +tA.z.toFixed(4) }));

    // B. контроль на тех же телах: по экватору материал есть, контакт обязан быть
    var x = -0.55, first = null;
    for (var b = 0; b < 400 && first === null; b++) {
      x += 0.001;
      var ib = one(function (buf) { fin(buf, 0, x, 0, 0); off(buf, 1); });
      if (ib.contacts > 0) first = { gap: H.body('torus').x - ib.fingers[0].x, contacts: ib.contacts };
    }
    ok('контроль: палец цепляет материал кольца', first !== null,
      first === null ? 'контакта нет' : 'зазор=' + first.gap.toFixed(4) +
      ' истина=' + (R + tube + FR + PAD).toFixed(4) + ' (граница формы + handPad)');

    // C. кольцо едет за пальцем: зазор = внешняя граница формы, скорость = скорость пальца
    var vx = 0.4, vs = 0;
    for (var c = 0; c < 200; c++) {
      x += vx * DT;
      var ic = one(function (buf) { fin(buf, 0, x, 0, 0); off(buf, 1); });
      if (c > 170) vs = ic.bodies.filter(function (q) { return q.id === 'torus'; })[0].speed;
    }
    var tc2 = H.body('torus'), ic2 = H.info();
    ok('кольцо поехало за пальцем', tc2.x > 0.05, 'x=' + tc2.x.toFixed(3));
    ok('зазор палец->кольцо = внешняя граница формы',
      Math.abs((tc2.x - ic2.fingers[0].x) - (R + tube + FR)) < 0.012,
      'зазор=' + (tc2.x - ic2.fingers[0].x).toFixed(4) + ' истина=' + (R + tube + FR).toFixed(4));
    ok('скорость кольца = скорость пальца', Math.abs(vs - vx) < 0.1, 'v=' + vs.toFixed(3));

    // D. главное обещание веб-версии: тело НЕ улетает за экран. Возвращаем поводок и тащим
    // шарик на полной скорости: без поводка он ушёл бы на 6+ метров. Шарик, а не кольцо,
    // потому что толчок в трубку кольца даёт момент и кольцо уводит во вращение.
    H.cfg({ leash: LEASH });
    H.park('torus', 0, 3, 0);
    H.park('sphere', 0, 0, 0);
    var fz = -(0.35 + 0.035 + FR), maxD = 0, pressed = 0;
    for (var d = 0; d < 300; d++) {
      fz += 2.5 * DT;
      var id2 = one(function (buf) { fin(buf, 0, 0, 0, fz); off(buf, 1); });
      var sq = id2.bodies.filter(function (q) { return q.id === 'sphere'; })[0];
      maxD = Math.max(maxD, sq.leash);
      if (sq.contacts > 0) pressed++;
    }
    ok('пинок не выносит тело за экран: поводок держит', maxD <= LEASH + 0.012,
      'максимум от якоря ' + maxD.toFixed(3) + ' м при поводке ' + LEASH +
      ' м; кадров с контактом ' + pressed + ' из 300');
    ok('и тело действительно упёрлось в поводок', maxD > LEASH - 0.05,
      'максимум ' + maxD.toFixed(3) + ' м — толкало, но дальше не пустило');
    // палец убран: торможение должно погасить движение примерно за секунду
    var vAfter = 0;
    for (var d2 = 0; d2 < 72; d2++) {
      var inf3 = one(function (buf) { off(buf, 0); off(buf, 1); });
      vAfter = inf3.bodies.filter(function (q) { return q.id === 'sphere'; })[0].speed;
    }
    ok('торможение гасит движение', vAfter < 0.05,
      'скорость через 1 с после отрыва: ' + vAfter.toFixed(4) + ' м/с (damping 6 1/с)');

    // E. place() — «перед собой»: якоря и тела совпадают
    H.place();
    var inf2 = H.info(), worst = 0;
    for (var e = 0; e < inf2.bodies.length; e++) worst = Math.max(worst, inf2.bodies[e].leash);
    ok('перенос «перед собой» ставит тела ровно в якоря', worst < 1e-3 && inf2.bodies.length === 3,
      'самое большое расстояние от якоря ' + worst.toExponential(1) + ' м');

    // F. отладочный вывод жив и луч молчал
    var rep = null, repErr = null;
    try { rep = JSON.parse(H.report()); } catch (err) { repErr = String(err); }
    ok('отчёт для шлема разбирается', rep && rep.bodies.length === 3 && rep.anchors.length === 3,
      repErr || ('perf=' + H.perf() + ' ; луч отправлено ' + H.sent()));
    ok('луч отладки в тесте выключен', H.sent() === 0, 'отправлено ' + H.sent());
    ok('всё конечно', inf2.bodies.every(function (q) {
      return isFinite(q.x) && isFinite(q.y) && isFinite(q.z) && isFinite(q.speed) && isFinite(q.leash); }),
      JSON.stringify(inf2.bodies));
  } catch (err) {
    exc = String(err && err.stack || err);
  }
  document.getElementById('report').textContent =
    JSON.stringify({ checks: checks, exc: exc, info0: info0 }, null, 1);
})();
<\/script>`;

/* Скриншот «шарик внутри кольца». Курсор в превью двигает палец только в плоскости, а ось
 * кольца смотрит на камеру (это и есть жалоба на веб-версию), поэтому кадр собирается ручными
 * шагами физики: палец становится за шариком и толкает его вдоль оси кольца (+z). rAF в
 * headless делает ~1 кадр в секунду, курсорного разгона туда просто не помещается. */
const shotDriver = `
<script>
  window.addEventListener('error', function (e) {
    var d = document.createElement('pre');
    d.id = 'shotError';
    d.textContent = e.message + ' @ ' + e.filename + ':' + e.lineno;
    document.body.appendChild(d);
  });
  window.addEventListener('load', function () {
    document.getElementById('preview').click();
    (async function () {
      var H = window.__ja;
      for (var w = 0; w < 200 && !(H && H.readyPromise); w++) {
        await new Promise(function (r) { setTimeout(r, 20); });
      }
      await H.readyPromise;
      H.cfg({ beacon: false });
      H.freeze(true);                                  // шагаем сами, rAF только рисует
      var BR = 0.035, FR = 0.011;
      H.park('sphere', 0, 0, -0.30);                   // шарик на оси кольца, за кольцом
      var z = -0.30 - BR - FR - 0.03;                  // палец за шариком
      for (var s = 0; s < 190; s++) {
        z += 0.002;                                    // 0.14 м/с — толкаем плавно
        (function (zz) {
          H.step(1, function (buf) {
            buf[0] = 0; buf[1] = 0; buf[2] = zz; buf[3] = FR; buf[4] = NaN;
          });
        })(z);
      }
      var b = H.info().bodies.filter(function (q) { return q.id === 'sphere'; })[0];
      var n = document.getElementById('report');
      n.textContent = 'шарик z=' + b.z.toFixed(4) + ' x=' + b.x.toFixed(4) +
        ' y=' + b.y.toFixed(4) + ' контактов ' + b.contacts;
      n.style.display = 'none';            // скриншот без отладочной строки, DOM всё равно с ней
    })();
  });
<\/script>`;

/* Диагностика кадра: рисует ли рендерер вообще. Чёрный кадр сам по себе ни о чём не говорит. */
const diagDriver = `
<script>
(async function () {
  var checks = [], exc = null;
  function ok(name, cond, detail) { checks.push({ name: name, ok: !!cond, detail: detail }); }
  try {
    for (var w = 0; w < 100 && !(window.__ja && window.__ja.readyPromise); w++) {
      await new Promise(function (r) { setTimeout(r, 10); });
    }
    var H = window.__ja;
    if (!H || !H.readyPromise) throw new Error('страница не объявила window.__ja');
    await H.readyPromise;
    H.cfg({ beacon: false });
    var p = H.painted();
    var d = H.diag();
    ok('рендерер рисует сцену', d.calls >= 3 && d.tris > 0, JSON.stringify(d));
    ok('на кадре есть фигуры (кадр не прозрачный)',
      p.n > 0 && p.lit / p.n > 0.004,
      'закрашено ' + p.lit + ' из ' + p.n + (p.n ? ' = ' + (100 * p.lit / p.n).toFixed(2) + '%' : ''));
  } catch (e) { exc = String(e && e.stack || e); }
  document.getElementById('report').textContent = JSON.stringify({ checks: checks, exc: exc }, null, 1);
})();
<\/script>`;

/* ---------------------------------- http-сервер -------------------------- */
const html = readFileSync(pageFile, 'utf8');
const pages = {
  '/ar-test.html': html.replace('</body>', driver + '\n</body>'),
  '/ar-shot.html': html.replace('</body>', shotDriver + '\n</body>'),
  '/ar-diag.html': html.replace('</body>', diagDriver + '\n</body>'),
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
  '--enable-unsafe-swiftshader', '--use-angle=swiftshader',
  // Без этих четырёх rAF в headless выдаёт 2 кадра на 30 с виртуального времени, с ними —
  // 18 (замер на этой машине: raf 6→19, кадров страницы 2→18). Живой цикл страницы проверяется
  // именно тактом rAF, поэтому троттлинг сюда прямо противопоказан.
  '--disable-gpu-vsync', '--disable-frame-rate-limit',
  '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
  '--disable-background-timer-throttling'];
// СИНХРОННЫЙ запуск chrome нельзя: http-сервер живёт в этом же процессе и должен отвечать
// на запросы страницы, иначе взаимное ожидание.
async function chrome(extra) {
  const { stdout } = await run(CH, flags.concat(extra), { maxBuffer: 1 << 26, timeout: 180000 });
  return stdout;
}
function parseReport(dom) {
  const m = dom.match(/<pre id="report"[^>]*>([\s\S]*?)<\/pre>/);
  if (!m) return null;
  return JSON.parse(m[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
}

let fails = 0;
let dom = '';
try {
  dom = await chrome(['--virtual-time-budget=90000', '--dump-dom', base + '/ar-test.html']);
} catch (err) {
  console.log('FAIL не удалось запустить chrome: ' + String(err).slice(0, 400));
  server.close();
  process.exit(1);
}
let rep = null;
writeFileSync(join(TMP, 'ar_dom.html'), dom);      // полный дамп: без него пустой отчёт ни о чём не говорит
try {
  rep = parseReport(dom);
} catch (err) {
  console.log('FAIL отчёт не разбирается: ' + err);
}
if (!rep || !rep.checks) {
  const pageErr = dom.match(/<pre id="shotError"[^>]*>([\s\S]*?)<\/pre>/);
  console.log('FAIL в дампе нет отчёта проверок.');
  if (pageErr) console.log('исключение страницы: ' + pageErr[1].slice(0, 1500));
  console.log('фрагмент DOM:\n' + dom.slice(0, 3000));
  server.close();
  process.exit(1);
}
for (const c of rep.checks) {
  console.log((c.ok ? 'ok   ' : 'FAIL ') + c.name + '   [' + c.detail + ']');
  if (!c.ok) fails++;
}
if (rep.exc) { console.log('FAIL исключение: ' + rep.exc); fails++; }
if (!rep.info0 || rep.info0.numBodies < 5 || rep.info0.bodies.length !== 3) {
  console.log('FAIL мир собран неправильно: ' + JSON.stringify(rep.info0));
  fails++;
} else console.log('ok   мир собран: тел ' + rep.info0.numBodies + ', фигур ' + rep.info0.bodies.length);

for (const [pg, png, budget] of [['/ar-jolt-ar.html', 'ar_start.png', 20000],
                                 ['/ar-shot.html', 'ar_ball_in_ring.png', 70000]]) {
  try {
    await chrome(['--window-size=1280,720', '--virtual-time-budget=' + budget,
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
  const shotDom = await chrome(['--virtual-time-budget=25000', '--dump-dom', base + '/ar-shot.html']);
  const shotErr = shotDom.match(/<pre id="shotError"[^>]*>([\s\S]*?)<\/pre>/);
  if (shotErr) { console.log('FAIL кадр превью бросает исключение: ' + shotErr[1]); fails++; }
  else console.log('боевой кадр: в цикле.setAnimationLoop исключений нет');
  // Тем же прогоном проверяем то, ради чего скриншот: шарик действительно внутри кольца.
  const note = shotDom.match(/<pre id="report"[^>]*>([\s\S]*?)<\/pre>/);
  const num = note && [...note[1].matchAll(/-?\d+\.\d+/g)].map((m) => +m[0]);
  const inHole = num && num.length >= 3 && Math.abs(num[1]) < 0.02 && Math.abs(num[2]) < 0.02 &&
    Math.abs(num[0]) < 0.06;
  console.log((inHole ? 'ok   ' : 'FAIL ') + 'шарик введён вдоль оси кольца' +
    '   [' + (note ? note[1].trim() : 'страница ничего не сообщила') + ']');
  if (!inHole) fails++;
} catch (err) {
  console.log('FAIL не удалось проверить боевой кадр: ' + String(err).slice(0, 200));
  fails++;
}

try {
  const diagDom = await chrome(['--virtual-time-budget=40000', '--dump-dom', base + '/ar-diag.html']);
  const drep = parseReport(diagDom);
  if (!drep) { console.log('FAIL диагностика кадра ничего не сообщила'); fails++; }
  else {
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
