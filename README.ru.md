# obsync Community Edition

[English version](README.md)

[![Лицензия: AGPL-3.0-only](https://img.shields.io/badge/license-AGPL--3.0--only-blue.svg)](LICENSE)
[![Версия](https://img.shields.io/badge/version-1.6.8-green.svg)](server/package.json)

Сервер синхронизации для плагина obsync Obsidian.

## Требования

- Docker Engine или Docker Desktop.
- Docker Compose.
- Git.
- HTTPS-домен для синхронизации вне локальной сети.

## Установка сервера

Склонируйте репозиторий:

```bash
git clone https://github.com/obsyncteam/obsync-ce.git
cd obsync-ce
```

Создайте `.env`:

```bash
cp .env.example .env
```

Задайте значения. Используйте реальные случайные строки, не оставляйте пустые значения:

```env
OBSYNC_POSTGRES_PASSWORD=<случайный пароль PostgreSQL>
OBSYNC_AUTH_TOKEN=<случайный токен минимум 32 символа>
OBSYNC_PORT=4444
OBSYNC_STORAGE_QUOTA_BYTES=0
OBSYNC_ALLOWED_ORIGINS=
```

Запустите:

```bash
docker compose up -d --build
```

Проверьте:

```bash
docker compose ps
curl http://127.0.0.1:4444/ready
```

Ожидаемый ready-ответ:

```json
{
  "ok": true,
  "service": "obsync-server",
  "storage": {
    "metadata": "postgres",
    "blobs": "filesystem"
  }
}
```

## Переменные окружения

`compose.yml` собирает `obsync-server:1.6.8` из `./server` и запускает PostgreSQL 16.

| Переменная | Обязательная | Описание |
| --- | --- | --- |
| `OBSYNC_POSTGRES_PASSWORD` | да | Пароль PostgreSQL для compose-стека. |
| `OBSYNC_AUTH_TOKEN` | да | Общий токен плагина. Используйте длинное случайное значение. |
| `OBSYNC_PORT` | нет | Порт хоста, проброшенный на `127.0.0.1:4444`. По умолчанию `4444`. |
| `OBSYNC_STORAGE_QUOTA_BYTES` | нет | Квота хранилища в байтах. `0` отключает квоту. |
| `OBSYNC_ALLOWED_ORIGINS` | нет | Список origins через запятую для браузерного CORS-доступа. По умолчанию CORS не открыт. |

## S3-хранилище

Оставьте S3-переменные пустыми для локального хранения файлов.

| Переменная | Описание |
| --- | --- |
| `OBSYNC_S3_ENDPOINT` | S3-совместимый endpoint, например MinIO. |
| `OBSYNC_S3_REGION` | S3-регион. |
| `OBSYNC_S3_BUCKET` | Имя bucket. |
| `OBSYNC_S3_ACCESS_KEY_ID` | Ключ доступа. |
| `OBSYNC_S3_SECRET_ACCESS_KEY` | Секретный ключ. |
| `OBSYNC_S3_FORCE_PATH_STYLE` | Используйте `true` для endpoints в стиле MinIO. |

## Данные

Стандартные Docker volumes:

- `postgres-data`: данные PostgreSQL.
- `obsync-data`: содержимое синхронизируемых файлов и временные загрузки.

Делайте резервную копию обоих volumes.

## Reverse Proxy

Для публичного или мобильного доступа проксируйте HTTPS-домен на сервер.

Пути:

```text
/health
/ready
/api/v1/
/sync
```

`/sync` должен поддерживать WebSocket upgrade.

Пример URL в плагине:

```text
https://sync.example.com
```

Не используйте `127.0.0.1` на телефоне.

## Плагин Obsidian

Репозиторий плагина:

```text
https://github.com/obsyncteam/obsync-plugin
```

### Установка из release

Скачайте архив плагина из releases:

```text
https://github.com/obsyncteam/obsync-plugin/releases
```

Формат имени архива:

```text
obsync_vX.Y.Z.zip
```

Структура архива:

```text
obsync/main.js
obsync/manifest.json
obsync/styles.css
```

Распакуйте архив в папку плагинов хранилища:

```text
<хранилище>/.obsidian/plugins/obsync/main.js
<хранилище>/.obsidian/plugins/obsync/manifest.json
<хранилище>/.obsidian/plugins/obsync/styles.css
```

Используйте версию из `manifest.json` репозитория плагина в именах релизных архивов.

### Сборка из исходников

Соберите:

```bash
git clone https://github.com/obsyncteam/obsync-plugin.git
cd obsync-plugin
npm ci
npm run build
```

Установите:

```bash
mkdir -p /path/to/vault/.obsidian/plugins/obsync
cp main.js manifest.json styles.css /path/to/vault/.obsidian/plugins/obsync/
```

После установки любым способом перезапустите Obsidian или перезагрузите приложение. Включите obsync в Community plugins.

## Настройки плагина

| Настройка | Описание |
| --- | --- |
| `Server URL` | Базовый URL сервера синхронизации. |
| `Auth token` | То же значение, что `OBSYNC_AUTH_TOKEN`. |
| `Device name` | Стабильная метка: `pc`, `phone`, `laptop`. |
| `Vault name` | Одинаковое имя хранилища на всех устройствах. |
| `Sync attachments` | Синхронизация бинарных файлов. |
| `Sync .obsidian` | Синхронизация конфигурации Obsidian. Держите выключенной до проверки заметок. |
| `Max file size` | Файлы выше этого значения пропускаются. |

## Первое устройство

Используйте устройство с исходным содержимым хранилища.

Настройки:

```text
Server URL: https://sync.example.com
Auth token: значение OBSYNC_AUTH_TOKEN
Device name: pc
Vault name: my-vault
Sync attachments: on
Sync .obsidian: off
```

Нажмите `Sync`. Дождитесь завершения начальной индексации.

## Дополнительные устройства

Используйте пустое или тестовое хранилище.

Настройки:

```text
Server URL: https://sync.example.com
Auth token: значение OBSYNC_AUTH_TOKEN
Device name: phone
Vault name: то же имя хранилища, что на первом устройстве
Sync attachments: on
```

Нажмите `Sync`. Дождитесь успешного начального скачивания.

## История изменений

`Open note history` показывает Markdown-версии, сохраненные сервером.

При Markdown-конфликтах obsync оставляет локальную заметку без изменений. Откройте историю, сравните версии и восстановите нужную. Бинарные конфликты могут создавать conflict copies.

## Обновление

```bash
git pull
docker compose up -d --build
```

## Безопасность

- Сделайте резервную копию хранилища перед первой синхронизацией.
- Проверьте синхронизацию заметок и вложений до включения `.obsidian`.
- Используйте одинаковый `Vault name` на всех устройствах.

## Лицензия

obsync Community Edition распространяется под лицензией `AGPL-3.0-only`.

Полный текст лицензии находится в [LICENSE](LICENSE).

Вы можете:

- запускать obsync Community Edition на своем сервере;
- использовать ее для синхронизации хранилищ Obsidian;
- читать и изменять исходный код;
- передавать копии программы;
- публиковать измененные версии на условиях той же лицензии.

obsync включает серверный компонент. У `AGPL-3.0-only` есть требования для сетевого использования.

Если вы изменили сервер и предоставляете пользователям доступ к измененной версии по сети, пользователи сервиса должны иметь возможность получить соответствующий исходный код на условиях AGPL.

Лицензии сторонних зависимостей указаны в package manager файлах, включенных в этот репозиторий.
