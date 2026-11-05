/* Общий Jolt-мир для спайка (spike-page.js) и AR-страницы (ar-page.js).
 *
 * Здесь собраны все embind-грабли из AGENTS.md («Как заводится»), чтобы чинить их в одном
 * месте, а не в двух: таблица пар фильтров создаётся ЗАПРЕЩЁННОЙ; BodyID живёт только в
 * копии; формы обязаны висеть в JS-массиве alive; mConvexRadius у convex-форм обнулять;
 * слушатель контактов — методы СОБСТВЕННЫЕ свойства инстанса.
 */

export const DT = 1 / 72;
export const HAND_PAD = 0.008;          // = PhysicsSettings.mSpeculativeContactDistance
export const L_HAND = 0, L_SHAPE = 1, L_STATIC = 2;
const N_LAYERS = 3;

/* Настройки мира + три слоя. bpl/opl толкаем в alive: Jolt держит на них только указатели,
 * а владелец C++-объекта — JS-обёртка, так что без ссылки тела молча перестают сталкиваться. */
export function settings(Jolt, alive) {
  const st = new Jolt.JoltSettings();
  st.mMaxBodies = 512; st.mMaxBodyPairs = 4096; st.mMaxContactConstraints = 2048;
  st.mMaxWorkerThreads = 0;                 // в браузере воркеры не нужны (и требуют COOP/COEP)

  const bpl = new Jolt.BroadPhaseLayerInterfaceTable(N_LAYERS, N_LAYERS);
  bpl.MapObjectToBroadPhaseLayer(L_HAND, new Jolt.BroadPhaseLayer(0));
  bpl.MapObjectToBroadPhaseLayer(L_SHAPE, new Jolt.BroadPhaseLayer(1));
  bpl.MapObjectToBroadPhaseLayer(L_STATIC, new Jolt.BroadPhaseLayer(2));

  const opl = new Jolt.ObjectLayerPairFilterTable(N_LAYERS);
  opl.EnableCollision(L_HAND, L_SHAPE);
  opl.EnableCollision(L_SHAPE, L_SHAPE);
  opl.EnableCollision(L_HAND, L_STATIC);
  opl.EnableCollision(L_SHAPE, L_STATIC);
  opl.DisableCollision(L_HAND, L_HAND);     // суставы не расталкивают друг друга

  st.mBroadPhaseLayerInterface = bpl;
  st.mObjectVsBroadPhaseLayerFilter = new Jolt.ObjectVsBroadPhaseLayerFilterTable(bpl, N_LAYERS, opl, N_LAYERS);
  st.mObjectLayerPairFilter = opl;
  alive.push(st, bpl, opl, st.mObjectVsBroadPhaseLayerFilter);
  return st;
}

export function setSpeculative(ps, meters) {
  const s = ps.GetPhysicsSettings();
  s.mSpeculativeContactDistance = meters;   // по умолчанию 0.02 — слишком рано
  ps.SetPhysicsSettings(s);
}

export function sphereShape(Jolt, alive, r) {
  const s = new Jolt.SphereShape(r);
  alive.push(s);
  return s;
}

export function boxShape(Jolt, alive, half) {
  const V = (x, y, z) => new Jolt.Vec3(x, y, z);
  const bs = new Jolt.BoxShapeSettings(V(half, half, half));
  bs.mConvexRadius = 0;                     // иначе рёбра и углы съедены (замер: −22 мм / −40 мм)
  const res = bs.Create();
  if (!res.IsValid()) throw new Error('box не собрался: ' + res.GetError());
  const sh = res.Get();
  alive.push(bs, res, sh);
  return sh;
}

/* Тора в Jolt нет нигде — собирается из капсул по кольцу. Середины хорд стоят НА окружности
 * радиуса R, поэтому стенка отверстия встаёт ровно на R − r (замер 2026-11-04: N=16 и N=32
 * дают одну и ту же дырку). Ось капсулы — локальная +Y, потому поворот вокруг Z на угол сегмента. */
export function torusShape(Jolt, alive, R, tube, n) {
  const V = (x, y, z) => new Jolt.Vec3(x, y, z);
  const cs = new Jolt.StaticCompoundShapeSettings();
  const half = R * Math.sin(Math.PI / n);
  for (let i = 0; i < n; i++) {
    const a = (i + 0.5) * 2 * Math.PI / n;
    const cap = new Jolt.CapsuleShapeSettings(half, tube);
    cap.mConvexRadius = 0;
    alive.push(cap);
    cs.AddShape(V(R * Math.cos(a), R * Math.sin(a), 0),
      Jolt.Quat.prototype.sRotation(V(0, 0, 1), a), cap, 0);
  }
  const res = cs.Create();
  if (!res.IsValid()) throw new Error('compound не собрался: ' + res.GetError());
  const sh = res.Get();
  alive.push(cs, res, sh);
  return sh;
}

/* BodyCreationSettings с настройками ощущения. Damping у BodyInterface НЕТ — только здесь. */
export function bodySettings(Jolt, shape, x, y, z, motion, layer, opts = {}) {
  const V = (a, b, c) => new Jolt.Vec3(a, b, c);
  const bs = new Jolt.BodyCreationSettings(shape, V(x, y, z),
    Jolt.Quat.prototype.sIdentity(), motion, layer);
  bs.mLinearDamping = opts.linearDamping !== undefined ? opts.linearDamping : 0;
  bs.mAngularDamping = opts.angularDamping !== undefined ? opts.angularDamping : 0;
  bs.mFriction = opts.friction !== undefined ? opts.friction : 0.5;
  bs.mRestitution = opts.restitution !== undefined ? opts.restitution : 0;   // без отскока
  bs.mAllowSleeping = false;                     // спящее тело не ловит контакт в том же кадре
  return bs;
}

/* CreateAndAddBody отдаёт BodyID как общее временное окно: второй вызов затирает первый. */
export function addBody(Jolt, bi, bs) {
  const id = bi.CreateAndAddBody(bs, Jolt.EActivate_Activate);
  return new Jolt.BodyID(id.GetIndexAndSequenceNumber());
}

/* Короткая дуга from->to. sFromTo объявляет результат неопределённым для противоположных
 * векторов, а взгляд в шлеме смотрит ровно вдоль −Z — то есть opposite это дефолт, не редкость. */
export function alignQuat(Jolt, fromVec, toVec) {
  const V = (a, b, c) => new Jolt.Vec3(a, b, c);
  const d = fromVec.Dot(toVec);
  if (d < -0.999) return Jolt.Quat.prototype.sRotation(V(1, 0, 0), Math.PI);
  return Jolt.Quat.prototype.sFromTo(fromVec, toVec);
}

/* Манifold'ы кадров: предикат контактов и точки касания. WereBodiesInContact отвечает только
 * «была ли пара», глубины и точек там нет. Методы — собственные свойства: embind проверяет
 * hasOwnProperty и иначе падает на первом шаге.
 *
 * validate(aPtr, bPtr, keyOf) -> true означает «пару пропустить»: ответ возвращается заново
 * каждый шаг, состояние в биндинге не копим (именно так работает игнор коллизий для конечности,
 * держащей предмет). Грабелька, о которой надо помнить (спайк, проверки 13b): пару, которую
 * отклоняют долго, Jolt перестаёт тестировать в narrowphase вовсе, и после снятия отказа стоячая
 * на месте пара не оживает — контакты вернутся только когда что-то из пары пошевелится
 * (SetUseCollisionActivation / SetCollide / mNumStepsBetweenCollisionTestActivation в этом
 * JS-билдинге не экспортированы, так что будить пару нечем). */
export function contactRecorder(Jolt, alive, ps, validate) {
  const store = [];
  const keyOf = (p) => Jolt.wrapPointer(p, Jolt.Body).GetID().GetIndexAndSequenceNumber();
  class Listener extends Jolt.ContactListenerJS {
    constructor() {
      super();
      this.OnContactValidate = (a, b) => (validate && validate(a, b, keyOf)
        ? Jolt.ValidateResult_RejectContact : Jolt.ValidateResult_AcceptContact);
      this.OnContactAdded = (a, b, mp) => rec(a, b, mp);
      this.OnContactPersisted = (a, b, mp) => rec(a, b, mp);
      this.OnContactRemoved = () => {};
    }
  }
  function rec(b1, b2, mp) {
    const m = Jolt.wrapPointer(mp, Jolt.ContactManifold);
    const p = m.GetWorldSpaceContactPointOn1(0);
    store.push({
      a: Jolt.wrapPointer(b1, Jolt.Body).GetID().GetIndexAndSequenceNumber(),
      b: Jolt.wrapPointer(b2, Jolt.Body).GetID().GetIndexAndSequenceNumber(),
      pen: m.get_mPenetrationDepth(), x: p.GetX(), y: p.GetY(), z: p.GetZ(),
    });
  }
  const l = new Listener();
  alive.push(l);
  ps.SetContactListener(l);
  return store;
}
