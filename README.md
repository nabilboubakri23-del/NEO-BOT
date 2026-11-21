# NEO BOT — V1.0.0

Modular WhatsApp bot. Phase 1: connection, dual authentication, encrypted sessions,
auto-reconnect, message handling, real interactive list menu, `.menu` and `.ping`.

## Stack
| Component | Technology |
|---|---|
| Runtime | Node.js 20+ (ES Modules) |
| WhatsApp engine | **raoltech/baileys v1.1.0** (Baileys v7.0.0-rc13 fork, MessageBuilder v4.5), pinned to commit `8568397` |
| Interactive messages | `Button` builder from raoltech/baileys (native_flow `single_select`, `quick_reply`, `cta_url`, `cta_copy`) |
| QR | qrcode, qrcode-terminal |
| Logging | pino (+ pino-pretty) |
| Session encryption | Node.js crypto, AES-256-GCM |

> `npm audit` shows a "critical" advisory for `baileys <6.7.22`. It is a false match:
> the fork's package version is `1.1.0`, but its code is synced with upstream rc13 and
> includes the rc12 security patch for that advisory.

## Setup
```bash
npm install
cp .env.example .env
npm run genkey          # paste the output into SESSION_ENCRYPTION_KEY
npm start
```
Choose `[1] Phone Number` or `[2] QR Code` in the terminal.

### Cloud hosting (no terminal)
1. Set env vars: `SESSION_ENCRYPTION_KEY`, `WEB_SETUP_TOKEN` (long random), `PORT`, `SESSION_DIR` on a **persistent volume**.
2. Open `https://<your-host>/?token=<WEB_SETUP_TOKEN>` and pick Phone or QR.
3. `GET /health` is available for health checks.

Alternatively set `AUTH_METHOD=qr` or `AUTH_METHOD=phone` + `PAIRING_NUMBER`.

## Session security
- Every auth file (creds + Signal keys) is stored as `NEO1 | IV | TAG | ciphertext` (AES-256-GCM, random IV per write, file name bound as AAD).
- File names are HMAC hashes, so they reveal nothing.
- Writes are atomic (tmp + rename). Tampered files or a wrong key stop the bot safely.
- **Keep your key safe. Losing it means linking WhatsApp again.**
- `npm run reset-session` deletes the session.

## Commands
| Command | Description |
|---|---|
| `.menu` | Interactive list with the **ORDERS** button (2 sections, 6 rows). `.menu <id>` is the text fallback. |
| `.ping` | Real round-trip time + connection status (edits its own message). |

Selection ids: `ai_center`, `smart_tools`, `media_lab`, `knowledge`, `automation`, `system`.
`system` opens a panel with quick replies (BOT INFO / HELP / OWNER), a URL button and a COPY CODE button.

## Structure
```
config/config.js           settings + env
core/connection.js         single socket, events, backoff reconnection
core/authentication.js     method selection (env / terminal / web) + live auth status
core/pairing.js            phone pairing code
core/qr.js                 QR rendering (terminal + image)
core/setupServer.js        private web setup page + /health
core/sessionManager.js     encrypted Baileys auth-state adapter
core/messageHandler.js     messages.upsert → filter → route
core/commandHandler.js     command loader, permissions, interactive selections
core/logger.js             pino with redaction
systems/security/encryption.js
systems/menus/interactiveMenu.js
commands/menu.js, commands/ping.js
utils/                     formatter, validators, errors
tests/offline.test.js      npm test
```

## Notes
- The bot ignores its own messages: test from **another** WhatsApp number.
- Only fresh messages (`notify`, < 60 s old at boot) are processed.
- Interactive rendering depends on the WhatsApp client; it must be verified on a real phone.

## Deploy on Render (free) with MongoDB Atlas

Render's free plan wipes local files on every restart and idles after 15 minutes
without traffic. NEO BOT handles both:

- **Session in MongoDB:** set `MONGODB_URI` and the session is stored in MongoDB
  (encrypted with AES-256-GCM *before* it leaves the bot; the database only sees
  hashed keys and ciphertext).
- **Keep-alive:** the bot pings its own `/health` every 10 minutes using
  `RENDER_EXTERNAL_URL` (set by Render automatically).

Steps:

1. MongoDB Atlas → create a free **M0** cluster → Database Access: add a user →
   Network Access: allow `0.0.0.0/0` → Connect → Drivers → copy the `mongodb+srv://...` string.
2. Render → New → **Blueprint** → pick this repository (uses `render.yaml`), or
   New → Web Service with build `npm ci --omit=dev`, start `node index.js`, plan Free.
3. Environment variables:
   - `SESSION_ENCRYPTION_KEY` – `npm run genkey` (keep a copy; losing it = link again)
   - `MONGODB_URI` – the Atlas string
   - `WEB_SETUP_TOKEN` – a long random secret
   - `OWNER_NUMBERS` – e.g. `2126XXXXXXXX`
4. Open `https://<your-service>.onrender.com/?token=<WEB_SETUP_TOKEN>` and link with QR or phone number.

Note: 750 free instance hours per month cover one service running all month.

## Remote developer console (`.dev`)

Owner-only (the linked account itself, or numbers in `OWNER_NUMBERS`). Disable with `DEVTOOLS_ENABLED=false`.

| Command | What it does |
| --- | --- |
| `.dev` | Console panel |
| `.dev cmds` / `ls [dir]` / `tree [dir]` | Browse commands and folders |
| `.dev cat <file\|cmd> [page]` / `get` / `find <text>` | Read, download or search code |
| `.dev template [name]` | Ready command skeleton |
| `.dev add <name>` + code | New command, hot-loaded |
| `.dev edit <file\|cmd>` + code / `new <path>` + code | Replace or create a file |
| `.dev del <file\|cmd>` / `restore` / `backups` | Delete to trash, undo, versions |
| `.dev reload` | Hot-reload commands |

Code goes on the lines under the command, in a `.js` file sent with the command as its caption, or in a message you reply to. Every change is syntax-checked (and command files import-checked) before saving; `.env`, sessions, `.git` and `node_modules` are never readable or writable. On Render, files changed this way are lost on the next deploy; edit through GitHub for permanent changes.
