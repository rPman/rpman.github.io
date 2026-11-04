# AGENTS.md — ar-hands-sphere (AR «сфера и руки»)

Рабочий документ проекта. Чат-сессия не является источником истины — источник истины здесь и
в исходниках `ar/`.

## Что за проект

Passthrough-**AR**: белая сфера, которую толкают **реальные руки** (hand tracking, без
контроллеров). Направление удара — по нормали в точке касания (бильярд), инерции нет: рука
встала — сфера встала. Движок — three.js **r128** (UMD).

Поставка **многофайловая**: страница + соседние скрипты, никакой сборки и единого архива.
Требования «один самодостаточный файл» больше нет (2026-11-04).

## Карта файлов

| файл | что делает |
|---|---|
| `ar-hands-sphere.html` | сама страница: разметка + CSS + три `<script src>` (5.6 КБ, 100 строк) |
| `ar/sphere-push.js` | физика коллизии, ЧИСТАЯ: без three и DOM, UMD (node + браузер), 225 строк |
| `ar/app.js` | сцена three + чтение кистей + превью без шлема + хук `window.__hs`, 393 строки |
| `ar/three-r128.min.js` | ВЕНДОР: UMD three.js r128 (589 КБ, одна строка). Не читается и не правится |
| `ar/sphere-push.test.mjs` | юнит-тесты физики: `node ar/sphere-push.test.mjs` (24 проверки, без браузера) |
| `ar/page-test.mjs` | headless-Chrome: гоняет страницу через `__hs.step()`, печатает таблицу + 3 скриншота в `/tmp/arhands` |

Границы между частями не случайны: `sphere-push.js` не знает ни про three, ни про DOM (работает
в node) — поэтому физику проверяют без браузера; `app.js` — единственное место, где есть `THREE`;
в HTML — только вёрстка и стили. Порядок `<script src>` в конце `<body>` важен: `three` →
`sphere-push` → `app` (все трое — обычные классические скрипты, не ES-модули, поэтому работают
и по `file://`, и по HTTPS).

Размер three сюда не «раздувает» файл: 589 КБ вендора лежат отдельным файлом и редактор к ним
непричастен.

## Команды проверки (не выдумывать заново)

```bash
node ar/sphere-push.test.mjs        # 24/24, физика без браузера
node ar/page-test.mjs               # 12/12 + shot_start/shot_preview/shot_contact.png
node --check ar/app.js              # быстрая проверка синтаксиса
```

Сборки нет: правки в `ar/app.js` / `ar/sphere-push.js` / `ar-hands-sphere.html` видны сразу при
открытии страницы. `page-test.mjs` для своих копий (`test.html`, `shot.html`,
`shot_contact.html` в `/tmp/arhands`) сам переписывает `src="ar/…"` на абсолютные `file://` —
копии вне каталога иначе не увидят скрипты.

Хром для тестов: `~/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome`
(SwiftShader, `--headless=new --no-sandbox --disable-gpu-sandbox --enable-unsafe-swiftshader
--use-angle=swiftshader`). Отчёт страница отдаёт сама через `window.__hs` в
`<pre id="report">`.

## Статус на 2026-11-04

- `node ar/sphere-push.test.mjs` → **all passed** (24/24).
- `node ar/page-test.mjs` → **12/12, exit 0** — уже на многофайловой раскладке; числа физики
  те же, что были у однофайловой сборки (лобовой `v=0.400`, резкий угол 26.3°, сжатие
  `Δ=5.8e-7`).
- 2026-11-04 же убраны `ar/build.mjs` и `ar/template.html`: страница больше не склеивается, а
  `ar-hands-sphere.html` с 625 КБ стал 5.6 КБ. Прежний однофайловый вариант (на случай, если
  всё-таки понадобится «принести одним файлом») —
  `/tmp/arhands/removed/ar-hands-sphere.single-file.html`, `sha256 ec6e39a0…9a65`; в каталоге
  его нет.

## Найденное про hand tracking в WebXR (проверено по спекам/MDN/исходникам, 2026-10-29)

- `requestSession('immersive-ar', {optionalFeatures:['local-floor','hand-tracking','dom-overlay'],
  domOverlay:{root:hud}})`. `isSessionSupported` НЕ принимает фичи — hand-tracking без открытия
  сессии не проверить; реальный состав фич читаем из `session.enabledFeatures`.
- `XRHand` = 25 суставов в фиксированном порядке спеки (`wrist`, затем по 4/5 на палец, у
  большого нет `*-phalanx-intermediate`), обход `for (const [name, space] of hand)`.
  Поза — `frame.getJointPose(space, refSpace)` → `transform` + `radius` (радиус сустава в
  метрах — готовый радиус коллизии). `getJointAngles`/`jointAxes` в спеке НЕТ.
  Оси: `-Z` вдоль кости к кончикам, `-Y` из ладони наружу.
- `frame.fillPoses(hand.values(), refSpace, Float32Array(16*25))` + `fillJointRadii` — быстрый
  путь без аллокаций, НО отказывает на всю кисть, если не оттрекан хоть один сустав ⇒ нужен
  запасной путь поштучный (в `app.js` есть).
- Порядок `inputSources` не гарантирован, поэтому базовый слот (0 / 25) вешается на сам объект
  `XRInputSource` через `Map`, а пропавшая рука заливается NaN — иначе скорость сустава
  считается через «телепорт».
- `local-floor` в `immersive-ar` законен, но всегда требует согласия: просим optional и при
  отказе `setSession` падаем на `local` (тогда без пола).
- `renderer.xr.getReferenceSpace()` в r128 отдаёт ТУ ЖЕ систему отсчёта, что и рендер ⇒ позы
  суставов можно класть в позицию объекта сцены напрямую.
- Passthrough требует `new THREE.WebGLRenderer({alpha:true})` и `scene.background = null`
  (Color-фон ставит clear alpha = 1 и гасит камеру).
- `dom-overlay` на Quest не подтверждён: проверять `session.domOverlayState`, а управления
  дублировать жестами — `select` (щипок) и `squeeze` (кулак) на самой сессии.

## Как разрабатывать VR-приложения: three.js r128 + WebXR

- UMD-сборка r128 **не содержит** `VRButton` (он только в `examples/jsm`), нет
  `xr.setFoveation` (r131) и `xr.cameraAutoUpdate` (r129) → кнопка входа в VR своя.
- `renderer.xr.enabled=true` обязателен, иначе `render()` игнорирует XR.
  `xr.setSession()` в r128 **async** — ошибки ловить через `.then(a,b)`.
- Поза головы пишется в `camera.matrix` **относительно родителя камеры** ⇒ нужен долли
  (`Group` с камерой); `camera.position` в XR = положение в системе отсчёта комнаты, а не в
  мире. Контроллеры/хват тоже вешать на долли: их позы выдаются в системе отсчёта комнаты.
  `getController(i)` создавать ДО `setSession`, иначе события не привязываются к индексу;
  `event.data` — это `XRInputSource`; `matrixWorld` контроллера в кадре — на 1 кадр старше.
- `setReferenceSpaceType('local-floor')`, держать `local-floor` в `optionalFeatures` + фолбэк
  на `local` (при падении на `local` руками добавлять поправку на рост глаз, ~1.6 м).
- `setSize`/`setPixelRatio` во время сессии — no-op (с предупреждением); после выхода размер
  холста и `camera.aspect` восстанавливать вручную; `resize`-хэндлер guard'ить
  `if (renderer.xr.isPresenting) return;`.
- `near/far` камеры уходят в `depthNear/depthFar` со сдвигом в один кадр — не анимировать.
- Рендер-таргеты внутри XR-кадра портят картинку (до r133 слой байпассит bind-кэш);
  `shadowMap` работает, тень считается один раз за кадр. `antialias` слоя XR наследуется
  от конструктора рендерера.
- **xr-standard mapping** (источники: webxr-gamepads-module, реестр input-profiles):
  `axes[2]/[3]` — стик (у Quest `axes[0]/[1]` — нули), `axes[0]/[1]` — тачпад;
  кнопки: `0` trigger (аналог в `.value`), `1` squeeze, `2` клик тачпада, `3` клик стика,
  `4` A/X, `5` B/Y. Знак: положительное = вправо/вниз ⇒ «вперёд» = `-axes[3]`.
- Опрос контроллеров — `session.inputSources` (у `XRFrame` своего `inputSources` НЕТ);
  `Gamepad` мутируется на месте, события кнопок считать самому по прежнему состоянию.
- `dom-overlay` для `immersive-vr` фактически недоступен (AR-only) → интерфейс в сцену
  (CanvasTexture-панели: запястье, лист помощи, тост).
- Нужен защищённый контекст (`https://` или `localhost`); во фрейме —
  `allow="xr-spatial-tracking"`, иначе `SecurityError`. `isSessionSupported` не должен
  показывать промптов; `requestSession` — только из обработчика клика.

## Как проверять WebXR без шлема (переносимые грабли)

1. **SwiftShader рендерит ~1 кадр за секунды** → `clock.getDelta()` непригоден. В тестах
   `renderer.render=function(){}`, часы заменяются на `getDelta()===1/60`, кадры шагаются
   вручную (`__hs.step(n)`).
2. **Для скриншотов так нельзя**: `preserveDrawingBuffer:false`, поэтому кадр, отрисованный
   вне реального rAF, на снимке чёрный. Съёмка — только боевым циклом rAF.
3. **Код внутри IIFE**: скрипт, дописанный перед `</body>`, не видит внутренние переменные —
   поэтому наружу заранее экспортируется `window.__hs` (`world`, `info()`, `step(n, fill)`,
   `cfg()`, `setMode()`), и тесты работают только через него.
4. Живые обработчики висят на `document` → события шлёт на `document` c `bubbles:true`
   (в `page-test.mjs` это `PointerEvent` на canvas с `bubbles:true`).
5. У синтетического `mousemove` `movementX=0` — годится только запасной путь обзора/курсора по
   `clientX/clientY`.
6. Иммерсивную сессию headless-Chrome не даёт (`navigator.xr.isSessionSupported` → false).
   Логику проверяют на **фейковой** сессии: объект `{inputSources:[{handedness,
   gamepad:{axes,buttons}}]}` в замыкаемую переменную сессии + `renderer.xr.isPresenting=true`,
   `connected` на контроллерах вызывается вручную. Покрывает игровую логику, но НЕ реальный
   XR-слой — живой тест на шлеме обязателен. Здесь вместо фейковой сессии физику гоняют через
   `__hs.setMode('none')` + `__hs.step(n, fillFn)`: руки задаются массивом `x,y,z,r` на сустав.

## Известные ограничения (не баги)

- Перетаскивания/хвата нет — только выталкивание (просили именно его).
- При двустороннем сжатии двумя руками перекрытие геометрии неизбежно: сфера встаёт посередине.
- В шлеме без `dom-overlay` интерфейс — только жесты.

## Что осталось (по приоритету)

1. Живой тест на шлеме: HTTPS (или `localhost`), раздать каталог целиком (страницу + `ar/`),
   реальный `hand-tracking`, состав `session.enabledFeatures`, читаемость жестикуляции, FPS.
2. Решить, нужен ли свой репозиторий/`.git` для этого каталога (сейчас файлов в git нет;
   `ar/three-r128.min.js` — 589 КБ бинароподобного вендора, для git это ок, но можно и в
   LFS/отдельный tarball).
