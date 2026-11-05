/* AR на Jolt: три фигуры с честными формами, их толкает палец реальной руки, а если рук нет —
 * контроллер. Смысл страницы ровно в том, что в веб-версии не получалось:
 *   1) в XR у пальца (и у контроллера) есть x, y, z, поэтому шарик можно ВВЕЗТЬ В КОЛЬЦО,
 *      а не только водить по экрану;
 *   2) фигуры не улетают за экран: у тел стоит линейный/угловой damping, а вокруг якоря
 *      работает leash — дальше leashMeters метров тело не уходит ни при каком ударе.
 *
 * Физика та же, что в спайке (ar/jolt/spike-page.js) и в node (ar/jolt/spike.mjs): мир
 * собирает общий модуль ar/jolt/jolt-setup.js, поэтому зазоры из тестов здесь те же.
 *
 * Отладка со шлема. Раз в секунду в AR-режиме страница шлёт компактную строку GET-пикселем
 * на yokko.duckdns.org: строка оседает в nginx access log, её читают отсюда по ssh. Ничего
 * на том сервере для этого не заводится — только запись в чужой лог-файл. Кулак (squeeze)
 * или кнопка «Отладка» отправляют полный отчёт сразу.
 */
import initJolt from '../jolt-physics.wasm-compat.js';
import { DT, HAND_PAD, L_HAND, L_SHAPE, settings, setSpeculative, sphereShape, boxShape,
  torusShape, bodySettings, addBody, contactRecorder, alignQuat } from './jolt-setup.js';

/* --------------------------------------------------------------- настройки */
/* Размеры подобраны под эксперимент владельца: шарик (35 мм) должен ВХОДИТЬ в отверстие
 * кольца (дырка R - tube = 85 мм). В спайке кольцо было 75/30 — дырка 45 мм, шарик 85 мм,
 * то есть впихнуть его было физически невозможно. */
const FIGS = [
  { id: 'sphere', color: 0xff6b57, r: 0.035 },
  { id: 'torus', color: 0xffd24a, R: 0.11, tube: 0.025, seg: 16 },
  { id: 'cube', color: 0x57b6ff, half: 0.05 },
];
const LATERAL = [-0.28, 0.00, 0.30];      // м вдоль «вправо» от точки появления
const MAX_SPEED = 2.5, MAX_SPIN = 10;
const DAMP = 6, DAMP_A = 6;               // v *= 1/(1+d*dt) за шаг: ~1 с до остановки

/* Порядок суставов кисти фиксирован спекой WebXR Hand Input: wrist, затем большой (без
 * intermediate) и по пять на остальные пальцы. Индекс слота = base + позиция в этом списке,
 * поэтому руки между собой не путаются и тесты ссылаются на сустав по номеру. */
const JOINT_ORDER = ['wrist',
  'thumb-metacarpal', 'thumb-phalanx-proximal', 'thumb-phalanx-distal', 'thumb-tip',
  'index-metacarpal', 'index-phalanx-proximal', 'index-phalanx-distal',
  'index-phalanx-intermediate', 'index-tip',
  'middle-metacarpal', 'middle-phalanx-proximal', 'middle-phalanx-distal',
  'middle-phalanx-intermediate', 'middle-tip',
  'ring-metacarpal', 'ring-phalanx-proximal', 'ring-phalanx-distal',
  'ring-phalanx-intermediate', 'ring-tip',
  'pinky-metacarpal', 'pinky-phalanx-proximal', 'pinky-phalanx-distal',
  'pinky-phalanx-intermediate', 'pinky-tip'];
const HAND_SLOTS = JOINT_ORDER.length;    // 25
const INDEX_TIP = 9;
const handSlot = (side, j) => side * HAND_SLOTS + j;
const CTRL_SLOT = 2 * HAND_SLOTS;         // 50, 51 — контроллеры, когда руки не читаются
const MAX_SLOTS = 2 * HAND_SLOTS + 2;     // 52 кинематических сферы максимум

/* Query-параметры — единственный способ переключать режим в шлеме: на PICO 4 Ultra
 * dom-overlay не выдаётся (start|feat=…|ovl=нет), так что кнопок HUD в AR не видно. */
const QS = new URLSearchParams(location.search);
let handsMode = QS.get('hands') === 'index' ? 'index' : 'full';
let showHands = QS.get('proxy') !== '0';

/* XR-радиус сустава на PICO щедрее реальной руки: ладонь выходила вдвое толще настоящей, а
 * соседние суставы сливались в один комок (замечание владельца 2026-11-04). Кисть строится с
 * половинным радиусом: JOINT_R_SCALE умножается на XR-радиус ДО clamp'а, а границы clamp'а уже
 * уменьшенные — иначе самый мелкий сустав упёрся бы в прежнее дно 4 мм и половинки бы не вышло.
 * Контроллер (PAD_R) и курсор превью (FINGER_R0) — не кисть, они не меняются. */
const JOINT_R_SCALE = 0.5;
const MIN_JOINT_R = 0.002, MAX_JOINT_R = 0.015, FINGER_R0 = 0.011, PAD_R = 0.020;
const BEACON = 'https://yokko.duckdns.org/ar-ht/rep.gif';
let leashMeters = isFinite(+QS.get('leash')) && +QS.get('leash') > 0 ? +QS.get('leash') : 0.9;
let beaconOn = !QS.has('nobeacon');

const el = (id) => document.getElementById(id);
const statusEl = el('status'), statEl = el('stat'), noteEl = el('hudNote'), errEl = el('err');
const say = (t) => { statusEl.textContent = t; };

const consoleErrs = [];
const origErr = console.error.bind(console);
console.error = (...a) => {
  if (consoleErrs.length < 12) consoleErrs.push(a.map((x) => String(x)).join(' ').slice(0, 200));
  origErr(...a);
};
function fail(err) {
  const msg = String(err && err.stack || err);
  say('ОШИБКА: ' + msg.split('\n')[0]);
  const pre = el('shotError') || document.createElement('pre');
  pre.id = 'shotError';
  pre.textContent = msg;
  if (!pre.parentNode) document.body.appendChild(pre);
  const rep = el('report');
  if (rep) rep.textContent = 'ERROR ' + msg;
}
window.addEventListener('error', (e) => fail(e.error || (e.message + ' @ ' + e.filename + ':' + e.lineno)));
window.addEventListener('unhandledrejection', (e) => fail(e.reason));

/* --------------------------------------------------------------- three */
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setClearColor(0x000000, 0);       // passthrough: alpha обязана быть нулевой
renderer.xr.enabled = true;
renderer.xr.setReferenceSpaceType('local-floor');
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();           // scene.background не задаём: Color гасит passthrough
const dolly = new THREE.Group();
scene.add(dolly);
const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.01, 30);
dolly.add(camera);

/* В AR долли стоит в начале системы отсчёта: r128 пишет позу головы в matrix камеры
 * ОТНОСИТЕЛЬНО её родителя, поэтому любые координаты XR прямо совпадают с миром. */
function setRig(inAR) {
  if (inAR) { dolly.position.set(0, 0, 0); dolly.rotation.set(0, 0, 0); }
  else { dolly.position.set(0, 0.06, 0.95); dolly.rotation.set(-0.12, 0, 0); }
  camera.position.set(0, 0, 0);
}
setRig(false);

scene.add(new THREE.HemisphereLight(0xe8f0ff, 0x2a2118, 0.9));
const key = new THREE.DirectionalLight(0xffffff, 0.8);
key.position.set(0.4, 0.9, 0.6);
scene.add(key);
const grid = new THREE.GridHelper(4, 20, 0x2f3b4a, 0x1c242e);
scene.add(grid);

const meshes = {};
for (const f of FIGS) {
  const mat = new THREE.MeshStandardMaterial({ color: f.color, roughness: 0.4, metalness: 0.05 });
  const geo = f.id === 'sphere' ? new THREE.SphereGeometry(f.r, 40, 24)
    : f.id === 'cube' ? new THREE.BoxGeometry(f.half * 2, f.half * 2, f.half * 2)
      : new THREE.TorusGeometry(f.R, f.tube, 20, 40);
  meshes[f.id] = new THREE.Mesh(geo, mat);
  scene.add(meshes[f.id]);
}

/* Прокси приводных сфер: видно, куда физика поставила сферу вместо сустава, и какой у неё
 * радиус. 52 экземпляра: 25 на кисть + 2 контроллера. */
const handMesh = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 16, 12),
  new THREE.MeshBasicMaterial({ color: 0x63c8ff, transparent: true, opacity: 0.35 }), MAX_SLOTS);
handMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
handMesh.count = MAX_SLOTS;
scene.add(handMesh);

const touchMeshes = [];
// 48 маркеров: кисть из 25 сфер легко даёт больше контактов, чем 24, а молча не дорисованные
// точки выглядят как расходимость чисел в HUD.
for (let i = 0; i < 48; i++) {
  const m = new THREE.Mesh(new THREE.SphereGeometry(0.004, 8, 6),
    new THREE.MeshBasicMaterial({ color: 0xff3355 }));
  m.visible = false;
  scene.add(m);
  touchMeshes.push(m);
}

/* --------------------------------------------------------------- Jolt */
const alive = [];
let Jolt, ji, ps, bi, V, Q;
const bodies = new Map();
const anchors = new Map();
const bodyIds = [];                          // параллельно bodiesList: обход по индексу
const bodiesList = [];
const fingers = [];                        // имя старше идеи: теперь это 25 сфер на кисть + контроллеры
const slotR = new Array(MAX_SLOTS).fill(FINGER_R0);
const shapesByR = new Map();               // радиус (мм) → сфера: кисти меняют радиус, а форма одна на всех
let frameContacts = [];

function shapeFor(J, f) {
  if (f.id === 'sphere') return sphereShape(J, alive, f.r);
  if (f.id === 'cube') return boxShape(J, alive, f.half);
  return torusShape(J, alive, f.R, f.tube, f.seg);
}

/* Сферы суставов квантуются по 1 мм и переиспользуются: у 50 кинематических сфер радиус
 * меняется постоянно, а new SphereShape на каждый кадр = тысячи wasm-объектов в минуту.
 * Формы обязаны жить в alive: Jolt держит на них сырые указатели. */
function sphereFor(J, r) {
  const key = Math.round(r * 1000);
  let sh = shapesByR.get(key);
  if (!sh) {
    sh = new J.SphereShape(key / 1000);
    alive.push(sh);
    shapesByR.set(key, sh);
  }
  return sh;
}

async function boot() {
  Jolt = await initJolt();
  V = (x, y, z) => new Jolt.Vec3(x, y, z);
  Q = () => Jolt.Quat.prototype.sIdentity();

  ji = new Jolt.JoltInterface(settings(Jolt, alive));
  ps = ji.GetPhysicsSystem();
  bi = ps.GetBodyInterfaceNoLock();
  ps.SetGravity(V(0, 0, 0));               // гравитации нет: фигуры стоят там, где поставили
  setSpeculative(ps, HAND_PAD);
  frameContacts = contactRecorder(Jolt, alive, ps);

  for (const f of FIGS) {
    const id = addBody(Jolt, bi, bodySettings(Jolt, shapeFor(Jolt, f), 0, 0, 0,
      Jolt.EMotionType_Dynamic, L_SHAPE,
      { linearDamping: DAMP, angularDamping: DAMP_A, friction: 0.5, restitution: 0 }));
    bi.SetMaxLinearVelocity(id, MAX_SPEED);
    bi.SetMaxAngularVelocity(id, MAX_SPIN);
    bodies.set(f.id, id);
    anchors.set(f.id, { x: 0, y: 0, z: 0 });
  }
  for (let i = 0; i < MAX_SLOTS; i++) {
    fingers.push(addBody(Jolt, bi, bodySettings(Jolt, sphereFor(Jolt, FINGER_R0),
      -3, 0, 0, Jolt.EMotionType_Kinematic, L_HAND)));
  }

  placeRow(0, 0, 0, 1, 0, null);           // ряд вдоль X: шар, кольцо, куб
  for (const [id, b] of bodies) { bodyIds.push(id); bodiesList.push(b); }
  indexContactKeys();                      // контакты приходят ключами тел
  say('jolt ok: тел ' + ps.GetNumBodies() + ', бублик = ' + FIGS[1].seg + ' капсул, damping ' +
    DAMP + ', leash ' + leashMeters + ' м, рук по ' + HAND_SLOTS + ' суставов, режим ' + handsMode +
    ', захват ' + (grabOn ? 'вкл' : 'выкл'));
  // Кнопка обязана отражать ?grab=0, иначе врет с первого кадра.
  el('btnGrab').textContent = grabOn ? 'Захват вкл' : 'Захват выкл';

  syncThree();
  renderer.render(scene, camera);          // первый кадр явно: в --dump-dom rAF не вызывается
  frames++;
  window.__ja.ready = true;
}

/* ------------------------------------------------------ расстановка фигур */
/* Дырка бублика разворачивается вдоль взгляда, чтобы шарик можно было толкнуть СКВОЗЬ неё. */
function placeRow(cx, cy, cz, rx, rz, forward) {
  for (let k = 0; k < FIGS.length; k++) {
    const f = FIGS[k], off = LATERAL[k] || 0;
    const x = cx + rx * off, z = cz + rz * off, b = bodies.get(f.id);
    let rot = Q();
    if (f.id === 'torus' && forward) {
      const q = alignQuat(Jolt, new Jolt.Vec3(0, 0, 1),
        new Jolt.Vec3(forward.x, forward.y, forward.z));
      rot = new Jolt.Quat(q.GetX(), q.GetY(), q.GetZ(), q.GetW());
    }
    bi.SetPositionAndRotation(b, V(x, cy, z), rot, Jolt.EActivate_Activate);
    bi.SetLinearVelocity(b, V(0, 0, 0));
    bi.SetAngularVelocity(b, V(0, 0, 0));
    anchors.set(f.id, { x, y: cy, z });
  }
}

function placeInFrontOfHead(frame, refSpace) {
  const fwd = new THREE.Vector3();
  if (frame && refSpace) {
    const p = frame.getViewerPose(refSpace);
    if (!p) return;
    const t = p.transform.position, o = p.transform.orientation;
    fwd.set(-2 * (o.x * o.z + o.w * o.y), -2 * (o.y * o.z - o.w * o.x),
      -(1 - 2 * (o.x * o.x + o.y * o.y)));
    if (fwd.length() === 0) fwd.set(0, 0, -1);
    fwd.normalize();
    placeRow(t.x + fwd.x * 0.7, t.y + fwd.y * 0.7 - 0.05, t.z + fwd.z * 0.7,
      -fwd.z, fwd.x, fwd);
    return;
  }
  camera.getWorldPosition(fwd);
  const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
  placeRow(fwd.x + dir.x * 0.8, fwd.y + dir.y * 0.8 - 0.05, fwd.z + dir.z * 0.8,
    -dir.z, dir.x, dir);
}

/* --------------------------------------------------------- шаг физики */
function posOf(id) { const p = bi.GetPosition(id); return { x: p.GetX(), y: p.GetY(), z: p.GetZ() }; }

function drive(slot, x, y, z) {            // кинематика: ТОЛЬКО скорость (SetKinematicTarget нет)
  const p = posOf(fingers[slot]);
  // Появившаяся рука (или первый кадр курсора) иначе летит из точки спавна со скоростью
  // (цель - спавн)/DT ~ 200 м/с и на пути выбивает все фигуры: дальше 25 см — телепорт.
  if (Math.hypot(x - p.x, y - p.y, z - p.z) > 0.25) {
    bi.SetPositionAndRotation(fingers[slot], V(x, y, z), Q(), Jolt.EActivate_Activate);
    bi.SetLinearVelocity(fingers[slot], V(0, 0, 0));
    return;
  }
  bi.SetLinearVelocity(fingers[slot], V((x - p.x) / DT, (y - p.y) / DT, (z - p.z) / DT));
}
function stop(slot) { bi.SetLinearVelocity(fingers[slot], V(0, 0, 0)); }

/* Радиус сустава = радиус коллизии. Форму пересобираем редко: только если палец изменился
 * больше чем на 2 мм (SetShape на каждом кадре перекладывает тело в broadphase), и берём её
 * из кеша по кванту 1 мм. */
function setRadius(slot, r) {
  if (!isFinite(r) || r <= 0 || Math.abs(r - slotR[slot]) < 0.002) return;
  slotR[slot] = r;
  bi.SetShape(fingers[slot], sphereFor(Jolt, r), true, Jolt.EActivate_Activate);
}

/* Ни один удар не должен уносить фигуру за экран: пружина здесь не нужна, достаточно
 * ограничения по расстоянию от якоря + снятия скорости наружу. Якоря держим по id фигуры:
 * Map по BodyID не работает, embind на каждый метод отдаёт новый объект-обёртку. */
function leash() {
  let over = 0;
  for (let i = 0; i < bodiesList.length; i++) {
    if (grabbed.has(bodyIds[i])) continue;   // удерживаемую фигуру ведёт рука, не поводок
    const b = bodiesList[i], an = anchors.get(bodyIds[i]);
    const p = posOf(b);
    const dx = p.x - an.x, dy = p.y - an.y, dz = p.z - an.z;
    const d = Math.hypot(dx, dy, dz);
    if (d <= leashMeters || d === 0) continue;
    over = Math.max(over, d - leashMeters);
    const k = leashMeters / d;
    const q = bi.GetRotation(b);
    const qq = new Jolt.Quat(q.GetX(), q.GetY(), q.GetZ(), q.GetW());
    bi.SetPositionAndRotation(b, V(an.x + dx * k, an.y + dy * k, an.z + dz * k), qq,
      Jolt.EActivate_Activate);
    const v = bi.GetLinearVelocity(b);
    const nx = dx / d, ny = dy / d, nz = dz / d;
    const outward = v.GetX() * nx + v.GetY() * ny + v.GetZ() * nz;
    if (outward > 0) bi.SetLinearVelocity(b, V(v.GetX() - nx * outward, v.GetY() - ny * outward,
      v.GetZ() - nz * outward));
  }
  return over;
}

const driveBuf = new Float32Array(MAX_SLOTS * 4);

/* ------------------------------------------------------------------ захват
 * Предмет держится, когда его с ДВУХ сторон толкают РАЗНЫЕ суставы одной кисти: направления
 * толкания (нормаль манifold`а: из сустава в точку контакта) противоположны. Это физика
 * процесса, а не жест: «вектора воздействий пересекаются».
 *
 * Как держим: фигура на время захвата становится КИНЕМАТИЧЕСКОЙ и едет за кадром захвата.
 * Проверено в node (ar/jolt/spike.mjs): кинематическое тело интегрирует и линейную, и
 * угловую скорость, а обратно в динамику возвращаться умеет. Следствие: во время захвата
 * контактов палец<->фигура нет вовсе (kinematic<->kinematic), поэтому отпускание судится
 * ГЕОМЕТРИЕЙ, а не контактами.
 *
 * Кадр захвата: центр — средневзвешенный по радиусам центр державших суставов; ориентация —
 * по главному суставу (самый крупный радиус из державших), его матрица приходит прямо из
 * fillPoses. Смещение фигуры относительно кадра и её поворот относительно кадра запоминаются.
 *
 * Отпускаем, когда захват РАСКРЫЛСЯ: размах державших суставов вырос больше чем на GRAB_OPEN
 * относительно САМОГО СЖАТОГО кадра за время захвата. Пальцы стоят или сжимаются — держим.
 * Плюс: живых суставов меньше двух, рука пропала, захват выключен параметром.
 */
const GRAB_MIN_JOINTS = 2;       // минимум разных суставов, чтобы держать
const GRAB_FRAMES = 3;           // сколько кадров подряд условие держится до включения
const GRAB_OPPOSE = -0.3;        // dot направлений толкания пары: ниже — значит держат с двух сторон
const GRAB_OPEN = 0.03;          // м: насколько разжались пальцы относительно минимума — отпустить
const GRAB_LOST = 30;            // кадров без двух живых суставов — отпустить
const GRAB_MAX_SPAN = 0.20;      // м: размах больше этого — это не захват, а случайные касания
let grabOn = QS.get('grab') !== '0';
const grabs = new Map();         // side -> захват (на кисть не больше одного предмета)
const grabbed = new Set();       // id фигур, которые сейчас держат
const holdFrames = new Map();    // fig id -> сколько кадров подряд он зажаты (до включения)

// Контакты приходят парами указателей, поэтому нужны ключи тел: key->слот и key->фигура.
const keyToSlot = new Map(), keyToFig = new Map();
function indexContactKeys() {
  keyToSlot.clear(); keyToFig.clear();
  for (let i = 0; i < fingers.length; i++) keyToSlot.set(fingers[i].GetIndexAndSequenceNumber(), i);
  for (let i = 0; i < bodyIds.length; i++) keyToFig.set(bodiesList[i].GetIndexAndSequenceNumber(), bodyIds[i]);
}
const handOfSlot = (s) => (s < HAND_SLOTS ? 0 : 1);      // контроллеры (50/51) не хватают

/* Кандидаты на захват по контактам ПРЕДЫДУЩЕГО шага: фигура -> {сторона, слоты}. */
function gripCandidates() {
  const byFig = new Map();
  for (const c of frameContacts) {
    const sa = keyToSlot.get(c.a), sb = keyToSlot.get(c.b);
    const fa = keyToFig.get(c.a), fb = keyToFig.get(c.b);
    const slot = sa !== undefined ? sa : sb, fig = sa !== undefined ? fb : fa;
    if (slot === undefined || fig === undefined || slot >= 2 * HAND_SLOTS) continue;
    const j = posOf(fingers[slot]);
    let nx = c.x - j.x, ny = c.y - j.y, nz = c.z - j.z;
    const d = Math.hypot(nx, ny, nz) || 1;
    let m = byFig.get(fig);
    if (!m) { m = new Map(); byFig.set(fig, m); }
    m.set(slot, [nx / d, ny / d, nz / d]);
  }
  const out = [];
  for (const [fig, m] of byFig) {
    if (grabbed.has(fig) || m.size < GRAB_MIN_JOINTS) continue;
    let side = -1, same = true;
    for (const s of m.keys()) {
      const sd = handOfSlot(s);
      if (side < 0) side = sd; else if (sd !== side) same = false;    // разными кистями не держим
    }
    if (!same || side < 0 || grabs.has(side)) continue;
    const arr = [...m.entries()];
    let opposed = false;
    for (let i = 0; i < arr.length && !opposed; i++) {
      for (let j = i + 1; j < arr.length; j++) {
        const d = arr[i][1][0] * arr[j][1][0] + arr[i][1][1] * arr[j][1][1] + arr[i][1][2] * arr[j][1][2];
        if (d < GRAB_OPPOSE) { opposed = true; break; }
      }
    }
    if (opposed) out.push({ fig, side, slots: arr.map((e) => e[0]) });
  }
  return out;
}

function gripSpan(slots) {
  const lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9];
  let live = 0;
  for (const s of slots) {
    const t = targets[s];
    if (!t.live) continue;
    live++;
    const v = [t.x, t.y, t.z];
    for (let k = 0; k < 3; k++) { if (v[k] < lo[k]) lo[k] = v[k]; if (v[k] > hi[k]) hi[k] = v[k]; }
  }
  return { span: live ? Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) : 0, live };
}

const gC = new THREE.Vector3(), gM = new THREE.Matrix4(), gQ = new THREE.Quaternion();
function gripFrame(g) {
  let w = 0, live = 0;
  gC.set(0, 0, 0);
  for (const s of g.slots) {
    const t = targets[s];
    if (!t.live) continue;
    gC.x += t.x * t.r; gC.y += t.y * t.r; gC.z += t.z * t.r; w += t.r; live++;
  }
  if (!live || w <= 0) return null;
  gC.divideScalar(w);
  const refT = targets[g.ref] && targets[g.ref].live ? targets[g.ref]
    : targets[g.slots.find((s) => targets[s].live)];
  if (!refT) return null;
  gQ.setFromRotationMatrix(gM.fromArray(refT.m));
  return { cx: gC.x, cy: gC.y, cz: gC.z, qx: gQ.x, qy: gQ.y, qz: gQ.z, qw: gQ.w, live };
}

function biggestSlot(slots) {
  let best = slots[0], r = -1;
  for (const s of slots) if (slotR[s] > r) { r = slotR[s]; best = s; }
  return best;
}

function grabStart(c) {
  const ref = biggestSlot(c.slots);
  const fr0 = gripFrame({ slots: c.slots, ref });
  if (!fr0) return;
  const b = bodies.get(c.fig), p = posOf(b), q = bi.GetRotation(b);
  const q0 = new THREE.Quaternion(q.GetX(), q.GetY(), q.GetZ(), q.GetW());
  const Q0 = new THREE.Quaternion(fr0.qx, fr0.qy, fr0.qz, fr0.qw).invert();
  const off = new THREE.Vector3(p.x - fr0.cx, p.y - fr0.cy, p.z - fr0.cz).applyQuaternion(Q0);
  const rot0 = Q0.clone().multiply(q0);
  // поводок на время захвата считается от точки захвата: иначе рука не донесла бы фигуру
  anchors.set(c.fig, { x: p.x, y: p.y, z: p.z });
  bi.SetMotionType(b, Jolt.EMotionType_Kinematic, Jolt.EActivate_Activate);
  grabbed.add(c.fig);
  const g = { id: c.fig, side: c.side, slots: c.slots.slice(), ref,
    off, rot0, spanMin: gripSpan(c.slots).span, lost: 0, lin: null, ang: null };
  grabs.set(c.side, g);
  beacon('grab|' + c.fig + '|' + g.slots.length);
}

function grabEnd(g, why) {
  const b = bodies.get(g.id);
  bi.SetMotionType(b, Jolt.EMotionType_Dynamic, Jolt.EActivate_Activate);
  anchors.set(g.id, posOf(b));                 // полёт после отпускания — от точки отпускания
  if (g.lin) {
    bi.SetLinearVelocity(b, V(g.lin[0], g.lin[1], g.lin[2]));
    bi.SetAngularVelocity(b, V(g.ang[0], g.ang[1], g.ang[2]));
  }
  grabbed.delete(g.id); grabs.delete(g.side); holdFrames.delete(g.id);
  beacon('release|' + g.id + '|' + why);
}

/* Один кадр захвата: отпустить/довести. Вызывается ВНУТРИ шага, до ji.Step: кинематика
 * сама интегрирует скорость за шаг, как и пальцы. */
function grabStep() {
  for (const [, g] of [...grabs]) {
    const sp = gripSpan(g.slots);
    if (sp.live >= GRAB_MIN_JOINTS && sp.span < g.spanMin) g.spanMin = sp.span;
    if (sp.live < GRAB_MIN_JOINTS) {
      if (++g.lost > GRAB_LOST) { grabEnd(g, 'lost'); continue; }
    } else g.lost = 0;
    if (sp.span > g.spanMin + GRAB_OPEN || sp.span > GRAB_MAX_SPAN + GRAB_OPEN) {
      grabEnd(g, 'open'); continue;
    }
    const fr = gripFrame(g);
    if (!fr) continue;
    const Q = new THREE.Quaternion(fr.qx, fr.qy, fr.qz, fr.qw);
    let tp = g.off.clone().applyQuaternion(Q);
    tp = { x: fr.cx + tp.x, y: fr.cy + tp.y, z: fr.cz + tp.z };
    const TQ = Q.clone().multiply(g.rot0);
    // поводок: рука не уносит фигуру дальше leashMeters от точки захвата
    const an = anchors.get(g.id);
    const ddx0 = tp.x - an.x, ddy0 = tp.y - an.y, ddz0 = tp.z - an.z;
    const da = Math.hypot(ddx0, ddy0, ddz0);
    if (da > leashMeters) {
      const k = leashMeters / da;
      tp = { x: an.x + ddx0 * k, y: an.y + ddy0 * k, z: an.z + ddz0 * k };
    }
    const b = bodies.get(g.id), p = posOf(b), q = bi.GetRotation(b);
    const ddx = tp.x - p.x, ddy = tp.y - p.y, ddz = tp.z - p.z;
    if (Math.hypot(ddx, ddy, ddz) > 0.25) {      // телепорт, как у пальцев: иначе 200 м/с
      bi.SetPositionAndRotation(b, V(tp.x, tp.y, tp.z),
        new Jolt.Quat(TQ.x, TQ.y, TQ.z, TQ.w), Jolt.EActivate_Activate);
      bi.SetLinearVelocity(b, V(0, 0, 0)); bi.SetAngularVelocity(b, V(0, 0, 0));
      g.lin = [0, 0, 0]; g.ang = [0, 0, 0];
      continue;
    }
    let vx = ddx / DT, vy = ddy / DT, vz = ddz / DT;
    const s2 = Math.hypot(vx, vy, vz);
    if (s2 > MAX_SPEED) { const k = MAX_SPEED / s2; vx *= k; vy *= k; vz *= k; }
    bi.SetLinearVelocity(b, V(vx, vy, vz));
    const dq = new THREE.Quaternion(TQ.x, TQ.y, TQ.z, TQ.w)
      .multiply(new THREE.Quaternion(q.GetX(), q.GetY(), q.GetZ(), q.GetW()).invert());
    if (dq.w < 0) { dq.x = -dq.x; dq.y = -dq.y; dq.z = -dq.z; dq.w = -dq.w; }
    const ang = 2 * Math.acos(Math.min(1, dq.w));
    const sn = Math.sqrt(Math.max(1e-9, 1 - dq.w * dq.w));
    let wx = dq.x / sn * ang / DT, wy = dq.y / sn * ang / DT, wz = dq.z / sn * ang / DT;
    const sw = Math.hypot(wx, wy, wz);
    if (sw > MAX_SPIN) { const k = MAX_SPIN / sw; wx *= k; wy *= k; wz *= k; }
    bi.SetAngularVelocity(b, V(wx, wy, wz));
    g.lin = [vx, vy, vz]; g.ang = [wx, wy, wz];
  }
}

/* Кандидаты в захват: контакты ПРЕДЫДУЩЕГО шага (их ещё не очистили). Счётчик подряд идущих
 * кадров нужен, чтобы случайное двойное касание не включало захват. */
function grabDetect() {
  const seen = new Set();
  for (const c of gripCandidates()) {
    seen.add(c.fig);
    const n = (holdFrames.get(c.fig) || 0) + 1;
    holdFrames.set(c.fig, n);
    if (n >= GRAB_FRAMES && !grabs.has(c.side)) grabStart(c);
  }
  for (const id of [...holdFrames.keys()]) {
    if (!seen.has(id) && !grabbed.has(id)) holdFrames.delete(id);
  }
}

/* Состояние захвата для HUD, луча и тестов. */
function grabState() {
  return [...grabs.values()].map((g) => {
    const sp = gripSpan(g.slots);
    return { id: g.id, side: g.side, slots: g.slots.slice(), ref: g.ref,
      span: +sp.span.toFixed(4), spanMin: +g.spanMin.toFixed(4), lost: g.lost };
  });
}

function fromTargets(buf) {
  for (let i = 0; i < MAX_SLOTS; i++) {
    const g = targets[i];
    buf[i * 4] = g.live ? g.x : NaN;
    buf[i * 4 + 1] = g.live ? g.y : 0;
    buf[i * 4 + 2] = g.live ? g.z : 0;
    buf[i * 4 + 3] = g.r;
  }
}

function stepPhysics(n, fill) {
  let over = 0;
  for (let k = 0; k < n; k++) {
    if (fill) {
      // Не заполненный слот = ВЫКЛЮЧЕН, а не «ноль»: иначе 50 незаполненных суставов
      // поехали бы в (0,0,0) и смяли фигуру в центре ряда.
      driveBuf.fill(NaN);
      fill(driveBuf);
      for (let i = 0; i < MAX_SLOTS; i++) {
        if (!isFinite(driveBuf[i * 4])) { stop(i); continue; }
        setRadius(i, driveBuf[i * 4 + 3]);
        drive(i, driveBuf[i * 4], driveBuf[i * 4 + 1], driveBuf[i * 4 + 2]);
      }
    }
    if (grabOn) { grabDetect(); grabStep(); }
    frameContacts.length = 0;
    ji.Step(DT, 1);
    over = Math.max(over, leash());
  }
  return over;
}

/* --------------------------------------------------- ввод: руки/контроллеры */
let handsSeen = 0, padSeen = 0, jointsLive = 0, srcNote = '—';
const targets = [];
const IDENT16 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
for (let i = 0; i < MAX_SLOTS; i++) {
  // m — полная матрица сустава (column-major, как в XR): захват по ней поворачивает предмет.
  targets.push({ x: -3, y: 0, z: 0, r: FINGER_R0, live: false, m: new Float32Array(IDENT16) });
}

const clampR = (r) => (isFinite(r) ? Math.min(MAX_JOINT_R, Math.max(MIN_JOINT_R, r)) : FINGER_R0);

/* Списки XRJointSpace кэшируются на объект XRInputSource: hand.values() каждый кадр даёт новый
 * итератор, а fillPoses/fillJointRadii требуют iterable и обязаны увидеть ОДИН и тот же порядок
 * (он фиксирован спекой). */
const handCache = new WeakMap();
function handSpaces(s) {
  let h = handCache.get(s);
  if (!h) {
    let spaces = [];
    try {
      for (const [, space] of s.hand) spaces.push(space);   // порядок по спеке
    } catch (e) {
      spaces = [];                                          // runtime без итератора XRHand
    }
    if (spaces.length !== HAND_SLOTS) {
      // Порядок задаём сами по JOINT_ORDER — он и есть спековый.
      spaces = JOINT_ORDER.map((n) => s.hand.get(n)).filter(Boolean);
    }
    h = { spaces };
    handCache.set(s, h);
  }
  return h;
}

const pose16 = new Float32Array(16 * HAND_SLOTS);   // матрицы column-major: перевод в 12..14
const radii25 = new Float32Array(HAND_SLOTS);

/* Одна кисть = 25 приводных сфер. Быстрый путь (fillPoses + fillJointRadii) отказывает на ВСЮ
 * кисть, если не оттрекан хоть один сустав, поэтому есть запасной путь поштучно. */
function readHand(s, side, frame, refSpace) {
  const h = handSpaces(s);
  const onlyTip = handsMode === 'index';
  let n = 0, fast = false;
  try {
    fast = frame.fillPoses(h.spaces, refSpace, pose16) !== false &&
      frame.fillJointRadii(h.spaces, radii25) !== false;
  } catch (e) { fast = false; }
  for (let j = 0; j < h.spaces.length; j++) {
    if (onlyTip && j !== INDEX_TIP) continue;
    let x, y, z, r;
    if (fast) {
      const o = j * 16;
      x = pose16[o + 12]; y = pose16[o + 13]; z = pose16[o + 14]; r = radii25[j];
    } else {
      let jp = null;
      try { jp = frame.getJointPose(h.spaces[j], refSpace); } catch (e) { jp = null; }
      if (!jp) continue;
      const p = jp.transform.position;
      x = p.x; y = p.y; z = p.z; r = jp.radius;
    }
    if (!isFinite(x) || !isFinite(y) || !isFinite(z)) continue;
    const t = targets[handSlot(side, j)];
    t.x = x; t.y = y; t.z = z; t.r = clampR(r * JOINT_R_SCALE); t.live = true;
    if (fast) {
      const o = j * 16;
      for (let k = 0; k < 16; k++) t.m[k] = pose16[o + k];
    } else {
      const mm = jp.transform.matrix;                       // XRRigidTransform.matrix — те же 16
      if (mm) for (let k = 0; k < 16; k++) t.m[k] = mm[k]; else t.m.set(IDENT16);
    }
    n++;
  }
  return n;
}

/* Приоритет у руки: при включённом hand tracking контроллер в том же слоте исчезает. Позы
 * читаем напрямую из XRInputSource: индекс контроллера в three привязан к порядку inputSources
 * и легко разъезжается, а source всегда под рукой. */
function readInputs(frame, refSpace) {
  handsSeen = 0; padSeen = 0; jointsLive = 0;
  const src = frame.session.inputSources, note = [], taken = [false, false];
  for (const g of targets) g.live = false;
  for (let i = 0; i < src.length; i++) {
    const s = src[i];
    const side = s.handedness === 'right' ? 1 : 0;
    const tag = side ? 'R' : 'L';
    if (taken[side]) continue;             // третий inputSource в этой сцене не modeled
    if (s.hand) {
      const n = readHand(s, side, frame, refSpace);
      if (n) {
        taken[side] = true; handsSeen++; jointsLive += n;
        note.push(tag + 'рука' + n);
        continue;
      }
    }
    const space = s.gripSpace || s.targetRaySpace;
    let pose = null;
    try { pose = space ? frame.getPose(space, refSpace) : null; } catch (e) { pose = null; }
    if (pose) {
      taken[side] = true; padSeen++;
      note.push(tag + 'контроллер');
      const t = targets[CTRL_SLOT + side], q = pose.transform.position;
      t.x = q.x; t.y = q.y; t.z = q.z; t.r = PAD_R; t.live = true;
    }
  }
  srcNote = note.length ? note.join(',') : 'ничего';
}

/* Превью без шлема: курсор задаёт ЛЕВЫЙ палец в плоскости через кольцо. Объёма здесь нет —
 * это только проверка физики, вхожения шарика в кольцо тут не получится. */
const ptr = { x: 0, y: 0, has: false, usedX: 0, usedY: 0, applied: 0 };
const PTR_SLOT = handSlot(0, INDEX_TIP);   // курсор = кончик указательного левой кисти
const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
const plane = new THREE.Plane(), hit = new THREE.Vector3(), viewDir = new THREE.Vector3();
function readPointer() {
  if (!ptr.has) return;
  // Направление берётся из МИРОВОЙ матрицы камеры: наклон превью висит на долли, а
  // camera.quaternion — локальный (единичный), поэтому прежняя плоскость выходила мировой
  // z=0 — почти параллельной лучу, и прицел уезжал на метры в сторону от кольца.
  camera.getWorldDirection(viewDir);
  plane.setFromNormalAndCoplanarPoint(viewDir, meshes.torus.position);
  ndc.set(ptr.x, ptr.y);
  ray.setFromCamera(ndc, camera);
  if (!ray.ray.intersectPlane(plane, hit)) return;
  const t = targets[PTR_SLOT];
  t.x = hit.x; t.y = hit.y; t.z = hit.z; t.r = FINGER_R0; t.live = true;
  ptr.usedX = ptr.x; ptr.usedY = ptr.y; ptr.applied++;
}
renderer.domElement.addEventListener('pointermove', (e) => {
  ptr.x = (e.clientX / window.innerWidth) * 2 - 1;
  ptr.y = -(e.clientY / window.innerHeight) * 2 + 1;
  ptr.has = true;
});
renderer.domElement.addEventListener('pointerleave', () => {
  ptr.has = false; targets[PTR_SLOT].live = false;
});

/* ------------------------------------------------------------- отрисовка */
const mtx = new THREE.Matrix4(), q0 = new THREE.Quaternion(), vp = new THREE.Vector3(), vs = new THREE.Vector3();
function setInstance(i, x, y, z, r) {
  if (r > 0) { vp.set(x, y, z); vs.set(r, r, r); } else { vp.set(0, -100, 0); vs.set(0, 0, 0); }
  mtx.compose(vp, q0, vs);
  handMesh.setMatrixAt(i, mtx);
}
function syncThree() {
  for (let i = 0; i < bodyIds.length; i++) {
    const b = bodiesList[i], m = meshes[bodyIds[i]];
    const p = posOf(b), q = bi.GetRotation(b);
    m.position.set(p.x, p.y, p.z);
    m.quaternion.set(q.GetX(), q.GetY(), q.GetZ(), q.GetW());
  }
  for (let i = 0; i < MAX_SLOTS; i++) {
    // Рисуем только отслеженные суставы: все 52 тела на старте стоят в (-3,0,0), и без этого
    // условия в кадре был бы пучок из 52 сфер.
    if (!showHands || !targets[i].live) { setInstance(i, 0, -100, 0, 0); continue; }
    const p = posOf(fingers[i]);
    setInstance(i, p.x, p.y, p.z, slotR[i] + HAND_PAD * 0.5);
  }
  handMesh.instanceMatrix.needsUpdate = true;
  for (let i = 0; i < touchMeshes.length; i++) {
    const c = frameContacts[i];
    touchMeshes[i].visible = !!c;
    if (c) touchMeshes[i].position.set(c.x, c.y, c.z);
  }
}

/* ------------------------------------------------------- отладочный луч */
let seq = 0, sent = 0;                    // beaconOn объявлен рядом с настройками
function beacon(line) {
  if (!beaconOn) return;
  new Image().src = BEACON + '?k=arht&i=' + (++seq) + '&d=' + encodeURIComponent(line).slice(0, 700);
  sent++;
}

/* --------------------------------------------------------- главный цикл */
let mode = 'idle', frozen = false, placed = false, frames = 0;
let fps = 0, frameMs = 0, stepMs = 0, maxSpeed = 0, maxOver = 0, pen = 0;
let lastT = 0, fpsN = 0, fpsT = 0, statT = 0, repT = 0;
let lastFrame = null, lastRef = null;

function tick(time, frame) {
  if (!window.__ja.ready) return;          // wasm ещё компилируется: тел нет, шагать нечем
  const t0 = performance.now();
  const dt = lastT ? Math.min(0.1, (t0 - lastT) / 1000) : DT;
  lastT = t0;
  frames++; fpsN++; fpsT += dt;

  if (mode === 'ar' && frame) {
    const refSpace = renderer.xr.getReferenceSpace();
    if (!placed && frame.getViewerPose(refSpace)) { placeInFrontOfHead(frame, refSpace); placed = true; }
    readInputs(frame, refSpace);
  } else if (mode === 'preview') {
    readPointer();
  }

  if (!frozen && mode !== 'idle') {
    const steps = Math.max(1, Math.min(4, Math.round(dt / DT)));
    const s0 = performance.now();
    for (let s = 0; s < steps; s++) {
      maxOver = stepPhysics(1, fromTargets);
    }
    stepMs = stepMs * 0.8 + (performance.now() - s0) * 0.2;
  }

  syncThree();
  renderer.render(scene, camera);

  frameMs = frameMs * 0.8 + (performance.now() - t0) * 0.2;
  pen = 0; maxSpeed = 0;
  for (const b of bodiesList) {
    const v = bi.GetLinearVelocity(b);
    maxSpeed = Math.max(maxSpeed, Math.hypot(v.GetX(), v.GetY(), v.GetZ()));
  }
  for (const c of frameContacts) if (c.pen > pen) pen = c.pen;

  if (t0 - statT > 500) { statT = t0; fps = fpsT > 0 ? fpsN / fpsT : 0; fpsN = 0; fpsT = 0; updateStat(); }
  if (mode === 'ar' && t0 - repT > 1000) { repT = t0; beacon(perfLine()); }
}

function updateStat() {
  statEl.textContent = 'fps ' + fps.toFixed(0) + ' · шаг ' + stepMs.toFixed(1) + ' мс · кадр ' +
    frameMs.toFixed(1) + ' мс · рук ' + handsSeen + ' (' + jointsLive + ' суставов) · контроллеров ' +
    padSeen + ' · контактов ' + frameContacts.length + ' · v ' + maxSpeed.toFixed(2) + ' м/с' +
    (maxOver > 0.001 ? ' · leash вжата +' + maxOver.toFixed(3) + ' м' : '') +
    (grabs.size ? ' · держит ' + [...grabs.values()]
      .map((g) => g.id + ' ' + g.slots.length + ' п.').join(', ') : '') +
    ' · отправлено ' + sent;
}

/* Joint-сводка, а не список из 52 радиусов: строка луча упирается в длину URL. */
function jointStats() {
  let n = 0, lo = 99, hi = 0;
  for (let i = 0; i < MAX_SLOTS; i++) {
    if (!targets[i].live) continue;
    n++;
    lo = Math.min(lo, slotR[i]); hi = Math.max(hi, slotR[i]);
  }
  return { n, lo: n ? lo : 0, hi };
}

function perfLine() {
  const j = jointStats();
  // G — что сейчас в захвате: s2 = шар держат 2 сустава. Строка луча короткая, поэтому id одна буква.
  const G = 'G' + (grabs.size ? [...grabs.values()].map((g) => g.id[0] + g.slots.length).join(',') : '0');
  return ['f' + fps.toFixed(0), 'step' + stepMs.toFixed(1), 'fr' + frameMs.toFixed(1),
    'c' + frameContacts.length, 'v' + maxSpeed.toFixed(2), 'pen' + pen.toFixed(3),
    'lv' + maxOver.toFixed(3), 'j' + j.n + '(' + (j.lo * 1000).toFixed(0) + '-' +
    (j.hi * 1000).toFixed(0) + 'мм)', G, srcNote.replace(/[ ,]/g, '')].join('|');
}

function fullReport() {
  const j = jointStats();
  return JSON.stringify({
    mode: mode, fps: +fps.toFixed(1), stepMs: +stepMs.toFixed(2), frameMs: +frameMs.toFixed(2),
    contacts: frameContacts.length, v: +maxSpeed.toFixed(3), pen: +pen.toFixed(4),
    leashOver: +maxOver.toFixed(4), src: srcNote, handsMode: handsMode, grabOn: grabOn,
    grabs: [...grabs.values()].map((g) => ({ id: g.id, side: g.side, slots: g.slots.slice(),
      span: +gripSpan(g.slots).span.toFixed(4), spanMin: +g.spanMin.toFixed(4) })),
    joints: j.n, jointRmin: +j.lo.toFixed(4), jointRmax: +j.hi.toFixed(4),
    bodies: bodyIds.map((id, i) => { const p = posOf(bodiesList[i]); return [id, +p.x.toFixed(3), +p.y.toFixed(3), +p.z.toFixed(3)]; }),
    anchors: bodyIds.map((id) => { const a = anchors.get(id); return [id, +a.x.toFixed(3), +a.y.toFixed(3), +a.z.toFixed(3)]; }),
    errs: consoleErrs.slice(0, 3),
  });
}

/* --------------------------------------------------------- вход в AR */
function setChrome(running, inAR) {
  document.body.classList.toggle('running', running);
  document.body.classList.toggle('inar', inAR);
  grid.visible = !inAR;
  setRig(inAR);
}
function showError(msg) { errEl.textContent = msg || ''; errEl.style.display = msg ? 'block' : 'none'; }

function enterAR() {
  showError('');
  navigator.xr.requestSession('immersive-ar', {
    optionalFeatures: ['local-floor', 'hand-tracking', 'dom-overlay'],
    domOverlay: { root: el('hud') },
  }).then((session) => {
    mode = 'ar'; placed = false; lastT = 0;
    scene.background = null;
    setChrome(true, true);
    noteEl.textContent = session.domOverlayState
      ? 'Щипок — перенести фигуры перед собой. Кулак — отладочный отчёт на сервер.'
      : 'DOM-оверлей не дан: кнопок в шлеме не видно, но жесты работают: щипок — перенести, ' +
        'кулак — отчёт. Режимы (hands=index, proxy=0, leash=…) — в адресной строке.';

    session.addEventListener('select', () => placeInFrontOfHead(lastFrame, lastRef));
    session.addEventListener('squeeze', () => beacon('FULL|' + fullReport()));
    session.addEventListener('end', () => {
      mode = 'idle';
      setChrome(false, false);
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(window.innerWidth, window.innerHeight);
      beacon('end|f' + fps.toFixed(0) + '|sent' + sent);
    });

    renderer.xr.setReferenceSpaceType('local-floor');
    renderer.xr.setSession(session).then(() => {
      const f = session.enabledFeatures || [];
      beacon('start|feat=' + f.join(',') + '|ovl=' + (session.domOverlayState ? session.domOverlayState.type : 'нет'));
      if (f.indexOf('hand-tracking') < 0) {
        noteEl.textContent = 'Шлем не выдал hand-tracking — рукам неоткуда взяться, толкает контроллер. ' +
          'Включите трекинг рук в настройках контроля и зайдите заново.';
      }
    }, () => {
      renderer.xr.setReferenceSpaceType('local');
      return renderer.xr.setSession(session).then(() => beacon('start|feat=local-only'));
    }).catch((e) => showError('Не удалось запустить сессию: ' + e));
  }, (e) => showError('immersive-ar не открылся: ' + e + '. Нужен шлем с passthrough и https.'));
}

el('enterAR').addEventListener('click', enterAR);
el('preview').addEventListener('click', () => {
  mode = 'preview'; placed = true; lastT = 0;
  scene.background = new THREE.Color(0x14161a);
  setChrome(true, false);
  noteEl.textContent = 'Мышь = кончик указательного пальца левой кисти, и только в плоскости. ' +
    'Это превью: объёма тут нет, шарик в кольцо входит в AR, где кисть даёт 25 суставов.';
});
el('btnReset').addEventListener('click', () => placeInFrontOfHead(lastFrame, lastRef));
el('btnHands').addEventListener('click', () => { showHands = !showHands; });
el('btnGrab').addEventListener('click', () => {
  grabOn = !grabOn;
  if (!grabOn) for (const [, g] of [...grabs]) grabEnd(g, 'btn');
  el('btnGrab').textContent = grabOn ? 'Захват вкл' : 'Захват выкл';
});
el('btnReport').addEventListener('click', () => beacon('FULL|' + fullReport()));

window.addEventListener('resize', () => {
  if (renderer.xr.isPresenting) return;   // setSize во время сессии — no-op
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

function noAR(why) { el('enterAR').disabled = true; el('enterAR').textContent = why; }
if (!window.isSecureContext) noAR('Нужен https или localhost');
else if (!navigator.xr || !navigator.xr.isSessionSupported) noAR('WebXR не поддерживается');
else navigator.xr.isSessionSupported('immersive-ar').then((ok) => { if (!ok) noAR('immersive-ar недоступен'); },
  () => noAR('immersive-ar недоступен'));

renderer.setAnimationLoop((time, frame) => {
  if (frame) { lastFrame = frame; lastRef = renderer.xr.getReferenceSpace(); }
  tick(time, frame);
});

/* --------------------------------------------------------- хук для тестов */
window.__ja = {
  ready: false,
  info() {
    const list = bodyIds.map((id, i) => {
      const p = posOf(bodiesList[i]), v = bi.GetLinearVelocity(bodiesList[i]), a = anchors.get(id);
      return { id, x: p.x, y: p.y, z: p.z,
        speed: Math.hypot(v.GetX(), v.GetY(), v.GetZ()),
        contacts: frameContacts.filter((c) => {
          const k = bodiesList[i].GetIndexAndSequenceNumber();
          return c.a === k || c.b === k;
        }).length,
        leash: Math.hypot(p.x - a.x, p.y - a.y, p.z - a.z) };
    });
    let penMax = 0;
    for (const c of frameContacts) if (c.pen > penMax) penMax = c.pen;
    const fin = fingers.map((f, i) => { const p = posOf(f); return { i, x: p.x, y: p.y, z: p.z, r: slotR[i] }; });
    return { mode, bodies: list, fingers: fin, contacts: frameContacts.length, pen: penMax,
      hands: handsSeen, pads: padSeen, joints: jointsLive, slots: MAX_SLOTS,
      handsMode: handsMode, grabOn: grabOn, grabs: window.__ja.grab(),
      numBodies: ps.GetNumBodies(), radii: slotR.slice(),
      leash: leashMeters };
  },
  step(n, fill) { for (let k = 0; k < n; k++) maxOver = stepPhysics(1, fill); syncThree(); },
  body(id) { return posOf(bodies.get(id)); },
  anchor(id) { return anchors.get(id); },
  kick(id, vx, vy, vz) { bi.SetLinearVelocity(bodies.get(id), V(vx, vy, vz)); },
  speed(id) { const v = bi.GetLinearVelocity(bodies.get(id)); return Math.hypot(v.GetX(), v.GetY(), v.GetZ()); },
  park(id, x, y, z) {
    const b = bodies.get(id);
    bi.SetPositionAndRotation(b, V(x, y, z), Q(), Jolt.EActivate_Activate);
    bi.SetLinearVelocity(b, V(0, 0, 0));
    bi.SetAngularVelocity(b, V(0, 0, 0));
    anchors.set(id, { x, y, z });
  },
  place: () => placeInFrontOfHead(lastFrame, lastRef),
  cfg(o) {
    if (!o) return;
    if (o.handPad !== undefined) setSpeculative(ps, o.handPad);
    if (o.beacon !== undefined) beaconOn = !!o.beacon;
    if (o.leash !== undefined) leashMeters = o.leash;
    if (o.hands !== undefined) handsMode = o.hands === 'index' ? 'index' : 'full';
    if (o.proxy !== undefined) showHands = !!o.proxy;
    if (o.grab !== undefined) {
      grabOn = !!o.grab;
      if (!grabOn) for (const [, g] of [...grabs]) grabEnd(g, 'cfg');
    }
  },
  freeze(v) { frozen = !!v; },
  /* Захват изнутри страницы: состояние, перевод тела и ручной ввод суставов (для тестов без
   * шлема: тот же путь, что и живой цикл — цели в targets, шаг через fromTargets). */
  grab() { return grabState(); },
  // Диагностика детекции: что дал предыдущий шаг в пересчёте на слоты/фигуры и какие
  // пары считаются «держат с двух сторон». Нужна, потому что контакты приходят указателями.
  gripDbg() {
    return frameContacts.map((c) => ({
      slot: keyToSlot.has(c.a) ? keyToSlot.get(c.a) : keyToSlot.get(c.b),
      fig: keyToSlot.has(c.a) ? keyToFig.get(c.b) : keyToFig.get(c.a),
      pen: +c.pen.toFixed(4),
      p: [+c.x.toFixed(4), +c.y.toFixed(4), +c.z.toFixed(4)],
      dir: (() => {
        const s = keyToSlot.has(c.a) ? keyToSlot.get(c.a) : keyToSlot.get(c.b);
        if (s === undefined) return null;
        const j = posOf(fingers[s]);
        const dx = c.x - j.x, dy = c.y - j.y, dz = c.z - j.z, d = Math.hypot(dx, dy, dz) || 1;
        return [+(dx / d).toFixed(3), +(dy / d).toFixed(3), +(dz / d).toFixed(3)];
      })(),
    }));
  },
  cand() { return gripCandidates(); },
  grabbedIds() { return [...grabbed]; },
  motion(id) {
    const t = bi.GetMotionType(bodies.get(id));
    return t === Jolt.EMotionType_Kinematic ? 'кинематик' : t === Jolt.EMotionType_Dynamic ? 'динамик' : 'стик';
  },
  // Угол вокруг Z: тела в тестах крутятся только вокруг этой оси, и её компонента quaternion'a
  // и есть искомый поворот (в пределах ±π).
  rotAngle(id) {
    const q = bi.GetRotation(bodies.get(id));
    return 2 * Math.atan2(q.GetZ(), q.GetW());
  },
  setJoint(slot, x, y, z, r, spin) {
    const t = targets[slot];
    t.x = x; t.y = y; t.z = z; t.r = clampR(r); t.live = true;
    const a = spin || 0;
    t.m.set([Math.cos(a), Math.sin(a), 0, 0, -Math.sin(a), Math.cos(a), 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  },
  stepTargets(n) { for (let k = 0; k < n; k++) maxOver = stepPhysics(1, fromTargets); syncThree(); },
  // Увести все суставы кистей из кадра (тесты: после прогонов «ладонью» их тела остаются
  // лежать вокруг фигуры и портят следующие проверки). Везёт их тот же drive, поэтому
  // расстояние больше 25 см уходит в телепорт, а не в полёт со 200 м/с.
  parkFingers() {
    for (let s = 0; s < 2 * HAND_SLOTS; s++) {
      const t = targets[s];
      t.live = true;
      t.x = (s < HAND_SLOTS ? -1 : 1) * 3; t.y = 2.5 + (s % 5) * 0.02; t.z = (s % 25) * 0.02;
      t.m.set(IDENT16);
    }
    for (let s = 2 * HAND_SLOTS; s < MAX_SLOTS; s++) targets[s].live = false;
  },
  pointer: () => ({ has: ptr.has, ndc: [ptr.x, ptr.y], used: [ptr.usedX, ptr.usedY],
    applied: ptr.applied, target: Object.assign({}, targets[PTR_SLOT]), slot: PTR_SLOT,
    hit: [+hit.x.toFixed(4), +hit.y.toFixed(4), +hit.z.toFixed(4)],
    normal: [plane.normal.x, plane.normal.y, plane.normal.z],
    constant: plane.constant, rayO: ray.ray.origin.toArray(), rayD: ray.ray.direction.toArray(),
    fov: camera.fov, aspect: +camera.aspect.toFixed(3),
    camWorld: camera.getWorldPosition(new THREE.Vector3()).toArray() }),
  perf: () => perfLine(),
  report: () => fullReport(),
  sent: () => sent,
  touchDots() { return touchMeshes.filter((m) => m.visible).length; },
  diag() {
    return { calls: renderer.info.render.calls, tris: renderer.info.render.triangles, frames: frames,
      presenting: renderer.xr.isPresenting, errs: consoleErrs,
      ctxLost: renderer.getContext().isContextLost(),
      cam: camera.matrixWorld.elements.slice(12).map((x) => +x.toFixed(3)),
      obj: Object.keys(meshes).map((k) => ({ k, pos: meshes[k].position.toArray().map((x) => +x.toFixed(3)) })) };
  },
  painted() {
    syncThree();
    renderer.render(scene, camera);
    frames++;
    const gl = renderer.getContext(), w = renderer.domElement.width, h = renderer.domElement.height;
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    let lit = 0, n = 0;
    for (let i = 3; i < px.length; i += 4 * 61) { n++; if (px[i] > 8) lit++; }
    return { lit, n, w, h };
  },
  get world() { return ps; },
};

/* boot() стартует сразу, но тесты обязаны дождаться wasm без таймеров: в headless-Chrome
 * виртуальное время идёт быстрее реального, и опрос через setTimeout съедает весь budget. */
window.__ja.readyPromise = boot();
window.__ja.readyPromise.catch(fail);
