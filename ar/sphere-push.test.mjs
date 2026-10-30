/* Юнит-тесты коллизии «руки -> сфера» (ar/sphere-push.js).
 * Запуск:  node ar/sphere-push.test.mjs     (exit != 0 при провале)
 *
 * Тестируются именно те свойства, что просил заказчик:
 *   1) сфера выталкивается из руки и не тонет в ней;
 *   2) нет инерции: рука встала — сфера встала, рука убралась — сфера осталась;
 *   3) направление = нормаль в точке касания (бильярд), а НЕ направление руки;
 *   4) ладонь (несколько суставов одновременно) тоже не продавливает сферу.
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const SP = require('./sphere-push.js');

const DT = 1 / 72;
let fails = 0;

function ok(name, cond, detail) {
  const line = (cond ? 'ok   ' : 'FAIL ') + name + (detail !== undefined ? '   [' + detail + ']' : '');
  console.log(line);
  if (!cond) fails++;
}
function near(a, b, eps) { return Math.abs(a - b) <= eps; }

// четвёрка сустава в плоском массиве
function joint(arr, slot, x, y, z, r) {
  arr[slot * 4] = x; arr[slot * 4 + 1] = y; arr[slot * 4 + 2] = z; arr[slot * 4 + 3] = r;
  return arr;
}
function blank(nSlots) { return new Float64Array(nSlots * 4).fill(NaN); }

function mk(opts) {
  const st = SP.create(Object.assign({ leash: 10, floorY: null, velSmoothing: 0.005 }, opts));
  SP.place(st, 0, 0, 0);
  return st;
}

// ---------------------------------------------------------------- 1. лобовой толчок
{
  const st = mk({});
  const R = st.radius, jr = 0.010, min = R + jr + st.handPad;
  let x = -0.30, worstPen = 0, speedSum = 0, speedN = 0;
  for (let f = 0; f < 60; f++) {
    x += 0.4 * DT;                       // рука едет +X со скоростью 0.4 м/с
    const j = joint(blank(1), 0, x, 0, 0, jr);
    SP.step(st, DT, j);
    worstPen = Math.max(worstPen, SP.penetration(st, j));
    if (f > 42) { speedSum += SP.speed(st); speedN++; }
  }
  const v = speedSum / speedN;
  ok('лобовой: сферу выталкивает вдоль +X', st.pos.x > 0.11, 'x=' + st.pos.x.toFixed(3));
  ok('лобовой: нет проникновения в руку', worstPen < 1e-4, 'pen=' + worstPen.toExponential(1));
  ok('лобовой: сфера держит контакт с рукой', near(st.pos.x - x, min, 0.005),
     'gap=' + (st.pos.x - x).toFixed(4) + ' min=' + min.toFixed(4));
  ok('лобовой: скорость сферы = скорость руки (без разгона)', near(v, 0.4, 0.06), 'v=' + v.toFixed(3));
}

// ---------------------------------------------------------------- 2. нет инерции
{
  const st = mk({});
  let x = -0.30;
  const j = () => joint(blank(1), 0, x, 0, 0, 0.010);
  for (let f = 0; f < 40; f++) { x += 0.4 * DT; SP.step(st, DT, j()); }   // догнали, толкаем
  const vPush = SP.speed(st);
  for (let f = 0; f < 36; f++) SP.step(st, DT, j());                      // рука замерла в контакте
  const vStop = SP.speed(st);
  const pHold = { x: st.pos.x, y: st.pos.y, z: st.pos.z };
  for (let f = 0; f < 30; f++) SP.step(st, DT, j());
  const driftHold = Math.hypot(st.pos.x - pHold.x, st.pos.y - pHold.y, st.pos.z - pHold.z);
  const xRelease = x;
  for (let f = 0; f < 20; f++) { x = xRelease - 0.6 * DT; SP.step(st, DT, j()); }  // рука ушла назад
  for (let f = 0; f < 36; f++) SP.step(st, DT, j());                      // катится по инерции?
  const afterRelease = Math.hypot(st.pos.x - pHold.x, st.pos.y - pHold.y, st.pos.z - pHold.z);
  const vEnd = SP.speed(st);
  ok('без инерции: при толчке скорость есть', vPush > 0.2, 'v=' + vPush.toFixed(3));
  ok('без инерции: рука встала — сфера встала', vStop < 0.02, 'v=' + vStop.toFixed(4));
  ok('без инерции: в статичном контакте не дрейфует', driftHold < 1e-4, 'd=' + driftHold.toExponential(1));
  ok('без инерции: после отрыва гаснет за ~0.5 с', afterRelease < 0.03 && vEnd < 1e-3,
     'd=' + afterRelease.toFixed(4) + ' v=' + vEnd.toExponential(1));
}

// ---------------------------------------------------------------- 3. бильярд (резкий удар)
{
  // рука движется ЧИСТО по +X, но бьёт по сфере со смещением +Y: сфера обязана уйти
  // по нормали в точке касания, т.е. +X и -Y, а не строго по +X.
  const off = 0.05, jr = 0.008;
  const st = mk({});
  let x = -0.30, firstN = null;
  for (let f = 0; f < 60; f++) {
    x += 0.5 * DT;
    const j = joint(blank(1), 0, x, off, 0, jr);
    SP.step(st, DT, j);
    if (firstN === null && st.contacts.length) {
      const c = st.contacts[0];
      firstN = { nx: c.nx, ny: c.ny, nz: c.nz };
    }
  }
  const dx = st.pos.x, dy = st.pos.y;
  const dir = Math.atan2(dy, dx);
  const nrm = Math.atan2(firstN.ny, firstN.nx);
  let dAng = Math.abs(dir - nrm); if (dAng > Math.PI) dAng = 2 * Math.PI - dAng;
  ok('резкий: сфера ушла по +X', dx > 0.02, 'dx=' + dx.toFixed(3));
  ok('резкий: появился боковой увод по -Y', dy < -0.003, 'dy=' + dy.toFixed(4));
  ok('резкий: направление = нормаль касания, а не вектор руки',
     dAng < 25 * Math.PI / 180 && Math.abs(dy / dx) > 0.2,
     'Δугол=' + (dAng * 180 / Math.PI).toFixed(1) + '°  dy/dx=' + (dy / dx).toFixed(2));
  ok('резкий: первый контакт — нормаль смотрит от руки к сфере',
     firstN.nx > 0.5 && firstN.ny < 0, JSON.stringify(firstN));
}

// ---------------------------------------------------------------- 4. ладонь целиком
{
  const st = mk({});
  const N = 25;
  let worstPen = 0, x = -0.28;
  for (let f = 0; f < 45; f++) {
    x += 0.35 * DT;
    const j = blank(N);                       // «веер» суставов ладони, толкает центральный
    for (let s = 0; s < N; s++) {
      const a = (s / N - 0.5) * 0.09;         // разброс по Y и Z, все едут по +X
      joint(j, s, x, a, a * 0.6, 0.010);
    }
    SP.step(st, DT, j);
    worstPen = Math.max(worstPen, SP.penetration(st, j));
  }
  ok('ладонь: много суставов — сфера не продавлена', worstPen < 1e-4, 'pen=' + worstPen.toExponential(1));
  ok('ладонь: сфера уехала от ладони', st.pos.x > 0.02, 'x=' + st.pos.x.toFixed(3));
}

// ------------------------------------------------- 4b. рука появилась внутри сферы
{
  const st = mk({});
  const j = joint(blank(1), 0, 0.02, 0, 0, 0.01);   // статичная рука сквозь сферу (глич трекинга)
  SP.step(st, DT, j);
  const vPop = SP.speed(st);
  for (let f = 0; f < 40; f++) SP.step(st, DT, j);
  const target = 0.02 - (st.radius + 0.01 + st.handPad);
  const settle = Math.abs(st.pos.x - target);
  for (let f = 0; f < 40; f++) SP.step(st, DT, blank(1));   // рука пропала
  const glide = Math.abs(st.pos.x - target);
  ok('глич: выталкивание не выстреливает сферой', vPop < 0.05, 'v=' + vPop.toFixed(4));
  ok('глич: сфера встала в точку касания', settle < 1e-4, 'd=' + settle.toExponential(1));
  ok('глич: после исчезновения руки не улетела', glide < 0.005, 'd=' + glide.toExponential(1));
}

// ------------------------------------- 4c. сжатие двумя руками (перекрытие неизбежно)
{
  // Два сустава едут навстречу: одновременно быть на расстоянии касания от обоих
  // геометрически нельзя. Важно, чтобы сфера осталась в зазоре и не дрожала.
  const st = mk({});
  let l = -0.22, r = 0.22;
  const squeeze = (arr) => {
    joint(arr, 0, l, 0, 0, 0.012);
    joint(arr, 25, r, 0, 0, 0.012);
    for (let s = 1; s < 25; s++) { arr[s * 4] = NaN; arr[(25 + s) * 4] = NaN; }
    return arr;
  };
  for (let f = 0; f < 30; f++) { l += 0.3 * DT; r -= 0.3 * DT; SP.step(st, DT, squeeze(blank(26))); }
  const xStop = st.pos.x;
  for (let f = 0; f < 20; f++) SP.step(st, DT, squeeze(blank(26)));
  ok('сжатие: сфера осталась между рук', Math.abs(st.pos.x) < Math.abs(l),
     'x=' + st.pos.x.toFixed(4) + ' руки=±' + Math.abs(l).toFixed(3));
  ok('сжатие: в стойке не дрожит', Math.abs(st.pos.x - xStop) < 5e-4 && SP.speed(st) < 0.02,
     'Δ=' + Math.abs(st.pos.x - xStop).toExponential(1) + ' v=' + SP.speed(st).toFixed(4));
}

// ---------------------------------------------------------------- 5. устойчивость
{
  const st = mk({});
  let threw = null;
  try {
    for (let f = 0; f < 20; f++) SP.step(st, DT, blank(25));         // рука есть, поз нет
    for (let f = 0; f < 20; f++) SP.step(st, DT, new Float64Array(0)); // рук нет вообще
    const j = joint(blank(2), 0, 0.02, 0, 0, 0.01);                   // влетела внутрь сферы
    joint(j, 1, NaN, NaN, NaN, NaN);
    for (let f = 0; f < 10; f++) SP.step(st, DT, j);
    SP.step(st, 0, j); SP.step(st, -1, j);                            // мусор по dt
  } catch (e) { threw = String(e); }
  ok('устойчивость: без исключений', threw === null, threw);
  ok('устойчивость: координаты конечны',
     isFinite(st.pos.x) && isFinite(st.pos.y) && isFinite(st.pos.z) && isFinite(SP.speed(st)),
     JSON.stringify(st.pos));
  ok('устойчивость: сустав внутри сферы выталкивается, а не тонет',
     SP.penetration(st, joint(blank(1), 0, 0.02, 0, 0, 0.01)) < 1e-3, 'pen=' +
     SP.penetration(st, joint(blank(1), 0, 0.02, 0, 0, 0.01)).toFixed(4));

  const st2 = mk({});
  let x = -0.3;
  for (let f = 0; f < 200; f++) { x += 1.5 * DT; SP.step(st2, DT, joint(blank(1), 0, x, 0, 0, 0.01)); }
  const d = Math.hypot(st2.pos.x, st2.pos.y, st2.pos.z);
  ok('leash: сферу нельзя утащить за поводок', d <= st2.leash + 1e-3, 'd=' + d.toFixed(3) + ' leash=' + st2.leash);

  const st3 = mk({ floorY: 0 });
  let y = 0.5;
  for (let f = 0; f < 60; f++) { y -= 0.5 * DT; SP.step(st3, DT, joint(blank(1), 0, 0, y, 0, 0.01)); }
  ok('пол: сфера не проваливается под y=0', st3.pos.y >= st3.radius - 1e-6, 'y=' + st3.pos.y.toFixed(4));
}

console.log(fails ? '\n' + fails + ' FAIL' : '\nall passed');
process.exit(fails ? 1 : 0);
