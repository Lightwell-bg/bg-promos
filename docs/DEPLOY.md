# Выкатка этапа 2 на VPS

Этап 2 добавляет два сервиса Docker Compose: `api` (FastAPI, порт 8001 на loopback) и `web` (nginx со статикой PWA и прокси `/api/`, порт 8002 на loopback). Сервис `collector` и cron сборщика **не трогаем**.

Схема:

```
браузер --HTTPS--> host nginx (promos.centerai.eu) --> 127.0.0.1:8002 (контейнер web)
                                                          |-- статика и prerender-страницы
                                                          '-- /api/ --> контейнер api:8001 --> SQLite (data/, WAL)
```

> Шаги раздела 5 (nginx и сертификат на хосте) выполняет **только владелец сервера и только после согласования**. Все серверные команды выполняются по ключу SSH, который уже настроен; пароли в чат не отправлять.

## 0. Что нужно подготовить заранее

- Telegram-бот и chat id (раздел 6): без них форма «Сообщить об ошибке» отвечает 503, остальное работает.
- Measurement ID Google Analytics 4 (раздел 7): без него аналитика и баннер согласия полностью отключены.
- DNS: `promos.centerai.eu` указывает на IP сервера. Проверка с вашей машины и на сервере:
  ```bash
  dig +short promos.centerai.eu
  curl -s https://ifconfig.me ; echo
  ```
  Адреса должны совпадать (если домен только что мигрировал, сверьтесь с этим документом, а не с памятью или `~/.ssh/config`).

## 1. Проверить, что порты свободны (на сервере)

```bash
ss -ltnp | grep -E ':8001|:8002'
```

Вывод должен быть пустым. Если порт занят чужим процессом, сначала разберитесь с ним, а не меняйте чужие сервисы.

## 2. Обновить код и настройки (на сервере)

```bash
cd /opt/bg-promos
git pull
```

Добавьте в `.env` (файл не коммитится; значения из раздела 6):

```
TELEGRAM_BOT_TOKEN=123456:ABC...
TELEGRAM_CHAT_ID=-1001234567890
```

Если переменные уже есть в `.env`, ничего не меняйте. Не затирайте существующие значения.

В `config.ini` в секции `[web]` укажите Measurement ID (раздел 7). Пустое значение отключает аналитику:

```ini
[web]
ga4_id = G-XXXXXXXXXX
```

Остальные ключи `[web]`, `[brochures]`, `[offers_urls]` уже заполнены в репозитории.

### 2a. Внутренняя аналитика и /admin (новые переменные)

Добавьте в `.env` на сервере (шаблон — `.env.example`; существующие значения не трогайте):

```
ANALYTICS_SECRET=<вывод команды ниже>
ADMIN_PASSWORD=<ваш пароль для /admin>
```

Секрет генерируется так (один раз; при смене анонимные посетители начнут считаться новыми):

```bash
python -c "import secrets;print(secrets.token_hex(32))"
```

Пустой `ANALYTICS_SECRET` = случайный на каждый запуск (в логе предупреждение). Пустой `ADMIN_PASSWORD` = `/admin` выключен (API отвечает 404). В `config.ini [web]` появились `clarity_id` (пусто = Clarity выключен), `analytics_enabled = true`, `admin_cookie_secure = true`. Сервису `bot` теперь нужен том `./data:/app/data` (уже есть в `docker-compose.yml`): бот пишет `bot_start` в `data/analytics.sqlite3`. После обновления пересоздайте `api`, `web` и `bot`: `docker compose up -d --build --force-recreate api web bot`. Подробности — `docs/ANALYTICS.md`, раздел Operations.

## 3. Собрать и запустить api и web (на сервере)

```bash
cd /opt/bg-promos
docker compose build api web
docker compose up -d --force-recreate api web
```

`docker compose build api web` собирает только образы `bg-promos-api` и `bg-promos-web`. У сервиса `api` свой тег образа, поэтому образ сборщика `bg-promos-collector` не пересобирается и не перетегируется: cron продолжает запускать ту же версию сборщика. Сервис `collector` не запускается (он одноразовый, запускается из cron). Команды вида `docker compose up -d` без имён сервисов не используйте.

`--force-recreate` нужен, чтобы контейнеры перечитали `config.ini` и `.env` (они читаются при старте): после любого их изменения и после `git pull` пересоздавайте `api web`.

### 3a. Обновление сборщика (нужно для категорий Lidl; только с разрешения владельца)

Необязательный отдельный шаг. Он затрагивает работающий сборщик, поэтому выполняйте его только с разрешения владельца сервера:

```bash
cd /opt/bg-promos
docker compose build collector
```

Строка cron не меняется (`docker compose run --rm collector collect --scheduled`). Что изменится: при следующем запуске сборщик сохранит путь категории Lidl, и категории Lidl в каталоге станут точнее. Пока сборщик не обновлён и не отработал, API определяет категории Lidl по ключевым словам в названии.

## 4. Проверки (на сервере)

```bash
docker compose ps
curl -s http://127.0.0.1:8001/api/health
curl -I http://127.0.0.1:8002/
curl -s http://127.0.0.1:8002/api/health
curl -s http://127.0.0.1:8002/api/v1/config
curl -I http://127.0.0.1:8002/bg/c/produce
ls -l data/
```

Ожидается:

- `/api/health` отвечает `{"status":"ok","db":true}` и на 8001, и через web на 8002;
- `curl -I http://127.0.0.1:8002/` отвечает `200` и содержит заголовки `Content-Security-Policy` и `X-Content-Type-Options`;
- `/bg/c/produce` отвечает `200` (prerender-страница);
- WAL: в `data/` есть `bg_promos.sqlite3-wal` и `bg_promos.sqlite3-shm`, владелец uid `1000` (как у collector). Если файлов нет, это нормально до первой записи сборщика в режиме WAL; если владелец `root`, выполните `sudo chown -R 1000:1000 data` и перезапустите `api`.

Откат: `docker compose stop web api` (сборщик и cron продолжают работать).

## 5. Nginx на хосте (только владелец, только после согласования)

Проверить, есть ли сертификат:

```bash
sudo ls /etc/letsencrypt/live/promos.centerai.eu/
```

**Если сертификата нет**, сначала создайте HTTP-блок `/etc/nginx/sites-available/promos.centerai.eu` (только порт 80), включите его и выпустите сертификат. Certbot сам допишет блок HTTPS и редирект:

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name promos.centerai.eu;
    client_max_body_size 16k;
    gzip off;
    location / {
        proxy_pass http://127.0.0.1:8002;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/promos.centerai.eu /etc/nginx/sites-enabled/promos.centerai.eu
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d promos.centerai.eu
```

**Если сертификат уже есть**, используйте итоговый блок (HTTP -> HTTPS, пути Let's Encrypt, всё проксируется в контейнер web; gzip выключен, потому что сжатие делает апстрим):

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name promos.centerai.eu;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name promos.centerai.eu;

    ssl_certificate     /etc/letsencrypt/live/promos.centerai.eu/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/promos.centerai.eu/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;

    client_max_body_size 16k;
    gzip off;
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;

    location / {
        proxy_pass http://127.0.0.1:8002;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Применить и проверить:

```bash
sudo ln -sf /etc/nginx/sites-available/promos.centerai.eu /etc/nginx/sites-enabled/promos.centerai.eu
sudo nginx -t && sudo systemctl reload nginx
curl -I https://promos.centerai.eu/
curl -s https://promos.centerai.eu/api/health
curl -s https://promos.centerai.eu/sitemap.xml | head -5
```

Адрес клиента: host nginx **перезаписывает** `X-Forwarded-For` значением `$remote_addr` (подделанный клиентом заголовок отбрасывается), контейнер web дописывает адрес своего соседа (`$proxy_add_x_forwarded_for`), а API идёт по цепочке справа налево и пропускает адреса из `trusted_proxies` (`config.ini [web]`, по умолчанию `127.0.0.1`, `::1`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`); первый недоверенный адрес считается клиентом. Если `trusted_proxies` пуст, в логе API при старте будет предупреждение, а все отчёты будут приписаны адресу прокси.

HSTS (`Strict-Transport-Security`) выставляет только host nginx в блоке 443; контейнер web его не отправляет.

## 6. Telegram-бот для сообщений об ошибках

1. В Telegram откройте `@BotFather`, отправьте `/newbot`, задайте имя и username бота. BotFather пришлёт токен вида `123456:ABC...` (документация: https://core.telegram.org/bots#how-do-i-create-a-bot).
2. Напишите любое сообщение своему боту (или добавьте бота в группу и напишите там).
3. Откройте в браузере `https://api.telegram.org/bot<ТОКЕН>/getUpdates` (подставьте свой токен) и найдите `"chat":{"id": ...}`. У групп id отрицательный. Если список пустой, отправьте боту ещё одно сообщение.
4. Впишите токен и id в `.env` на сервере (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`), затем `docker compose up -d --force-recreate api web`.
5. Проверка: на сайте нажмите «Сообщить об ошибке», отправьте тестовое сообщение (не раньше 3 секунд после открытия формы). Сообщение придёт в чат бота.

Токен храните только в `.env`; в репозиторий и в чат он не попадает.

## 7. Google Analytics 4: свойство и Measurement ID

1. Откройте https://analytics.google.com, войдите в аккаунт Google.
2. Admin (шестерёнка) -> Create -> Property. Название: `BG Promos`, часовой пояс и валюта: Болгария / EUR.
3. Создайте поток данных: Data streams -> Add stream -> Web, адрес `https://promos.centerai.eu`.
4. Скопируйте **Measurement ID** вида `G-XXXXXXXXXX`.
5. Admin -> Data collection and modification -> Data retention: поставьте 14 месяцев (так написано в политике конфиденциальности). Отключите Google signals и рекламные функции.
6. Впишите ID в `config.ini`, секция `[web]`, ключ `ga4_id`, затем `docker compose up -d --force-recreate api web` (команда из раздела 3). Баннер согласия появится только когда ID задан; до согласия посетителя ничего от Google не загружается.

Документация: https://support.google.com/analytics/answer/9304153

## 8. Обновление в дальнейшем

```bash
cd /opt/bg-promos
git pull
docker compose build api web
docker compose up -d --force-recreate api web
curl -s http://127.0.0.1:8001/api/health
curl -I http://127.0.0.1:8002/
```

Тексты правовых страниц (`web/src/content/legal/`) являются шаблоном, а не юридической консультацией: перед публичным запуском их стоит показать юристу.
