# NEO BOT — V1.1.0 (Core Evolution)

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
| Command | Access | Description |
|---|---|---|
| `.menu [category]` | everyone | Multi-level interactive menu built from the registered commands (category → commands → BACK). |
| `.help [command]` | everyone | Generated help; `.help ping` shows usage, aliases, access and cooldown. |
| `.ping` | everyone | Round-trip time + connection status. |
| `.stats` | everyone | Uptime, usage counters, top commands, server info. |
| `.myid` | everyone | Your number, LID and owner status. |
| `.bot on/off/status` | group admins | Switch the bot off in one chat. |
| `.settings [set/reset/info]` | owners | Change bot settings from WhatsApp. |
| `.ban / .unban / .banlist` | owners | Banned users are ignored everywhere. |
| `.owner` | owners | Manage owners (data/owners.json). |
| `.dev` | owners | Remote developer console. |

## Core Evolution (v1.1.0)
- **Command Engine V2** (`core/commandHandler.js`, `core/commandParser.js`): quoted args, `--flags`, multi-line body,
  definition validation on load, alias conflict protection, atomic reload, "did you mean" suggestions,
  `usage` / `examples` / `minArgs` / `cooldown` / `hidden` / `allowWhenOff` fields, `ctx` as 4th argument.
- **Permissions** (`systems/permissions/`): `public`, `owner`, `mainOwner`, `admin` (group admin), `botAdmin`,
  `group`, `private`, combined with AND. Group metadata is cached (`systems/groups/groupCache.js`) and reused by the socket.
- **Policy**: bot mode (`public | private | groups | inbox`), per-chat on/off, bans. Owners always pass.
- **Anti-spam + cooldowns** (`systems/security/rateLimiter.js`): each limit is announced once, then silent.
- **Anti-duplicate** (`systems/security/dedupe.js`).
- **Unified interactions**: ids `.<command>` run a command; `<command>:<a>:<b>` call that command's `onSelect`.
- **Central error handler**: `UsageError` → usage card, `UserError` → clean message, crashes → reference code (details for owners only).
- **Settings / users / stats** stored through `systems/database/docStore.js` (MongoDB `documents` collection when `MONGODB_URI` is set, otherwise `data/*.json`).
- **Formatter** (`utils/formatter.js`): `box`, `fields`, `section`, `success`, `failure`, `usage`.

### Writing a command
```js
export default {
    name: 'echo',
    category: 'tools',
    description: 'Repeat text.',
    usage: '<text>',
    minArgs: 1,
    cooldown: 3,
    permissions: ['public'],
    async execute(sock, message, args, ctx) {
        await message.reply(ctx.argsText);
    }
};
```

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
core/commandHandler.js     command engine V2 (pipeline, errors, interactions)
core/commandParser.js      args / flags / suggestions
systems/permissions/       permission levels + bot policy
systems/security/          encryption, dedupe, rate limiter
systems/settings/ users/ stats/ database/ groups/
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

## Owners (`data/owners.json`)

Owners are kept in `data/owners.json` (git-ignored, created by the bot). The main owner and every listed owner get full owner permissions; only the main owner adds or removes owners.

- First run: the terminal prints `.owner claim <code>`. Send it from your own WhatsApp to become the main owner.
- `.owner` lists owners · `.owner add <number|@mention|reply>` · `.owner del <number|@mention>` · `.owner reload` re-reads the file after a manual edit.
- `OWNER_NUMBERS` in `.env` still works as extra main owners. `.myid` shows your number, LID and status.
