/* Коллизия «руки -> сфера» для WebXR hand tracking.
 *
 * Чистый модуль: без three.js, без DOM — чтобы его можно было гонять в node (см.
 * sphere-push.test.mjs). Состояние и вход — плоские числа/объекты.
 *
 * Модель (запрошена «без инерции, как бильярдные шары»):
 *  - Каждый сустав кисти — шар (центр из XRJointPose.transform, радиус из XRJointPose.radius).
 *  - Нормаль контакта n = (центр сферы - центр сустава). Это ровно прямая, соединяющая
 *    точку касания на сфере и точку касания на руке, т.е. «линия центров» бильярда:
 *    сфера улетает ПО НОРМАЛИ, а не вдоль движения руки.
 *  - Пока есть контакт, скорость сферы = её фактическое перемещение / dt, т.е. ровно то,
 *    что её вытолкнула рука (позиционная коррекция перекрытия). Моментума нет:
 *    рука встала -> перемещения нет -> сфера встала.
 *  - После отрыва остаётся короткое затухающее доскольжение (releaseDamping), иначе
 *    сфера резко «залипает» и выглядит сломанной.
 *  - Касательная составляющая скорости руки (трение кожи) даёт небольшой занос вдоль
 *    поверхности — tangentialGain.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SpherePush = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var DEFAULTS = {
    radius: 0.085,        // м, радиус сферы
    handPad: 0.008,       // м, «кожа»: контакт чуть раньше реального касания
    releaseDamping: 14,   // 1/с, доскольжение после отрыва (~70 мс)
    pushGain: 1,          // доля нормальной скорости руки, ушедшая в сферу
    tangentialGain: 0.3,  // доля касательной скорости (трение)
    maxSpeed: 2.5,        // м/с
    velSmoothing: 0.045,  // с, ЭМА скорости сустава (джойстики трекинга шумят)
    leash: 2.2,           // м, мягкий радиус вокруг точки появления
    floorY: null,         // 0, если reference space = local-floor
    iterations: 3,        // passes расталкивания (ладонь + пальцы одновременно)
    minJointR: 0.004,
    maxJointR: 0.03
  };

  function create(opts) {
    var st = Object.assign({}, DEFAULTS, opts || {});
    st.pos = { x: 0, y: 0, z: 0 };
    st.vel = { x: 0, y: 0, z: 0 };
    st.anchor = { x: 0, y: 0, z: 0 };
    st.prevPos = [];   // [slot] -> {x,y,z} | null
    st.prevVel = [];   // [slot] -> {x,y,z}
    st.contacts = [];
    return st;
  }

  function place(st, x, y, z) {
    st.pos.x = x; st.pos.y = y; st.pos.z = z;
    st.anchor.x = x; st.anchor.y = y; st.anchor.z = z;
    st.vel.x = st.vel.y = st.vel.z = 0;
  }

  function finite3(p) {
    return isFinite(p[0]) && isFinite(p[1]) && isFinite(p[2]);
  }

  /* joints — плоский массив четвёрок [x,y,z,r, ...] в МИРОВЫХ координатах системы
   * отсчёта XR (той же, в которой рендерится сцена). Индекс слота (рука*25+сустав)
   * обязан быть стабилен между кадрами: по нему считается скорость сустава. */
  function step(st, dt, joints) {
    if (!(dt > 0)) return stats(st, 0);
    if (dt > 0.05) dt = 0.05;          // 20 fps — потолок, иначе расталкивание «взрывается»
    var n = joints ? (joints.length >> 2) : 0;
    var i, s;

    // 1. скорости суставов: ЭМА по смещению за кадр; пропал слот -> сброс
    var a = 1 - Math.exp(-dt / Math.max(1e-3, st.velSmoothing));
    var vel = [];
    for (s = 0; s < n; s++) {
      var p = [joints[s * 4], joints[s * 4 + 1], joints[s * 4 + 2]];
      var prev = st.prevPos[s];
      if (!finite3(p)) { st.prevPos[s] = null; vel[s] = null; continue; }
      if (prev) {
        var raw = { x: (p[0] - prev.x) / dt, y: (p[1] - prev.y) / dt, z: (p[2] - prev.z) / dt };
        var old = st.prevVel[s] || { x: 0, y: 0, z: 0 };
        vel[s] = { x: old.x + (raw.x - old.x) * a, y: old.y + (raw.y - old.y) * a, z: old.z + (raw.z - old.z) * a };
      } else {
        vel[s] = { x: 0, y: 0, z: 0 };
      }
      st.prevPos[s] = { x: p[0], y: p[1], z: p[2] };
      st.prevVel[s] = vel[s];
    }
    for (s = n; s < st.prevPos.length; s++) { st.prevPos[s] = null; st.prevVel[s] = null; }

    // 2. список контактов
    var R = st.radius, pad = st.handPad;
    var list = [];
    for (s = 0; s < n; s++) {
      var q = st.prevPos[s];
      if (!q) continue;
      var jr = joints[s * 4 + 3];
      jr = isFinite(jr) ? Math.min(st.maxJointR, Math.max(st.minJointR, jr)) : st.minJointR;
      var dx = st.pos.x - q.x, dy = st.pos.y - q.y, dz = st.pos.z - q.z;
      var dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      var min = R + jr + pad;
      if (dist >= min) continue;
      var nx, ny, nz;
      if (dist > 1e-6) { nx = dx / dist; ny = dy / dist; nz = dz / dist; }
      else { // сустав точно в центре сферы: выталкиваем вдоль скорости руки
        var v0 = vel[s];
        var vl = v0 ? Math.sqrt(v0.x * v0.x + v0.y * v0.y + v0.z * v0.z) : 0;
        if (vl > 1e-4) { nx = -v0.x / vl; ny = -v0.y / vl; nz = -v0.z / vl; }
        else { nx = 0; ny = 1; nz = 0; }
        dist = 1e-6;
      }
      list.push({ s: s, jx: q.x, jy: q.y, jz: q.z, jr: jr, nx: nx, ny: ny, nz: nz,
                  min: min, dist: dist, depth: min - dist,
                  vx: vel[s].x, vy: vel[s].y, vz: vel[s].z });
    }

    // 3. расталкивание (Gauss-Seidel): сфера никогда не остаётся внутри руки
    var before = { x: st.pos.x, y: st.pos.y, z: st.pos.z };
    if (list.length) {
      for (var it = 0; it < st.iterations; it++) {
        for (i = 0; i < list.length; i++) {
          var c = list[i];
          var ex = st.pos.x - c.jx, ey = st.pos.y - c.jy, ez = st.pos.z - c.jz;
          var ed = Math.sqrt(ex * ex + ey * ey + ez * ez);
          var over = c.min - ed;
          if (over <= 1e-6) continue;
          if (ed > 1e-6) { ex /= ed; ey /= ed; ez /= ed; } else { ex = c.nx; ey = c.ny; ez = c.nz; }
          st.pos.x += ex * over; st.pos.y += ey * over; st.pos.z += ez * over;
        }
      }
      // 4. трение: занос вдоль поверхности за счёт касательной скорости руки
      var tx = 0, ty = 0, tz = 0;
      for (i = 0; i < list.length; i++) {
        var k = list[i];
        var vn = k.vx * k.nx + k.vy * k.ny + k.vz * k.nz;
        tx += (k.vx - k.nx * vn) * st.pushGain;
        ty += (k.vy - k.ny * vn) * st.pushGain;
        tz += (k.vz - k.nz * vn) * st.pushGain;
      }
      var inv = st.tangentialGain / list.length * dt;
      st.pos.x += tx * inv; st.pos.y += ty * inv; st.pos.z += tz * inv;
    }

    // 5. скорость = фактическое перемещение / dt (никакого накопленного импульса)
    var mvx = (st.pos.x - before.x) / dt, mvy = (st.pos.y - before.y) / dt, mvz = (st.pos.z - before.z) / dt;
    if (list.length) {
      // Сфера не может быть быстрее того, кто её толкает: без этого лимита единовременное
      // перекрытие (рука «телепортировалась» внутрь после потери трекинга) выстреливало
      // сферой на maxSpeed, что выглядит как инерция.
      var drive = 0;
      for (i = 0; i < list.length; i++) {
        var c2 = list[i];
        var hs = Math.sqrt(c2.vx * c2.vx + c2.vy * c2.vy + c2.vz * c2.vz);
        if (hs > drive) drive = hs;
      }
      setVel(st, mvx, mvy, mvz, drive * 1.05);
    } else {
      st.pos.x += st.vel.x * dt; st.pos.y += st.vel.y * dt; st.pos.z += st.vel.z * dt;
      var decay = Math.exp(-st.releaseDamping * dt);
      setVel(st, st.vel.x * decay, st.vel.y * decay, st.vel.z * decay);
    }

    // 6. границы: пол и «поводок» вокруг точки появления, чтобы не потерять сферу
    if (st.floorY !== null && st.floorY !== undefined) {
      var fy = st.floorY + R;
      if (st.pos.y < fy) { st.pos.y = fy; if (st.vel.y < 0) st.vel.y = 0; }
    }
    var lx = st.pos.x - st.anchor.x, ly = st.pos.y - st.anchor.y, lz = st.pos.z - st.anchor.z;
    var ld = Math.sqrt(lx * lx + ly * ly + lz * lz);
    if (ld > st.leash && ld > 1e-6) {
      var f = st.leash / ld;
      st.pos.x = st.anchor.x + lx * f; st.pos.y = st.anchor.y + ly * f; st.pos.z = st.anchor.z + lz * f;
      var outward = (st.vel.x * lx + st.vel.y * ly + st.vel.z * lz) / ld;
      if (outward > 0) {
        st.vel.x -= lx / ld * outward; st.vel.y -= ly / ld * outward; st.vel.z -= lz / ld * outward;
      }
    }

    // 7. точки касания для отрисовки (на сфере и на руке)
    st.contacts.length = 0;
    for (i = 0; i < list.length; i++) {
      var t = list[i];
      st.contacts.push({
        slot: t.s, depth: t.depth,
        nx: t.nx, ny: t.ny, nz: t.nz,
        sx: st.pos.x - t.nx * R, sy: st.pos.y - t.ny * R, sz: st.pos.z - t.nz * R,
        hx: t.jx + t.nx * t.jr, hy: t.jy + t.ny * t.jr, hz: t.jz + t.nz * t.jr
      });
    }
    return stats(st, list.length);
  }

  function setVel(st, x, y, z, cap) {
    var l = Math.sqrt(x * x + y * y + z * z);
    var lim = isFinite(cap) ? Math.min(st.maxSpeed, Math.max(0, cap)) : st.maxSpeed;
    if (l > lim && l > 0) { var f = lim / l; x *= f; y *= f; z *= f; }
    if (!isFinite(x) || !isFinite(y) || !isFinite(z)) { st.vel.x = st.vel.y = st.vel.z = 0; return; }
    st.vel.x = x; st.vel.y = y; st.vel.z = z;
  }

  function speed(st) {
    return Math.sqrt(st.vel.x * st.vel.x + st.vel.y * st.vel.y + st.vel.z * st.vel.z);
  }

  function stats(st, contacts) {
    return { contacts: contacts, speed: speed(st),
             pos: { x: st.pos.x, y: st.pos.y, z: st.pos.z } };
  }

  /* Глубина самого глубокого проникновения — для тестов и отладки. */
  function penetration(st, joints) {
    var worst = 0;
    for (var s = 0; s < (joints.length >> 2); s++) {
      var x = joints[s * 4], y = joints[s * 4 + 1], z = joints[s * 4 + 2];
      if (!finite3([x, y, z])) continue;
      var jr = joints[s * 4 + 3];
      jr = isFinite(jr) ? Math.min(st.maxJointR, Math.max(st.minJointR, jr)) : st.minJointR;
      var d = Math.sqrt((st.pos.x - x) ** 2 + (st.pos.y - y) ** 2 + (st.pos.z - z) ** 2);
      var over = st.radius + jr + st.handPad - d;
      if (over > worst) worst = over;
    }
    return worst;
  }

  return { create: create, place: place, step: step, speed: speed,
           penetration: penetration, DEFAULTS: DEFAULTS };
});
