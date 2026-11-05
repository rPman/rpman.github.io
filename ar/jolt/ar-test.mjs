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

    /* --- кисть: 25 суставов на руку (50 сфер) + 2 контроллера ---------------- */
    H.cfg({ leash: 5 });
    H.park('torus', 0, 3, 0);
    H.park('cube', 4, 0, 0);
    H.park('sphere', 0, 0, 0);
    var NSLOT = H.info().slots;
    ok('слотов ввода хватает на две кисти', NSLOT === 52,
      'слотов ' + NSLOT + ', тел в мире ' + H.info().numBodies);

    // G. «ладонь» — стена из 25 суставов — толкает шарик всей площадью. Захват при этом
    // обязан НЕ включаться: ладонь толкает с одной стороны, держать нечем.
    function palm(buf, X) {
      for (var j = 0; j < 25; j++) {
        fin(buf, j, X, -0.06 + Math.floor(j / 5) * 0.03, -0.06 + (j % 5) * 0.03);
      }
      for (var j2 = 25; j2 < NSLOT; j2++) off(buf, j2);
    }
    var px = 0.22, touched = 0, x0 = H.body('sphere').x, palmGrabs = 0;
    for (var g = 0; g < 160; g++) {
      px -= 0.002;
      var ig = one(function (buf) { palm(buf, px); });
      if (ig.contacts > 0) touched++;
      palmGrabs = Math.max(palmGrabs, H.grab().length);
    }
    var sx = H.body('sphere').x;
    ok('ладонь из 25 суставов толкает шарик, но не хватает', touched > 0 && sx < x0 - 0.05 &&
      palmGrabs === 0,
      'кадров с контактом ' + touched + ' из 160, шарик с ' + x0.toFixed(3) + ' до ' +
      sx.toFixed(3) + ' м, захватов максимум ' + palmGrabs);

    // H. две кисти внахлёст: пара рука↔рука выключена в фильтре пар, иначе 50 суставов
    // начали бы генерировать манifold'ы на каждом кадре
    H.park('sphere', -4, 0, 0);
    var hc = 0, drift = 0;
    for (var h = 0; h < 60; h++) {
      var ih = one(function (buf) {
        for (var i = 0; i < 50; i++) fin(buf, i, 0.5, 0, 0);
        for (var c = 50; c < NSLOT; c++) off(buf, c);
      });
      hc = Math.max(hc, ih.contacts);
      for (var q = 0; q < 50; q++) drift = Math.max(drift, Math.abs(ih.fingers[q].x - 0.5));
    }
    ok('50 перекрывающихся суставов: слой рука<->рука выключен', hc === 0 && drift < 1e-3,
      'контактов ' + hc + ', разнос максимум ' + drift.toExponential(1) + ' м');

    // I. радиус сустава = радиус коллизии: форма обязана пересобираться под него
    H.park('torus', 0, 0, 0);
    var rx = -0.55, gapR = null;
    for (var i2 = 0; i2 < 700 && gapR === null; i2++) {
      rx += 0.001;
      var ii = one(function (buf) {
        buf[0] = rx; buf[1] = 0; buf[2] = 0; buf[3] = 0.030;
        for (var c2 = 1; c2 < NSLOT; c2++) off(buf, c2);
      });
      if (ii.contacts > 0) gapR = H.body('torus').x - ii.fingers[0].x;
    }
    ok('радиус сустава идёт в форму (r = 30 мм)',
      gapR !== null && Math.abs(gapR - (R + tube + 0.03 + PAD)) < 0.004,
      gapR === null ? 'контакта нет' : 'зазор=' + gapR.toFixed(4) +
        ' истина=' + (R + tube + 0.03 + PAD).toFixed(4) + ' (граница формы + handPad)');

    // J. полный скелет обеих кистей: 72 шага, все 52 сферы живые, три фигуры на месте.
    // Про часов тут нет: в --dump-dom виртуальное время внутри синхронного цикла не идёт
    // (=0 мс на любой работе), поэтому цена шага меряется живым браузером в cdp.mjs.
    // Захват тут выключен: две ладони, сходящиеся на шарике с двух сторон, по новым правилам
    // захват и ДЕЛАЮТ (ладонь+ладонь разных рук — разрешённая пара), а держимая фигура
    // перестает толкаться. Толкание проверяется здесь, захват — в блоке L..L13.
    H.cfg({ grab: false });
    H.park('sphere', 0, 0, 0);
    H.park('torus', 0, 3, 0);
    H.park('cube', 0, -3, 0);
    var touchAll = 0, maxV = 0;
    for (var k2 = 0; k2 < 72; k2++) {
      H.step(1, function (buf) {
        // Две «ладони» лицом к шарику: слоты 0..24 слева, 25..49 справа, контроллеры выключены.
        for (var i3 = 0; i3 < 50; i3++) {
          var side = i3 < 25 ? -1 : 1, j = i3 % 25;
          fin(buf, i3, side * (0.10 - k2 * 0.002), -0.06 + ((j / 5) | 0) * 0.03,
            -0.06 + (j % 5) * 0.03);
        }
      });
      var sk = H.info().bodies.filter(function (q) { return q.id === 'sphere'; })[0];
      if (sk.contacts > 0) touchAll++;
      maxV = Math.max(maxV, sk.speed);
    }
    var skInf = H.info().bodies, worstLeash = 0;
    for (var s2 = 0; s2 < skInf.length; s2++) {
      worstLeash = Math.max(worstLeash, skInf[s2].leash);
      if (!isFinite(skInf[s2].x) || !isFinite(skInf[s2].y) || !isFinite(skInf[s2].z)) maxV = NaN;
    }
    ok('полный скелет двух кистей (50 суставов) гоняется 72 шага',
      touchAll > 20 && isFinite(maxV) && worstLeash <= LEASH + 1e-3 && H.diag().errs.length === 0,
      'кадров с контактом ' + touchAll + ' из 72, скорость шарика максимум ' + maxV.toFixed(3) +
      ' м/с, поводок выдержан до ' + worstLeash.toFixed(3) + ' м при лимите ' + LEASH +
      ', ошибок ' + H.diag().errs.length);

    // L..L13. захват: зацепляться могут шары РАЗНЫХ групп (палец+палец, палец+ладонь) и
    // любых рук; держащая конечность выпадает из коллизий с предметом и ещё на секунду после
    // отпускания, пока её шары внутри; одна рука держит один предмет, две руки — два разных.
    H.cfg({ grab: true, leash: 0.9 });
    var FR = 0.013, YSIDE = 0.047;
    // pin — пара пальцев левой по обе стороны предмета вдоль X; pinR — пара пальцев правой
    // вдоль Y; pin3 — те же двое плюс безымянный по Y. spin поворачивает цель вокруг предмета.
    function pin(xoff, cz, spin) {
      H.setJoint(9, xoff, 0, cz, FR, spin);       // index-tip левой
      H.setJoint(14, -xoff, 0, cz, FR, spin);     // middle-tip левой
      H.stepTargets(1);
    }
    function pin3(xoff, cz, spin) {
      H.setJoint(19, 0, YSIDE, cz, FR, spin);     // ring-tip той же кисти
      pin(xoff, cz, spin);
    }
    function pinR(yoff, cz, spin) {
      H.setJoint(34, 0, yoff, cz, FR, spin);      // index-tip правой
      H.setJoint(39, 0, -yoff, cz, FR, spin);     // middle-tip правой
      H.stepTargets(1);
    }
    // Вся тройка поворачивается вокруг оси Z через центр предмета: расстояния пальцев до
    // центра не меняются (контакт держится), меняется только конфигурация захвата.
    function pinRot(xoff, th, cz) {
      var c = Math.cos(th), s = Math.sin(th), p = [[xoff, 0], [-xoff, 0], [0, YSIDE]];
      for (var i9 = 0; i9 < 3; i9++) {
        H.setJoint([9, 14, 19][i9], p[i9][0] * c - p[i9][1] * s,
          p[i9][0] * s + p[i9][1] * c, cz, FR, 0);
      }
      H.stepTargets(1);
    }
    // Каждое измерение начинается с чистого кадра: снятый захват, убранные из кадра суставы
    // (после проверки J пятьдесят их тел лежат вокруг фигур), фигуры на своих местах.
    function cleanRow() {
      H.cfg({ grab: false });
      H.parkFingers(); H.stepTargets(2);
      H.cfg({ grab: true });
      H.park('sphere', 0, 0, 0);
      H.park('torus', 0, 3, 0);
      H.park('cube', 0, -3, 0);
    }
    function squeezeIn(cz) {
      var x = 0.12;
      for (var s = 0; s < 90; s++) { x -= 0.0015; pin(x, cz, 0); if (H.grab().length) return x; }
      return null;
    }
    function squeeze3(cz) {
      var x3 = 0.12;
      for (var s3 = 0; s3 < 90; s3++) {
        x3 -= 0.0015; pin3(x3, cz, 0);
        if (H.grab().length) return x3;
      }
      return null;
    }
    function sidesOfGrab() {
      return H.grab().map(function (q) {
        return q.id + ':' + q.sides.map(function (s) { return s ? 'П' : 'Л'; }).join('+');
      }).join(' ');
    }
    function grabIds() { return H.grabbedIds(); }
    function distTo(p) { var q = H.body('sphere'); return Math.hypot(q.x - p.x, q.y - p.y, q.z - p.z); }

    cleanRow();
    var gx = squeezeIn(0);
    var g = H.grab()[0];
    ok('два пальца с двух сторон берут шарик в захват', gx !== null && g &&
      g.id === 'sphere' && g.slots.length >= 2 && H.motion('sphere') === 'кинематик',
      gx === null ? 'захват не включился; контакты: ' +
        JSON.stringify(H.gripDbg()).slice(0, 420) + ' кандидаты: ' +
        JSON.stringify(H.cand()).slice(0, 200) : 'слоты ' + JSON.stringify(g.slots) +
      ', взято при |x|=' + gx.toFixed(4) + ' (контакт начинается на ' +
      (0.035 + 0.013 + PAD).toFixed(3) + '), тело: ' + H.motion('sphere'));

    // L2. один палец захват не включает (тот же шарик, та же глубина)
    cleanRow();
    var oneTouch = 0;
    for (var l2 = 0; l2 < 60; l2++) {
      H.setJoint(9, 0.075 - l2 * 0.0005, 0, 0, 0.013, 0);
      H.stepTargets(1);
      if (H.info().contacts > 0) oneTouch++;
    }
    ok('одного пальца мало: захвата нет', H.grab().length === 0 && oneTouch > 10,
      'контактов ' + oneTouch + ' кадров из 60, захватов ' + H.grab().length);

    // L2b. два сустава ОДНОГО пальца с двух сторон — не захват (нужны разные группы шаров)
    cleanRow();
    var sameFinger = 0;
    for (var l2b = 0; l2b < 60; l2b++) {
      var xb = 0.075 - l2b * 0.0005;
      H.setJoint(8, xb, 0, 0, FR, 0);            // указательный: средний фаланг
      H.setJoint(9, -xb, 0, 0, FR, 0);           // тот же палец: кончик, с другой стороны
      H.stepTargets(1);
      if (H.info().contacts > 0) sameFinger++;
    }
    ok('два сустава одного пальца захват не включают',
      H.grab().length === 0 && sameFinger > 10,
      'кадров с контактом ' + sameFinger + ' из 60, захватов ' + H.grab().length);

    // L2c. ладонь с ладонью одной кисти — не держат; ладонь с пальцем — держат
    cleanRow();
    for (var l2c = 0; l2c < 60; l2c++) {
      var xw = 0.09 - l2c * 0.0006;
      H.setJoint(0, xw, 0, 0, FR, 0);            // запястье
      H.setJoint(5, -xw, 0, 0, FR, 0);           // плюсневая кость указательного
      H.stepTargets(1);
    }
    var palmPalm = H.grab().length;
    var palmTouch = H.info().contacts;
    cleanRow();
    var wristTake = null;
    for (var l2d = 0; l2d < 90; l2d++) {
      wristTake = 0.12 - l2d * 0.0015;
      H.setJoint(0, wristTake, 0, 0, FR, 0);     // ладонь слева
      H.setJoint(9, -wristTake, 0, 0, FR, 0);    // кончик указательного справа
      H.stepTargets(1);
      if (H.grab().length) break;
    }
    ok('ладонь с ладонью не держат, ладонь с пальцем держат',
      palmPalm === 0 && H.grab().length === 1,
      'запястье+плюсневая: захватов ' + palmPalm + ' (контактов в кадре ' + palmTouch +
      '); запястье+кончик: ' + sidesOfGrab() + ' при |x|=' + (wristTake || 0).toFixed(4));

    // L3. захват тащит шарик за собой и держит, пока пальцы сжимаются
    cleanRow();
    gx = squeezeIn(0);
    var zc = 0, z0 = H.body('sphere').z;
    for (var l3 = 0; l3 < 120; l3++) { zc -= 0.0025; pin(gx, zc, 0); }
    var afterCarry = H.body('sphere');
    for (var l3b = 0; l3b < 20; l3b++) pin(gx - 0.0005, zc, 0);   // ещё и дожимаем
    var stillHeld = H.grab().length === 1;
    ok('захват ведёт шарик за центром пальцев и не рвётся при сжатии',
      gx !== null && stillHeld && Math.abs(afterCarry.z - zc) < 0.02 &&
      Math.abs(afterCarry.x) < 0.02,
      'центр захвата z=' + zc.toFixed(3) + ', шарик z=' + afterCarry.z.toFixed(3) +
      ' x=' + afterCarry.x.toFixed(3) + ' (было z=' + z0.toFixed(3) + '), удерживается после' +
      ' дожима: ' + stillHeld + ', размах ' + (g && H.grab()[0] ? H.grab()[0].span : '-') +
      ' при минимуме ' + (H.grab()[0] ? H.grab()[0].spanMin : '-'));

    // L4. три шара захвата: их поворот поворачивает шарик (жёсткая подгонка по всем шарам)
    cleanRow();
    var g3 = squeeze3(0);
    var qz0 = H.rotAngle('sphere');
    for (var l4 = 0; l4 <= 60; l4++) pinRot(g3, l4 * (1.0 / 60), 0);
    var turned = H.rotAngle('sphere') - qz0;
    ok('три шара захвата: их поворот поворачивает шарик', g3 !== null &&
      Math.abs(turned - 1.0) < 0.25,
      'пальцы провернули 1.000 рад, шарик — ' + turned.toFixed(3) + ' рад; слоты ' +
      JSON.stringify(H.grab().length ? H.grab()[0].slots : []) + ', взято при |x|=' +
      (g3 || 0).toFixed(4));

    // L4b. двух шаров для поворота мало: конфигурация вырождена (все на одной прямой),
    // подгонка отклонена — предмет только переезжает за центром шаров.
    cleanRow();
    var g2 = squeezeIn(0);
    var qz2 = H.rotAngle('sphere');
    for (var l4b = 0; l4b <= 60; l4b++) {
      var th2 = l4b * (1.0 / 60), c4 = Math.cos(th2), s4 = Math.sin(th2);
      H.setJoint(9, g2 * c4, g2 * s4, 0, FR, 0);
      H.setJoint(14, -g2 * c4, -g2 * s4, 0, FR, 0);
      H.stepTargets(1);
    }
    var twoTurn = H.rotAngle('sphere') - qz2;
    ok('двух шаров для поворота мало: шарик не крутится',
      Math.abs(twoTurn) < 0.05,
      'пальцы провернули 1.000 рад, шарик — ' + twoTurn.toFixed(3) + ' рад');

    // L5. в идущий захват новые суставы не добавляются
    var slotsBefore = H.grab()[0] ? H.grab()[0].slots.length : 0;
    for (var l5 = 0; l5 < 30; l5++) {
      H.setJoint(19, 0, 0, zc + 0.045, 0.013, 0);    // ещё один палец лезет на шарик
      pin(gx, zc, 1.0);
    }
    var slotsAfter = H.grab()[0] ? H.grab()[0].slots.length : 0;
    ok('в идущий захват новые суставы не добавляются',
      H.grab().length === 1 && slotsAfter === slotsBefore && slotsBefore >= 2,
      'было ' + slotsBefore + ' слота, стало ' + slotsAfter);
    H.setJoint(19, 3, 0, 0, 0.013, 0);

    // L6. пальцы разошлись — отпускание, и тело снова динамическое
    var relZ = H.body('sphere').z, spread = gx;
    for (var l6 = 0; l6 < 40; l6++) { spread += 0.0015; pin(spread, zc, 1.0); }
    ok('разжатые пальцы отпускают шарик', H.grab().length === 0 &&
      H.motion('sphere') === 'динамик',
      'размах вырос с ' + gx.toFixed(3) + ' до ' + spread.toFixed(3) + ' м (порог 0.030), ' +
      'захватов ' + H.grab().length + ', тело: ' + H.motion('sphere') +
      ', шарик: z=' + H.body('sphere').z.toFixed(3) + ' (было ' + relZ.toFixed(3) + ')');

    // L7. застрявший в предмете палец: держащая конечность выпадает из коллизий, и после
    // отпускания игнор держится, пока её шары внутри предмета, но не дольше секунды.
    // Палец при этом шевелится: Jolt перестаёт тестировать пару без движения (замер в node),
    // а живая рука стоит на месте только в тесте.
    cleanRow();
    var gx7 = squeezeIn(0);
    var limb7 = H.ignores();
    function wobble(k) {                      // безымянный внутри шарика, вход/выход на 25 мм
      H.setJoint(19, 0.012 + 0.025 * Math.sin(k * 0.35), 0.006, 0, FR, 0);
    }
    wobble(0);
    H.stepTargets(3);
    ok('держащая конечность выпадает из коллизий с предметом',
      limb7 === 1 && H.grab().length === 1,
      'конечностей в игноре ' + limb7 + ' (у каждой 25 пар), захват ' + sidesOfGrab());
    var p7 = H.body('sphere');
    p7 = { x: p7.x, y: p7.y, z: p7.z };
    var spread7 = gx7;
    for (var l7 = 0; l7 < 40; l7++) { spread7 += 0.0015; wobble(l7); pin(spread7, 0, 0); }
    var released7 = H.grab().length === 0;
    for (var l7b = 0; l7b < 26; l7b++) { wobble(40 + l7b); pin(0.30, 0, 0); }  // рука убрана,
    var moved7b = distTo(p7);                                                 // палец внутри
    ok('застрявший в предмете палец его не тащит, пока длится прощение',
      released7 && moved7b < 0.002,
      'захват снят: ' + released7 + ', разжат до ' + spread7.toFixed(3) + ' м; сдвиг шарика за ' +
      (40 + 26) + ' кадров ' + moved7b.toFixed(5) + ' м, grace: ' + JSON.stringify(H.graceList()));
    for (var l7c = 0; l7c < 80; l7c++) { wobble(66 + l7c); pin(0.30, 0, 0); }  // секунда прошла
    var moved7c = distTo(p7);
    var inf7 = H.info();
    ok('через секунду застрявший палец снова толкает предмет',
      moved7c > 0.01 && H.ignores() === 0,
      'сдвиг ' + moved7c.toFixed(3) + ' м, конечностей в игноре ' + H.ignores() +
      ', grace: ' + JSON.stringify(H.graceList()) + ', тело: ' + H.motion('sphere') +
      ', контактов в кадре ' + inf7.contacts + ', шарик ' + JSON.stringify(H.body('sphere')));

    // L10. правая в захват не входила — её шары сталкиваются как обычно. Держимый предмет
    // при этом кинематический, а kinematic<->kinematic контактов не бывает вовсе (замер в
    // spike.mjs), поэтому толкнуть его нельзя; динамический кубик правая толкает нормально.
    cleanRow();
    squeezeIn(0);
    H.park('cube', 0.45, 0, 0); H.stepTargets(1);
    var ball10 = H.body('sphere');
    for (var l10 = 0; l10 < 60; l10++) {
      H.setJoint(34, 0.12 - l10 * 0.0015, 0, 0, FR, 0);
      H.stepTargets(1);
    }
    var b10 = H.body('sphere');
    var pushedBall = Math.hypot(b10.x - ball10.x, b10.y - ball10.y, b10.z - ball10.z);
    var cubeA = H.body('cube'), limb10 = H.ignores();
    for (var l10b = 0; l10b < 100; l10b++) {
      H.setJoint(34, 0.62 - l10b * 0.002, 0, 0, FR, 0);
      H.stepTargets(1);
    }
    var pushedCube = Math.abs(H.body('cube').x - cubeA.x);
    ok('в игноре только держащая рука: кубик правая толкает, держимый шарик — нет',
      pushedCube > 0.02 && pushedBall < 0.002 && limb10 === 1,
      'кубик сдвинут на ' + pushedCube.toFixed(3) + ' м, держимый шарик на ' +
      pushedBall.toFixed(5) + ' м, конечностей в игноре ' + limb10);

    // L11. левая держит шарик, правая держит кубик — два независимых захвата сразу
    cleanRow();
    var gx11 = squeezeIn(0);
    H.park('cube', 0.45, 0, 0); H.stepTargets(1);
    for (var l11 = 0; l11 < 90; l11++) {
      var d11 = 0.13 - l11 * 0.0015;
      H.setJoint(34, 0.45 + d11, 0, 0, FR, 0);
      H.setJoint(39, 0.45 - d11, 0, 0, FR, 0);
      H.stepTargets(1);
      if (H.grab().length === 2) break;
    }
    var ids11 = grabIds();
    ok('две руки держат разные предметы одновременно', H.grab().length === 2 &&
      ids11.indexOf('sphere') >= 0 && ids11.indexOf('cube') >= 0, 'захваты: ' + sidesOfGrab());
    var cz11 = 0;
    for (var l11b = 0; l11b < 70; l11b++) {
      cz11 += 0.0025;
      H.setJoint(34, 0.45 + d11, 0, cz11, FR, 0);
      H.setJoint(39, 0.45 - d11, 0, cz11, FR, 0);
      pin(gx11, 0, 0);                          // левая при этом стоит
    }
    var cube11 = H.body('cube'), ball11 = H.body('sphere');
    ok('кубик едет за правой, шарик остаётся у левой',
      Math.abs(cube11.z - cz11) < 0.02 && Math.hypot(ball11.x, ball11.z) < 0.01 &&
      H.grab().length === 2,
      'кубик z=' + cube11.z.toFixed(3) + ' (правая на z=' + cz11.toFixed(3) + '), шарик x=' +
      ball11.x.toFixed(3) + ' z=' + ball11.z.toFixed(3) + ', захватов ' + H.grab().length);

    // L12/L13. передача предмета из руки в руку: вторая конечность входит в идущий захват,
    // первая разжимается — предмет остаётся у второй и едет за ней.
    cleanRow();
    var gx12 = squeezeIn(0);
    var y12 = null, joined12 = false;
    for (var l12 = 0; l12 < 90; l12++) {
      y12 = 0.12 - l12 * 0.0015;
      pinR(y12, 0, 0);
      if (H.grab().length === 1 && H.grab()[0].sides.length === 2) { joined12 = true; break; }
    }
    var g12 = H.grab()[0];
    ok('правая входит в захват левой: предмет держат две конечности',
      joined12 && g12.slots.length >= 4,
      g12 ? sidesOfGrab() + ' слоты ' + JSON.stringify(g12.slots) + ', пальцы правой в ' +
      (y12 || 0).toFixed(4) + ' м от центра (касание — на ' + (0.035 + FR).toFixed(3) + ' м)'
        : 'захвата нет');
    var sp12 = gx12;
    for (var l13 = 0; l13 < 45; l13++) { sp12 += 0.0015; pin(sp12, 0, 0); pinR(y12, 0, 0); }
    var g13 = H.grab()[0];
    ok('левая разжалась — предмет остался в захвате правой',
      g13 && g13.sides.length === 1 && H.motion('sphere') === 'кинематик',
      g13 ? sidesOfGrab() + ' слоты ' + JSON.stringify(g13.slots) + ', левая разжата до ' +
      sp12.toFixed(3) + ' м, тело: ' + H.motion('sphere') : 'захвата нет');
    var zc13 = 0;
    for (var l13b = 0; l13b < 70; l13b++) { zc13 += 0.0025; pin(0.30, zc13, 0); pinR(y12, zc13, 0); }
    var b13 = H.body('sphere');
    ok('после передачи шарик едет за правой рукой',
      Math.abs(b13.z - zc13) < 0.02 && H.grab().length === 1,
      'правая на z=' + zc13.toFixed(3) + ', шарик z=' + b13.z.toFixed(3) + ', захватов ' +
      H.grab().length);
    H.parkFingers(); H.stepTargets(3);

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

/* Дамп DOM в headless приходит, когда исчерпан виртуальный бюджет, а не когда драйвер дописал
 * отчёт: отчёт иногда обрывается посреди JSON («Unexpected end of JSON input»). Дамп
 * переигрывается, пока в `<pre id="report">` не окажется завершённый объект. */
async function dumpTry(path, budget, attempts) {
  let last = '';
  for (let a = 0; a < attempts; a++) {
    const dom = await chrome(['--virtual-time-budget=' + budget, '--dump-dom', base + path]);
    last = dom;
    const m = dom.match(/<pre id="report"[^>]*>([\s\S]*?)<\/pre>/);
    if (!m || !m[1].trim()) continue;                 // драйвер ещё молчит
    if (/^\s*\{/.test(m[1])) {
      try { parseReport(dom); return dom; } catch (e) { continue; }  // JSON оборван
    }
    return dom;                                       // текстовый отчёт готов
  }
  return last;
}

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
  const shotDom = await dumpTry('/ar-shot.html', 25000, 3);
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
  const diagDom = await dumpTry('/ar-diag.html', 40000, 3);
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
