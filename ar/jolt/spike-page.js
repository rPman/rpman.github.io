/* Spike-страница переезда на Jolt (шаг 1b в AGENTS.md): three.js r128 + jolt-physics в браузере.
 *
 * Задача спайка — не игра, а три вещи, проверенные в node (ar/jolt/spike.mjs) живьём в three:
 *   1) wasm-compat-сборка Jolt заводится по <script type="module"> без fetch и без сборки;
 *   2) у фигур честные формы (шар / куб / бублик из 16 капсул), а не шар-прокси;
 *   3) кинематический «палец» входит в отверстие бублика и толкает его с зазором = граница формы.
 *
 * Управление: мышь = палец (плоскость z = 0). Отладочный хук — window.__js (шаги, info, park),
 * им пользуется ar/jolt/page-test.mjs. Исключения попадают в <pre id="shotError"> — чёрный
 * скриншот сам по себе ни о чём не говорит.
 */
import initJolt from '../jolt-physics.wasm-compat.js';

const DT = 1 / 72;
const HAND_PAD = 0.008;            // = PhysicsSettings.mSpeculativeContactDistance
const L_HAND = 0, L_SHAPE = 1, L_STATIC = 2;

const FIGS = [
  { id: 'sphere', x: -0.30, color: 0xff6b57, r: 0.085 },
  { id: 'cube', x: 0.00, color: 0x57b6ff, half: 0.065 },
  { id: 'torus', x: 0.30, color: 0xffd24a, R: 0.075, tube: 0.03, seg: 16 },
];
const FINGERS = 2, FINGER_R = 0.011;

const statusEl = document.getElementById('status');
const say = (t) => { statusEl.textContent = t; };
/* Ошибки three (сборка шейдеров, потеря контекста) в console.error и в headless их
 * не видно: собрать их и отдавать в diag(). */
const consoleErrs = [];
const origErr = console.error.bind(console);
console.error = (...a) => {
  if (consoleErrs.length < 12) consoleErrs.push(a.map((x) => String(x)).join(' ').slice(0, 220));
  origErr(...a);
};

function fail(err) {
  const msg = String(err && err.stack || err);
  say('ОШИБКА: ' + msg.split('\n')[0]);
  const pre = document.createElement('pre');
  pre.id = 'shotError';
  pre.textContent = msg;
  document.body.appendChild(pre);
  const rep = document.getElementById('report');
  if (rep) rep.textContent = 'ERROR ' + msg;
}
window.addEventListener('error', (e) => fail(e.error || (e.message + ' @ ' + e.filename + ':' + e.lineno)));
window.addEventListener('unhandledrejection', (e) => fail(e.reason));

/* -------------------------------- three: сцена --------------------------- */
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = null;                       // passthrough: фон не должен ставить alpha=1
const dolly = new THREE.Group();
scene.add(dolly);
const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.01, 20);
camera.position.set(0, 0.08, 0.0);
dolly.add(camera);
dolly.position.set(0, 0.05, 0.95);
// Камера внутри смотрит вдоль local -Z, а долли стоит на +Z от мира: разворот уже верный,
// нужен лишь лёгкий наклон вниз. dolly.lookAt(0,0,0) тут ломает картинку: у Object3D
// (Group) lookAt разворачивает к цели +Z, а не -Z как у камеры — камера бы смотрела ОТ сцены,
// все фигуры оказались бы за камерой, и three не сделал бы ни одного draw call.
dolly.rotation.x = -0.13;

scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x30241a, 0.9));
const key = new THREE.DirectionalLight(0xffffff, 0.75);
key.position.set(0.4, 0.9, 0.6);
scene.add(key);

function meshFor(f) {
  const mat = new THREE.MeshStandardMaterial({ color: f.color, roughness: 0.45, metalness: 0.05 });
  let geo;
  if (f.id === 'sphere') geo = new THREE.SphereGeometry(f.r, 32, 20);
  else if (f.id === 'cube') geo = new THREE.BoxGeometry(f.half * 2, f.half * 2, f.half * 2);
  else geo = new THREE.TorusGeometry(f.R, f.tube, 20, 40);   // ось дырки = Z, как у compound'а
  const m = new THREE.Mesh(geo, mat);
  m.position.set(f.x, 0, 0);
  scene.add(m);
  return m;
}
const meshes = {};
for (const f of FIGS) meshes[f.id] = meshFor(f);

const fingerMeshes = [];
for (let i = 0; i < FINGERS; i++) {
  const m = new THREE.Mesh(new THREE.SphereGeometry(FINGER_R, 20, 12),
    new THREE.MeshStandardMaterial({ color: 0x66e39a, roughness: 0.3 }));
  m.position.set(-0.3, 0, i * 0.05);
  scene.add(m);
  fingerMeshes.push(m);
}
/* Точки касаний из манifold'ов Jolt — их же будет рисовать боевая страница. */
const touchMeshes = [];
for (let i = 0; i < 24; i++) {
  const m = new THREE.Mesh(new THREE.SphereGeometry(0.004, 8, 6),
    new THREE.MeshBasicMaterial({ color: 0xff3355 }));
  m.visible = false;
  scene.add(m);
  touchMeshes.push(m);
}

/* -------------------------------- Jolt: мир ------------------------------ */
const alive = [];                                // формы должны жить в JS (иначе wasm-мусор)
let Jolt, ji, ps, bi, V, Q;
const bodies = new Map();                        // id -> { body, mesh }
const fingers = [];                              // kinematic BodyID
let frameContacts = [];

function torusShape(J, R, r, n) {
  const cs = new J.StaticCompoundShapeSettings();
  const half = R * Math.sin(Math.PI / n);
  for (let i = 0; i < n; i++) {
    const a = (i + 0.5) * 2 * Math.PI / n;
    const cap = new J.CapsuleShapeSettings(half, r);
    cap.mConvexRadius = 0;                       // выпуклый радиус съедает форму
    alive.push(cap);
    cs.AddShape(V(R * Math.cos(a), R * Math.sin(a), 0), J.Quat.prototype.sRotation(V(0, 0, 1), a), cap, 0);
  }
  const res = cs.Create();
  if (!res.IsValid()) throw new Error('compound не собрался: ' + res.GetError());
  const sh = res.Get();
  alive.push(cs, res, sh);
  return sh;
}
function shapeFor(J, f) {
  if (f.id === 'sphere') { const s = new J.SphereShape(f.r); alive.push(s); return s; }
  const bs = f.id === 'cube' ? new J.BoxShapeSettings(V(f.half, f.half, f.half))
                             : torusShape(J, f.R, f.tube, f.seg);
  if (f.id === 'cube') {
    bs.mConvexRadius = 0;                        // иначе рёбра и углы съедены
    alive.push(bs);
    const sh = bs.Create().Get();
    alive.push(sh);
    return sh;
  }
  return bs;
}

function addBody(J, shape, x, y, z, motion, layer) {
  const id = bi.CreateAndAddBody(new J.BodyCreationSettings(shape, V(x, y, z), Q(), motion, layer),
    J.EActivate_Activate);
  return new J.BodyID(id.GetIndexAndSequenceNumber());   // id живёт только в копии
}

/* Слушатель контактов объявляется внутри boot(): базовый класс ContactListenerJS появляется
 * в биндинге только после загрузки wasm. Методы — СОБСТВЕННЫЕ свойства инстанса: embind
 * проверяет hasOwnProperty и иначе падает на первом шаге. */
async function boot() {
  Jolt = await initJolt();
  V = (x, y, z) => new Jolt.Vec3(x, y, z);
  Q = () => Jolt.Quat.prototype.sIdentity();

  const st = new Jolt.JoltSettings();
  st.mMaxBodies = 512; st.mMaxBodyPairs = 4096; st.mMaxContactConstraints = 2048;
  st.mMaxWorkerThreads = 0;
  const bpl = new Jolt.BroadPhaseLayerInterfaceTable(3, 3);
  bpl.MapObjectToBroadPhaseLayer(L_HAND, new Jolt.BroadPhaseLayer(0));
  bpl.MapObjectToBroadPhaseLayer(L_SHAPE, new Jolt.BroadPhaseLayer(1));
  bpl.MapObjectToBroadPhaseLayer(L_STATIC, new Jolt.BroadPhaseLayer(2));
  const opl = new Jolt.ObjectLayerPairFilterTable(3);
  opl.EnableCollision(L_HAND, L_SHAPE);          // таблица пар создаётся ВЫКЛЮЧЕННОЙ
  opl.EnableCollision(L_SHAPE, L_SHAPE);
  opl.EnableCollision(L_HAND, L_STATIC);
  opl.EnableCollision(L_SHAPE, L_STATIC);
  opl.DisableCollision(L_HAND, L_HAND);          // 50 суставов не расталкивают друг друга
  st.mBroadPhaseLayerInterface = bpl;
  st.mObjectVsBroadPhaseLayerFilter = new Jolt.ObjectVsBroadPhaseLayerFilterTable(bpl, 3, opl, 3);
  st.mObjectLayerPairFilter = opl;

  ji = new Jolt.JoltInterface(st);
  ps = ji.GetPhysicsSystem();
  bi = ps.GetBodyInterfaceNoLock();
  ps.SetGravity(V(0, 0, 0));
  const set = ps.GetPhysicsSettings();
  set.mSpeculativeContactDistance = HAND_PAD;    // here lives handPad (default 0.02!)
  ps.SetPhysicsSettings(set);

  class Listener extends Jolt.ContactListenerJS {
    constructor() {
      super();
      this.OnContactValidate = () => Jolt.ValidateResult_AcceptContact;
      this.OnContactAdded = (a, b, mp) => rec(a, b, mp);
      this.OnContactPersisted = (a, b, mp) => rec(a, b, mp);
      this.OnContactRemoved = () => {};
    }
  }
  function rec(b1, b2, mp) {
    const m = Jolt.wrapPointer(mp, Jolt.ContactManifold);
    const p = m.GetWorldSpaceContactPointOn1(0);
    frameContacts.push({ a: Jolt.wrapPointer(b1, Jolt.Body).GetID().GetIndexAndSequenceNumber(),
      b: Jolt.wrapPointer(b2, Jolt.Body).GetID().GetIndexAndSequenceNumber(),
      pen: m.get_mPenetrationDepth(), x: p.GetX(), y: p.GetY(), z: p.GetZ() });
  }
  alive.push(new Listener());
  ps.SetContactListener(alive[alive.length - 1]);

  for (const f of FIGS) {
    const id = addBody(Jolt, shapeFor(Jolt, f), f.x, 0, 0, Jolt.EMotionType_Dynamic, L_SHAPE);
    bi.SetMaxLinearVelocity(id, 2.5);
    bi.SetMaxAngularVelocity(id, 10);
    bodies.set(f.id, id);
  }
  for (let i = 0; i < FINGERS; i++) {
    const sh = new Jolt.SphereShape(FINGER_R);
    alive.push(sh);
    fingers.push(addBody(Jolt, sh, -0.3, 0, i * 0.05, Jolt.EMotionType_Kinematic, L_HAND));
  }

  say('jolt ok: тел ' + ps.GetNumBodies() + ', бублик = ' + FIGS[2].seg + ' капсул, ' +
    'speculative ' + ps.GetPhysicsSettings().mSpeculativeContactDistance.toFixed(3));
  // Первый кадр рисуем сразу: в headless-Chrome с --dump-dom requestAnimationFrame не
  // вызывается ни разу, и без этого скриншот был бы чёрным даже при рабочей сцене.
  syncThree();
  renderer.render(scene, camera);
  frames++;
  window.__js.ready = true;
  requestAnimationFrame(frame);
}

/* ------------------------------- шаг и отрисовка ------------------------- */
let frozen = false;                              // тест шагает сам, rAF-цикл тогда молчит
let frames = 0;                                  // сколько кадров прошло — для диагностики
const pointer = { x: 0, y: 0, has: false };
const ray = new THREE.Raycaster();
const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);   // z = 0
const target = new THREE.Vector3();
renderer.domElement.addEventListener('pointermove', (e) => {
  pointer.x = (e.clientX / window.innerWidth) * 2 - 1;
  pointer.y = -(e.clientY / window.innerHeight) * 2 + 1;
  pointer.has = true;
});

function posOf(id) { const p = bi.GetPosition(id); return { x: p.GetX(), y: p.GetY(), z: p.GetZ() }; }
function drive(id, x, y, z) {                    // кинематика: ТОЛЬКО скорость
  const p = posOf(id);
  bi.SetLinearVelocity(id, V((x - p.x) / DT, (y - p.y) / DT, (z - p.z) / DT));
}

function stepPhysics(n, fill) {
  for (let k = 0; k < n; k++) {
    frameContacts = [];
    if (fill) {
      const buf = new Float32Array(FINGERS * 4);
      fill(buf);
      for (let i = 0; i < FINGERS; i++) {
        if (!isFinite(buf[i * 4])) { bi.SetLinearVelocity(fingers[i], V(0, 0, 0)); continue; }
        drive(fingers[i], buf[i * 4], buf[i * 4 + 1], buf[i * 4 + 2]);
      }
    }
    ji.Step(DT, 1);
  }
}

function syncThree() {
  for (const [id, body] of bodies) {
    const m = meshes[id], p = posOf(body), q = bi.GetRotation(body);
    m.position.set(p.x, p.y, p.z);
    m.quaternion.set(q.GetX(), q.GetY(), q.GetZ(), q.GetW());
  }
  for (let i = 0; i < FINGERS; i++) {
    const p = posOf(fingers[i]);
    fingerMeshes[i].position.set(p.x, p.y, p.z);
  }
  for (let i = 0; i < touchMeshes.length; i++) {
    const c = frameContacts[i];
    touchMeshes[i].visible = !!c;
    if (c) touchMeshes[i].position.set(c.x, c.y, c.z);
  }
}

function frame() {
  if (pointer.has) {
    ray.setFromCamera(pointer, camera);
    if (ray.ray.intersectPlane(plane, target)) {
      drive(fingers[0], target.x, target.y, target.z);
      bi.SetLinearVelocity(fingers[1], V(0, 0, 0));
    }
  }
  if (!frozen) stepPhysics(1, null);
  syncThree();
  if (!renderer.xr.isPresenting) renderer.render(scene, camera);
  frames++;
  requestAnimationFrame(frame);
}

/* -------------------------------- отладочный хук ------------------------- */
/* Только через него тесты и шагают: в headless-Chrome SwiftShader даёт ~1 кадр/с,
 * поэтому физика шагается вручную и по фиксированному dt. */
window.__js = {
  ready: false,
  info() {
    const list = [];
    for (const [id, body] of bodies) {
      const p = posOf(body), v = bi.GetLinearVelocity(body);
      list.push({ id, x: p.x, y: p.y, z: p.z,
        speed: Math.hypot(v.GetX(), v.GetY(), v.GetZ()),
        contacts: frameContacts.filter(c => c.a === body.GetIndexAndSequenceNumber() ||
          c.b === body.GetIndexAndSequenceNumber()).length });
    }
    const fin = fingers.map((f, i) => { const p = posOf(f); return { i, ...p }; });
    let pen = 0;
    for (const c of frameContacts) if (c.pen > pen) pen = c.pen;
    return { bodies: list, fingers: fin, contacts: frameContacts.length, pen,
      numBodies: ps.GetNumBodies() };
  },
  /* Шаг физики без рендера: fill(buf) задаёт цели пальцев [x,y,z,r,...]. */
  step(n, fill) { stepPhysics(n, fill); syncThree(); },
  body(id) { return posOf(bodies.get(id)); },
  /* увести фигуру из кадра теста, чтобы её контакты не мешали проверяемой паре */
  park(id, x, y, z) {
    const b = bodies.get(id);
    bi.SetPositionAndRotation(b, V(x, y, z), Q(), Jolt.EActivate_Activate);
    bi.SetLinearVelocity(b, V(0, 0, 0));
    bi.SetAngularVelocity(b, V(0, 0, 0));
  },
  cfg(o) {
    if (o && o.handPad !== undefined) {
      const s = ps.GetPhysicsSettings();
      s.mSpeculativeContactDistance = o.handPad;
      ps.SetPhysicsSettings(s);
    }
  },
  freeze(v) { frozen = !!v; },
  touchDots() { return touchMeshes.filter((m) => m.visible).length; },
  /* Диагноз отрисовки: сколько вызовов сделал рендерер и сколько пикселей кадра nonzero
   * (в headless-Chrome скриншот сам по себе ни о чём не говорит: чёрный кадр бывает и
   * когда рендер вообще не вызван, и когда камера смотрит мимо). */
  diag() {
    return { calls: renderer.info.render.calls, tris: renderer.info.render.triangles,
      frame: renderer.info.render.frame, geo: renderer.info.memory.geometries,
      tex: renderer.info.memory.textures, frames: frames,
      ctxLost: renderer.getContext().isContextLost(), errs: consoleErrs,
      w: renderer.domElement.width, h: renderer.domElement.height,
      presenting: renderer.xr.isPresenting,
      children: scene.children.length,
      cam: { pos: camera.position.toArray(), near: camera.near, far: camera.far,
        fov: camera.fov, aspect: camera.aspect, proj0: camera.projectionMatrix.elements[0],
        world: camera.matrixWorld.elements.slice(12).map((v) => +v.toFixed(3)),
        quat: camera.quaternion.toArray().map((v) => +v.toFixed(3)),
        parent: camera.parent && camera.parent.type },
      obj: Object.keys(meshes).map((k) => ({ k, vis: meshes[k].visible, inScene: meshes[k].parent === scene,
        geo: meshes[k].geometry && meshes[k].geometry.attributes.position.count,
        pos: meshes[k].position.toArray(),
        quat: meshes[k].quaternion.toArray(),
        mw: meshes[k].matrixWorld.elements.slice(0, 3).map((v) => +v.toFixed(4)),
        bound: meshes[k].geometry.boundingSphere
          ? [meshes[k].geometry.boundingSphere.center.toArray().map((v) => +v.toFixed(3)),
             +meshes[k].geometry.boundingSphere.radius.toFixed(3)] : null })) };
  },
  /* Снимок кадра, прочитанный сразу после render() в этом же таске: буфер не хранится,
   * на rAF в headless полагаться нельзя, а декодирование data-URL через Image в режиме
   * --dump-dom не успевает до дампа. Поэтому читаем back buffer напрямую. */
  painted() {
    syncThree();
    renderer.render(scene, camera);
    frames++;
    const gl = renderer.getContext();
    const w = renderer.domElement.width, h = renderer.domElement.height;
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    let lit = 0, n = 0;
    for (let i = 3; i < px.length; i += 4 * 61) { n++; if (px[i] > 8) lit++; }
    return { lit, n, w, h };
  },
  get world() { return ps; },
  get Jolt() { return Jolt; },
};

/* boot() стартует сразу, но тесты должны уметь дождаться wasm без таймеров:
 * в headless-Chrome виртуальное время идёт быстрее реального, и опрос через
 * setTimeout съедает весь budget, пока компилируется wasm. */
window.__js.readyPromise = boot();
window.__js.readyPromise.catch(fail);
