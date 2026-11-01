# Jamur Janggel Monitor Backend

REST API, PostgreSQL/Prisma persistence, InfluxDB sensor history, MQTT bridge, and authenticated Socket.IO events for the Flutter application.

## Requirements

- Node.js 20 or newer and npm
- PostgreSQL
- InfluxDB 2.x (required for sensor-history persistence/query)
- An MQTT broker that supports MQTT over TLS (EMQX Cloud)

## 1. Install

```powershell
npm install
Copy-Item .env.example .env
```

Edit `.env` with your own credentials. `DATABASE_URL` and a random `JWT_SECRET` of at least 32 characters are required. Do not commit `.env` or share broker/database credentials. Configure the MQTT username and password in your private environment; they are intentionally blank in `.env.example`.

## 2. Set up PostgreSQL

Create the database named `jamur_monitor`, then apply the checked-in initial migration and generate the client:

```powershell
npm run db:deploy
npm run db:generate
```

Create one `Node` row per physical device in Prisma Studio (`npm run db:studio`) or through your provisioning process. `Node.nodeId` is the globally unique hardware ID used in MQTT topics; the application currently shares active Node 1–2 with every authenticated account. Node configuration edits remain restricted to the database owner. New accounts receive default settings, but nodes are provisioned separately.

For local schema changes, use `npm run db:migrate` to create and apply a migration. In production, use `npm run db:deploy`; do not run development migrations.

### Reset all accounts (destructive)

Only use this recovery utility after creating and verifying a database backup. It deletes every account and, through database cascades, all nodes and their logs, schedules, notifications, settings, and password-reset tokens. Sensor history stored separately in InfluxDB is not deleted. The new admin account does not automatically own any nodes; provision or assign nodes separately afterward.

Run from the project directory and provide the replacement admin email and name:

```powershell
npm run db:reset-accounts -- admin@gmail.com adminjamur
```

The utility displays the target database, requires confirmation that a backup exists, requires typing the destructive action explicitly, and asks for the new password twice without echoing it. Use a unique password of at least 12 characters. Account deletion and admin creation run in one transaction; if creation fails, the deletion is rolled back. Never run this against production unless the production backup and recovery procedure have been verified.

## 3. Start the server

```powershell
npm run dev
# or
npm start
```

The API listens on `PORT` (default `3000`). Health check: `GET /health`. Interactive API documentation: `/api-docs`.

PostgreSQL and JWT configuration are required at startup. MQTT and InfluxDB are independently configured: the server logs when MQTT is disabled, sensor events can still be sent over Socket.IO without InfluxDB, and history requests return `503` until InfluxDB is configured. Schedule/manual pump control requires a connected MQTT broker.

## 4. Test the API

Run the automated tests with:

```powershell
npm test
```

Example administrator-created account and login:

```powershell
$api = "http://localhost:3000/api"
$body = @{ email = "user@example.com"; name = "Jamur User"; password = "change-this-password" } | ConvertTo-Json
$adminHeaders = @{ Authorization = "Bearer $adminToken" }
Invoke-RestMethod -Method Post -Uri "$api/auth/register" -Headers $adminHeaders -ContentType "application/json" -Body $body
$session = Invoke-RestMethod -Method Post -Uri "$api/auth/login" -ContentType "application/json" -Body $body
$headers = @{ Authorization = "Bearer $($session.data.token)" }
Invoke-RestMethod -Uri "$api/nodes" -Headers $headers
```

Only authenticated administrators can create accounts at `/api/auth/register`.
New accounts receive the `user` role and must log in separately. Login responses
contain the access token at `data.token`. Authenticated requests use
`Authorization: Bearer <token>`. Responses use `{ success, message, data, timestamp }`;
errors use `{ success, message, errors, timestamp }`.

## 5. Flutter integration

- Replace local authentication with `POST /api/auth/register`, `POST /api/auth/login`, and `GET /api/auth/me`.
- Creating accounts at `POST /api/auth/register` requires an authenticated administrator; new accounts are regular users.
- Any authenticated account can read the shared Node 1–2 and control the single master pump. Configuration edits remain restricted to each node’s database owner.
- Use the REST endpoints in `/api-docs` for nodes, sensor history, controls, schedules, notifications, profile, and settings. Node IDs in URLs are hardware IDs 1–2, not PostgreSQL row IDs.
- Connect using Socket.IO at the backend origin. Send the JWT in the handshake as `auth: { token: "<JWT>" }`; emit `subscribe:node` with `{ nodeId: 1 }` before listening for `sensor:update`, `node:status`, and `relay:status`. Listen for `notification:new` and `schedule:triggered` for account-wide notifications and subscribed-node schedules.
- Sensor and battery history support `from`, `to`, `aggregate=mean|max|min`, and `interval=5m|1h|1d`. If omitted, the range defaults to the previous 24 hours. Battery history is available at `GET /api/sensor/:nodeId/battery`.
- `POST /api/control/pompa` accepts `{ "duration": 10 }` in seconds (1–3600) and publishes the duration once to `jamur/pompa/perintah`. `POST /api/control/pompa/stop` publishes `0` to stop the master pump.

The backend, not the Flutter app, subscribes to the MQTT broker. It listens to `jamur/node{1..2}/soil`, `/suhu`, `/rh`, `/battery`, `/battery_percent`, `/status`, and `jamur/notifikasi`. Soil, temperature, relative humidity, battery voltage, and battery percentage use plain numeric MQTT payloads; battery percentage must be in the range 0–100. Status accepts `online`, `1`, `true`, or a JSON status value. Manual, scheduled, and automatic irrigation publish to the master topic `jamur/pompa/perintah`; mode remains `auto`/`manual` on `/mode` and JSON configuration on `/pengaturan`.

Authenticated MQTT diagnostics are available at `GET /api/debug/mqtt/status`, `GET /api/debug/mqtt/messages` (last 10 received messages), and `POST /api/debug/mqtt/publish`. The publish endpoint sends a harmless payload to the separately subscribed `jamur/debug/test` topic, so it verifies broker publish/receive without injecting sensor readings into a node. Sensor messages are logged with their topic and payload; TLS certificate validation is disabled only outside production and remains enabled in production.

Schedule `days` is a seven-character string ordered Sunday through Saturday (`1` means enabled), and its `time` is `HH:mm` in the server's local timezone. Keep one backend scheduler instance active; running multiple replicas will trigger matching schedules more than once. Scheduled and automatic watering are logged. The automatic mode currently uses a simple soil-moisture deficit heuristic with a five-minute in-memory cooldown, not a calibrated fuzzy controller.

Forgot-password email requires SMTP settings and `FRONTEND_RESET_URL`. Avatar uploads accept JPEG, PNG, WEBP, or GIF up to `MAX_AVATAR_SIZE_MB`; local uploads are served from `/uploads`.

## 6. Production deployment

1. Provision PostgreSQL, InfluxDB, and EMQX with TLS and restricted network access.
2. Set production environment variables through your deployment platform's secret manager. Use a unique high-entropy JWT secret, SMTP credentials if needed, and a specific `CORS_ORIGIN` (comma-separated origins; avoid `*` in production).
3. Run `npm ci`, `npm run db:generate`, and `npm run db:deploy`; then start with `npm start` under a process manager or container orchestrator.
4. Use HTTPS/WSS at a reverse proxy, persistent or object-backed avatar storage, monitored backups, and log/health-check collection. Do not expose database or MQTT credentials to Flutter.
5. Run only one scheduler worker. If scaling HTTP/WebSocket instances, move scheduling to a single dedicated worker or add distributed schedule locking before enabling multiple workers.

Sensor writes use the InfluxDB bucket `INFLUX_BUCKET`, measurement `sensor_data`, tags `node_id` and `user_id`, and fields `temperature`, `humidity`, `soil_moisture`, `battery_voltage`, and `battery_percent`.
