/* Dev-инструмент: гоняет страницу через CDP на уже запущенном Chrome (127.0.0.1:9222).
 *
 *   node ar/jolt/cdp.mjs /ar-jolt-ar.html                 — просто поднять страницу
 *   node ar/jolt/cdp.mjs /ar-jolt-ar.html "__ja.info()"    — вычислить и напечатать JSON
 *   node ar/jolt/cdp.mjs /ar-jolt-ar.html "..." --shot /tmp/arhands/cdp.png
 *   node ar/jolt/cdp.mjs ... --keep                        — не закрывать вкладку
 *
 * Смысл: headless-Chrome на этой машине без GPU даёт ~2 кадра в секунду, а живой rAF-цикл —
 * как раз то, что проверяется. Здесь кадры настоящие, вкладка своя, чужие не трогаются.
 * Каталог проекта при этом раздаётся локальным http-сервером: ES-модули из file:// не грузятся.
 */
import { createServer } from 'node:http';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join, normalize, extname } from 'node:path';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const argv = process.argv.slice(2);
// Первый аргумент — либо путь внутри каталога проекта (тогда поднимется локальный http-сервер),
// либо готовый URL целиком: опубликованную страницу тоже надо уметь проверить живым браузером.
const external = argv[0] && /^https?:\/\//.test(argv[0]);
const pagePath = external ? argv[0]
  : (argv[0] && argv[0].startsWith('/') ? argv[0] : '/ar-jolt-ar.html');
const expr = argv[1] && !argv[1].startsWith('--') ? argv[1] : null;
const shotAt = argv.indexOf('--shot');
const shot = shotAt >= 0 ? argv[shotAt + 1] : null;
// Свою вкладку по умолчанию закрываем (иначе от прогонов их становится десятки), --keep
// оставляет открытой: рядом монитор, на кадр можно посмотреть живьём.
const keep = argv.includes('--keep');
// --pointer: гоняет превью живыми мышью-событиями (Input.dispatchMouseEvent). Headless так не
// умеет: rAF там ~3 к/с, а курсор пишется именно в боевом цикле.
const pointerSweep = argv.includes('--pointer');
const CDP = process.env.CDP || 'http://127.0.0.1:9222';

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm', '.json': 'application/json', '.map': 'application/json',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png' };
let server = null, url = pagePath;
if (!external) {
  // Браузер может быть не на этой машине (CDP проброшен туннелем), поэтому сервер обязан
  // слушать адрес, доступный ОТТУДА: SRV_HOST=192.168.254.11 node ar/jolt/cdp.mjs …
  const SRV_HOST = process.env.SRV_HOST || '127.0.0.1';
  server = createServer((req, res) => {
    const p = decodeURIComponent(req.url.split('?')[0]);
    const abs = normalize(join(project, p));
    if (!abs.startsWith(project) || !existsSync(abs)) { res.writeHead(404); res.end('нет ' + p); return; }
    res.writeHead(200, { 'content-type': MIME[extname(abs)] || 'application/octet-stream',
      'cache-control': 'no-store' });
    res.end(readFileSync(abs));
  });
  await new Promise((r) => server.listen(0, SRV_HOST, r));
  url = 'http://' + SRV_HOST + ':' + server.address().port + pagePath;
}

/* ------------------------------- CDP по минимуму ------------------------- */
async function target() {
  // Своя вкладка: /json/new в свежем Chrome требует PUT, а не GET.
  const created = await fetch(CDP + '/json/new?' + encodeURIComponent('about:blank'),
    { method: 'PUT' });
  const t = await created.json();
  if (!t.webSocketDebuggerUrl) throw new Error('не удалось открыть вкладку: ' + JSON.stringify(t));
  return t;
}
const t = await target();
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let id = 0;
const pending = new Map();
const events = [];
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && pending.has(msg.id)) {
    const { res, rej } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
  } else if (msg.method) events.push(msg);
};
function send(method, params) {
  return new Promise((res, rej) => {
    const my = ++id;
    pending.set(my, { res, rej });
    ws.send(JSON.stringify({ id: my, method, params: params || {} }));
  });
}
const waitEvent = (name, ms) => new Promise((res, rej) => {
  const t0 = Date.now();
  const iv = setInterval(() => {
    if (events.some((e) => e.method === name)) { clearInterval(iv); res(true); }
    else if (Date.now() - t0 > ms) { clearInterval(iv); rej(new Error('нет ' + name + ' за ' + ms + ' мс')); }
  }, 20);
});

await send('Page.enable');
await send('Runtime.enable');
await send('Log.enable').catch(() => {});
await send('Page.navigate', { url });
await waitEvent('Page.loadEventFired', 30000);

/* Консоль страницы наружу: без неё «страница не поднялась» ни о чём не говорит. */
function flushConsole() {
  const lines = [];
  for (const e of events) {
    if (e.method === 'Runtime.consoleAPICalled') {
      lines.push('[консоль ' + e.params.type + '] ' + e.params.args
        .map((a) => a.value !== undefined ? a.value : (a.description || a.type)).join(' '));
    } else if (e.method === 'Runtime.exceptionThrown') {
      lines.push('[исключение] ' + (e.params.exceptionDetails.exception &&
        e.params.exceptionDetails.exception.description || e.params.exceptionDetails.text));
    } else if (e.method === 'Log.entryAdded') {
      lines.push('[лог ' + e.params.entry.source + '/' + e.params.entry.level + '] ' +
        e.params.entry.text + (e.params.entry.url ? '  ' + e.params.entry.url : ''));
    }
  }
  events.length = 0;
  return lines;
}

async function evalJs(expression, awaitPromise) {
  const r = await send('Runtime.evaluate',
    { expression, awaitPromise: !!awaitPromise, returnByValue: true });
  if (r.exceptionDetails) throw new Error('в странице: ' +
    (r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text));
  return r.result.value;
}

/* Ждём, пока страница поднимет Jolt (wasm-compat раскод base64 и компилирует ~2 с) */
const ready = await evalJs(`(async () => {
  for (let i = 0; i < 300 && !(window.__ja && window.__ja.readyPromise); i++)
    await new Promise((r) => setTimeout(r, 20));
  if (!window.__ja) return 'нет window.__ja';
  await window.__ja.readyPromise;
  return window.__ja.ready ? 'ready' : 'не поднялся';
})()`, true);
console.log('страница: ' + ready + '   (' + url + ')');
for (const line of flushConsole()) console.log(line);

if (ready === 'ready') {
  /* Пропускная способность кадров — то, ради чего всё это. */
  const fps = await evalJs(`(async () => {
    const d0 = window.__ja.diag(), t0 = performance.now();
    await new Promise((r) => setTimeout(r, 3000));
    const d1 = window.__ja.diag();
    return { fps: ((d1.frames - d0.frames) / ((performance.now() - t0) / 1000)).toFixed(1),
      calls: d1.calls, tris: d1.tris, perf: window.__ja.perf() };
  })()`, true);
  console.log('кадры: ' + JSON.stringify(fps));

  /* Цена шага с полным скелетом. В headless это не померить: --dump-dom живёт на виртуальном
   * времени, и внутри синхронного цикла часы стоят (люббая работа = 0 мс). Здесь часы настоящие. */
  const cost = await evalJs(`(() => {
    const N = 360, H = window.__ja;
    H.park('sphere', 0, 0, 0); H.park('torus', 0, 3, 0); H.park('cube', 0, -3, 0);
    // Ладони вплотную к шарику (0.05 = r шара 0.035 + r сустава 0.011 + зазор 0.004), чтобы
    // narrowphase реально держала манifold'ы: на пустом мире цифра цены шага занижена.
    const fill = (buf) => {
      for (let i = 0; i < 50; i++) {
        const side = i < 25 ? -1 : 1, j = i % 25;
        buf[i * 4] = side * 0.05; buf[i * 4 + 1] = -0.06 + ((j / 5) | 0) * 0.03;
        buf[i * 4 + 2] = -0.06 + (j % 5) * 0.03; buf[i * 4 + 3] = 0.011;
      }
    };
    H.step(20, fill);                       // прогрев: первые шаги включают wasm-пути
    const t0 = performance.now();
    H.step(N, fill);
    const ms = performance.now() - t0;
    return { шагов: N, всего_мс: +ms.toFixed(1), мс_на_шаг: +(ms / N).toFixed(4),
      бюджет_кадра_мс: +(1000 / 72).toFixed(2), in_loop_perf: H.perf() };
  })()`);
  console.log('шаг: ' + JSON.stringify(cost));
}

if (pointerSweep) {
  /* Превью живым циклом: синтетические pointermove (обработчик читает clientX/clientY, поэтому
   * синтетика годится) вдоль горизонтальной линии, каждый шаг — свой кадр rAF. Курсор пишет
   * кончик указательного левой кисти (слот 9), так что заодно проверяется карта слотов. */
  const sweep = await evalJs(`(async () => {
    const H = window.__ja, cv = document.querySelector('canvas');
    document.getElementById('preview').click();
    // Ряд как на старте: предыдущие пробы (цена шага) разводят фигуры, а свип считается по
    // горизонтальной линии через центр кольца.
    H.park('sphere', -0.28, 0, 0); H.park('torus', 0, 0, 0); H.park('cube', 0.30, 0, 0);
    await new Promise((r) => requestAnimationFrame(r));
    const b0 = H.body('sphere'), t0 = H.body('torus');
    const move = (fx, fy) => cv.dispatchEvent(new PointerEvent('pointermove',
      { clientX: innerWidth * fx, clientY: innerHeight * fy, bubbles: true }));
    /* Горизонтальная строка на середине экрана проходит на 53 мм НИЖЕ центра ряда (камеру
     * наклоняет долли), то есть шарика едва касается и не толкает. Строку ищем сами:
     * fy, у которой точка попадания ближе всего к y ряда. */
    let fy = 0.5, bestDy = 1e9;
    for (let i = 0; i <= 24; i++) {
      move(0.5, 0.42 + 0.2 * i / 24);
      await new Promise((r) => requestAnimationFrame(r));
      const dy = Math.abs(H.pointer().hit[1] - b0.y);
      if (dy < bestDy) { bestDy = dy; fy = 0.42 + 0.2 * i / 24; }
    }
    let maxC = 0, touched = 0;
    for (let i = 0; i <= 90; i++) {
      move(0.15 + 0.7 * i / 90, fy);
      await new Promise((r) => requestAnimationFrame(r));
      const c = H.info().contacts;
      if (c > maxC) maxC = c;
      if (c > 0) touched++;
    }
    const p = H.pointer();
    return { mode: H.info().mode, slot: p.slot, applied: p.applied, fy: +fy.toFixed(3),
      hit: p.hit, frames: H.diag().frames, maxContacts: maxC, framesWithContact: touched,
      sphereBefore: [+b0.x.toFixed(3), +b0.z.toFixed(3)],
      sphereAfter: [+H.body('sphere').x.toFixed(3), +H.body('sphere').z.toFixed(3)],
      torusMoved: +(H.body('torus').x - t0.x).toFixed(3), errs: H.diag().errs };
  })()`, true);
  console.log('превью: ' + JSON.stringify(sweep));
}

if (expr) console.log('eval: ' + JSON.stringify(await evalJs(expr, true), null, 1));
if (shot) {
  const s = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(shot, Buffer.from(s.data, 'base64'));
  console.log('скриншот: ' + shot + ' (' + (readFileSync(shot).length / 1024).toFixed(0) + ' КБ)');
}
if (!keep) await send('Target.closeTarget', { targetId: t.id }).catch(() => {});
ws.close();
if (server) server.close();
