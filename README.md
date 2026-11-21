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
