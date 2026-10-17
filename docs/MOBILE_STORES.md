# Упаковка в магазины приложений (план на будущее)

Статус: **не реализовано**, SDK не устанавливались. Документ описывает, как упаковать готовое PWA (`web/`) для Google Play и App Store, не переписывая приложение.

## Что уже подготовлено в коде

- Веб-часть не зависит от окружения напрямую: всё платформенное вынесено в `web/src/platform/`:
  | Файл | Что делает в вебе | Что подменить в нативной оболочке |
  |---|---|---|
  | `storage.ts` | IndexedDB (idb-keyval) с запасным вариантом в памяти | Capacitor Preferences / Filesystem |
  | `openExternal.ts` | `window.open` | Capacitor Browser |
  | `share.ts` | Web Share API или копирование ссылки | Capacitor Share |
  | `analytics.ts`, `ga.ts` | GA4 с согласием | отключён в оболочках (`isNativeShell()`); позже можно подключить Firebase Analytics |
  | `installPrompt.ts`, `InstallHint` | подсказка «Установить» | скрыть (в оболочке не нужна) |
  | `lifecycle.ts` | `visibilitychange`, Escape | события Capacitor App (resume, backButton) |
  | `env.ts` | определение платформы (`isNativeShell()` по `window.Capacitor`) | без изменений |
- API-адрес: переменная сборки `VITE_API_BASE`. Пустая означает тот же origin (прокси `/api/`). Для оболочек задаётся абсолютный адрес `https://promos.centerai.eu`.
- CORS на сервере уже разрешает `capacitor://localhost` и `https://localhost` (`config.ini [web] cors_origins`).
- Сервис-воркер регистрируется только в вебе (`main.tsx`, `isNativeShell()`).

## Android: Trusted Web Activity (Bubblewrap)

TWA открывает ваш сайт в полноэкранном Chrome без адресной строки. Подходит, потому что PWA уже установочное (манифест, иконки any и maskable, офлайн).

1. Установить Node 22, JDK 17 и Android SDK (Bubblewrap предложит скачать сам): `npm i -g @bubblewrap/cli`.
2. Инициализация по манифесту:
   ```bash
   mkdir android && cd android
   bubblewrap init --manifest=https://promos.centerai.eu/manifest.webmanifest
   ```
   Идентификатор пакета: например `eu.centerai.bgpromos` (после публикации менять нельзя).
3. Ключ подписи: Bubblewrap создаёт `android.keystore` при `init`. **Сохраните keystore и пароли вне репозитория** (резервная копия обязательна: потеря ключа закрывает возможность обновлять приложение). Лучше включить Play App Signing: тогда Google хранит ключ подписи, а у вас остаётся ключ загрузки.
4. Digital Asset Links: получить отпечаток SHA-256 ключа, которым Google подписывает приложение (Play Console -> Setup -> App signing -> App signing key certificate), и опубликовать файл `https://promos.centerai.eu/.well-known/assetlinks.json`:
   ```json
   [{
     "relation": ["delegate_permission/common.handle_all_urls"],
     "target": {
       "namespace": "android_app",
       "package_name": "eu.centerai.bgpromos",
       "sha256_cert_fingerprints": ["AA:BB:...:FF"]
     }
   }]
   ```
   Файл кладётся в `web/public/.well-known/assetlinks.json` (попадёт в `dist/` и в контейнер web). В `web/nginx.conf` отдельная правка не нужна: путь отдаётся как статический файл (проверьте `curl -s https://promos.centerai.eu/.well-known/assetlinks.json` и `Content-Type: application/json`). Без валидного файла TWA покажет адресную строку.
5. Сборка: `bubblewrap build` создаёт `app-release-bundle.aab` (для Play) и `.apk` (для проверки). Проверка на устройстве: `bubblewrap install`.
6. Google Play Console (разовая плата разработчика, личный или организационный аккаунт):
   - создать приложение, загрузить `.aab`;
   - карточка: название, краткое и полное описание (bg и ru), скриншоты телефона (минимум 2), иконка 512x512, feature graphic 1024x500;
   - анкета Data safety: данные собираются только с согласия (GA4), форма ошибок отправляет текст сообщения; ссылка на политику конфиденциальности `https://promos.centerai.eu/bg/legal/privacy`;
   - возрастной рейтинг, целевая аудитория (не детская), контактный email `info@centerai.eu`;
   - для новых личных аккаунтов Google требует закрытое тестирование (минимум 12 тестеров на 14 дней) перед выходом в production; проверьте актуальные правила в Play Console.
7. Обновления контента не требуют новой версии приложения: TWA показывает сайт. Новая версия `.aab` нужна только при смене пакета, иконок или `targetSdk`.

## iOS: Capacitor

На iOS нет TWA, поэтому нужна нативная оболочка с WKWebView. Требуются Mac с Xcode и Apple Developer Program (платная подписка).

1. Установка (в `web/`, не сейчас):
   ```bash
   npm i @capacitor/core @capacitor/cli @capacitor/ios @capacitor/preferences @capacitor/filesystem @capacitor/browser @capacitor/share
   npx cap init "BG Promos" eu.centerai.bgpromos --web-dir=dist
   ```
2. Сборка веба для оболочки с абсолютным API:
   ```bash
   VITE_API_BASE=https://promos.centerai.eu npm run build
   npx cap add ios
   npx cap copy ios      # копирует web/dist в нативный проект
   npx cap open ios      # Xcode: подпись, иконки, запуск
   ```
   Prerender-страницы и sitemap в оболочке не используются, но не мешают.
3. Адаптеры в `web/src/platform/` (интерфейсы уже выделены):
   - `storage.ts`: реализовать `KeyValueStorage` поверх `Preferences` (мелкие значения) и `Filesystem` (кеш каталога, он большой); подставить вместо `createIdbStorage()`;
   - `openExternal.ts`: `Browser.open({ url })`;
   - `share.ts`: `Share.share({ title, url })`;
   - `analytics.ts`: оставить no-op (`isNativeShell()` уже отключает GA4 и баннер согласия); при желании позже добавить Firebase Analytics с отдельным согласием и обновить политику конфиденциальности;
   - `installPrompt.ts`: подсказка скрывается, так как `isNativeShell()` истинно.
4. Сервер: убедиться, что `cors_origins` содержит `capacitor://localhost` (уже есть). Запросы идут на `https://promos.centerai.eu/api/...` с этим Origin.
5. App Store Connect: иконка 1024x1024 без прозрачности, скриншоты, описание (bg/ru), политика конфиденциальности (URL), анкета App Privacy (согласно разделу о данных в политике), поддержка `info@centerai.eu`.

### Риск отказа по правилу 4.2 (Minimum Functionality)

Apple отклоняет приложения, которые являются просто упакованным сайтом. Как снизить риск:

- добавить нативные функции: push-уведомления об окончании акций и о новых предложениях любимой сети (APNs), виджет «лучшие скидки», Spotlight/Shortcuts для поиска, Share Sheet, Haptics;
- работать офлайн: кеш каталога на диске (`Filesystem`), корректные экраны без сети (в вебе это уже сделано);
- приложение должно запускаться и выглядеть как нативное: свой экран запуска, иконка, безопасные зоны (`env(safe-area-inset-*)` уже учтены), без видимого «браузерного» интерфейса;
- не отправлять пользователя на сайт для основной функции: каталог, поиск и фильтры работают внутри приложения;
- в заметках для проверяющих (App Review Notes) описать функции и приложить демо-сценарий;
- ссылки на сайты сетей открывать через `Browser` и пояснить, что приложение не связано с торговыми сетями (см. условия использования).

Если отказ всё же придёт, ответить в Resolution Center, указав нативные функции, и при необходимости добавить ещё одну (например, push).

## Порядок работ и оценка

1. Android TWA: 1-2 дня работы плюс ожидание проверки Google (закрытое тестирование, если аккаунт личный).
2. iOS Capacitor: 3-5 дней (адаптеры, push, проверка на устройстве) плюс проверка Apple (обычно несколько дней).
3. Перед обоими: показать тексты правовых страниц юристу (`web/src/content/legal/` является шаблоном, не юридической консультацией).
