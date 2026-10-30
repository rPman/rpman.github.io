/* Проверка собранного ar-hands-sphere.html в headless Chrome.
 *
 *   node ar/page-test.mjs [путь-к-htm]
 *
 * Страница сама отдаёт JSON-отчёт в <pre id="report"> (управление через window.__hs), поэтому
 * рендер SwiftShader не мешает: физика шагается вручную, по фиксированному dt.
 * Дополнительно пишется скриншот реального кадра предпросмотра (боевой цикл rAF).
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const page = process.argv[2] ? resolve(process.argv[2]) : join(project, 'ar-hands-sphere.html');
if (!existsSync(page)) throw new Error('нет собранного файла: ' + page + ' — сначала node ar/build.mjs');

const TMP = '/tmp/arhands';
mkdirSync(TMP, { recursive: true });
const CH = process.env.CHROME ||
  (process.env.HOME + '/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome');
if (!existsSync(CH)) throw new Error('нет chrome: ' + CH);

const html = readFileSync(page, 'utf8');

/* -------------------------------------------------- 1. проверка физики в бою */
const driver = `
<pre id="report" style="font:12px monospace;white-space:pre-wrap"></pre>
<script>
(function () {
  var checks = [], info0 = null, exc = null;
  function ok(name, cond, detail) { checks.push({ name: name, ok: !!cond, detail: detail }); }
  var DT = 1 / 72;
  function mover(o) {
    return function (buf, f) {
      o.x += o.vx * DT; o.y += o.vy * DT; o.z += o.vz * DT;
      buf[0] = o.x; buf[1] = o.y; buf[2] = o.z; buf[3] = o.r;
    };
  }
  try {
    var hs = window.__hs, SP = window.SpherePush;
    if (!hs || !SP) throw new Error('нет отладочного хука window.__hs');
    hs.setMode('none');
    hs.world.floorY = null; hs.world.leash = 10; hs.cfg({ handPad: 0.008 });
    SP.place(hs.world, 0, 0, 0);
    info0 = hs.info();

    // A. лобовой толчок
    var hand = { x: -0.30, y: 0, z: 0, vx: 0.4, vy: 0, vz: 0, r: 0.010 };
    var drive = mover(hand);
    hs.step(45, drive);
    var b = hs.info();
    var contact = hs.world.radius + hand.r + hs.world.handPad;   // центр на расстоянии касания
    ok('лобовой: сфера держит руку на растопырку',
       Math.abs(b.pos.x - (hand.x + contact)) < 0.004,
       'x=' + b.pos.x.toFixed(4) + ' ждали=' + (hand.x + contact).toFixed(4));
    ok('лобовой: есть контакт и нет проникновения', b.contacts > 0 && b.pen < 1e-4,
       'c=' + b.contacts + ' pen=' + b.pen.toExponential(1));
    ok('лобовой: скорость сферы = скорость руки', b.speed > 0.34 && b.speed < 0.46, 'v=' + b.speed.toFixed(3));

    // B. рука встала -> сфера встала
    hand.vx = 0;
    hs.step(30, drive);
    var c = hs.info();
    ok('без инерции: рука стоит — сфера стоит', c.speed < 0.02, 'v=' + c.speed.toFixed(4));
    var pin = c.pos;
    hs.step(30, drive);
    var d = hs.info();
    ok('без инерции: в статичном контакте не дрейфует',
       Math.hypot(d.pos.x - pin.x, d.pos.y - pin.y, d.pos.z - pin.z) < 1e-3,
       'd=' + Math.hypot(d.pos.x - pin.x, d.pos.y - pin.y).toExponential(1));

    // C. рука исчезла -> сфера осталась
    var pin2 = hs.info().pos;
    hs.step(45, null);
    var e = hs.info();
    ok('без инерции: после отрыва гаснет', e.speed < 1e-3 &&
       Math.hypot(e.pos.x - pin2.x, e.pos.y - pin2.y, e.pos.z - pin2.z) < 0.02,
       'v=' + e.speed.toExponential(1) + ' d=' + Math.hypot(e.pos.x - pin2.x, e.pos.z - pin2.z).toFixed(4));

    // D. резкий удар: рука идёт по +X со смещением по +Y -> сфера уходит по нормали
    SP.place(hs.world, 0, 0, 0);
    var cut = { x: -0.30, y: 0.05, z: 0, vx: 0.5, vy: 0, vz: 0, r: 0.008 };
    hs.step(60, mover(cut));
    var f2 = hs.info();
    var ang = Math.abs(Math.atan2(f2.pos.y, f2.pos.x) * 180 / Math.PI);
    ok('резкий: ушла по нормали, а не вдоль руки',
       f2.pos.x > 0.02 && f2.pos.y < -0.003 && ang > 15 && ang < 60,
       'x=' + f2.pos.x.toFixed(3) + ' y=' + f2.pos.y.toFixed(4) + ' угол=' + ang.toFixed(1));
    ok('резкий: проникновения нет', f2.pen < 1e-4, 'pen=' + f2.pen.toExponential(1));

    // E. ладонь (25 суставов) не продавливает сферу
    SP.place(hs.world, 0, 0, 0);
    var px = -0.26;
    hs.step(40, function (buf) {
      px += 0.35 * DT;
      for (var s = 0; s < 25; s++) {
        var t = (s / 25 - 0.5) * 0.09;
        buf[s * 4] = px; buf[s * 4 + 1] = t; buf[s * 4 + 2] = t * 0.6; buf[s * 4 + 3] = 0.010;
      }
    });
    var g = hs.info();
    ok('ладонь: 25 суставов — сфера не продавлена', g.pen < 1e-4 && g.pos.x > 0.02,
       'pen=' + g.pen.toExponential(1) + ' x=' + g.pos.x.toFixed(3));

    // F. две руки сжимают сферу: перекрыть оба контакта геометрически невозможно,
    //    значит проверяем не «pen=0», а что сферу не выплюнуло и она не дрожит
    SP.place(hs.world, 0, 0, 0);
    var l = -0.22, r2 = 0.22;
    hs.step(30, function (buf) {
      l += 0.3 * DT; r2 -= 0.3 * DT;
      buf[0] = l; buf[1] = 0; buf[2] = 0; buf[3] = 0.012;
      buf[25 * 4] = r2; buf[25 * 4 + 1] = 0; buf[25 * 4 + 2] = 0; buf[25 * 4 + 3] = 0.012;
      for (var s = 1; s < 25; s++) { buf[s * 4] = NaN; buf[(25 + s) * 4] = NaN; }
    });
    var beforeJit = hs.info().pos.x;
    hs.step(20, function (buf) {                    // руки стоят — сфера обязана стоять
      buf[0] = l; buf[1] = 0; buf[2] = 0; buf[3] = 0.012;
      buf[25 * 4] = r2; buf[25 * 4 + 1] = 0; buf[25 * 4 + 2] = 0; buf[25 * 4 + 3] = 0.012;
      for (var s = 1; s < 25; s++) { buf[s * 4] = NaN; buf[(25 + s) * 4] = NaN; }
    });
    var h2 = hs.info();
    ok('две руки: сфера осталась в зазоре', Math.abs(h2.pos.x) < Math.abs(l) && isFinite(h2.pos.x),
       'x=' + h2.pos.x.toFixed(4) + ' руки=±' + Math.abs(l).toFixed(3));
    ok('две руки: в сжатии не дрожит',
       Math.abs(h2.pos.x - beforeJit) < 5e-4 && h2.speed < 0.02,
       'Δ=' + Math.abs(h2.pos.x - beforeJit).toExponential(1) + ' v=' + h2.speed.toFixed(4));
    ok('всё конечно', isFinite(h2.pos.x) && isFinite(h2.pos.y) && isFinite(h2.speed), JSON.stringify(h2.pos));
  } catch (err) {
    exc = String(err && err.stack || err);
  }
  document.getElementById('report').textContent =
    JSON.stringify({ checks: checks, exc: exc, info0: info0 }, null, 1);
})();
</script>`;

writeFileSync(join(TMP, 'test.html'), html.replace('</body>', driver + '\n</body>'));

/* -------------------------------------------------- 2. скриншоты реального кадра */
function shotDriver(jitter) {
  return `
<script>
  var b = document.getElementById('preview');
  if (b) b.click();
  window.addEventListener('load', function () {
    var cv = document.querySelector('canvas');
    var t = 0;
    setInterval(function () {
      t += 0.04;
      var cx = ${jitter ? 0.435 : 0.5}, cy = ${jitter ? 0.52 : 0.5};   // левее сферы / прямо в сферу
      var x = window.innerWidth * (cx + 0.05 * Math.sin(t));
      var y = window.innerHeight * cy;
      cv.dispatchEvent(new PointerEvent('pointermove', { clientX: x, clientY: y, bubbles: true }));
    }, 16);
  });
<\/script>`;
}
writeFileSync(join(TMP, 'shot.html'), html.replace('</body>', shotDriver(true) + '\n</body>'));
writeFileSync(join(TMP, 'shot_contact.html'), html.replace('</body>', shotDriver(false) + '\n</body>'));

const flags = ['--headless=new', '--no-sandbox', '--disable-gpu-sandbox',
               '--enable-unsafe-swiftshader', '--use-angle=swiftshader'];

function chrome(extra) {
  return execFileSync(CH, flags.concat(extra), { encoding: 'utf8', maxBuffer: 1 << 26 });
}

let dom;
try {
  dom = chrome(['--virtual-time-budget=9000', '--dump-dom', 'file://' + join(TMP, 'test.html')]);
} catch (err) {
  console.log('FAIL не удалось запустить chrome: ' + String(err).slice(0, 400));
  process.exit(1);
}

// --dump-dom отдаёт текст <pre> HTML-экранированным и включает сами <script>-ы,
// поэтому ищем именно отчёт, а не литералы маркера в коде драйвера
const m = dom.match(/<pre id="report"[^>]*>([\s\S]*?)<\/pre>/);
if (!m) {
  console.log('FAIL в дампе нет отчёта. Фрагмент DOM:\n' + dom.slice(0, 1500));
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
console.log(fails ? '\n' + fails + ' FAIL' : '\nстраница: всё ok');

for (const [pg, png] of [[page, 'shot_start.png'], [join(TMP, 'shot.html'), 'shot_preview.png'],
                         [join(TMP, 'shot_contact.html'), 'shot_contact.png']]) {
  try {
    chrome(['--window-size=1280,720', '--virtual-time-budget=20000',
            '--screenshot=' + join(TMP, png), 'file://' + pg]);
    console.log('скриншот: ' + join(TMP, png));
  } catch (err) {
    console.log('не удалось снять ' + png + ': ' + String(err).slice(0, 200));
  }
}
process.exit(fails ? 1 : 0);
