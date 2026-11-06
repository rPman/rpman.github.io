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

/* Порядок и имена суставов фиксированы спекой WebXR Hand Input (enum XRHandJoint и таблица
 * skeleton joints, которой обязан следовать обход XRHand — на нём висит быстрый путь
 * fillPoses): wrist, затем большой (без intermediate) и по пять на остальные пальцы:
 * metacarpal, proximal, INTERMEDIATE, DISTAL, tip. До 2026-11-05 фаланги четырёх длинных
 * пальцев были переписаны вручную наоборот (distal раньше intermediate), поэтому в быстром
 * пути два средних сустава каждого длинного пальца лежали в чужих слотах; кончики попадали в
 * свои слоты всегда (tip — пятый в группе в любом порядке). Имена длинных пальцев в спеке с
 * «-finger-»: без них запасной путь s.hand.get(имя) не находил ни одного сустава длинного
 * пальца и давал 5 суставов вместо 25. Индекс слота = позиция в этом списке, поэтому руки
 * между собой не путаются и тесты ссылаются на сустав по номеру. */
const JOINT_ORDER = ['wrist',
  'thumb-metacarpal', 'thumb-phalanx-proximal', 'thumb-phalanx-distal', 'thumb-tip',
  'index-finger-metacarpal', 'index-finger-phalanx-proximal',
  'index-finger-phalanx-intermediate', 'index-finger-phalanx-distal', 'index-finger-tip',
  'middle-finger-metacarpal', 'middle-finger-phalanx-proximal',
  'middle-finger-phalanx-intermediate', 'middle-finger-phalanx-distal', 'middle-finger-tip',
  'ring-finger-metacarpal', 'ring-finger-phalanx-proximal',
  'ring-finger-phalanx-intermediate', 'ring-finger-phalanx-distal', 'ring-finger-tip',
  'pinky-finger-metacarpal', 'pinky-finger-phalanx-proximal',
  'pinky-finger-phalanx-intermediate', 'pinky-finger-phalanx-distal', 'pinky-finger-tip'];
const HAND_SLOTS = JOINT_ORDER.length;    // 25
const INDEX_TIP = 9;
/* Предок каждого кончика по цепочке пальца — плюсневая/средняя фаланга той же кисти: по ней
 * вычисляется направление «наружу от пальца» для выноса сферы кончика (см. extendTip). */
const TIP_PREV = JOINT_ORDER.map((n) => n.endsWith('-tip')
  ? JOINT_ORDER.indexOf(n.slice(0, -4) + 'phalanx-distal') : -1);
const handSlot = (side, j) => side * HAND_SLOTS + j;
const CTRL_SLOT = 2 * HAND_SLOTS;         // 50, 51 — контроллеры, когда руки не читаются
const MAX_SLOTS = 2 * HAND_SLOTS + 2;     // 52 кинематических сферы максимум

/* Query-параметры задают НАЧАЛЬНЫЕ значения: основной способ управления — панель на
 * стартовой странице (в AR кнопок нет: на PICO 4 Ultra dom-overlay не выдаётся, но
 * стартовая страница в браузер шлема попадает). Параметры оставлены, потому что живые
 * ссылки вида ?open=60 и замерные прогоны на них держатся. */
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
/* Кончик пальца. Поза *-tip в XR стоит на суставе концевой фаланги, а не на коже: спека
 * определяет radius как «шар, примерно касающийся кожи с обеих сторон кисти», и отдельно
 * разрешает реализациям смещать начало отсчёта tip-сустава. То есть плоть кончика лежит ЗА
 * позой ещё примерно на radius, а мы радиус ещё и режем пополам — поверхность прокси-сферы
 * отстояла от сустава на 0.5·radius вместо ~1·radius (на PICO: 7 мм там, где настоящий
 * кончик в ~14 мм; замечание владельца 2026-11-05 «шарики не на самых кончиках»). Сферы
 * кончиков выносим вперёд вдоль кости пальца на TIP_EXTEND долей СЫРОГО XR-radius (половинный
 * радиус ладони при этом остаётся). Правится на ходу: ?tip=50 (сотые доли radius), ?tip=0 —
 * как было. */
let TIP_EXTEND = (() => {
  // QS.get() вне адреса даёт null, а +null === 0: без явной проверки QS.has параметр ?tip=0
  // неотличим от «параметра нет», и вынос кончиков молча выключался сам.
  const q = +QS.get('tip');
  return QS.has('tip') && isFinite(q) && q >= 0 ? q / 100 : 0.5;
})();
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
let gripDots = 0;                        // сколько маркеров в кадре — это держатели, не касания
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
  frameContacts = contactRecorder(Jolt, alive, ps, pairIgnored);

  for (const f of FIGS) {
    // Аналитическое описание той же формы: по нему судим, где шар руки относительно фигуры
    // (у держимой фигуры контактов нет вовсе — она кинематик).
    shapeDesc.set(f.id, f.id === 'sphere' ? { kind: 'sphere', r: f.r }
      : f.id === 'cube' ? { kind: 'box', half: f.half }
        : { kind: 'torus', R: f.R, tube: f.tube });
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
 * Предмет держат шары РАЗНЫХ групп руки с двух сторон: направления толкания (нормаль
 * манifold`а: из сустава в точку контакта) противоположны. Это физика процесса, а не жест:
 * «вектора воздействий пересекаются».
 *
 * ГРУППА — палец (thumb/index/middle/ring/pinky) или ладонь (wrist + пять metacarpal, они
 * внутри ладони). Две сферы одной группы держать не могут: расстояние между ними не меняется,
 * поэтому разжаться такой захват физически не способен — на этом вживую ломалось отпускание
 * (зацепление между index-phalanx-proximal и index-tip расцепился только тряской руки). Ключ
 * группы — сторона+группа, значит ладонь левой и ладонь правой РАЗНЫЕ группы: держать двумя
 * руками можно, в том числе двумя ладонями.
 *
 * КАКОЕ ЗАЦЕПЛЕНИЕ ЗАКОННОЕ (правило владельца 2026-11-05). Встречная пара, которая включает
 * захват, обязана быть либо с РАЗНЫХ рук, либо из двух РАЗНЫХ ПАЛЬЦЕВ одной руки (щепоть).
 * Ладонь с пальцем той же руки зацепление не устанавливает: на PICO ладонь — шесть крупных
 * шаров, и её одного касания кубика вместе с кончиком этой же руки хватало, чтобы предмет
 * прилип, а отпускалось это только curl’ом, когда пальцы наконец разгибались (живой лог:
 * grab|cube|4|R висел 7 с при v 2.29 м/с). Ладонь↔ладонь двух рук остаётся законной парой —
 * именно так держат предмет двумя руками и именно для неё работает мера разъезда (SPREAD).
 *
 * Как держим: фигура В ОСТАЁТСЯ ДИНАМИКОЙ, а захват ведёт её скоростью к кадру захвата (так же,
 * как ведутся пальцы). Раньше на время захвата она становилась кинематиком, и это было видно
 * глазами: kinematic<->kinematic контактов не бывает вовсе (замер в spike.mjs), поэтому держимый
 * предмет — призрак и для другой руки, и для другого держимого предмета: два предмета в двух
 * руках проходили сквозь друг друга (замечание владельца на живом заходе 2026-11-05; решение —
 * держать динамиком). Цена: предмет отстаёт от кисти на долю шага (GRAB_FOLLOW) и его можно
 * вытолкнуть из захвата, если толкать сильнее, чем ведёт захват.
 *
 * КАДР ЗАХВАТА — каждый шар захвата помнит ТОЧКУ ТЕЛА, в которой он его взял (местные оси
 * фигуры, снимаются при взятии и при входе конечности). Держать — значит требовать, чтобы эти
 * точки тела шли за шарами рук: средний перенос даёт перенос предмета, то, что среднему
 * переносу не объясняется, объясняется поворотом (малый угол методом наименьших квадратов,
 * dθ = Σ w·r×d / Σ w·|r|²), а то, что не объясняется ничем, и есть невязка (см. SPREAD).
 * Это жёсткая подгонка по всем шарам захвата обеих рук — как и решил владелец, — только
 * считающаяся относительно ТЕЛА, а не относительно кадра момента взятия. Прежний Kabsch по
 * мировым конфигурациям имел две живые дыры:
 *   • вырожденная конфигурация отбрасывалась целиком (A.length < 3 и ранг < 2 → поворота нет
 *     вовсе). Куб (ребро 100 мм) ладонью одной руки — это 2-5 шаров на одной грани: живой лог
 *     2026-11-05 даёт grab|cube|2|R и grab|cube|4|R, то есть поворот был запрещён по построению.
 *     Бублик (труба 25 мм) пальцы обхватывают, конфигурация объёмная — он крутился. Отсюда и
 *     жалоба владельца «тор одной рукой крутится, куб одной рукой только едет».
 *   • при пропаже любого шара захвата кадр переснимался (reanchor), а с ним обнулялись и
 *     накопленный поворот, и позиция отсчёта — на мигающем трекинге PICO это происходило
 *     несколько раз в секунду, и ориентация не успевала накопиться.
 * У направления, которого шары захвата не видят (закручивание вокруг оси пары), числитель
 * просто нулевой: предмет по нему не крутится и ничего не выдумывается — ветка «вырождено»
 * больше не нужна, как и SVD (якобиана 24 свечи на каждый шаг была самой дорогой частью цикла).
 *
 * ОТПУСКАЕТ КОНЕЧНОСТЬ, а не весь захват: у каждой руки свои счётчики разжима и потери.
 * Вышедшая конечность перестаёт сталкиваться с фигурой ещё на GRAB_GRACE секунд — или пока её
 * шары не выйдут из фигуры: иначе застрявшие внутри шары продолжают тащить предмет, и захват
 * кажется бесконечным. То же окно запрещает и сразу ВЗЯТЬ предмет обратно (см. graced): на
 * живом заходе release и grab шли в одну секунду, и предмет выглядел приваренным к кисти.
 * Конечностей не осталось — захват окончен.
 *
 * ПО ЧЕМУ СУДЯТ О РАЗЖАТИИ (переписано после живого захода на PICO 2026-11-05). Прежняя мера —
 * размах шаров захвата как ДИАГОНАЛЬ ОСЕВОГО ЯЩИКА — на живой руке ломалась в обе стороны:
 * ящик поворачивается вместе с кистью, поэтому 8-9-сферные захваты «разжимались» сами собой
 * (отпускание в ту же секунду, что и взятие), а щепотка из двух кончиков, наоборот, не
 * отпускала 10-14 с — предмет висел до тех пор, пока кисть вообще не терялась (leave|lost).
 * Теперь две независимые меры, обе только по самой кисти:
 *   APERTURE — наибшая попарная дистанция живых шаров захвата ЭТОЙ руки. Инвариантна к
 *     повороту и переносу кисти (в отличие от ящика); растёт, когда пальцы расходятся.
 *   CURL — среднее |кончик пальца − его плюсневая кость| по пальцам, чьи суставы видены и
 *     стоят правдоподобно близко. Это сгиб самих пальцев: кулак ≈ 60-80 мм, раскрытая кисть
 *     ≈ 160-190 мм. Работает и когда в захвате один шар (у щепотки размах оценить нечем).
 * Ни APERTURE, ни CURL не измеряют расстояние до предмета: предмет едет за кистью, поэтому по
 * нему раскрывание ладони невидимо вовсе (за это расстояние отвечает SLIP, см. ниже).
 *   SPREAD — третья мера, и у неё другой предмет: РАЗЪЕЗД ДВУХ ДЕРЖАЩИХ РУК. Когда предмет
 * держат две конечности, ни aperture, ни curl разъезд не замечают: ладонь сама по себе остаётся
 * ладонью, её размах и сгиб не меняются, пока не менялась она сама. Живой замер 2026-11-05:
 * `grab|cube|8|R,L`, 22 с `Gc8RL(m45→11)` и ни одного отпускания, пока левая кисть не пропала
 * из трекинга (leave|cube|L|lost). Мера — НЕВЯЗКА КАДРА ЗАХВАТА: та часть рассогласования
 * шаров с точками тела, которую не объясняет ни один жёсткий перенос с поворотом (RMS по шарам).
 * При жёстком переносе двумя руками она нулевая по построению, при разъезде растёт примерно
 * вдвое медленнее самого разъезда. Больше GRAB_FIT — хватки нет ни у кого, отпускают обе руки
 * сразу (`?fit=80`). При одной держящей конечности мера не работает вовсе (предмет и так едет
 * за ней, и иначе дрожание одного сустава рвало бы удержание).
 *   SLIP — четвёртая мера, и она одна смотрит на ПРЕДМЕТ, а не на кисть: как далеко шары
 * захвата от его поверхности (минимум по живым шарам конечности: если хоть один шар ещё внутри
 * формы, значение отрицательное и рука сидит на предмете). Три прежние меры устроены так, что
 * увод руки от предмета их не трогает вовсе, а предмет при этом может не донестись: он упёрся
 * в поводок, в другую фигуру или в предел скорости — и тогда рука ходит, а предмет висит рядом.
 * Живой замер 2026-11-05 (последняя попытка): `grab|cube|4|R` продержался 7 с при v 2.29 м/с
 * (ведение упёрто в MAX_SPEED 2.5), и отпустило только по CURL, когда пальцы наконец разогнулись
 * на +87 мм. Если все шары державшей конечности вышли из формы на GRAB_SLIP и продержались так
 * GRAB_SLIP_FRAMES шагов — конечность отпускает (`?slip=80`).
 */
const GRAB_MIN_JOINTS = 2;       // минимум разных суставов, чтобы держать
const GRAB_FRAMES = 3;           // сколько кадров подряд условие держится до включения
const GRAB_OPPOSE = -0.3;        // dot направлений толкания пары: ниже — значит держат с двух сторон
/* Насколько кисть раскрылась относительно самого сжатого кадра — отпустить. Правится на ходу,
 * чтобы калибровать по живым числам без переката: ?open=60 (в миллиметрах). */
let GRAB_OPEN = isFinite(+QS.get('open')) && +QS.get('open') > 0 ? +QS.get('open') / 1000 : 0.045;
/* Потеря кисти: счёт копится шагом (+1 за кадр без кисти, −1 за живой), поэтому мигание
 * трекинга на PICO — 3 кадра через 1 — предмет не отпускает, а настоящая потеря за 0.5 с
 * отпускает. Прежний «подряд, сброс в ноль» переживался одним хорошим кадром и держал предмет
 * по 10-14 с. */
const GRAB_LOST = 36;
/* Доля рассогласования, которую захват выбирает за шаг. 1 = мёртвая петля: предмет встает в
 * кадр ровно за шаг, и толкнуть его другой рукой глазами невозможно (возврат тот же шаг).
 * 0.6: отставание ~1.7 шага (на скорости руки 0.4 м/с это ~1 см), зато держимый предмет реально
 * поддаётся толчку и его можно вытолкнуть из захвата. Правится на ходу: ?follow=0.4 */
let GRAB_FOLLOW = isFinite(+QS.get('follow')) && +QS.get('follow') > 0 ?
  Math.min(1, +QS.get('follow')) : 0.6;
const GRAB_TELEPORT = 0.25;      // м: крупный разрыв уходит в телепорт, как у пальцев
const GRAB_JOINT_REACH = 0.25;   // м: дальше этого сустав не «палец этой кисти» (в тестах кисти убраны)
/* Насколько державшие шары могут перестать напоминать одно жёсткое целое (RMS невязки кадра
 * захвата, метры). Смысл — хватка рвётся, когда две руки разъезжаются: предмет нельзя держать
 * ладонями в полуметре друг от друга. Правится на ходу: ?fit=80 (миллиметры). */
let GRAB_FIT = isFinite(+QS.get('fit')) && +QS.get('fit') > 0 ? +QS.get('fit') / 1000 : 0.06;
/* Насколько ВСЕ шары державшей конечности могут выйти из формы, чтобы считалось, что рука ушла,
 * а предмет не донёсся (метры; внутри формы значение отрицательное). Порог заведомо больше
 * HAND_PAD и penetration slop: при взятии шар сидит на поверхности, то есть зазор ≤ 8 мм.
 * Правится на ходу: ?slip=80 (миллиметры). */
let GRAB_SLIP = isFinite(+QS.get('slip')) && +QS.get('slip') > 0 ? +QS.get('slip') / 1000 : 0.06;
const GRAB_SLIP_FRAMES = 18;     // кадров подряд (0.25 с) вне формы, прежде чем отпустить
const GRAB_GRACE = 1.0;          // с: ещё столько снятая конечность не трогает выпущенную фигуру
let grabOn = QS.get('grab') !== '0';
const grabs = new Map();         // fig id -> захват: одна фигура = один захват
const grabbed = new Set();       // id фигур в захвате
const holdFrames = new Map();    // "fig|стороны" -> кадров подряд под условием (до включения)
const joinFrames = new Map();    // "fig|сторона" -> кадров подряд рука внутри держимой фигуры
const grace = [];                // {fig, side, until}: игнор коллизий снятой конечности
/* Шаг физики фиксированный (DT), поэтому окно прощения считается ШАГАМИ, а не часами: в
 * headless-тесте виртуальное время внутри синхронного цикла не идёт вовсе (замерено), а в
 * шлеме просадка кадров не должна съедать половину окна. */
let simSteps = 0;
const GRACE_STEPS = Math.round(GRAB_GRACE / DT);

// Контакты приходят парами указателей, поэтому нужны ключи тел: key->слот и key->фигура.
const keyToSlot = new Map(), keyToFig = new Map();
const figKey = new Map();        // fig id -> ключ тела (пары игнора строятся по ключам)
const slotKey = [];              // слот -> ключ тела сферы руки (обратная к keyToSlot)
function indexContactKeys() {
  keyToSlot.clear(); keyToFig.clear(); figKey.clear(); slotKey.length = 0;
  for (let i = 0; i < fingers.length; i++) {
    const k = fingers[i].GetIndexAndSequenceNumber();
    keyToSlot.set(k, i);
    slotKey[i] = k;
  }
  for (let i = 0; i < bodyIds.length; i++) {
    const k = bodiesList[i].GetIndexAndSequenceNumber();
    keyToFig.set(k, bodyIds[i]);
    figKey.set(bodyIds[i], k);
  }
}
const handOfSlot = (s) => (s < HAND_SLOTS ? 0 : 1);      // контроллеры (50/51) не хватают

/* Группа сустава по имени из спеки: палец или ладонь. Ключ — сторона+группа: «ладонь левой» и
 * «ладонь правой» — разные группы, две сферы одной ладони — одна. */
const JOINT_GROUP = JOINT_ORDER.map((n) =>
  (n === 'wrist' || n.endsWith('-metacarpal')) ? 'palm' : n.split('-')[0]);
const groupKey = (s) => (handOfSlot(s) ? 'R' : 'L') + ':' + JOINT_GROUP[s % HAND_SLOTS];
const sidesOf = (g) => [...g.groups.keys()];
function allSlots(g) {
  let a = [];
  for (const gr of g.groups.values()) a = a.concat(gr.slots);
  return a;
}
const sideBusy = (side) => {          // рука уже держит другую фигуру -> её id
  for (const g of grabs.values()) if (g.groups.has(side)) return g.id;
  return null;
};

/* Кандидаты на захват по контактам ПРЕДЫДУЩЕГО шага: фигура -> стороны и слоты, которые её
 * держат. Кандидат принимается, только если нашлась встречная пара, законная по правилу выше
 * (разные руки или два разных пальца), и все участвующие руки свободны; держат при этом
 * РАЗНЫЕ группы. */
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
    const slots = gripSlotsOf([...m.entries()]);
    if (!slots) continue;
    const sides = [...new Set(slots.map((s) => handOfSlot(s)))];
    if (sides.some((sd) => sideBusy(sd) !== null)) continue;   // рука уже что-то держит
    // и та же рука сразу после отпускания не берёт тот же предмет обратно
    if (sides.some((sd) => regrabBlocked(fig, sd))) continue;
    out.push({ fig, sides, slots });
  }
  return out;
}

/* Вторая рука приходит ВНУТРЬ держимой фигуры: контактов с ней нет (оба тела кинематики),
 * поэтому кандидатом считает геометрия — какие шары руки внутри формы и держат ли они с двух
 * сторон. Направление толкания — из шара к ближайшей точке поверхности. Пара встречных
 * направлений ищется НЕ только внутри приходящей руки: правая ладонь, прижавшаяся к предмету,
 * который держит левая, — это законная двухрукая хватка (разные руки), а своей ладонью
 * зацепиться по-прежнему нельзя (latchPair). */
function joinCandidates() {
  const out = [];
  for (const g of grabs.values()) {
    for (let side = 0; side < 2; side++) {
      if (g.groups.has(side) || sideBusy(side) !== null) continue;
      if (regrabBlocked(g.id, side)) continue;      // та же рука сразу после отпускания
      const inner = [];
      for (let j = 0; j < HAND_SLOTS; j++) {
        const s = side * HAND_SLOTS + j, t = targets[s];
        if (!t.live) continue;
        const si = surfaceInfo(g.id, t.x, t.y, t.z);
        if (si.gap > slotR[s]) continue;                     // шар ещё снаружи формы
        inner.push([s, [-si.nx, -si.ny, -si.nz]]);
      }
      if (inner.length < GRAB_MIN_JOINTS) continue;          // рука обязана трогать предмет
      const probe = inner.slice();
      for (const s of allSlots(g)) {
        const t = targets[s];
        if (!t.live) continue;
        const fi = surfaceInfo(g.id, t.x, t.y, t.z);
        probe.push([s, [-fi.nx, -fi.ny, -fi.nz]]);
      }
      if (opposedPair(probe)) out.push({ fig: g.id, side, slots: inner.map((e) => e[0]) });
    }
  }
  return out;
}

/* Зацепление устанавливают шары из РАЗНЫХ групп, и либо с РАЗНЫХ кистей, либо оба — пальцы.
 * Ладонь СВОЕЙ руки в установлении зацепления не участвует вовсе (решение владельца
 * 2026-11-05): на PICO ладонь — это шесть крупных шаров, и достаточно прижать к кубику её
 * вместе с пальцем той же руки, как предмет прилипал, а разжаться такому захват нечем. Ладонь
 * с ладонью ДВУХ рук — законная пара, как и два разных пальца одной кисти (щепоть), которой
 * владелец и держит предмет одной рукой. Внутри захвата оказываются ВСЕ шары, которые сейчас
 * трогают предмет: они им и управляют — правило группы ограничивает только создание. */
function latchPair(si, sj) {
  if (groupKey(si) === groupKey(sj)) return false;            // один палец / одна ладонь
  if (handOfSlot(si) !== handOfSlot(sj)) return true;         // разные руки: ладонь можно
  return JOINT_GROUP[si % HAND_SLOTS] !== 'palm' && JOINT_GROUP[sj % HAND_SLOTS] !== 'palm';
}

/* Есть ли среди шаров хотя бы одна пара, держащая предмет с двух сторон (косинус направлений
 * толкания ниже GRAB_OPPOSE) и имеющая на это право по правилу выше. */
function opposedPair(entries) {
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      if (!latchPair(entries[i][0], entries[j][0])) continue;
      const di = entries[i][1], dj = entries[j][1];
      if (di[0] * dj[0] + di[1] * dj[1] + di[2] * dj[2] <= GRAB_OPPOSE) return true;
    }
  }
  return false;
}

function gripSlotsOf(entries) {
  if (!opposedPair(entries)) return null;
  const slots = [...new Set(entries.map((e) => e[0]))];
  return slots.length >= GRAB_MIN_JOINTS ? slots : null;
}

/* Размах захвата руки: НАИБОЛЬШАЯ попарная дистанция её живых шаров. Диагональ осевого ящика
 * для этого не годится — ящик поворачивается вместе с кистью, и поворот кисти в пространстве
 * менял «размах» на десятки миллиметров (на живом заходе именно так захваты и отпускались сами
 * собой). Здесь поворот и перенос кисти не влияют вовсе: считается только конфигурация шаров. */
function aperture(slots) {
  let ap = 0, live = 0;
  const v = [];
  for (const s of slots) {
    const t = targets[s];
    if (!t.live) continue;
    live++;
    v.push(t);
  }
  for (let i = 0; i < v.length; i++) {
    for (let j = i + 1; j < v.length; j++) {
      const d = Math.hypot(v[i].x - v[j].x, v[i].y - v[j].y, v[i].z - v[j].z);
      if (d > ap) ap = d;
    }
  }
  return { ap: live > 1 ? ap : 0, live };
}

/* Сгиб самой кисти: среднее |кончик пальца − его плюсневая кость|. Меряется по всем пальцам
 * кисти, а не по державшим шарам, поэтому работает и когда захват держит один шар (у щепотки
 * размах оценить нечем). Пальцы с убранной парой суставов (трекинг потерял кончик, либо кисть
 * вообще уведена из кадра) в среднее не входят: GRAB_JOINT_REACH отсекает абсурдные расстояния,
 * иначе убранная в тесте кисть дала бы «раскрытие» в 2.5 м. */
const FINGER_NAMES = ['thumb', 'index', 'middle', 'ring', 'pinky'];
/* Имена суставов в спеке: у большого «thumb-…», у остальных «<палец>-finger-…» — одним
 * перебором, чтобы не разъехаться с JOINT_ORDER. */
const fingerJoint = (f, j) => (f === 'thumb' ? 'thumb-' : f + '-finger-') + j;
const META_SLOT = FINGER_NAMES.map((f) => JOINT_ORDER.indexOf(fingerJoint(f, 'metacarpal')));
const TIP_SLOT = FINGER_NAMES.map((f) => JOINT_ORDER.indexOf(fingerJoint(f, 'tip')));
function handCurl(side) {
  let sum = 0, n = 0;
  for (let f = 0; f < FINGER_NAMES.length; f++) {
    const a = targets[side * HAND_SLOTS + META_SLOT[f]], b = targets[side * HAND_SLOTS + TIP_SLOT[f]];
    if (!a.live || !b.live) continue;
    const d = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
    if (d > GRAB_JOINT_REACH) continue;
    sum += d; n++;
  }
  return { curl: n ? sum / n : 0, n };
}
function handLive(side) {
  let n = 0;
  for (let j = 0; j < HAND_SLOTS; j++) if (targets[side * HAND_SLOTS + j].live) n++;
  return n;
}

/* ----------------------------------------------- геометрия формы фигуры
 * Держимая фигура — кинематик, контактов с ней нет, а судить «шар внутри/снаружи» и стала ли
 * вторая рука кандидатом надо по форме. Локальные оси совпадают с формой из jolt-setup.js:
 * шар r, куб half по осям, кольцо — окружность радиуса R в плоскости XY (нормаль Z). */
const shapeDesc = new Map();       // fig id -> {kind, r | half | R, tube}
const vLoc = new THREE.Vector3(), vSurf = new THREE.Vector3(), vTmp = new THREE.Vector3();
const vNrm = new THREE.Vector3(), qRot = new THREE.Quaternion(), qInv = new THREE.Quaternion();
function surfaceInfo(fig, x, y, z) {
  const d = shapeDesc.get(fig);
  if (!d) return { gap: 1e9, nx: 0, ny: 0, nz: 1 };
  const b = bodies.get(fig), p = posOf(b), q = bi.GetRotation(b);
  qRot.set(q.GetX(), q.GetY(), q.GetZ(), q.GetW());
  qInv.copy(qRot).invert();
  const v = vLoc.set(x - p.x, y - p.y, z - p.z).applyQuaternion(qInv);
  let gap;
  if (d.kind === 'sphere') {
    const L = v.length() || 1e-9;
    vSurf.set(v.x / L * d.r, v.y / L * d.r, v.z / L * d.r);
    gap = L - d.r;
  } else if (d.kind === 'box') {
    const h = d.half;
    vSurf.set(Math.min(Math.max(v.x, -h), h), Math.min(Math.max(v.y, -h), h),
      Math.min(Math.max(v.z, -h), h));
    const ex = Math.abs(v.x) - h, ey = Math.abs(v.y) - h, ez = Math.abs(v.z) - h;
    gap = vTmp.set(Math.max(ex, 0), Math.max(ey, 0), Math.max(ez, 0)).length() +
      Math.min(Math.max(ex, Math.max(ey, ez)), 0);
  } else {                                     // кольцо: окружность R в XY, труба tube
    const rho = Math.hypot(v.x, v.y) || 1e-9;
    vSurf.set(v.x / rho * d.R, v.y / rho * d.R, 0);
    gap = Math.hypot(rho - d.R, v.z) - d.tube;
  }
  // нормаль — от поверхности к шару руки (наружу), в мировых осях
  vNrm.set(v.x - vSurf.x, v.y - vSurf.y, v.z - vSurf.z);
  if (vNrm.lengthSq() < 1e-18) vNrm.set(0, 0, 1);
  vNrm.normalize().applyQuaternion(qRot);
  return { gap, nx: vNrm.x, ny: vNrm.y, nz: vNrm.z };
}

/* Рассогласование кадра: для каждого живого шара — его якорь в мировых осях (r) и насколько
 * шар от него уехал (d). Среднее по весам (радиусам шаров) даёт перенос, разброс вокруг среднего
 * — поворот и невязку. Буферы общие на кадр: 52 якоря на 72 Гц — это тысячи объектов в минуту. */
const anQ = new THREE.Quaternion(), anV = new THREE.Vector3();
const anR = new Float64Array(MAX_SLOTS * 3), anD = new Float64Array(MAX_SLOTS * 3),
  anW = new Float64Array(MAX_SLOTS);

/* Кадр захвата: для каждого шара захвата помним точку ТЕЛА, в которой он этот предмет взял.
 * Местные оси фигуры — те же, что у surfaceInfo (шар r, куб half, кольцо R/tube), поэтому якорь
 * переживает и поворот, и перенос предмета, и пропажу/приход любого шара: переснимать кадр целиком
 * больше нечем, а с пересъёмом умирал и накопленный поворот (прежний reanchor обнулял qFit).
 * Снимается при взятии и при входе конечности; при её выходе её якоря просто удаляются. */
function captureAnchors(g, slots) {
  const b = bodies.get(g.id), p = posOf(b), qj = bi.GetRotation(b);
  anQ.set(qj.GetX(), qj.GetY(), qj.GetZ(), qj.GetW()).invert();
  for (const s of slots) {
    const t = targets[s];
    if (!t.live) continue;
    anV.set(t.x - p.x, t.y - p.y, t.z - p.z).applyQuaternion(anQ);
    g.anch.set(s, { x: anV.x, y: anV.y, z: anV.z, w: t.r });
  }
}
function dropAnchors(g, side) {
  for (const k of [...g.anch.keys()]) if (handOfSlot(k) === side) g.anch.delete(k);
}

function gripMatch(g, p, q) {
  let n = 0, w = 0, rx = 0, ry = 0, rz = 0, dx = 0, dy = 0, dz = 0;
  for (const [slot, a] of g.anch) {
    const t = targets[slot];
    if (!t.live) continue;
    anV.set(a.x, a.y, a.z).applyQuaternion(q);
    const o = n * 3;
    anR[o] = anV.x; anR[o + 1] = anV.y; anR[o + 2] = anV.z;
    anD[o] = t.x - p.x - anV.x; anD[o + 1] = t.y - p.y - anV.y; anD[o + 2] = t.z - p.z - anV.z;
    anW[n] = a.w; w += a.w;
    rx += a.w * anV.x; ry += a.w * anV.y; rz += a.w * anV.z;
    dx += a.w * anD[o]; dy += a.w * anD[o + 1]; dz += a.w * anD[o + 2];
    n++;
  }
  if (!n || w <= 0) return null;
  return { n, w, rx: rx / w, ry: ry / w, rz: rz / w, dx: dx / w, dy: dy / w, dz: dz / w };
}

function addGroup(g, side, slots) {
  const ap = aperture(slots), cu = handCurl(side);
  g.groups.set(side, { slots: slots.slice(), apMin: ap.ap, curlMin: cu.n >= 2 ? cu.curl : null,
    lost: 0, slip: 0 });
}

/* Насколько шары захвата этой конечности всё ещё сидят НА предмете: минимум по живым шарам от
 * (зазор до поверхности минус радиус шара). Пока хоть один шар внутри формы, значение
 * отрицательное — рука на предмете. Положительное и большое значит, что вся конечность ушла, а
 * предмет не донёсся: он упёрся в поводок/фигуру/предел скорости. Единственная из мер, которая
 * смотрит на предмет, а не на кисть (см. SLIP в описании отпускания). */
function gripGap(g, side) {
  const grp = g.groups.get(side);
  if (!grp) return null;
  let out = null;
  for (const s of grp.slots) {
    const t = targets[s];
    if (!t.live) continue;
    const v = surfaceInfo(g.id, t.x, t.y, t.z).gap - slotR[s];
    if (out === null || v < out) out = v;
  }
  return out;
}

/* Конечность перестаёт трогать фигуру: во время захвата — пока держит, после отпускания ещё
 * GRAB_GRACE секунд или пока её шары не выйдут из фигуры (см. rebuildIgnore). */
function addGrace(fig, side) {
  const until = simSteps + GRACE_STEPS;
  for (const e of grace) if (e.fig === fig && e.side === side) { e.until = until; return; }
  grace.push({ fig, side, until });
}

function grabStart(c) {
  const g = { id: c.fig, groups: new Map(), anch: new Map(), lin: null, ang: null,
    resid: 0 };
  const bySide = new Map();
  for (const s of c.slots) {
    const side = handOfSlot(s);
    if (!bySide.has(side)) bySide.set(side, []);
    bySide.get(side).push(s);
  }
  for (const [side, slots] of bySide) addGroup(g, side, slots);
  grabs.set(c.fig, g);
  grabbed.add(c.fig);
  // поводок на время захвата считается от точки захвата: иначе рука не донесла бы фигуру
  anchors.set(c.fig, posOf(bodies.get(c.fig)));
  captureAnchors(g, c.slots);
  beacon('grab|' + c.fig + '|' + allSlots(g).length + '|' +
    sidesOf(g).map((s) => (s ? 'R' : 'L')).join(','));
}

/* Вторая конечность вошла в идущий захват (держит ТОТ ЖЕ предмет): её шары получают якоря на
 * теле предмета, и дальше кадр считается по шарам обеих рук. Прежний reanchor при этом переснимал
 * ВЕСЬ кадр и обнулял накопленный поворот — теперь чужие якоря не трогаются вовсе. */
function grabJoin(c) {
  const g = grabs.get(c.fig);
  if (!g || g.groups.has(c.side)) return;
  addGroup(g, c.side, c.slots);
  captureAnchors(g, c.slots);
  beacon('join|' + c.fig + '|' + (c.side ? 'R' : 'L') + '|' + c.slots.length);
}

/* Одна конечность разжалась — предмет продолжают держать остальные. why плюс числа, по которым
 * это решено: порог калибруется только живыми замерами, угадать его по документации нельзя. */
function groupLeave(g, side, why, dbg) {
  g.groups.delete(side);
  dropAnchors(g, side);
  addGrace(g.id, side);
  blockRegab(g.id, side);
  beacon('leave|' + g.id + '|' + (side ? 'R' : 'L') + '|' + why + (dbg ? '|' + dbg : ''));
}

function grabEnd(g, why) {
  const b = bodies.get(g.id);
  anchors.set(g.id, posOf(b));                 // полёт после отпускания — от точки отпускания
  if (g.lin) {
    bi.SetLinearVelocity(b, V(g.lin[0], g.lin[1], g.lin[2]));
    bi.SetAngularVelocity(b, V(g.ang[0], g.ang[1], g.ang[2]));
  }
  for (const side of sidesOf(g)) addGrace(g.id, side);
  grabbed.delete(g.id); grabs.delete(g.id);
  for (const k of [...holdFrames.keys()]) if (k.startsWith(g.id + '|')) holdFrames.delete(k);
  for (const k of [...joinFrames.keys()]) if (k.startsWith(g.id + '|')) joinFrames.delete(k);
  beacon('release|' + g.id + '|' + why);
}

/* Один кадр захвата: release конечностей и ведение фигуры. Вызывается ВНУТРИ шага, до ji.Step:
 * кинематика сама интегрирует скорость за шаг, как и пальцы. */
function grabStep() {
  for (const [, g] of [...grabs]) {
    for (const [side, grp] of [...g.groups]) {
      if (!g.groups.has(side)) continue;             // разжатая конечность уже убрана
      // Кисти нет в поле (или пропали все её державшие шары) — предмет висит на фантомной
      // руке. Счёт НАКОПЛЕННЫЙ: трекинг на PICO мигает (в живом логе j50 -> j25 -> j50 в
      // пределах секунды), и прежний сброс в ноль из-за одного хорошего кадра держал предмет
      // по 10-14 с, пока кисть не терялась совсем.
      const ap = aperture(grp.slots);
      const gone = ap.live === 0 || handLive(side) === 0;
      if (gone) {
        grp.lost++;
        if (grp.lost > GRAB_LOST) {
          groupLeave(g, side, 'lost', 'j' + handLive(side) + '/' + grp.lost);
          continue;
        }
      } else if (grp.lost > 0) grp.lost--;
      if (ap.live >= GRAB_MIN_JOINTS) {
        if (grp.apMin <= 0 || ap.ap < grp.apMin) grp.apMin = ap.ap;
        if (ap.ap > grp.apMin + GRAB_OPEN) {
          groupLeave(g, side, 'open', 'ap' + (ap.ap * 1000).toFixed(0) + '/' +
            (grp.apMin * 1000).toFixed(0) + 'мм');
          continue;
        }
      }
      const cu = handCurl(side);
      if (cu.n >= 2) {
        if (grp.curlMin === null || cu.curl < grp.curlMin) grp.curlMin = cu.curl;
        if (cu.curl > grp.curlMin + GRAB_OPEN) {
          groupLeave(g, side, 'open', 'cu' + (cu.curl * 1000).toFixed(0) + '/' +
            (grp.curlMin * 1000).toFixed(0) + 'мм к' + cu.n);
          continue;
        }
      }
      // SLIP: рука ушла от предмета, а предмет не донёсся (упёрся в поводок, в другую фигуру
      // или в предел скорости). APERTURE и CURL на это смотреть не могут: они про кисть.
      const gap = gripGap(g, side);
      if (gap !== null) {
        if (gap > GRAB_SLIP) {
          grp.slip++;
          if (grp.slip >= GRAB_SLIP_FRAMES) {
            groupLeave(g, side, 'slip', 'sl' + Math.round(gap * 1000) + 'мм/' + grp.slip);
            continue;
          }
        } else grp.slip = 0;
      }
    }
    if (!grabs.has(g.id)) continue;                  // конечностей не осталось, захват окончен
    if (!g.groups.size) { grabEnd(g, 'open'); continue; }
    const b = bodies.get(g.id), p = posOf(b), qj = bi.GetRotation(b);
    anQ.set(qj.GetX(), qj.GetY(), qj.GetZ(), qj.GetW());
    const m = gripMatch(g, p, anQ);
    if (!m) continue;                                // живых шаров не осталось
    // ПОВОРОТ. То, что средний перенос не объясняет, объясняется поворотом вокруг центра
    // якорей: малый угол методом наименьших квадратов. У направления, которого шары захвата не
    // видят (закручивание вокруг оси пары), числитель нулевой — предмет по нему не крутится.
    // Именно здесь куб, взятый одной рукой (2-5 шаров на одной грани), у прежнего Kabsch
    // отбрасывался целиком как «вырожденная конфигурация» и только ехал за центром шаров,
    // тогда как бублик — крутился (пальцы обхватывают трубу, конфигурация объёмная).
    let nx = 0, ny = 0, nz = 0, den = 0, rs = 0, rw = 0;
    for (let i = 0; i < m.n; i++) {
      const o = i * 3, w = anW[i];
      const ax = anR[o] - m.rx, ay = anR[o + 1] - m.ry, az = anR[o + 2] - m.rz;
      const bx = anD[o] - m.dx, by = anD[o + 1] - m.dy, bz = anD[o + 2] - m.dz;
      nx += w * (ay * bz - az * by); ny += w * (az * bx - ax * bz); nz += w * (ax * by - ay * bx);
      den += w * (ax * ax + ay * ay + az * az);
    }
    const tx = den > 1e-9 ? nx / den : 0, ty = den > 1e-9 ? ny / den : 0,
      tz = den > 1e-9 ? nz / den : 0;
    // НЕВЯЗКА: остаток после переноса и поворота — то, что ни одним жёстким движением не
    // объясняется. Это и есть «держатели перестали быть одной хваткой» (разъезд двух рук).
    for (let i = 0; i < m.n; i++) {
      const o = i * 3, w = anW[i];
      const ax = anR[o] - m.rx, ay = anR[o + 1] - m.ry, az = anR[o + 2] - m.rz;
      const bx = anD[o] - m.dx, by = anD[o + 1] - m.dy, bz = anD[o + 2] - m.dz;
      const ex = bx - (ty * az - tz * ay), ey = by - (tz * ax - tx * az),
        ez = bz - (tx * ay - ty * ax);
      rs += w * (ex * ex + ey * ey + ez * ez); rw += w;
    }
    g.resid = rw > 0 ? Math.sqrt(rs / rw) : 0;
    // РАЗЪЕЗД ДЕРЖАТЕЛЕЙ. Пока предмет держат две конечности, разъезд ничем не измеряется:
    // у каждой руки свои aperture и curl, а ладонь сама по себе не меняется, когда ЕЁ уносят
    // от другой ладони. Живой замер: куб в двух ладонях, руки разъехались — Gc8RL продержался
    // 22 с, m опустилось лишь до 11 мм. Заодно это ломает и кадр: подгонка по двум
    // разъехавшимся кластерам не имеет жёсткого решения, поэтому предмет начинает вращаться
    // на пустом месте. Порог — невязка кадра: при жёстком переносе она нулевая.
    if (g.groups.size >= 2 && g.resid > GRAB_FIT) {
      const dbg = 'st' + Math.round(g.resid * 1000) + 'мм';
      for (const side of sidesOf(g)) if (g.groups.has(side)) groupLeave(g, side, 'spread', dbg);
      grabEnd(g, 'spread');
      continue;
    }
    let tp = { x: p.x + m.dx, y: p.y + m.dy, z: p.z + m.dz };
    // поводок: рука не уносит фигуру дальше leashMeters от точки захвата
    const an = anchors.get(g.id);
    const ddx0 = tp.x - an.x, ddy0 = tp.y - an.y, ddz0 = tp.z - an.z;
    const da = Math.hypot(ddx0, ddy0, ddz0);
    if (da > leashMeters) {
      const k = leashMeters / da;
      tp = { x: an.x + ddx0 * k, y: an.y + ddy0 * k, z: an.z + ddz0 * k };
    }
    const ddx = tp.x - p.x, ddy = tp.y - p.y, ddz = tp.z - p.z;
    if (Math.hypot(ddx, ddy, ddz) > GRAB_TELEPORT) {   // телепорт, как у пальцев: иначе 200 м/с
      bi.SetPositionAndRotation(b, V(tp.x, tp.y, tp.z),
        new Jolt.Quat(qj.GetX(), qj.GetY(), qj.GetZ(), qj.GetW()), Jolt.EActivate_Activate);
      bi.SetLinearVelocity(b, V(0, 0, 0)); bi.SetAngularVelocity(b, V(0, 0, 0));
      g.lin = [0, 0, 0]; g.ang = [0, 0, 0];
      continue;
    }
    // Держимое тело ДИНАМИЧНО, поэтому скорость — единственное, чем его можно вести: импульсы
    // контактов (другая рука, другой держимый предмет) в том же шаге её меняют, и рассогласование
    // на следующем шаге само показывает, что предмет толкнули.
    let vx = ddx * GRAB_FOLLOW / DT, vy = ddy * GRAB_FOLLOW / DT, vz = ddz * GRAB_FOLLOW / DT;
    const s2 = Math.hypot(vx, vy, vz);
    if (s2 > MAX_SPEED) { const k = MAX_SPEED / s2; vx *= k; vy *= k; vz *= k; }
    bi.SetLinearVelocity(b, V(vx, vy, vz));
    // Угол кадра мал по построению (это рассогласование за один шаг), поэтому ось/угол разбирать
    // не нужно: вектор малого поворота напрямую становится угловой скоростью, а направление,
    // которого шары захвата не видят, остаётся нулевым само — его не надо запрещать веткой.
    let wx = tx * GRAB_FOLLOW / DT, wy = ty * GRAB_FOLLOW / DT, wz = tz * GRAB_FOLLOW / DT;
    const sw = Math.hypot(wx, wy, wz);
    if (sw > MAX_SPIN) { const k = MAX_SPIN / sw; wx *= k; wy *= k; wz *= k; }
    bi.SetAngularVelocity(b, V(wx, wy, wz));
    g.lin = [vx, vy, vz]; g.ang = [wx, wy, wz];
  }
}

/* Кандидаты в захват: контакты ПРЕДЫДУЩЕГО шага (их ещё не очистили) + геометрия для второй
 * руки, которая лезет в уже держимый предмет. Счётчик подряд идущих кадров нужен, чтобы
 * случайное двойное касание не включало захват. */
function grabDetect() {
  const seen = new Set(), seenJoin = new Set();
  for (const c of gripCandidates()) {
    const key = c.fig + '|' + c.sides.slice().sort().join(',');
    seen.add(key);
    const n = (holdFrames.get(key) || 0) + 1;
    holdFrames.set(key, n);
    if (n >= GRAB_FRAMES) grabStart(c);
  }
  for (const c of joinCandidates()) {
    const key = c.fig + '|' + c.side;
    seenJoin.add(key);
    const n = (joinFrames.get(key) || 0) + 1;
    joinFrames.set(key, n);
    if (n >= GRAB_FRAMES) grabJoin(c);
  }
  for (const k of [...holdFrames.keys()]) if (!seen.has(k)) holdFrames.delete(k);
  for (const k of [...joinFrames.keys()]) if (!seenJoin.has(k)) joinFrames.delete(k);
}

/* Состояние захвата для HUD, луча и тестов: одна запись на фигуру, внутри — разбивка по
 * конечностям (s0 — левая, s1 — правая) и все меры, по которым судится отпускание: размах
 * (ap/curl), потеря (lost), уход от предмета (gap) и невязка кадра (resid). */
function grabState() {
  return [...grabs.values()].map((g) => {
    const slots = allSlots(g).slice().sort((a, b) => a - b);
    const out = { id: g.id, sides: sidesOf(g), slots, anch: g.anch.size };
    for (const [side, grp] of g.groups) {
      const ap = aperture(grp.slots), cu = handCurl(side), gap = gripGap(g, side);
      out['s' + side] = { slots: grp.slots.slice(), ap: +ap.ap.toFixed(4),
        apMin: +grp.apMin.toFixed(4), curl: +cu.curl.toFixed(4),
        curlMin: grp.curlMin === null ? null : +grp.curlMin.toFixed(4), lost: grp.lost,
        gap: gap === null ? null : +gap.toFixed(4), slip: grp.slip };
    }
    const ap = aperture(slots);
    out.ap = +ap.ap.toFixed(4);
    out.apMin = Math.min(...[...g.groups.values()].map((gr) => +gr.apMin.toFixed(4)));
    out.resid = +(g.resid || 0).toFixed(4);
    return out;
  });
}

/* Запас до отпускания в миллиметрах: по какой мере захват ближе всего к расцеплению. Отрицательным
 * не бывает — как только мера переполняется, конечность уходит. 9999 значит «мерить нечем»: кисть
 * не видна, и ни одна из кистевых мер не считается (единственный выход — счётчик потери). */
function releaseMargin(g) {
  let m = 9999;
  for (const [side, grp] of g.groups) {
    const ap = aperture(grp.slots), cu = handCurl(side), gap = gripGap(g, side);
    if (ap.live >= GRAB_MIN_JOINTS && grp.apMin > 0) {
      m = Math.min(m, (grp.apMin + GRAB_OPEN - ap.ap) * 1000);
    }
    if (cu.n >= 2 && grp.curlMin !== null) m = Math.min(m, (grp.curlMin + GRAB_OPEN - cu.curl) * 1000);
    if (gap !== null) m = Math.min(m, (GRAB_SLIP - gap) * 1000);
  }
  if (g.groups.size >= 2) m = Math.min(m, (GRAB_FIT - (g.resid || 0)) * 1000);
  return Math.round(m);
}

/* Отпускание не глушит взятие обратно в тот же миг: после release пальцы всё ещё сидят в
 * предмете (он маленький, сфера r=35 мм целиком внутри ладони), контакт восстанавливается за
 * три кадра, и предмет снова едет за рукой — в живом логе пары release|grab шли в одну секунду.
 * Окно не зависит от того, вышли ли шары из формы: ignoreSet живёт до выхода, а этот запрет —
 * весь GRAB_GRACE, и считается он тоже шагами. */
const regrab = new Map();        // "fig|side" -> шагов до конца запрета
function blockRegab(fig, side) { regrab.set(fig + '|' + side, simSteps + GRACE_STEPS); }
const regrabBlocked = (fig, side) => (regrab.get(fig + '|' + side) || 0) > simSteps;
function pruneRegrab() {
  for (const k of [...regrab.keys()]) if (regrab.get(k) <= simSteps) regrab.delete(k);
}

/* Пары «фигура <-> сфера руки», которые narrowphase обязана пропустить. Не сталкиваются шары
 * ТОЙ КОНЕЧНОСТИ, которая держит фигуру; остальные конечности сталкиваются как обычно: правая
 * рука толкает предмет, который держит левая, и наоборот. После отпускания то же правило живёт
 * GRAB_GRACE секунд — или пока шары конечности не выйдут из фигуры (иначе застрявшие внутри
 * шары продолжают тащить предмет, и захват кажется бесконечным). */
const ignoreSet = new Set();
const pk = (a, b) => a * 16777216 + b;      // ключи embind < 2^24; заводим оба порядка
function limbTouches(fig, side) {
  for (let j = 0; j < HAND_SLOTS; j++) {
    const s = side * HAND_SLOTS + j, t = targets[s];
    if (t.live && surfaceInfo(fig, t.x, t.y, t.z).gap <= slotR[s]) return true;
  }
  return false;
}
function rebuildIgnore() {
  ignoreSet.clear();
  for (let i = grace.length - 1; i >= 0; i--) {
    if (grace[i].until < simSteps || !limbTouches(grace[i].fig, grace[i].side)) grace.splice(i, 1);
  }
  if (!grabs.size && !grace.length) return;
  const addPairs = (fig, side) => {
    const fk = figKey.get(fig);
    if (fk === undefined) return;
    for (let j = 0; j < HAND_SLOTS; j++) {
      const sk = slotKey[side * HAND_SLOTS + j];
      if (sk === undefined) continue;
      ignoreSet.add(pk(fk, sk));
      ignoreSet.add(pk(sk, fk));
    }
  };
  for (const g of grabs.values()) for (const side of sidesOf(g)) addPairs(g.id, side);
  for (const e of grace) addPairs(e.fig, e.side);
}
/* Предикат для contactRecorder. Ключи тел снимаются только когда игнор реально есть: на пустом
 * Set два лишних wasm-вызова на каждый контакт не нужны. */
const pairIgnored = (a, b, keyOf) => ignoreSet.size > 0 && ignoreSet.has(pk(keyOf(a), keyOf(b)));

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
    rebuildIgnore();                     // шары держащей конечности не сталкиваются с фигурой
    pruneRegrab();
    frameContacts.length = 0;
    ji.Step(DT, 1);
    simSteps++;
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

/* Вынос сферы кончика за сустав: на TIP_EXTEND·(сырой XR-radius) от фаланги-предка наружу.
 * Направление — сама кость пальца (distal → tip). Если предка в этом кадре нет, сдвига нет:
 * выдумывать направление по матрице сустава нельзя, спека оставляет реализациям своё
 * согласование осей, а неверное направление унесло бы палец сквозь предмет. */
function extendTip(x, y, z, px, py, pz, rawR) {
  if (!(TIP_EXTEND > 0) || !(rawR > 0)) return { x, y, z };
  if (!isFinite(px) || !isFinite(py) || !isFinite(pz)) return { x, y, z };
  const dx = x - px, dy = y - py, dz = z - pz, L = Math.hypot(dx, dy, dz);
  if (!(L > 1e-4)) return { x, y, z };
  const k = TIP_EXTEND * rawR / L;
  return { x: x + dx * k, y: y + dy * k, z: z + dz * k };
}

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
    // Кончик выносим вперёд (см. extendTip). Предка берём из того же источника, что и сам
    // сустав: в быстром пути fillPoses залил все 25 поз, даже когда ?hands=index пишет
    // только кончик; в запасном пути вне кадра остались только прочитанные суставы, поэтому
    // там предок обязан быть живым в ЭТОМ кадре (live обнуляется в начале каждого кадра).
    let sx = x, sy = y, sz = z;
    const pj = TIP_PREV[j];
    if (pj >= 0) {
      let px, py, pz;
      if (fast) {
        const o2 = pj * 16;
        px = pose16[o2 + 12]; py = pose16[o2 + 13]; pz = pose16[o2 + 14];
      } else if (targets[handSlot(side, pj)].live) {
        const pt = targets[handSlot(side, pj)];
        px = pt.x; py = pt.y; pz = pt.z;
      } else {
        px = py = pz = NaN;
      }
      const e = extendTip(x, y, z, px, py, pz, r);
      sx = e.x; sy = e.y; sz = e.z;
    }
    const t = targets[handSlot(side, j)];
    t.x = sx; t.y = sy; t.z = sz; t.r = clampR(r * JOINT_R_SCALE); t.live = true;
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
  let ti = 0;
  for (; ti < touchMeshes.length && ti < frameContacts.length; ti++) {
    const c = frameContacts[ti];
    touchMeshes[ti].visible = true;
    touchMeshes[ti].position.set(c.x, c.y, c.z);
  }
  // Держащая конечность выпадает из коллизий с предметом, поэтому МАНИФОЛДОВ у неё нет вовсе,
  // и на живом заходе это читалось как «захват не работает: красных точек касания нет». Точки
  // держателей дорисовываем геометрически — по ближайшей точке поверхности той же формы, по
  // которой считаются slip и вход второй руки.
  gripDots = 0;
  for (const g of grabs.values()) {
    for (const s of allSlots(g)) {
      if (ti >= touchMeshes.length) break;
      const t = targets[s];
      if (!t.live) continue;
      const si = surfaceInfo(g.id, t.x, t.y, t.z);
      touchMeshes[ti].visible = true;
      touchMeshes[ti].position.set(t.x - si.nx * si.gap, t.y - si.ny * si.gap, t.z - si.nz * si.gap);
      ti++; gripDots++;
    }
  }
  for (; ti < touchMeshes.length; ti++) touchMeshes[ti].visible = false;
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
      .map((g) => g.id + ' ' + allSlots(g).length + ' п. (' +
        sidesOf(g).map((s) => (s ? 'П' : 'Л')).join('+') + ')').join(', ') : '') +
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
  // G — что сейчас в захвате: s5LR = шар держат 5 шаров двух рук. Строка луча короткая,
  // поэтому id фигуры — одна буква. m<мм> — запас до отпускания по ближайшей мере: GRAB_OPEN
  // под живую руку калибруется именно по этим числам (в прошлый заход луч таких не давал, и
  // «не отпускает» было нечем измерить).
  const G = 'G' + (grabs.size ? [...grabs.values()].map((g) => g.id[0] + allSlots(g).length +
    sidesOf(g).map((s) => (s ? 'R' : 'L')).join('') + '(m' + releaseMargin(g) + ')').join(',') : '0');
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
    grabs: grabState(),
    // Сколько конечностей сейчас не сталкивается со своей фигурой (включая окно после
    // отпускания): ignoreSet хранит пару в обоих порядках и по 25 сфер на конечность.
    ignoreLimbs: Math.round(ignoreSet.size / (2 * HAND_SLOTS)),
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
        'кулак — отчёт. Режимы и пороги выставляются на стартовой странице (выход из AR — в ней же).';

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
el('btnHands').addEventListener('click', () => { showHands = !showHands; optSync(); });
el('btnGrab').addEventListener('click', () => {
  grabOn = !grabOn;
  if (!grabOn) for (const [, g] of [...grabs]) grabEnd(g, 'btn');
  optSync();
});
el('btnReport').addEventListener('click', () => beacon('FULL|' + fullReport()));

/* -------------------------------------------------- настройки на старте */
/* Режимы и пороги правятся на стартовой странице, а не в адресной строке: dom-overlay шлем
 * не выдаёт, поэтому в AR кнопок нет, но стартовая страница в браузер шлема попадает, и
 * всё можно выбрать ДО входа в сессию (а в превью — на лету). Query-параметры остались и
 * определяют НАЧАЛЬНЫЕ значения полей: живые ссылки вида ?open=60 и прогоны не ломаются,
 * просто теперь их видно в ползунках. Значения читаются из переменных, а не из полей: поле
 * вне своего диапазона браузер молча сдвигает, и чтение обратно показало бы не то число,
 * которым мир реально живёт (например ?leash=5). */
const OPTS = [
  { id: 'oGrab', get: () => grabOn,
    set: (v) => { grabOn = v; if (!v) for (const [, g] of [...grabs]) grabEnd(g, 'opt'); } },
  { id: 'oProxy', get: () => !!showHands, set: (v) => { showHands = v; } },
  { id: 'oHands1', get: () => handsMode === 'index', set: (v) => { handsMode = v ? 'index' : 'full'; } },
  { id: 'oBeacon', get: () => beaconOn, set: (v) => { beaconOn = v; } },
  // миллиметры: GRAB_* живут в метрах
  { id: 'oOpen', get: () => Math.round(GRAB_OPEN * 1000), set: (v) => { GRAB_OPEN = v / 1000; } },
  { id: 'oFit', get: () => Math.round(GRAB_FIT * 1000), set: (v) => { GRAB_FIT = v / 1000; } },
  { id: 'oSlip', get: () => Math.round(GRAB_SLIP * 1000), set: (v) => { GRAB_SLIP = v / 1000; } },
  { id: 'oFollow', dec: 2, get: () => GRAB_FOLLOW, set: (v) => { GRAB_FOLLOW = Math.min(1, v); } },
  { id: 'oTip', unit: ' %', get: () => Math.round(TIP_EXTEND * 100), set: (v) => { TIP_EXTEND = v / 100; } },
  { id: 'oLeash', dec: 2, unit: ' м', get: () => leashMeters, set: (v) => { leashMeters = v; } },
];
function optSync() {
  for (const o of OPTS) {
    const inp = el(o.id), out = el(o.id + 'V');
    if (!inp) continue;
    const v = o.get();
    if (inp.type === 'checkbox') inp.checked = !!v;
    else {
      inp.value = v;
      if (out) out.textContent = (o.dec ? (+v).toFixed(o.dec) : String(v)) + (o.unit || '');
    }
  }
  el('btnGrab').textContent = grabOn ? 'Захват вкл' : 'Захват выкл';
}
for (const o of OPTS) {
  const inp = el(o.id);
  if (!inp) continue;
  const read = () => (inp.type === 'checkbox' ? inp.checked : +inp.value);
  inp.addEventListener('input', () => { o.set(read()); optSync(); });
}
optSync();

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
    if (o.open !== undefined) GRAB_OPEN = o.open;
    if (o.fit !== undefined) GRAB_FIT = o.fit;
    if (o.slip !== undefined) GRAB_SLIP = o.slip;
    if (o.tip !== undefined) TIP_EXTEND = o.tip;
    if (o.grab !== undefined) {
      grabOn = !!o.grab;
      if (!grabOn) for (const [, g] of [...grabs]) grabEnd(g, 'cfg');
    }
  },
  freeze(v) { frozen = !!v; },
  // Текущие настройки — те же числа, что показывает панель стартовой страницы. Тесту нужно,
  // чтобы проверить двусторонность панели: поле отражает мир, а правка поля меняет мир.
  settings() {
    return { handsMode: handsMode, proxy: !!showHands, grabOn: grabOn, beaconOn: beaconOn,
      open: GRAB_OPEN, fit: GRAB_FIT, slip: GRAB_SLIP, follow: GRAB_FOLLOW, tip: TIP_EXTEND,
      leash: leashMeters };
  },
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
  joinCand() { return joinCandidates(); },
  grabbedIds() { return [...grabbed]; },
  // Геометрия формы: зазор шара (x,y,z) до поверхности фигуры и нормаль наружу. По ней судятся
  // «внутри/снаружи» и приход второй руки, поэтому её надо уметь проверить из теста.
  surface(id, x, y, z) {
    const s = surfaceInfo(id, x, y, z);
    return { gap: +s.gap.toFixed(4), n: [+s.nx.toFixed(3), +s.ny.toFixed(3), +s.nz.toFixed(3)] };
  },
  // Порядок и имена суставов, которыми страница подписывает слоты: их обязан дать тест,
  // потому что быстрый путь (fillPoses) раскладывает позы В ЭТОМ порядке, и расхождение со
  // спекой молча меняет суставы местами (на этом два средних сустава длинных пальцев лежали
  // в чужих слотах, а запасной путь по имени не находил ни одного длинного пальца).
  joints: () => JOINT_ORDER.slice(),
  // Вынос сферы кончика: доля сырого radius и чистая геометрия сдвига (проверяет, что сдвиг
  // идёт вдоль кости наружу и что половинный радиус ладони на него не влияет).
  tipExt: () => TIP_EXTEND,
  tipPoint(x, y, z, px, py, pz, rawR) {
    const e = extendTip(x, y, z, px, py, pz, rawR);
    return [+(e.x - x).toFixed(5), +(e.y - y).toFixed(5), +(e.z - z).toFixed(5)];
  },
  // Какие пары шаров имеют право зацепить предмет (правило групп и рук) — прямо по слотам.
  latch(a, b) { return latchPair(a, b); },
  ignores() { return Math.round(ignoreSet.size / (2 * HAND_SLOTS)); },
  graceList() {
    return grace.map((e) => ({ fig: e.fig, side: e.side, ms: Math.round((e.until - simSteps) * DT * 1000) }));
  },
  // Запрет повторного взятия после отпускания: fig -> {сторона: шагов до конца}. Тесту нужно
  // проверить, что release и grab в один кадр больше не бывает.
  regrabList() {
    return [...regrab.entries()].map((e) => ({ fig: e[0].split('|')[0], side: +e[0].split('|')[1],
      steps: e[1] - simSteps }));
  },
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
      // Растягиваем убранную кисть вдоль Y с шагом 0.1 м: убранная кисть не должна выглядеть
      // как сжатая. Иначе её кончик и плюсневая кость дают правдоподобную пару (85 мм) и
      // фантомный CURL по пять пальцев в каждом тесте.
      t.x = (s < HAND_SLOTS ? -1 : 1) * 3; t.y = 2.5 + (s % 25) * 0.1; t.z = 0;
      t.m.set(IDENT16);
    }
    for (let s = 2 * HAND_SLOTS; s < MAX_SLOTS; s++) targets[s].live = false;
  },
  // Кисть пропала из поля трекинга: живые позы обнуляются, как в живом цикле страницы
  // (каждый кадр targets.live=false, а заливаются только те суставы, что оттреканы).
  clearHand(side) {
    for (let j = 0; j < HAND_SLOTS; j++) targets[side * HAND_SLOTS + j].live = false;
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
  // Сколько маркеров в кадре нарисованы как ДЕРЖАТЕЛИ (у держащей конечности манифолдов нет
  // вовсе — её шары исключены из коллизий с предметом, и без этих точек захват выглядит
  // невидимым).
  grabDots() { syncThree(); return gripDots; },
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
