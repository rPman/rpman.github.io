/* Spike: Jolt вместо шар-прокси (AGENTS.md, «Коллизии и движение», шаг 1 плана переезда).
 * Запуск:  node ar/jolt/spike.mjs        (exit != 0 при провале)
 *
 * Гоняется БЕЗ браузера — это ответ на пункт «node-совместимость jolt-physics не
 * подтверждена — проверить первым делом». Подтверждена: принцип «физику гонять без
 * браузера» на Jolt выжил.
 *
 * Что проверяется:
 *   1) jolt-physics 1.1.1 заводится в node, делает шаги, мир переиспользуется;
 *   2) тор собирается из капсул по кольцу (примитива тора в Jolt нет);
 *   3) палец входит в отверстие тора и не отталкивается заранее (главная цель переезда);
 *   4) кинематический сустав толкает динамическое тело: зазор = внешняя граница формы,
 *      скорость тела = скорость сустава (правило «без инерции» сохраняется);
 *   5) слои: рука↔рука выключена, рука↔фигура включена;
 *   6) Jolt сам считает тензор инерции из compound'а (у шар-прокси момента не было);
 *   7) честная форма: касание грани/ребра/угла куба там, где грань/ребро/угол
 *      (сверено с чистой геометрией: 0.0830/0.0840, 0.1080/0.1109, 0.1300/0.1316).
 *
 * Найдено НОВОГО (читать перед тем, как писать боевой модуль):
 *   Н1  Точка входа — JoltInterface: у PhysicsSystem нет ни конструктора, ни Update.
 *       Шаг: ji.Step(dt, collisionSteps). Официальный пример — Examples/js/example.js.
 *   Н2  ObjectLayerPairFilterTable создаётся с ЗАПРЕЩЁННЫМИ парами: без явных
 *       EnableCollision коллизий нет вообще, и молча. Это главная грабля.
 *   Н3  Мир ОДИН на процесс/страницу: второй JoltInterface = Aborted(OOM). «Сбросить
 *       мир» = удалить тела (RemoveBody + DestroyBody).
 *   Н4  CreateAndAddBody отдаёт BodyID как ОБЩЕЕ временное окно: второй вызов затирает
 *       первый, у двух тел становится один id → падение в DestroyBody. Копировать:
 *       new Jolt.BodyID(id.GetIndexAndSequenceNumber()).
 *   Н5  GetPosition (RVec3) — то же общее окно: снимать числа сразу, иначе два чтения
 *       разных тел дают одинаковые значения.
 *   Н6  SetKinematicTarget в биндинге нет. Кинематическому суставу ставить ТОЛЬКО
 *       скорость (кинематика сама интегрирует её за шаг); позиция+скорость = двойной
 *       шаг и накопный дрейф; без скорости палец проваливается в фигуру на 25 мм.
 *   Н7  mSpeculativeContactDistance по умолчанию 0.02 (!) — контакт начинается за 2 см
 *       до реального касания, т.е. ровно тот баг с бубликом, ради которого переезд.
 *       Здесь живёт handPad: ставим 0.008 и сверяем зазоры с этим числом.
 *   Н8  Контактов static↔kinematic и kinematic↔kinematic нет вовсе. Геометрические
 *       пробы делать ДИНАМИЧЕСКИМ пришпиленным телом.
 *   Н9  Методы ContactListenerJS обязаны быть СОБСТВЕННЫМИ свойствами инстанса
 *       (проверка через hasOwnProperty), а не методами прототипа. В колбэках приходят
 *       УКАЗАТЕЛИ на Body (числа), обратно в id — Jolt.wrapPointer(ptr, Jolt.Body).
 *       Константы валидации без буквы E: Jolt.ValidateResult_AcceptContact.
 *   Н10 WereBodiesInContact отвечает только «была ли пара в контакте» — ни глубины, ни
 *       точек. На simple-формах он совпал с манifold'ами (0.0830 против 0.0840), но
 *       предикат всё равно берём из манifold'ов слушателя: у них есть pen и точки,
 *       которые странице нужны для отрисовки касаний.
 *   Н11 ShapeSettings/ShapeResult/Shape надо держать в JS-массиве: иначе wasm-память
 *       освобождается и тела ходят по мусору.
 *   Н12 Выпуклый радиус выпуклых форм (у BoxShapeSettings по умолчанию ненулевой) съедает
 *       рёбра и углы: шар касался ребра куба на 22 мм позже, чем надо, угла — на 40 мм.
 *       Ставим mConvexRadius = 0 у ВСЕХ convex-настроек — после этого грань/ребро/угол
 *       совпадают с геометрией с точностью до 1 мм.
 *   Н13 Дырка тора из капсул: стенка стоит ровно на R - r (сагитта полигона не мешает,
 *       N=16 и N=32 дают одно и то же). Палец r=0.011 проходит свободно.
 */
import initJolt from 'jolt-physics';

const DT = 1 / 72;
const TORUS_R = 0.075;      // м, радиус кольца бублика (как в THREE.TorusGeometry на странице)
const TUBE_R = 0.03;        // м, радиус трубки
const NSEG = 16;            // капсул на кольцо
const FINGER_R = 0.011;     // м, типовой радиус сустава
const CUBE_HALF = 0.065;    // м, половина ребра куба со страницы (BoxGeometry 0.13)
const HAND_PAD = 0.008;     // м, handPad из старой физики -> speculative distance

let fails = 0;
function ok(name, cond, detail) {
  console.log((cond ? 'ok   ' : 'FAIL ') + name + (detail !== undefined ? '   [' + detail + ']' : ''));
  if (!cond) fails++;
}
function near(a, b, eps) { return Math.abs(a - b) <= eps; }

// слои: 0 = рука, 1 = фигура, 2 = статика (пол/стены)
const L_HAND = 0, L_SHAPE = 1, L_STATIC = 2;

const Jolt = await initJolt();
const V = (x, y, z) => new Jolt.Vec3(x, y, z);
const Q = () => Jolt.Quat.prototype.sIdentity();

/* ---------------- мир: ровно один на процесс (Н3) ------------------------ */
const st = new Jolt.JoltSettings();
st.mMaxBodies = 512;
st.mMaxBodyPairs = 4096;
st.mMaxContactConstraints = 2048;
st.mMaxWorkerThreads = 0;                       // node: без worker-потоков

const bpl = new Jolt.BroadPhaseLayerInterfaceTable(3, 3);
bpl.MapObjectToBroadPhaseLayer(L_HAND, new Jolt.BroadPhaseLayer(0));
bpl.MapObjectToBroadPhaseLayer(L_SHAPE, new Jolt.BroadPhaseLayer(1));
bpl.MapObjectToBroadPhaseLayer(L_STATIC, new Jolt.BroadPhaseLayer(2));
const opl = new Jolt.ObjectLayerPairFilterTable(3);
// (Н2: таблица пар создаётся ВЫКЛЮЧЕННОЙ — эти строки обязательны)
opl.EnableCollision(L_HAND, L_SHAPE);
opl.EnableCollision(L_SHAPE, L_SHAPE);
opl.EnableCollision(L_HAND, L_STATIC);
opl.EnableCollision(L_SHAPE, L_STATIC);
opl.DisableCollision(L_HAND, L_HAND);           // 50 суставов не расталкивают друг друга
st.mBroadPhaseLayerInterface = bpl;
st.mObjectVsBroadPhaseLayerFilter = new Jolt.ObjectVsBroadPhaseLayerFilterTable(bpl, 3, opl, 3);
st.mObjectLayerPairFilter = opl;

const ji = new Jolt.JoltInterface(st);
const ps = ji.GetPhysicsSystem();
const bi = ps.GetBodyInterfaceNoLock();
ps.SetGravity(V(0, 0, 0));                      // AR: ни гравитации, ни «падающих» фигур

const psSet = ps.GetPhysicsSettings();
console.log('настройки по умолчанию: speculative', psSet.mSpeculativeContactDistance.toFixed(3),
  ' slop', psSet.mPenetrationSlop.toFixed(3), ' шагов скорости', psSet.mNumVelocitySteps);
psSet.mSpeculativeContactDistance = HAND_PAD;   // (Н7) handPad живёт здесь
ps.SetPhysicsSettings(psSet);

const alive = [];                               // (Н11) формы должны оставаться достижимы из JS
function sphere(r) { const sh = new Jolt.SphereShape(r); alive.push(sh); return sh; }

/* --------------- контакты: манifold'ы слушателя, не WereBodiesInContact ----
 * (Н9, Н10). Слушатель отдаёт и точки касания — их же will использовать страница. */
let frameContacts = [];
class TouchListener extends Jolt.ContactListenerJS {
  constructor() {
    super();
    this.OnContactValidate = () => Jolt.ValidateResult_AcceptContact;
    this.OnContactAdded = (b1, b2, mp) => rec(b1, b2, mp);
    this.OnContactPersisted = (b1, b2, mp) => rec(b1, b2, mp);
    this.OnContactRemoved = () => {};
  }
}
function bodyNum(ptr) { return Jolt.wrapPointer(ptr, Jolt.Body).GetID().GetIndexAndSequenceNumber(); }
function rec(b1, b2, mp) {
  const m = Jolt.wrapPointer(mp, Jolt.ContactManifold);
  const pts = [];
  const n = m.mRelativeContactPointsOn1.size();
  for (let i = 0; i < n; i++) {
    const p = m.GetWorldSpaceContactPointOn1(i);
    pts.push([p.GetX(), p.GetY(), p.GetZ()]);   // (Н5) числа снимать сразу
  }
  frameContacts.push({ a: bodyNum(b1), b: bodyNum(b2), pen: m.get_mPenetrationDepth(), pts });
}
alive.push(new TouchListener());
ps.SetContactListener(alive[alive.length - 1]);
function step() { frameContacts = []; ji.Step(DT, 1); }
function contactsOf(idA, idB) {
  const a = idA.GetIndexAndSequenceNumber(), b = idB.GetIndexAndSequenceNumber();
  return frameContacts.filter(c => (c.a === a && c.b === b) || (c.a === b && c.b === a));
}
function touching(idA, idB) { return contactsOf(idA, idB).length > 0; }

/* Тор: N капсул, середины их осей лежат на окружности TORUS_R (ось дырки = Z).
 * Примитива тора в Jolt нет; дети compound обязаны быть выпуклыми. */
function torusShape(n = NSEG) {
  const cs = new Jolt.StaticCompoundShapeSettings();
  const half = TORUS_R * Math.sin(Math.PI / n);   // половина хорды => соседние капсулы смыкаются
  for (let i = 0; i < n; i++) {
    const a = (i + 0.5) * 2 * Math.PI / n;
    // ось капсулы в Jolt — local +Y; поворот вокруг Z на a ставит её по касательной
    const cap = new Jolt.CapsuleShapeSettings(half, TUBE_R);
    cap.mConvexRadius = 0;                      // (Н12) выпуклый радиус портит форму
    alive.push(cap);
    cs.AddShape(V(TORUS_R * Math.cos(a), TORUS_R * Math.sin(a), 0),
      Jolt.Quat.prototype.sRotation(V(0, 0, 1), a), cap, 0);
  }
  const res = cs.Create();
  if (!res.IsValid()) throw new Error('compound не собрался: ' + res.GetError());
  const shape = res.Get();
  alive.push(cs, res, shape);
  return shape;
}

function add(shape, x, y, z, motion, layer, rot) {
  const id = bi.CreateAndAddBody(new Jolt.BodyCreationSettings(shape, V(x, y, z), rot || Q(),
    motion, layer), Jolt.EActivate_Activate);
  return new Jolt.BodyID(id.GetIndexAndSequenceNumber());   // (Н4) id живёт только в копии
}
function drop(id) { bi.RemoveBody(id); bi.DestroyBody(id); }
function pos(id) {                                            // (Н5) числа сразу
  const p = bi.GetPosition(id);
  return { x: p.GetX(), y: p.GetY(), z: p.GetZ() };
}
function speedOf(id) { const v = bi.GetLinearVelocity(id); return Math.hypot(v.GetX(), v.GetY(), v.GetZ()); }

/* Кинематический сустав едет в (x,y,z): ТОЛЬКО скорость (Н6). */
function driveJoint(id, x, y, z) {
  const p = pos(id);
  bi.SetLinearVelocity(id, V((x - p.x) / DT, (y - p.y) / DT, (z - p.z) / DT));
}
/* Пришпиленная динамическая фигура: единственный способ получить контакт с пальцем (Н8). */
function addPinned(shape, layer, rot) {
  const id = add(shape, 0, 0, 0, Jolt.EMotionType_Dynamic, layer, rot);
  return {
    id,
    hold() {
      bi.SetPositionAndRotation(id, V(0, 0, 0), rot || Q(), Jolt.EActivate_Activate);
      bi.SetLinearVelocity(id, V(0, 0, 0));
      bi.SetAngularVelocity(id, V(0, 0, 0));
    },
  };
}

/* Палец едет из |r|=0.3 вдоль dir к началу координат (0.001 м за кадр).
 * Возвращает { r, pen }: |r| пальца в кадре первого контакта и глубину контакта. */
function firstTouch(shape, dir, rot) {
  const fig = addPinned(shape, L_SHAPE, rot);
  const len = Math.hypot(dir[0], dir[1], dir[2]);
  const d = dir.map(v => v / len);
  const finger = add(sphere(FINGER_R), d[0] * 0.3, d[1] * 0.3, d[2] * 0.3,
    Jolt.EMotionType_Kinematic, L_HAND);
  step();
  let out = null;
  for (let f = 1; f <= 300 && out === null; f++) {
    const t = 0.3 - 0.001 * f;
    fig.hold();
    driveJoint(finger, d[0] * t, d[1] * t, d[2] * t);
    step();
    const cs = contactsOf(fig.id, finger);
    if (cs.length) out = { r: Math.hypot(pos(finger).x, pos(finger).y, pos(finger).z), pen: cs[0].pen };
  }
  drop(finger);
  drop(fig.id);
  return out;
}

/* largest probe sphere that still touches the torus from the centre of the hole */
function maxProbeRadius(shape) {
  let lo = 0.004, hi = 0.07;
  for (let i = 0; i < 14; i++) {
    const rho = (lo + hi) / 2;
    const fig = addPinned(shape, L_SHAPE);
    const p = add(sphere(rho), 0, 0, 0, Jolt.EMotionType_Kinematic, L_HAND);
    fig.hold();
    step();
    const hit = touching(fig.id, p);
    drop(p);
    drop(fig.id);
    if (hit) hi = rho; else lo = rho;
  }
  return lo;
}

// ---- 1. node-совместимость и API ------------------------------------------
step();
ok('jolt-physics 1.1.1 заводится в node и делает шаг', ps.GetNumBodies() >= 0, 'тел ' + ps.GetNumBodies());
ok('PhysicsSystem не конструируется напрямую, точка входа JoltInterface (Н1)',
  Jolt.PhysicsSystem.new === undefined && Jolt.JoltInterface !== undefined);
ok('SetKinematicTarget в JS-биндинге нет (Н6)', bi.SetKinematicTarget === undefined);

// ---- 2..4. палец в отверстии тора -----------------------------------------
const torus16 = torusShape(NSEG);
const torus32 = torusShape(32);
{
  const fig = addPinned(torus16, L_SHAPE);
  const finger = add(sphere(FINGER_R), -0.3, 0, 0, Jolt.EMotionType_Kinematic, L_HAND);
  step();

  // контроль на ТЕХ ЖЕ телах: по экватору материал на пути — контакт обязан появиться
  let control = null;
  for (let f = 0; f < 300 && control === null; f++) {
    fig.hold();
    driveJoint(finger, -0.3 + 0.001 * (f + 1), 0, 0);
    step();
    if (touching(fig.id, finger)) control = Math.hypot(pos(finger).x, pos(finger).y, pos(finger).z);
  }
  ok('контроль: палец цепляет материал бублика по экватору',
    control !== null && near(control, TORUS_R + TUBE_R + FINGER_R + HAND_PAD, 0.005),
    '|r|=' + (control === null ? 'нет' : control.toFixed(4)) +
    ' истина=' + (TORUS_R + TUBE_R + FINGER_R + HAND_PAD).toFixed(4));

  // тот же палец — по оси дырки: материала на пути нет
  bi.SetPositionAndRotation(finger, V(0, 0, -0.25), Q(), Jolt.EActivate_Activate);
  bi.SetLinearVelocity(finger, V(0, 0, 0));
  step();
  let touchedAt = null;
  for (let f = 0; f < 200; f++) {
    fig.hold();
    driveJoint(finger, 0, 0, -0.25 + 0.0025 * (f + 1));      // насквозь по оси дырки
    step();
    if (touchedAt === null && touching(fig.id, finger)) touchedAt = -0.25 + 0.0025 * (f + 1);
  }
  ok('палец проходит сквозь отверстие тора и не отталкивается заранее', touchedAt === null,
    'дырка ' + (TORUS_R - TUBE_R).toFixed(3) + ' м, палец r=' + FINGER_R +
    '; старая физика: контакт с |z| < 0.109');
  drop(finger);
  drop(fig.id);
}
{
  const hole16 = maxProbeRadius(torus16);
  const hole32 = maxProbeRadius(torus32);
  const truth = TORUS_R - TUBE_R;                            // чистая дырка нарисованного тора
  // щуп касается стенки, когда зазор = speculative (handPad) => стенка = rho + HAND_PAD
  ok('размер дырки глазами физики = R - r (Н13)',
    near(hole16 + HAND_PAD, truth, 0.002),
    'N16=' + (hole16 + HAND_PAD).toFixed(4) + ' истина=' + truth.toFixed(4) +
    ' (сагитта полигона N=16 ' + (TORUS_R * (1 - Math.cos(Math.PI / NSEG))).toFixed(4) + ')');
  ok('дырка не зависит от числа капсул: ошибка формы снаружи, не в дырке',
    Math.abs(hole32 - hole16) < 0.001, 'N16=' + hole16.toFixed(4) + ' N32=' + hole32.toFixed(4));
}

// ---- 5. кинематическая рука двигает динамическую фигуру -------------------
{
  const torus = add(torus16, 0, 0, 0, Jolt.EMotionType_Dynamic, L_SHAPE);
  bi.SetMaxLinearVelocity(torus, 2.5);                       // = maxSpeed в старой физике
  bi.SetMaxAngularVelocity(torus, 10);
  const finger = add(sphere(FINGER_R), -0.3, 0, 0, Jolt.EMotionType_Kinematic, L_HAND);
  step();
  let contacts = 0, vTorus = 0, vFinger = 0;
  for (let f = 0; f < 200; f++) {
    driveJoint(finger, -0.3 + 0.4 * DT * (f + 1), 0, 0);     // палец: +X, 0.4 м/с
    step();
    if (touching(torus, finger)) contacts++;
    if (f > 170) { vTorus = speedOf(torus); vFinger = speedOf(finger); }
  }
  const gap = pos(torus).x - pos(finger).x;
  ok('бублик поехал за пальцем', pos(torus).x > 0.05, 'x=' + pos(torus).x.toFixed(3));
  ok('зазор рука->бублик = внешняя граница формы, проникновения нет',
    near(gap, TORUS_R + TUBE_R + FINGER_R, 0.012),
    'зазор=' + gap.toFixed(4) + ' истина=' + (TORUS_R + TUBE_R + FINGER_R).toFixed(4));
  ok('скорость бублика = скорость пальца (правило «не быстрее толкающего»)',
    near(vTorus, vFinger, 0.05), 'v бублика=' + vTorus.toFixed(3) + ' v пальца=' + vFinger.toFixed(3));
  ok('контакт держится всё время толкания', contacts > 150, 'кадров с контактом ' + contacts);
  drop(finger);
  drop(torus);
}

// ---- 6. слои --------------------------------------------------------------
{
  const handA = add(sphere(0.02), 0, 0, 0, Jolt.EMotionType_Kinematic, L_HAND);
  const handProbe = add(sphere(0.02), 0.01, 0, 0, Jolt.EMotionType_Dynamic, L_HAND);
  const handB = add(sphere(0.02), 0, 0.5, 0, Jolt.EMotionType_Kinematic, L_HAND);
  const shapeProbe = add(sphere(0.02), 0.01, 0.5, 0, Jolt.EMotionType_Dynamic, L_SHAPE);
  step();
  ok('рука<->рука выключена слоями (тела внахлёст — контакта нет)', !touching(handA, handProbe));
  ok('рука<->фигура включена (тела внахлёст — контакт есть, pen = slop+spec)',
    touching(handB, shapeProbe), 'pen=' + contactsOf(handB, shapeProbe)[0].pen.toFixed(4));
  drop(shapeProbe);
  drop(handB);
  drop(handProbe);
  drop(handA);
}

// ---- 7. момент инерции из compound ----------------------------------------
{
  const mp = torus16.GetMassProperties();
  const Izz = mp.mInertia.GetDiagonal3().GetZ();
  ok('у compound-тора ненулевые масса и момент (у шар-прокси момента не было вовсе)',
    mp.mMass > 0 && Izz > 0, 'm=' + mp.mMass.toFixed(4) + ' Izz=' + Izz.toFixed(6));
  const t = add(torus16, 0, 0, 0, Jolt.EMotionType_Dynamic, L_SHAPE);
  bi.SetAngularVelocity(t, V(0, 0, 2));
  for (let f = 0; f < 60; f++) step();
  const angle = 2 * Math.acos(Math.min(1, Math.abs(bi.GetRotation(t).GetW())));
  ok('бублик вращается вокруг оси дырки', angle > 1.5,
    'поворот за 1 с = ' + angle.toFixed(2) + ' рад при 2 рад/с');
  drop(t);
}

// ---- 8. кинематическому суставу ОБЯЗАТЕЛЬНО нужна скорость (Н6) -----------
{
  const t = add(torus16, 0, 0, 0, Jolt.EMotionType_Dynamic, L_SHAPE);
  const finger = add(sphere(FINGER_R), -0.3, 0, 0, Jolt.EMotionType_Kinematic, L_HAND);
  step();
  for (let f = 0; f < 200; f++) {                            // только позиция, без скорости
    bi.SetPositionAndRotation(finger, V(-0.3 + 0.4 * DT * (f + 1), 0, 0), Q(), Jolt.EActivate_Activate);
    step();
  }
  const gap = pos(t).x - pos(finger).x;
  ok('без скорости сустава палец проваливается внутрь фигуры',
    gap < TORUS_R + TUBE_R + FINGER_R - 0.01,
    'зазор=' + gap.toFixed(4) + ' против ' + (TORUS_R + TUBE_R + FINGER_R).toFixed(4) + ' при скорости');
  drop(finger);
  drop(t);
}

// ---- 9. честная форма вместо шара-прокси ----------------------------------
{
  const bs = new Jolt.BoxShapeSettings(V(CUBE_HALF, CUBE_HALF, CUBE_HALF));
  bs.mConvexRadius = 0;                       // (Н12) иначе рёбра и углы «съедены»
  const boxShape = (alive[alive.length] = bs.Create()).Get();
  alive.push(bs);

  const face = firstTouch(boxShape, [1, 0, 0]);
  const faceTruth = CUBE_HALF + FINGER_R + HAND_PAD;
  const proxy = 0.090 + FINGER_R + HAND_PAD;  // что дал бы старый шар-прокси radius 0.090
  ok('куб: касание грани совпало с гранью (шар-прокси врал на ' +
    Math.round((proxy - faceTruth) * 1000) + ' мм)',
    face !== null && near(face.r, faceTruth, 0.003),
    'грань=' + (face === null ? 'нет' : face.r.toFixed(4)) + ' истина=' + faceTruth.toFixed(4) +
    ' прокси=' + proxy.toFixed(4));

  const edge = firstTouch(boxShape, [1, 1, 0]);
  const edgeTruth = CUBE_HALF * Math.SQRT2 + FINGER_R + HAND_PAD;
  ok('куб: касание ребра совпало с ребром', edge !== null && near(edge.r, edgeTruth, 0.003),
    'ребро=' + (edge === null ? 'нет' : edge.r.toFixed(4)) + ' истина=' + edgeTruth.toFixed(4));

  const corner = firstTouch(boxShape, [1, 1, 1]);
  const cornerTruth = CUBE_HALF * Math.sqrt(3) + FINGER_R + HAND_PAD;
  ok('куб: касание угла совпало с углом (форма различает грань/ребро/угол)',
    corner !== null && near(corner.r, cornerTruth, 0.003),
    'угол=' + (corner === null ? 'нет' : corner.r.toFixed(4)) + ' истина=' + cornerTruth.toFixed(4));
}

// ---- 10. WereBodiesInContact против манifold'ов слушателя (Н10) -----------
{
  const bs = new Jolt.BoxShapeSettings(V(CUBE_HALF, CUBE_HALF, CUBE_HALF));
  bs.mConvexRadius = 0;
  const boxShape = (alive[alive.length] = bs.Create()).Get();
  alive.push(bs);
  const fig = addPinned(boxShape, L_SHAPE);
  const finger = add(sphere(FINGER_R), 0.3, 0, 0, Jolt.EMotionType_Kinematic, L_HAND);
  step();
  let firstWere = null, firstManifold = null;
  for (let f = 1; f <= 300; f++) {
    const t = 0.3 - 0.001 * f;
    fig.hold();
    driveJoint(finger, t, 0, 0);
    step();
    if (firstWere === null && ps.WereBodiesInContact(fig.id, finger)) firstWere = t;
    if (firstManifold === null && touching(fig.id, finger)) firstManifold = t;
  }
  ok('WereBodiesInContact = голый факт пары: предикат контактов берём из манifold`ов (Н10)',
    firstManifold !== null && firstWere !== null && Math.abs(firstWere - firstManifold) < 0.002 &&
    contactsOf(fig.id, finger)[0].pts.length > 0,
    'WereBodiesInContact=' + firstWere.toFixed(4) + ' манifold=' + firstManifold.toFixed(4) +
    ' истина=' + (CUBE_HALF + FINGER_R + HAND_PAD).toFixed(4) +
    ', у манifold`а точек ' + contactsOf(fig.id, finger)[0].pts.length + ', pen ' +
    contactsOf(fig.id, finger)[0].pen.toFixed(4));
  drop(finger);
  drop(fig.id);
}

// ---- 12. захват: SetMotionType и кинематическое вращение ----------------
// Захват решено держать так: на время захвата фигура становится КИНЕМАТИЧЕСКОЙ и едет за
// кадром захвата (линейная + угловая скорость). Здесь проверяется всё, на чём это стоит.
{
  ok('у BodyInterface есть SetMotionType(id, motion, activation) — перевод фигуры в кинематику',
    typeof bi.SetMotionType === 'function' && typeof bi.GetMotionType === 'function',
    'SetMotionType: ' + typeof bi.SetMotionType + ', GetMotionType: ' + typeof bi.GetMotionType);

  const held = add(sphere(0.035), 0, 0, 0, Jolt.EMotionType_Dynamic, L_SHAPE);
  bi.SetMotionType(held, Jolt.EMotionType_Kinematic, Jolt.EActivate_Activate);
  bi.SetLinearVelocity(held, V(0.3, 0, 0));
  bi.SetAngularVelocity(held, V(0, 0, 2));
  for (let f = 0; f < 72; f++) step();                 // ровно одна секунда
  const p = pos(held), q = bi.GetRotation(held);
  const ang = 2 * Math.acos(Math.min(1, Math.abs(q.GetW())));
  ok('кинематическое тело интегрирует и линейную, и угловую скорость — поворот захвата есть',
    near(p.x, 0.3, 0.01) && near(ang, 2, 0.05),
    'x=' + p.x.toFixed(4) + ' (ждали 0.300), поворот ' + ang.toFixed(3) + ' рад (ждали 2.000)');

  // Держать придётся ГЕОМЕТРИЕЙ: палец (кинематический) и удерживаемая фигура (тоже
  // кинематическая) контактов не дают вовсе.
  const finger = add(sphere(FINGER_R), pos(held).x - (0.035 + FINGER_R), 0, 0,
    Jolt.EMotionType_Kinematic, L_HAND);
  step();
  ok('удерживаемая фигура с пальцем не контактирует: kinematic<->kinematic контактов нет',
    !touching(held, finger),
    'палец впритык (|dx|=' + Math.abs(pos(held).x - pos(finger).x).toFixed(4) +
    '), контактов ' + contactsOf(held, finger).length);
  drop(finger);

  bi.SetMotionType(held, Jolt.EMotionType_Dynamic, Jolt.EActivate_Activate);
  const vKeep = speedOf(held);
  bi.SetLinearVelocity(held, V(0.3, 0, 0));             // на отпускании скорость ставим сами
  for (let f = 0; f < 72; f++) step();
  const p2 = pos(held);
  ok('обратно в динамик тело продолжает лететь — бросок работает',
    p2.x - p.x > 0.25, 'скорость сразу после перехода ' + vKeep.toFixed(3) + ' м/с, пролетело ещё ' +
    (p2.x - p.x).toFixed(3) + ' м за 1 с');
  drop(held);
}

// ---- 11. мир переиспользуется (Н3) ---------------------------------------
ok('мир переиспользуется: тела добавляются и удаляются без нового мира',
  (() => { const a = add(sphere(0.01), 0, 0, 0, Jolt.EMotionType_Dynamic, L_SHAPE); drop(a); return true; })(),
  'тел ' + ps.GetNumBodies());

console.log(fails ? '\nFAIL ' + fails : '\nall passed');
process.exit(fails ? 1 : 0);
