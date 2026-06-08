# obsync Community Edition

[Русская версия](README.ru.md)

[![License: AGPL-3.0-only](https://img.shields.io/badge/license-AGPL--3.0--only-blue.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-1.6.8-green.svg)](server/package.json)

Self-hosted sync server for the obsync Obsidian plugin.

## Requirements

- Docker Engine or Docker Desktop.
- Docker Compose.
- Git.
- HTTPS domain for sync outside a local network.

## Server Install

Clone the repository:

```bash
git clone https://github.com/obsyncteam/obsync-ce.git
cd obsync-ce
```

Create `.env`:

```bash
cp .env.example .env
```

Set values. Use real random strings and do not leave empty values:

```env
OBSYNC_POSTGRES_PASSWORD=<random PostgreSQL password, at least 16 characters>
OBSYNC_AUTH_TOKEN=<random token at least 32 characters long>
OBSYNC_PORT=4444
OBSYNC_STORAGE_QUOTA_BYTES=0
OBSYNC_ALLOWED_ORIGINS=
```

Start:

```bash
docker compose up -d --build
```

Check:

```bash
docker compose ps
curl http://127.0.0.1:4444/ready
```

Expected ready response:

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

## Environment

`compose.yml` builds `obsync-server:1.6.8` from `./server` and starts PostgreSQL 16.

| Variable | Required | Description |
| --- | --- | --- |
| `OBSYNC_POSTGRES_PASSWORD` | yes | PostgreSQL password used by the compose stack. Use a random value at least 16 characters long. |
| `OBSYNC_AUTH_TOKEN` | yes | Shared plugin token. Use a long random value. |
| `OBSYNC_PORT` | no | Host port mapped to `127.0.0.1:4444`. Default: `4444`. |
| `OBSYNC_STORAGE_QUOTA_BYTES` | no | Storage quota in bytes. `0` disables the quota. |
| `OBSYNC_ALLOWED_ORIGINS` | no | Comma-separated origins for browser CORS access. CORS is closed by default. |

## S3 Storage

Leave S3 variables empty for local filesystem storage.

| Variable | Description |
| --- | --- |
| `OBSYNC_S3_ENDPOINT` | S3-compatible endpoint, for example MinIO. |
| `OBSYNC_S3_REGION` | S3 region. |
| `OBSYNC_S3_BUCKET` | Bucket name. |
| `OBSYNC_S3_ACCESS_KEY_ID` | Access key. |
| `OBSYNC_S3_SECRET_ACCESS_KEY` | Secret key. |
| `OBSYNC_S3_FORCE_PATH_STYLE` | Use `true` for MinIO-style endpoints. |

## Data

Default Docker volumes:

- `postgres-data`: PostgreSQL data.
- `obsync-data`: synced file content and upload staging.

Back up both volumes.

## Reverse Proxy

For public or mobile access, proxy an HTTPS domain to the server.

Forward these paths:

```text
/health
/ready
/api/v1/
/sync
```

`/sync` must support WebSocket upgrade.

Example plugin URL:

```text
https://sync.example.com
```

Do not use `127.0.0.1` on a phone.

## Obsidian Plugin

Plugin repository:

```text
https://github.com/obsyncteam/obsync-plugin
```

### Install From Release

Download the plugin archive from releases:

```text
https://github.com/obsyncteam/obsync-plugin/releases
```

Release zip name format:

```text
obsync_vX.Y.Z.zip
```

Archive structure:

```text
obsync/main.js
obsync/manifest.json
obsync/styles.css
```

Extract it into the vault plugins directory:

```text
<vault>/.obsidian/plugins/obsync/main.js
<vault>/.obsidian/plugins/obsync/manifest.json
<vault>/.obsidian/plugins/obsync/styles.css
```

Use the version from the plugin repository `manifest.json` in release archive names.

### Build From Source

Build:

```bash
git clone https://github.com/obsyncteam/obsync-plugin.git
cd obsync-plugin
npm ci
npm run build
```

Install:

```bash
mkdir -p /path/to/vault/.obsidian/plugins/obsync
cp main.js manifest.json styles.css /path/to/vault/.obsidian/plugins/obsync/
```

After installing either way, restart Obsidian or reload the app. Enable obsync in Community plugins.

## Plugin Settings

| Setting | Description |
| --- | --- |
| `Server URL` | Base URL of the sync server. |
| `Auth token` | Same value as `OBSYNC_AUTH_TOKEN`. |
| `Device name` | Stable label: `pc`, `phone`, `laptop`. |
| `Vault name` | Same vault name on all devices. |
| `Sync attachments` | Binary file sync. |
| `Sync .obsidian` | Obsidian configuration sync. Keep off until note sync is checked. |
| `Max file size` | Files above this value are skipped. |

## First Device

Use the device that already has the vault content.

Settings:

```text
Server URL: https://sync.example.com
Auth token: value from OBSYNC_AUTH_TOKEN
Device name: pc
Vault name: my-vault
Sync attachments: on
Sync .obsidian: off
```

Click `Sync`. Wait until initial indexing finishes.

## Additional Devices

Use an empty or test vault.

Settings:

```text
Server URL: https://sync.example.com
Auth token: value from OBSYNC_AUTH_TOKEN
Device name: phone
Vault name: same vault name as the first device
Sync attachments: on
```

Click `Sync`. Wait until the initial download succeeds.

## Change History

`Open note history` shows Markdown versions retained by the server.

For Markdown conflicts, obsync leaves the local note unchanged. Open history, compare versions and restore the version to keep. Binary conflicts can create conflict copies.

## Update

```bash
git pull
docker compose up -d --build
```

## Safety

- Back up the vault before the first sync.
- Check note and attachment sync before enabling `.obsidian` sync.
- Keep the same `Vault name` on every device.

## License

obsync Community Edition is licensed under `AGPL-3.0-only`.

The full license text is in [LICENSE](LICENSE).

You can:

- run obsync Community Edition on your own server;
- use it to sync Obsidian vaults;
- read and modify the source code;
- share copies of the software;
- publish modified versions under the same license terms.

obsync includes a server component. `AGPL-3.0-only` has network-use requirements.

If you modify the server and provide access to the modified version over a network, users of that service must be able to receive the corresponding source code under the AGPL terms.

Third-party dependency license metadata is listed in package manager files included in this repository.
