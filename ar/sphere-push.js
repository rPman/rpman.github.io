/* Коллизия «руки -> тела» и «тела -> тела» для WebXR hand tracking.
 *
 * Чистый модуль: без three.js, без DOM — чтобы его можно было гонять в node (см.
 * sphere-push.test.mjs). Состояние и вход — плоские числа/объекты.
 *
 * Мир = конфиг + массив тел (`world.bodies`). Тело = шар-прокси: pos/vel/anchor/radius.
 * Для куба, тетраэдра, додекаэдра и тора берётся один радиус касания (между вписанной и
 * описанной сферой формы) — форма в физике не различается, различается только размер шара.
 * create() создаёт мир с одним телом; world.pos/vel/anchor/contacts — это bodies[0], т.е.
 * API одно-телевой версии сохранено.
 *
 * Модель (запрошена «без инерции, как бильярдные шары»):
 *  - Каждый сустав кисти — шар (центр из XRJointPose.transform, радиус из XRJointPose.radius).
 *  - Нормаль контакта n = (центр тела - центр сустава или соседнего тела). Это ровно прямая,
 *    соединяющая точки касания, т.е. «линия центров» бильярда: тело уходит ПО НОРМАЛИ,
 *    а не вдоль движения толкающего.
 *  - Пока есть контакт, скорость тела = его фактическое перемещение / dt, т.е. ровно то,
 *    что его вытолкнули (позиционная коррекция перекрытия). Моментума нет:
 *    рука встала -> перемещения нет -> тело встало.
 *  - Тело, которое в этом кадре толкает рука, для соседей неподвижно (как рука): всё
 *    перекрытие расталкиваемого получает сосед. Если толкают оба тела или ни одного —
 *    перекрытие делится пополам.
 *  - После отрыва остаётся короткое затухающее доскольжение (releaseDamping), иначе
 *    тело резко «залипает» и выглядит сломанным.
 *  - Касательная составляющая скорости толкающего (трение) даёт небольшой занос вдоль
 *    поверхности — tangentialGain.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SpherePush = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var DEFAULTS = {
    radius: 0.085,        // м, радиус первого (главного) тела
    handPad: 0.008,       // м, «кожа»: контакт с суставом чуть раньше реального касания
    bodyPad: 0.003,       // м, тот же запас между телами
    bodySkin: 0.002,      // м, за сколько до касания контакт между телами уже засчитывается
    releaseDamping: 14,   // 1/с, доскольжение после отрыва (~70 мс)
    pushGain: 1,          // доля нормальной скорости толкающего, ушедшая в тело
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
    var w = Object.assign({}, DEFAULTS, opts || {});
    w.prevPos = [];   // [slot] -> {x,y,z} | null
    w.prevVel = [];   // [slot] -> {x,y,z}
    w.bodies = [];
    addBody(w, { id: 'main', shape: 'sphere' });
    var b = w.bodies[0];
    w.pos = b.pos; w.vel = b.vel; w.anchor = b.anchor; w.contacts = b.contacts;
    return w;
  }

  function addBody(w, opts) {
    var o = opts || {};
    var b = {
      id: o.id || ('body' + w.bodies.length),
      shape: o.shape || 'ball',
      radius: (isFinite(o.radius) && o.radius > 0) ? o.radius : w.radius,
      pos: { x: 0, y: 0, z: 0 },
      vel: { x: 0, y: 0, z: 0 },
      anchor: { x: 0, y: 0, z: 0 },
      contacts: [],
      index: w.bodies.length
    };
    w.bodies.push(b);
    return b;
  }

  /* Принимаем и мир, и тело: у мира берём главное тело (bodies[0]). */
  function bodyOf(t) { return t.bodies ? t.bodies[0] : t; }

  function place(target, x, y, z) {
    var b = bodyOf(target);
    b.pos.x = x; b.pos.y = y; b.pos.z = z;
    b.anchor.x = x; b.anchor.y = y; b.anchor.z = z;
    b.vel.x = b.vel.y = b.vel.z = 0;
  }

  function finite3(p) {
    return isFinite(p[0]) && isFinite(p[1]) && isFinite(p[2]);
  }

  function jointRadius(w, r) {
    return isFinite(r) ? Math.min(w.maxJointR, Math.max(w.minJointR, r)) : w.minJointR;
  }

  /* Контакт «b толкает o»: o — сустав (o = null) или соседнее тело.
   * skin — запас, на котором контакт уже ЗАСЧИТЫВАЕТСЯ (тело считается занятым и не
   * катится по инерции), но ещё не корректируется: без него тело, едущее впритык за
   * соседом, в следующем кадре наезжало бы на него, и между телами висел бы
   * осциллирующий зазор в доли миллиметра. */
  function pushContact(b, min, ox, oy, oz, or_, vx, vy, vz, other, skin) {
    var dx = b.pos.x - ox, dy = b.pos.y - oy, dz = b.pos.z - oz;
    var dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (dist >= min + (skin || 0)) return null;
    var nx, ny, nz;
    if (dist > 1e-6) { nx = dx / dist; ny = dy / dist; nz = dz / dist; }
    else {  // толкающий точно в центре тела: выталкиваем вдоль его скорости
      var vl = Math.sqrt(vx * vx + vy * vy + vz * vz);
      if (vl > 1e-4) { nx = -vx / vl; ny = -vy / vl; nz = -vz / vl; }
      else { nx = 0; ny = 1; nz = 0; }
      dist = 1e-6;
    }
    return { o: other, px: ox, py: oy, pz: oz, pr: or_, min: min,
             nx: nx, ny: ny, nz: nz, dist: dist, depth: Math.max(0, min - dist),
             vx: vx, vy: vy, vz: vz };
  }

  /* joints — плоский массив четвёрок [x,y,z,r, ...] в МИРОВЫХ координатах системы
   * отсчёта XR (той же, в которой рендерится сцена). Индекс слота (рука*25+сустав)
   * обязан быть стабилен между кадрами: по нему считается скорость сустава. */
  function step(w, dt, joints) {
    if (!(dt > 0)) return stats(w, 0);
    if (dt > 0.05) dt = 0.05;          // 20 fps — потолок, иначе расталкивание «взрывается»
    var n = joints ? (joints.length >> 2) : 0;
    var B = w.bodies, nb = B.length;
    var i, j, s, b;

    // 1. скорости суставов: ЭМА по смещению за кадр; пропал слот -> сброс
    var a = 1 - Math.exp(-dt / Math.max(1e-3, w.velSmoothing));
    var jvel = [];
    for (s = 0; s < n; s++) {
      var p = [joints[s * 4], joints[s * 4 + 1], joints[s * 4 + 2]];
      var prev = w.prevPos[s];
      if (!finite3(p)) { w.prevPos[s] = null; jvel[s] = null; continue; }
      if (prev) {
        var raw = { x: (p[0] - prev.x) / dt, y: (p[1] - prev.y) / dt, z: (p[2] - prev.z) / dt };
        var old = w.prevVel[s] || { x: 0, y: 0, z: 0 };
        jvel[s] = { x: old.x + (raw.x - old.x) * a, y: old.y + (raw.y - old.y) * a, z: old.z + (raw.z - old.z) * a };
      } else {
        jvel[s] = { x: 0, y: 0, z: 0 };
      }
      w.prevPos[s] = { x: p[0], y: p[1], z: p[2] };
      w.prevVel[s] = jvel[s];
    }
    for (s = n; s < w.prevPos.length; s++) { w.prevPos[s] = null; w.prevVel[s] = null; }

    // 2. контакты каждого тела: суставы + соседние тела
    var lists = [], driven = [];
    for (i = 0; i < nb; i++) {
      b = B[i];
      var list = [];
      for (s = 0; s < n; s++) {
        var q = w.prevPos[s];
        if (!q || !jvel[s]) continue;
        var jr = jointRadius(w, joints[s * 4 + 3]);
        var c1 = pushContact(b, b.radius + jr + w.handPad, q.x, q.y, q.z, jr,
                             jvel[s].x, jvel[s].y, jvel[s].z, null);
        if (c1) { c1.slot = s; list.push(c1); }
      }
      for (j = 0; j < nb; j++) {
        if (j === i) continue;
        var o = B[j];
        var c2 = pushContact(b, b.radius + o.radius + w.bodyPad, o.pos.x, o.pos.y, o.pos.z,
                             o.radius, o.vel.x, o.vel.y, o.vel.z, o, w.bodySkin);
        if (c2) { c2.slot = -1 - j; list.push(c2); }   // отрицательный slot = толкает тело j
      }
      lists[i] = list;
      var hand = false;
      for (j = 0; j < list.length; j++) if (!list[j].o) { hand = true; break; }
      driven[i] = hand;
    }

    // 3. расталкивание (Gauss-Seidel): тело никогда не остаётся внутри руки или соседа.
    //    Цепочка из N тел сходится только за ~N проходов, поэтому для мира из многих тел
    //    берём не меньше проходов, чем тел.
    var before = [];
    for (i = 0; i < nb; i++) before.push({ x: B[i].pos.x, y: B[i].pos.y, z: B[i].pos.z });
    var passes = Math.max(w.iterations, nb);
    for (var it = 0; it < passes; it++) {
      for (i = 0; i < nb; i++) {
        b = B[i];
        var lst = lists[i];
        for (j = 0; j < lst.length; j++) {
          var c = lst[j];
          // толкающий-сосед двигается вместе с нами, поэтому его позицию берём живьём,
          // а не снимком из сбора контактов (иначе overlap считается по устаревшему центру
          // и тело расталкивает дальше, чем нужно)
          var px = c.o ? c.o.pos.x : c.px, py = c.o ? c.o.pos.y : c.py, pz = c.o ? c.o.pos.z : c.pz;
          var ex = b.pos.x - px, ey = b.pos.y - py, ez = b.pos.z - pz;
          var ed = Math.sqrt(ex * ex + ey * ey + ez * ez);
          var over = c.min - ed;
          if (over <= 1e-6) continue;
          if (ed > 1e-6) { ex /= ed; ey /= ed; ez /= ed; } else { ex = c.nx; ey = c.ny; ez = c.nz; }
          if (c.o) {
            // ведомое рукой тело для соседа неподвижно — как рука; иначе делим пополам
            var wb = driven[i] ? 0 : 1, wo = driven[c.o.index] ? 0 : 1;
            if (wb + wo === 0) { wb = 1; wo = 1; }
            var tot = wb + wo;
            b.pos.x += ex * over * (wb / tot); b.pos.y += ey * over * (wb / tot); b.pos.z += ez * over * (wb / tot);
            c.o.pos.x -= ex * over * (wo / tot); c.o.pos.y -= ey * over * (wo / tot); c.o.pos.z -= ez * over * (wo / tot);
          } else {
            b.pos.x += ex * over; b.pos.y += ey * over; b.pos.z += ez * over;
          }
        }
      }
    }

    // 4. трение: занос вдоль поверхности за счёт касательной скорости толкающего
    for (i = 0; i < nb; i++) {
      var l2 = lists[i];
      if (!l2.length) continue;
      var tx = 0, ty = 0, tz = 0;
      for (j = 0; j < l2.length; j++) {
        var k = l2[j];
        var vn = k.vx * k.nx + k.vy * k.ny + k.vz * k.nz;
        tx += (k.vx - k.nx * vn) * w.pushGain;
        ty += (k.vy - k.ny * vn) * w.pushGain;
        tz += (k.vz - k.nz * vn) * w.pushGain;
      }
      var inv = w.tangentialGain / l2.length * dt;
      b = B[i];
      b.pos.x += tx * inv; b.pos.y += ty * inv; b.pos.z += tz * inv;
    }

    // 5. скорость = фактическое перемещение / dt (никакого накопленного импульса)
    for (i = 0; i < nb; i++) {
      b = B[i];
      var list2 = lists[i];
      var mvx = (b.pos.x - before[i].x) / dt, mvy = (b.pos.y - before[i].y) / dt, mvz = (b.pos.z - before[i].z) / dt;
      if (list2.length) {
        // Тело не может быть быстрее того, кто его толкает: без этого лимита единовременное
        // перекрытие (рука «телепортировалась» внутрь после потери трекинга) выстреливало
        // телом на maxSpeed, что выглядит как инерция.
        var drive = 0;
        for (j = 0; j < list2.length; j++) {
          var c3 = list2[j];
          var hs = Math.sqrt(c3.vx * c3.vx + c3.vy * c3.vy + c3.vz * c3.vz);
          if (hs > drive) drive = hs;
        }
        setVel(w, b, mvx, mvy, mvz, drive * 1.05);
      } else {
        b.pos.x += b.vel.x * dt; b.pos.y += b.vel.y * dt; b.pos.z += b.vel.z * dt;
        var decay = Math.exp(-w.releaseDamping * dt);
        setVel(w, b, b.vel.x * decay, b.vel.y * decay, b.vel.z * decay);
      }
    }

    // 6. границы: пол и «поводок» вокруг точки появления, чтобы не потерять тело
    for (i = 0; i < nb; i++) {
      b = B[i];
      if (w.floorY !== null && w.floorY !== undefined) {
        var fy = w.floorY + b.radius;
        if (b.pos.y < fy) { b.pos.y = fy; if (b.vel.y < 0) b.vel.y = 0; }
      }
      var lx = b.pos.x - b.anchor.x, ly = b.pos.y - b.anchor.y, lz = b.pos.z - b.anchor.z;
      var ld = Math.sqrt(lx * lx + ly * ly + lz * lz);
      if (ld > w.leash && ld > 1e-6) {
        var f = w.leash / ld;
        b.pos.x = b.anchor.x + lx * f; b.pos.y = b.anchor.y + ly * f; b.pos.z = b.anchor.z + lz * f;
        var outward = (b.vel.x * lx + b.vel.y * ly + b.vel.z * lz) / ld;
        if (outward > 0) {
          b.vel.x -= lx / ld * outward; b.vel.y -= ly / ld * outward; b.vel.z -= lz / ld * outward;
        }
      }
    }

    // 6b. тела не имеют права остаться пересекающимися и после шага: свободный полёт
    //     (шаг 5) считается до коррекции и может за один кадр наехать на соседа, которого
    //     в этом кадре ещё не считали контактом.
    separate(w, driven);

    // 7. точки касания для отрисовки (на теле и на толкающем)
    for (i = 0; i < nb; i++) {
      b = B[i];
      b.contacts.length = 0;
      var l3 = lists[i];
      for (j = 0; j < l3.length; j++) {
        var t = l3[j];
        var qx = t.o ? t.o.pos.x : t.px, qy = t.o ? t.o.pos.y : t.py, qz = t.o ? t.o.pos.z : t.pz;
        b.contacts.push({
          slot: t.slot,
          body: t.o ? t.o.id : null,
          depth: t.depth,
          nx: t.nx, ny: t.ny, nz: t.nz,
          sx: b.pos.x - t.nx * b.radius, sy: b.pos.y - t.ny * b.radius, sz: b.pos.z - t.nz * b.radius,
          hx: qx + t.nx * t.pr, hy: qy + t.ny * t.pr, hz: qz + t.nz * t.pr
        });
      }
    }
    return stats(w, lists[0].length);
  }

  /* Расталкивание тел после свободного полёта. Свободный полёт (шаг 5) выполняется до
   * коррекции перекрытий, поэтому быстрый шар за кадр может въехать в соседа, который
   * в этом кадре ещё не попал в список контактов. Здесь только позиции, без скорости:
   * моментума у модели нет, а «не быстрее того, кто толкает» должно оставаться и тут. */
  function separate(w, driven) {
    var B = w.bodies, nb = B.length;
    if (nb < 2) return;
    for (var it = 0; it < 2 * nb; it++) {
      for (var i = 0; i < nb; i++) {
        for (var j = i + 1; j < nb; j++) {
          var a = B[i], c = B[j];
          var ex = c.pos.x - a.pos.x, ey = c.pos.y - a.pos.y, ez = c.pos.z - a.pos.z;
          var d = Math.sqrt(ex * ex + ey * ey + ez * ez);
          var over = a.radius + c.radius + w.bodyPad - d;
          if (over <= 1e-6) continue;
          if (d > 1e-6) { ex /= d; ey /= d; ez /= d; } else { ex = 0; ey = 1; ez = 0; }
          var wa = driven[i] ? 0 : 1, wc = driven[j] ? 0 : 1;
          if (wa + wc === 0) { wa = 1; wc = 1; }
          var tot = wa + wc;
          a.pos.x -= ex * over * (wa / tot); a.pos.y -= ey * over * (wa / tot); a.pos.z -= ez * over * (wa / tot);
          c.pos.x += ex * over * (wc / tot); c.pos.y += ey * over * (wc / tot); c.pos.z += ez * over * (wc / tot);
        }
      }
    }
  }

  function setVel(w, b, x, y, z, cap) {
    var l = Math.sqrt(x * x + y * y + z * z);
    var lim = isFinite(cap) ? Math.min(w.maxSpeed, Math.max(0, cap)) : w.maxSpeed;
    if (l > lim && l > 0) { var f = lim / l; x *= f; y *= f; z *= f; }
    if (!isFinite(x) || !isFinite(y) || !isFinite(z)) { b.vel.x = b.vel.y = b.vel.z = 0; return; }
    b.vel.x = x; b.vel.y = y; b.vel.z = z;
  }

  function speed(target) {
    var b = bodyOf(target);
    return Math.sqrt(b.vel.x * b.vel.x + b.vel.y * b.vel.y + b.vel.z * b.vel.z);
  }

  function fastest(w) {
    var m = 0;
    for (var i = 0; i < w.bodies.length; i++) m = Math.max(m, speed(w.bodies[i]));
    return m;
  }

  function totalContacts(w) {
    var m = 0;
    for (var i = 0; i < w.bodies.length; i++) m += w.bodies[i].contacts.length;
    return m;
  }

  function stats(w, contacts) {
    var b = w.bodies[0];
    return { contacts: contacts, speed: speed(b),
             pos: { x: b.pos.x, y: b.pos.y, z: b.pos.z } };
  }

  /* Глубина самого глубокого проникновения суставов в тела — для тестов и отладки. */
  function penetration(w, joints) {
    var worst = 0;
    for (var i = 0; i < w.bodies.length; i++) {
      var b = w.bodies[i];
      for (var s = 0; s < (joints.length >> 2); s++) {
        var x = joints[s * 4], y = joints[s * 4 + 1], z = joints[s * 4 + 2];
        if (!finite3([x, y, z])) continue;
        var jr = jointRadius(w, joints[s * 4 + 3]);
        var d = Math.sqrt((b.pos.x - x) ** 2 + (b.pos.y - y) ** 2 + (b.pos.z - z) ** 2);
        var over = b.radius + jr + w.handPad - d;
        if (over > worst) worst = over;
      }
    }
    return worst;
  }

  /* Глубина самого глубокого взаимного проникновения тел (после шага обязана быть ~0). */
  function bodyPenetration(w) {
    var worst = 0, B = w.bodies;
    for (var i = 0; i < B.length; i++) {
      for (var j = i + 1; j < B.length; j++) {
        var d = Math.sqrt((B[i].pos.x - B[j].pos.x) ** 2 + (B[i].pos.y - B[j].pos.y) ** 2 +
                          (B[i].pos.z - B[j].pos.z) ** 2);
        var over = B[i].radius + B[j].radius + w.bodyPad - d;
        if (over > worst) worst = over;
      }
    }
    return worst;
  }

  return { create: create, addBody: addBody, place: place, step: step, speed: speed,
           fastest: fastest, totalContacts: totalContacts, penetration: penetration,
           bodyPenetration: bodyPenetration, DEFAULTS: DEFAULTS };
});
