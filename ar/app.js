/* WebXR AR: набор цветных фигур, которые толкают реальные руки (hand tracking).
 * Фигуры толкают не только руки, но и друг друга — по той же схеме, что и суставы.
 * Зависимости — глобальные THREE (ar/three-r128.min.js) и SpherePush (ar/sphere-push.js),
 * оба подключаются <script src> в ar-h.html.
 */
(function () {
  'use strict';

  var THREE = window.THREE;
  var PHYS = window.SpherePush;
  var JPH = 25;                  // суставов на кисть — фиксированный порядок спеки
  var MAX_SLOTS = JPH * 2;       // левая занимает 0..24, правая 25..49
  var CONTACT_MAX = 60;

  var el = function (id) { return document.getElementById(id); };
  var startScreen = el('start'), hud = el('hud'), errBox = el('err');
  var btnAR = el('enterAR'), btnPreview = el('preview'), btnReset = el('btnReset'), btnHands = el('btnHands');
  var statLine = el('stat'), hudNote = el('hudNote'), noteLine = el('note');

  /* ------------------------------------------------------------ сцена */
  var renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(window.devicePixelRatio || 1);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setClearColor(0x000000, 0);      // alpha-blend passthrough: фон обязан быть прозрачным
  renderer.xr.enabled = true;
  renderer.xr.setReferenceSpaceType('local-floor');
  document.body.appendChild(renderer.domElement);

  var scene = new THREE.Scene();            // scene.background НЕ задаём в AR
  var camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.01, 40);
  camera.position.set(0, 1.35, 0.85);
  camera.lookAt(0, 1.1, 0);

  scene.add(new THREE.HemisphereLight(0xffffff, 0x556677, 0.9));
  var sun = new THREE.DirectionalLight(0xffffff, 0.8);
  sun.position.set(0.4, 1.2, 0.5);
  scene.add(sun);

  /* ------------------------------------------------------------ фигуры сцены
   * Каждая фигура — тело физики (шар-прокси) + своя геометрия и цвет. Форма в коллизиях
   * не различается: radius подобран между вписанной и описанной сферой формы, чтобы
   * грань куба и его угол давали примерно одинаковое расстояние до руки.
   * Первое тело — сфера: world.pos/world.contacts это оно же. */
  var OBJECTS = [
    { id: 'sphere', color: 0xffffff, r: 0.085, geo: function () { return new THREE.SphereGeometry(0.085, 48, 32); } },
    { id: 'cube', color: 0xff5c5c, r: 0.090, geo: function () { return new THREE.BoxGeometry(0.13, 0.13, 0.13); } },
    { id: 'tetra', color: 0xffd166, r: 0.075, geo: function () { return new THREE.TetrahedronGeometry(0.10); } },
    { id: 'dodeca', color: 0x4ade80, r: 0.090, geo: function () { return new THREE.DodecahedronGeometry(0.10); } },
    { id: 'torus', color: 0xc084fc, r: 0.090, geo: function () { return new THREE.TorusGeometry(0.075, 0.03, 20, 40); } }
  ];
  var LATERAL = [-0.48, -0.24, 0, 0.24, 0.48];   // м, вдоль «вправо» от точки появления

  var world = PHYS.create({ radius: OBJECTS[0].r, leash: 2.2, floorY: null });
  var items = [];
  OBJECTS.forEach(function (o, i) {
    var body = i === 0 ? world.bodies[0] : PHYS.addBody(world, { id: o.id, radius: o.r });
    body.id = o.id;
    var mat = new THREE.MeshStandardMaterial({
      color: o.color, roughness: 0.32, metalness: 0.02, emissive: o.color, emissiveIntensity: 0
    });
    var mesh = new THREE.Mesh(o.geo(), mat);
    scene.add(mesh);
    items.push({ body: body, mesh: mesh, mat: mat });
  });
  var lead = items[0];

  /* Ряд фигур вдоль «вправо» от точки cx,cy,cz. */
  function placeRow(cx, cy, cz, rx, ry, rz) {
    for (var k = 0; k < items.length; k++) {
      var off = LATERAL[k] || 0;
      PHYS.place(items[k].body, cx + rx * off, cy + ry * off, cz + rz * off);
    }
  }
  placeRow(0, 1.1, 0, 1, 0, 0);

  // Прокси кистей — те же шары, что участвуют в коллизии: видно, ПОЧЕМУ поехала фигура.
  var jointMesh = new THREE.InstancedMesh(
    new THREE.SphereGeometry(1, 12, 8),
    new THREE.MeshBasicMaterial({ color: 0x63c8ff, transparent: true, opacity: 0.3 }), MAX_SLOTS);
  jointMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  jointMesh.count = 0;
  scene.add(jointMesh);

  var contactMesh = new THREE.InstancedMesh(
    new THREE.SphereGeometry(1, 10, 8),
    new THREE.MeshBasicMaterial({ color: 0xff7a1a }), CONTACT_MAX);
  contactMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  contactMesh.count = 0;
  scene.add(contactMesh);

  var previewRig = new THREE.Group();       // сетка пола — только в режиме без шлема
  previewRig.add(new THREE.GridHelper(6, 30, 0x2f3b4a, 0x1c242e));
  scene.add(previewRig);

  var showHands = true;

  /* ------------------------------------------------------------ настройки ощущаемости */
  var cfg = { handPad: 0.008, tangentialGain: 0.3, releaseDamping: 14 };
  function applyCfg() {
    world.handPad = cfg.handPad;
    world.tangentialGain = cfg.tangentialGain;
    world.releaseDamping = cfg.releaseDamping;
  }
  ['handPad', 'tangentialGain', 'releaseDamping'].forEach(function (k) {
    var input = el('cfg_' + k);
    if (!input) return;
    var out = el('out_' + k);
    var sync = function () {
      cfg[k] = parseFloat(input.value);
      applyCfg();
      if (out) out.textContent = input.value;
    };
    input.addEventListener('input', sync);
    sync();
  });

  /* ------------------------------------------------------------ чтение кистей */
  var jointBuf = new Float64Array(MAX_SLOTS * 4);
  var mats = new Float32Array(16 * JPH);
  var radii = new Float32Array(JPH);
  var baseBySource = new Map();             // XRInputSource -> базовый слот, стабилен между кадрами

  function clampR(r) {
    return isFinite(r) ? Math.min(0.03, Math.max(0.004, r)) : 0.004;
  }
  function put(slot, x, y, z, r) {
    var o = slot * 4;
    jointBuf[o] = x; jointBuf[o + 1] = y; jointBuf[o + 2] = z; jointBuf[o + 3] = clampR(r);
  }
  function slotBase(src, taken) {
    var b = baseBySource.get(src);
    if (b !== undefined) return b;
    for (var i = 0; i < 2; i++) {
      if (taken.indexOf(i * JPH) < 0) { baseBySource.set(src, i * JPH); return i * JPH; }
    }
    return JPH;
  }

  /* Пишет все кисти в jointBuf (мировые координаты системы отсчёта XR — той же, в которой
   * рендерится сцена: r128 getReferenceSpace() отдаёт тот же space, что и рендер).
   * Быстрый путь fillPoses/fillJointRadii дешевле по аллокациям, но по спеке отказывает на
   * ВСЮ кисть, если не оттрекан хоть один сустав, — тогда читаем getJointPose поштучно,
   * чтобы половина кисти продолжала толкаться. */
  function readHands(frame, refSpace, session) {
    jointBuf.fill(NaN);
    var sources = session.inputSources, taken = [], hands = 0, live = [], i;
    for (i = 0; i < sources.length; i++) live.push(sources[i]);
    baseBySource.forEach(function (v, src) { if (live.indexOf(src) < 0) baseBySource.delete(src); });

    for (i = 0; i < sources.length; i++) {
      var src = sources[i], hand = src.hand;
      if (!hand) continue;
      var base = slotBase(src, taken); taken.push(base); hands++;
      var fast = false;
      if (frame.fillPoses && frame.fillJointRadii) {
        try {
          fast = frame.fillJointRadii(hand.values(), radii) && frame.fillPoses(hand.values(), refSpace, mats);
        } catch (e) { fast = false; }
      }
      if (fast) {
        for (var j = 0; j < JPH; j++) {
          var o = j * 16;                                   // колонки 12..14 = перевод
          put(base + j, mats[o + 12], mats[o + 13], mats[o + 14], radii[j]);
        }
      } else {
        var k = 0;
        hand.forEach(function (space, name) {               // обход в порядке спеки
          if (k >= JPH) return;
          var jp = null;
          try { jp = frame.getJointPose(space, refSpace); } catch (e) { jp = null; }
          if (jp) put(base + k, jp.transform.position.x, jp.transform.position.y,
                       jp.transform.position.z, jp.radius);
          k++;
        });
      }
    }
    return hands;
  }

  /* ------------------------------------------------------------ режим без шлема
   * Псевдо-кисть из 6 шаров идёт за курсором в плоскости, перпендикулярной взгляду и
   * проходящей через центр главной фигуры (ряда). Физика боевая — тот же step(). */
  var pointer = { x: 0, y: 0, has: false };
  var ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
  var plane = new THREE.Plane(), hitPt = new THREE.Vector3(), viewDir = new THREE.Vector3();
  var FAN = [[0, 0], [-0.05, 0.010], [-0.025, 0.020], [0.005, 0.022], [0.035, 0.016], [0.060, 0.004]];

  function readFakeHand() {
    jointBuf.fill(NaN);                     // фан-кисть короче реальной: хвост обязан быть пуст
    if (!pointer.has) return 0;
    // плоскость строим по позиции mesh (THREE.Vector3): у тела pos — простой объект, THREE
    // требует именно вектор (у него есть .dot)
    plane.setFromNormalAndCoplanarPoint(viewDir.set(0, 0, -1).applyQuaternion(camera.quaternion),
                                        lead.mesh.position);
    ndc.set(pointer.x, pointer.y);
    ray.setFromCamera(ndc, camera);
    if (!ray.ray.intersectPlane(plane, hitPt)) return 1;
    for (var i = 0; i < FAN.length; i++) put(i, hitPt.x + FAN[i][0], hitPt.y + FAN[i][1], hitPt.z, 0.011);
    return 1;
  }

  renderer.domElement.addEventListener('pointermove', function (e) {
    if (mode !== 'preview') return;
    pointer.x = (e.clientX / window.innerWidth) * 2 - 1;
    pointer.y = -(e.clientY / window.innerHeight) * 2 + 1;
    pointer.has = true;
  });
  renderer.domElement.addEventListener('pointerleave', function () { pointer.has = false; });

  /* ------------------------------------------------------------ шаг мира и отрисовка */
  var mtx = new THREE.Matrix4(), q0 = new THREE.Quaternion(), vPos = new THREE.Vector3(), vScl = new THREE.Vector3();

  function setInstance(mesh, i, x, y, z, r) {
    if (r > 0) { vPos.set(x, y, z); vScl.set(r, r, r); } else { vPos.set(0, -100, 0); vScl.set(0, 0, 0); }
    mtx.compose(vPos, q0, vScl);
    mesh.setMatrixAt(i, mtx);
  }

  function stepWorld(dt, joints) {
    var res = PHYS.step(world, dt, joints);

    var pad = world.handPad, s, i, k;
    for (k = 0; k < items.length; k++) {
      var b = items[k].body, c = b.contacts;
      items[k].mesh.position.set(b.pos.x, b.pos.y, b.pos.z);
      items[k].mat.emissiveIntensity = c.length ? Math.min(0.55, 0.12 + 0.09 * c.length) : 0;
    }

    for (s = 0; s < MAX_SLOTS; s++) {
      var o = s * 4;
      if (isFinite(joints[o]) && showHands) setInstance(jointMesh, s, joints[o], joints[o + 1], joints[o + 2], joints[o + 3] + pad * 0.5);
      else setInstance(jointMesh, s, 0, 0, 0, 0);
    }
    jointMesh.count = MAX_SLOTS;
    jointMesh.instanceMatrix.needsUpdate = true;

    var ci = 0;                               // точки касания со всех тел: руки и фигуры друг о друга
    for (k = 0; k < items.length; k++) {
      var cs = items[k].body.contacts;
      for (i = 0; i < cs.length && ci < CONTACT_MAX; i++) setInstance(contactMesh, ci++, cs[i].sx, cs[i].sy, cs[i].sz, 0.006);
    }
    contactMesh.count = ci;
    contactMesh.instanceMatrix.needsUpdate = true;
    return res;
  }

  /* Ставит весь ряд фигур перед головой (в AR) или перед камерой (в превью). */
  function placeInFrontOfHead(frame, refSpace) {
    var x, y, z, dx, dy, dz;
    var p = frame && refSpace ? frame.getViewerPose(refSpace) : null;
    if (p) {
      var t = p.transform.position, o = p.transform.orientation;
      x = t.x; y = t.y; z = t.z;
      // вперёд = (0,0,-1) в системе ориентации головы
      dx = -2 * (o.x * o.z + o.w * o.y);
      dy = -2 * (o.y * o.z - o.w * o.x);
      dz = -(1 - 2 * (o.x * o.x + o.y * o.y));
    } else {
      camera.getWorldPosition(vPos); x = vPos.x; y = vPos.y; z = vPos.z;
      camera.getWorldDirection(vPos); dx = vPos.x; dy = vPos.y; dz = vPos.z;
    }
    var l = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
    dx /= l; dy /= l; dz /= l;
    // «вправо» = вперёд × верх(0,1,0); ряд лежит перпендикулярно взгляду
    var rl = Math.sqrt(dx * dx + dz * dz) || 1;
    placeRow(x + dx * 0.8, y + dy * 0.8 - 0.06, z + dz * 0.8, -dz / rl, 0, dx / rl);
  }

  /* ------------------------------------------------------------ цикл */
  var mode = 'idle';                            // idle | ar | preview
  var clock = new THREE.Clock();
  var handsSeen = 0, fps = 0, frames = 0, fpsT = 0, placed = false, floorMode = null;
  var handsEver = false, arStart = 0, noHandsFeature = false;
  var lastFrame = null, lastRef = null;

  function tick(time, frame) {
    if (frame) { lastFrame = frame; lastRef = renderer.xr.getReferenceSpace(); }
    var dt = clock.getDelta();
    if (dt > 0.2) dt = 1 / 60;                  // первый кадр после паузы вкладки
    frames++; fpsT += dt;
    if (fpsT > 0.5) { fps = frames / fpsT; frames = 0; fpsT = 0; updateStat(); }

    if (mode === 'ar' && frame) {
      handsSeen = readHands(frame, lastRef, renderer.xr.getSession());
      if (!placed) { placeInFrontOfHead(frame, lastRef); placed = true; }
      stepWorld(dt, jointBuf);
    } else if (mode === 'preview') {
      handsSeen = readFakeHand();
      stepWorld(dt, jointBuf);
    }
    renderer.render(scene, camera);
  }
  renderer.setAnimationLoop(tick);

  function updateStat() {
    statLine.textContent = 'fps ' + fps.toFixed(0) + ' · рук ' + handsSeen +
      ' · фигур ' + items.length + ' · касаний ' + PHYS.totalContacts(world) +
      ' · v ' + PHYS.fastest(world).toFixed(2) + ' м/с' +
      (floorMode === null ? '' : ' · пол y=' + floorMode);
    if (mode !== 'ar') return;
    if (handsSeen > 0) handsEver = true;
    else if (!handsEver && !noHandsFeature && performance.now() - arStart > 4000) {
      hudNote.textContent = 'Руки не видны уже 4 с: включите hand tracking в системе шлема и ' +
        'держите ладони в поле зрения камер.';
      arStart = Infinity;                        // не пиловать сообщение каждый кадр
    }
  }

  function showError(msg) {
    errBox.textContent = msg || '';
    errBox.style.display = msg ? 'block' : 'none';
  }

  /* ------------------------------------------------------------ вход в AR */
  function setChrome(running, inAR) {
    startScreen.style.display = running ? 'none' : '';
    document.body.classList.toggle('running', running);
    document.body.classList.toggle('inar', inAR);
  }

  function enterAR() {
    showError('');
    // hand-tracking держим в optional: на десктопе сессия всё равно не откроется, а на
    // шлеме без включённого трекинга рук хотя бы заработает passthrough — и мы это покажем.
    // hit-test/anchors не просим: они лишь добавляют согласований, а не нужны здесь.
    navigator.xr.requestSession('immersive-ar', {
      optionalFeatures: ['local-floor', 'hand-tracking', 'dom-overlay'],
      domOverlay: { root: hud }
    }).then(function (session) {
      mode = 'ar'; placed = false; floorMode = null;
      handsEver = false; noHandsFeature = false; arStart = performance.now();
      scene.background = null;                  // любой Color-фон убивает passthrough
      previewRig.visible = false;
      world.leash = 2.2;
      setChrome(true, true);
      hudNote.textContent = session.domOverlayState
        ? 'Щипок — перенести фигуры перед собой. Сжатие кулака — показать/скрыть прокси рук.'
        : 'DOM-оверлей недоступен, кнопок в шлеме не видно: щипок — перенести фигуры, сжатие кулака — прокси рук.';

      session.addEventListener('select', function () { placeInFrontOfHead(lastFrame, lastRef); });
      session.addEventListener('squeeze', function () { showHands = !showHands; });
      session.addEventListener('end', function () {
        mode = 'idle'; previewRig.visible = true; setChrome(false, false);
        // r128 не восстанавливает холст после сессии: size/aspect правим руками
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(window.innerWidth, window.innerHeight);
      });

      // local-floor есть не везде и требует согласия: при отказе падаем на local (тогда без пола)
      renderer.xr.setReferenceSpaceType('local-floor');
      renderer.xr.setSession(session).then(function () {
        var f = session.enabledFeatures;
        floorMode = (f && f.indexOf('local-floor') >= 0) ? 0 : null;
        world.floorY = floorMode === null ? null : 0;
        if (f && f.indexOf('hand-tracking') < 0) {
          noHandsFeature = true;
          hudNote.textContent = 'Шлем не выдал фичу hand-tracking — рук не будет. Включите ' +
            'трекинг рук в настройках контроля и зайдите в AR заново.';
        }
      }, function () {
        renderer.xr.setReferenceSpaceType('local');
        return renderer.xr.setSession(session).then(function () {
          floorMode = null; world.floorY = null;
        });
      }).catch(function (e) { showError('Не удалось запустить сессию: ' + e); });
    }, function (e) {
      showError('immersive-ar не открылся: ' + e +
                '. Нужен шлем с passthrough (Quest Browser) и https или localhost.');
    });
  }

  btnAR.addEventListener('click', enterAR);
  btnReset.addEventListener('click', function () { placeInFrontOfHead(lastFrame, lastRef); });
  btnHands.addEventListener('click', function () { showHands = !showHands; });

  btnPreview.addEventListener('click', function () {
    mode = 'preview';
    setChrome(true, false);
    scene.background = new THREE.Color(0x0b0f14);
    previewRig.visible = true;
    world.floorY = null; world.leash = 3;
    placeRow(0, 1.1, 0, 1, 0, 0);
    noteLine.textContent = 'Мышь = псевдо-кисть из 6 шаров. Esc — назад в меню.';
    el('previewHint').style.display = 'block';
  });

  window.addEventListener('keydown', function (e) {   // из предпросмотра назад в меню (в AR рулит система)
    if (e.key === 'Escape' && mode === 'preview') { mode = 'idle'; setChrome(false, false); }
  });

  window.addEventListener('resize', function () {
    if (renderer.xr.isPresenting) return;       // setSize/pixelRatio во время сессии — no-op
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  /* ------------------------------------------------------------ способность / отладка */
  function noAR(why) {
    btnAR.disabled = true;
    btnAR.textContent = why;
  }
  if (!window.isSecureContext) noAR('Нужен https или localhost');
  else if (!navigator.xr || !navigator.xr.isSessionSupported) noAR('WebXR не поддерживается');
  else {
    navigator.xr.isSessionSupported('immersive-ar').then(function (ok) {
      if (!ok) noAR('immersive-ar недоступен');
    }, function () { noAR('immersive-ar недоступен'); });
  }

  // Тесты/отладка: __hs.info(), __hs.step(n, fillFn), __hs.cfg({...}), __hs.setMode('preview')
  window.__hs = {
    world: world,
    bodies: items.map(function (it) { return it.body; }),
    body: function (id) {
      for (var k = 0; k < items.length; k++) if (items[k].body.id === id) return items[k].body;
      return null;
    },
    // увести лишние фигуры из кадра теста, чтобы не совали свои контакты в проверяемое тело
    park: function (x, y, z) {
      for (var k = 1; k < items.length; k++) PHYS.place(items[k].body, x + k * 0.6, y, z);
    },
    info: function () {
      var list = items.map(function (it) {
        var b = it.body;
        return { id: b.id, x: b.pos.x, y: b.pos.y, z: b.pos.z, r: b.radius,
                 speed: PHYS.speed(b), contacts: b.contacts.length };
      });
      return { mode: mode, hands: handsSeen, contacts: world.contacts.length,
               speed: PHYS.speed(world), pos: { x: world.pos.x, y: world.pos.y, z: world.pos.z },
               pen: PHYS.penetration(world, jointBuf), bodyPen: PHYS.bodyPenetration(world),
               bodies: list, showHands: showHands, cfg: cfg };
    },
    cfg: function (o) { Object.assign(cfg, o || {}); applyCfg(); },
    setMode: function (m) {
      mode = m;
      var dark = m !== 'ar';
      scene.background = dark ? new THREE.Color(0x0b0f14) : null;
      previewRig.visible = (m === 'preview');
    },
    step: function (n, fill) {                  // рукотворные кисти: fill(jointBuf, frameIdx)
      for (var f = 0; f < n; f++) {
        jointBuf.fill(NaN);
        if (fill) fill(jointBuf, f);
        stepWorld(1 / 72, jointBuf);
      }
    }
  };
})();
