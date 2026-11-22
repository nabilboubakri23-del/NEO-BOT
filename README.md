# NEO BOT — V1.4.0 (Moderation, Media & Games)

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
| `.menu [category]` | 👤 everyone | Multi-level interactive menu; shows only the commands you can use, with rank badges. |
| `.help [command]` | 👤 everyone | Generated help; `.help ping` shows usage, aliases, permission and your cooldown. |
| `.ping` | 👤 everyone | Round-trip time + connection status. |
| `.stats` | 👤 everyone | Uptime, usage counters, top commands, server info. |
| `.myid` | 👤 everyone | Your number, LID and rank. |
| `.rank` / `.myrank` | 👤 everyone | Your rank, level, perks, expiry and the commands it unlocks. `.rank list` · `.rank who <rank>` |
| `.rank set <user> <rank> [7d\|12h\|30m] [reason]` · `.rank del <user>` · `.rank info <user>` | 🛡️ moderator+ | Grant / remove ranks strictly below your own (temporary ranks supported). |
| `.premium <user> <duration>` | 🛡️ moderator+ | Shortcut for `.rank set <user> premium <duration>`. |
| `.rank log [n]` | 👑 owner+ | Audit log of rank, permission, ban and owner changes. |
| `.perm list` · `.perm show <cmd>` | 👑 owner+ | Runtime permission changes. |
| `.perm set <cmd> <rank>` · `reset` · `lock` · `unlock` · `allow <user> <cmd>` · `deny <user> <cmd>` · `clear <user> <cmd>` | 🔱 creator | Change who may use a command without editing code. |
| `.bot on/off/status` | group admins | Switch the bot off in one chat. |
| `.jid [group/channel link]` (aliases gid, cid) | 👤 public | Group or channel ID: run it in a group, in your own channel, with an invite/channel link, or replying to a post forwarded from a channel. |
| `.settings [set/reset/info]` | 👑 owner+ | Change bot settings from WhatsApp. |
| `.ban / .unban / .banlist` | 🛡️ moderator+ | Banned users are ignored everywhere (only users below your rank). |
| `.owner` | 👑 owner+ (add/del: 🔱 creator) | Manage owners (data/owners.json); `.owner claim` on first setup. |
| `.dev` | 👑 owner+ | Remote developer console. |
| `.kick / .promote / .demote` | group admins (bot must be admin) | Manage one member; ranked members are protected from lower ranks. |
| `.tagall [message]` | group admins | Mention every member. |
| `.welcome on/off` | group admins | Join/leave greetings (from the `welcome` plugin). |
| `.plugins [info/enable/disable/install/remove/reload]` | 👑 owner+ | Manage plugins. |
| `.myid [user]` (aliases id, whoami) | 👤 everyone | Now also shows the number / LID / rank of a mentioned or replied user. |
| `.system` (aliases ram, sysinfo, server) | 👤 everyone | Process and host RAM, CPU, load, uptime, available media tools. |
| **Moderation (v1.4.0)** | | |
| `.warn <user> [reason]` | group admins (bot admin) | Warning; at the group's limit (default 3) the member is removed. |
| `.unwarn <user> [n\|all]` (delwarn, resetwarn) · `.warnings [user\|list]` | group admins · everyone | Remove warnings · see warnings and their reasons. |
| `.mute <user> [30m\|2h\|1d]` · `.unmute` · `.mutelist` | group admins (bot admin) | The bot deletes a muted member's messages, optionally for a while. |
| `.gset [option value]` | group admins | Per-group options: `antilink`, `linkscope`, `antivcard`, `warnlimit`, `adminonly`, `levelup` (buttons panel). |
| `.antilink <off\|delete\|warn\|kick> [invites\|all]` · `.antivcard <off\|delete\|warn\|kick>` | group admins | Shortcuts for the two guards. |
| `.open` / `.close` · `.editinfo <admins\|all>` | group admins (bot admin) | Who can send messages · who can edit group info. |
| `.setname` · `.setdesc` · `.setpp` | group admins (bot admin) | Group name, description, picture (`.setpp` needs the optional `jimp` package). |
| `.link` · `.revoke` · `.requests [approve\|reject] [all\|n]` | group admins (bot admin) | Invite link, reset it, pending join requests. |
| `.delete` (del) | group admins | Delete the replied message for everyone. |
| `.hidetag <text>` (htag) | group admins | Notify every member without listing them. `.tagall` now lists admins and members apart. |
| **Media** | | |
| `.sticker [pack \| author]` (s) | 👤 everyone | Image / GIF / short video → sticker (ffmpeg). |
| `.take <pack> \| [author]` (wm) | 👤 everyone | Re-label a sticker (pure JS, no ffmpeg). |
| `.toimage` · `.tomp3` · `.togif` | 👤 everyone | Sticker → image, video / voice → MP3, video → GIF. |
| **Games & levels** | | |
| `.xo [bot\|end]` (ttt) | 👤 everyone | Tic-tac-toe vs a friend or the bot (plugin `tictactoe`). |
| `.quiz [flag\|math\|word\|hint\|stop]` (flag, math, scramble) | 👤 everyone | 5-round chat quizzes, offline questions (plugin `quiz`). |
| `.profile [user]` (level, xp) · `.leaderboard [xp\|coins\|wins]` (lb, top) | 👤 everyone | Level, XP, coins, wins · top 10. |
| `.daily` / `.weekly` / `.monthly` · `.give <user> <amount>` | 👤 everyone | Periodic coin rewards · give coins. |
| **AI & automation** | | |
| `.ai <question>` (ask, gpt) · `.ai reset` | 👤 everyone | OpenAI-compatible chat; needs `AI_API_KEY`. Change access with `.perm set ai premium`. |
| `.autoreply` / `.autoreact on\|off\|list\|add\|del` | admins on/off · owners add/del | Auto-replies / reactions, OFF in every chat by default (plugin `autoresponder`). |
| **Owner** | | |
| `.join <link>` · `.leave` · `.setbotpp` | 👑 owner+ | Join a group, leave this group, bot profile picture. |

## Moderation, Media & Games (v1.4.0)

Ported from the Pomni AI bot and rewritten for NEO BOT's architecture (ranks, docStore, event bus, plugins).

- **Group guard** (`systems/moderation/`): a core `message` listener deletes links / contact cards per the group's
  `.gset` options (delete, warn, or kick) and the messages of muted members. Group admins and 🛡️ Moderator+ are never
  affected, and nothing is enforced while the bot is not a group admin. Bot notices are rate-limited per member.
  `adminonly` makes regular members' commands silent in that group.
- **Warnings** are shared by `.warn` and the guard (`actions.js`): one count per member, kick at `warnlimit`.
  Ranked members are protected from lower ranks, the creator and the bot can never be targeted.
- **Stores** (MongoDB `documents` or `data/*.json`): `groupConfig`, `warnings`, `mutes`, `economy`.
- **Media** (`systems/media/`): stickers are built with ffmpeg (feature-detected, `FFMPEG_PATH`; Termux: `pkg install ffmpeg`)
  and labelled by a pure-JS WebP EXIF writer, so `.take` works without ffmpeg. Without ffmpeg, image/video stickers
  and video → MP3 answer with a clear message; voice → MP3 and video → GIF still work. Downloads are capped at 25 MB.
  Group / bot pictures need the optional `jimp` package (`npm install jimp`, ~36 MB) — not bundled.
- **Games** are plugins (`plugins/tictactoe.js`, `plugins/quiz.js`) with per-chat sessions and inactivity timeouts
  (`systems/games/`); questions are generated offline. Wins pay coins and XP.
- **Levels** (`plugins/levels.js`): 5–15 XP per message, at most once a minute; level-up announcements are opt-in per group (`.gset levelup on`).
- **AI** (`.ai`): set `AI_API_KEY` (and optionally `AI_BASE_URL`, `AI_MODEL`, `AI_SYSTEM_PROMPT`). No key is ever committed.
- **Plugin API**: `api.allows(sock, message)` tells a hook whether the bot answers this sender in this chat (bans, mode, chat off).
- **Serializer**: `message.quoted.key` (delete / download the replied message), `utils/media.js` (`findMedia`, `downloadMedia`), `utils/mentions.js`.

## Permission System (v1.3.0)

One person is on top: the **creator** (the main owner) has every permission. Every other
person has exactly one rank; a higher rank always has all the permissions of the lower ones.

| Rank | Level | Who | Cooldowns | Commands / day |
|---|---|---|---|---|
| 🔱 Creator | 100 | The main owner (`data/owners.json`, `MAIN_OWNER`, `OWNER_NUMBERS`) and the linked account. Bypasses policy, bans, cooldowns, limits, locks and denies. | none | unlimited |
| 👑 Owner | 80 | Co-owners (the `admins` list in `data/owners.json`, migrated automatically). | none | unlimited |
| 🛡️ Moderator | 60 | Granted with `.rank set`. Can ban and grant VIP / Premium. | none | unlimited |
| 🌟 VIP | 40 | Granted. | 25 % | unlimited |
| 💎 Premium | 30 | Granted (often temporary: `.premium <user> 30d`). | 50 % | unlimited |
| 👤 User | 10 | Everyone else (`public` is an alias). | normal | `dailyLimit` setting (default 100, 0 = unlimited) |
| 🚫 Banned | 0 | `.ban` — ignored by the bot. | – | 0 |

**One field per command** — the minimum rank:

```js
export default {
    name: 'imagine',
    permission: 'premium',            // creator | owner | moderator | vip | premium | user | public
    scope: 'group',                   // optional: 'group' | 'private'
    requires: ['groupAdmin'],         // optional: 'groupAdmin' | 'botAdmin'
    async execute(sock, message, args, ctx) {
        ctx.access.rank;              // { name, level, emoji, label, perks, expiresAt }
        ctx.access.atLeast('vip');    // true / false
        ctx.access.isCreator;
    }
};
```

- Unknown rank names are rejected when the command loads (fail closed). The old `permissions: [...]` arrays still work
  (`owner` → owner, `mainOwner` → creator, `admin` → requires groupAdmin, `botAdmin` → requires botAdmin, `group` / `private` → scope).
- **Rules:** rank management needs 🛡️ Moderator; you only grant or revoke ranks strictly below your own, to people below you;
  only the creator grants 👑 Owner; nobody can target the creator. Kick / demote through the bot cannot hit a ranked member of equal or higher rank.
- **Temporary ranks:** `.rank set <user> vip 7d` — expired ranks fall back to 👤 User automatically.
- **Runtime overrides (creator):** `.perm set ping premium`, `.perm lock dev` (creator only), `.perm allow|deny <user> <cmd>`
  (deny always wins), `.perm reset <cmd>`. Overrides win over the file default.
- **Pipeline:** policy → anti-spam → deny / lock / rank (override, allow) → scope → requires → daily limit → cooldown × rank multiplier → run.
  A denial says what is needed: `⛔ Requires 💎 Premium. Your rank: 👤 User.` (locked commands stay silent for non-owners).
- **Audit log:** last 200 rank, permission, ban and owner changes (`.rank log`).
- **Plugins:** `api.ranks.of(message)` and `api.ranks.atLeast(message, 'vip')`; plugin commands use the same `permission` field.
- **Storage** (MongoDB `documents` or `data/*.json`): `ranks`, `commandPerms`, `usage`, `audit`. Creator and owners stay in `data/owners.json`, bans on the user record: one source of truth each.
- Code: `systems/permissions/` — `ranks.js` (hierarchy), `resolveRank.js`, `rankRules.js`, `rankService.js`, `rankStore.js`,
  `commandOverrides.js`, `perks.js`, `dailyLimit.js`, `auditLog.js`, `permissions.js` (checks), `policy.js`.

## Plugin System (v1.2.0)
- **Event bus** (`core/events.js`): the core emits `message`, `command:before` (can veto), `command:after`,
  `command:error`, `group:participants`, `connection:open`, `plugins:reloaded`. Failing listeners are isolated.
- **Plugin manager** (`systems/plugins/pluginManager.js`): every `.js` file in `/plugins` (files starting with `_` are skipped)
  can add commands, hooks and its own storage (`api.store`), without touching the core.
  Enable / disable is saved; reload removes exactly what a plugin added.
- **Safe install from URL**: `.plugins install <https url>` downloads, scans for risky code
  (shell, eval, file deletion, env / credentials), validates in isolation, then loads.
  Risky plugins need `--force`.
- **Multi-command files**: a command file may `export default [cmdA, cmdB]` (see `commands/group.js`).

### Writing a plugin
```js
// plugins/hello.js
export default {
    name: 'hello',
    version: '1.0.0',
    description: 'Says hi when someone writes "hi".',
    commands: [{ name: 'hi', description: 'Say hi.', permission: 'public', async execute(sock, m) { await m.reply('Hi!'); } }],
    hooks: {
        async message({ message }, api) {
            if (message.text.toLowerCase() === 'hi') await message.reply('Hello 👋');
        }
    }
};
```

## Core Evolution (v1.1.0)
- **Command Engine V2** (`core/commandHandler.js`, `core/commandParser.js`): quoted args, `--flags`, multi-line body,
  definition validation on load, alias conflict protection, atomic reload, "did you mean" suggestions,
  `usage` / `examples` / `minArgs` / `cooldown` / `hidden` / `allowWhenOff` fields, `ctx` as 4th argument.
- **Permissions** (`systems/permissions/`): replaced by ranks in v1.3.0 (see above). Group metadata is cached (`systems/groups/groupCache.js`) and reused by the socket.
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
    permission: 'public',
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
systems/permissions/       ranks, rank store, overrides, perks, audit log, policy
systems/moderation/        group options, warnings, mutes, detectors, guard, shared actions
systems/media/             ffmpeg runner, WebP sticker EXIF, sticker builder, converters
systems/games/             sessions, tic-tac-toe, quiz generators, countries
systems/economy/           XP / levels math, coins and rewards store
systems/ai/                OpenAI-compatible client, short conversation memory
systems/automation/        auto-reply / auto-react matching
systems/security/          encryption, dedupe, rate limiter
systems/settings/ users/ stats/ database/ groups/
core/logger.js             pino with redaction
systems/security/encryption.js
systems/menus/interactiveMenu.js
commands/menu.js, commands/ping.js
utils/                     formatter, validators, errors
tests/*.test.js            npm test
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

👑 Owner rank and above by default (change it with `.perm set dev <rank>` or `.perm lock dev`). Disable with `DEVTOOLS_ENABLED=false`.

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

Owners are kept in `data/owners.json` (git-ignored, created by the bot). The main owner is the 🔱 Creator; every listed owner has the 👑 Owner rank. Only the creator adds or removes owners (`.owner add` or `.rank set <user> owner`).

- First run: the terminal prints `.owner claim <code>`. Send it from your own WhatsApp to become the main owner.
- `.owner` lists owners · `.owner add <number|@mention|reply>` · `.owner del <number|@mention>` · `.owner reload` re-reads the file after a manual edit.
- `OWNER_NUMBERS` in `.env` still works as extra main owners. `.myid` shows your number, LID and status.

## Channel forward look
Every bot message shows as "Forwarded from channel" (name + picture of the channel). Set `NEWSLETTER_JID` / `NEWSLETTER_NAME` in .env; turn off with `.settings set channelForward off`.


## Free AI chat and character commands

Recommended provider: **Groq Free**, with `openai/gpt-oss-120b` as the default.
Use your own account and key. A free API is quota-limited, not unlimited.
Do not use shared or leaked keys. Do not enable a paid plan to use these commands.

On the bot host, set the private environment variables:

```dotenv
AI_PROVIDER=groq
GROQ_API_KEY=<your own private Groq key>
```

Leave `AI_BASE_URL` and `AI_MODEL` unset (or empty) to use Groq defaults.
If they already contain OpenAI settings, clear them before switching providers.
Restart the bot after changing its environment. Never commit the real key.
Create keys in the official Groq Console. No key is included with this code.
The integration is inactive until a valid key is configured.

Existing deployments with `AI_API_KEY` keep the prior OpenAI-compatible defaults
unless `AI_PROVIDER=groq` is selected. Groq also accepts the existing `AI_API_KEY`
variable when explicitly selected. No new dependency is required.

- General chat: `.ai`, `.ask`, `.gpt`, `.chat`, `.بوت`, `.اوبن` followed by a question.
- Characters: `.eren` / `.إيرن`, `.itachi` / `.إيتاتشي`, `.luffy` / `.لوفي`,
  `.marin` / `.مارين`, `.mikasa` / `.ميكاسا`, `.pomni` / `.بومني`.
- Example: `.لوفي شنو هو الحلم ديالك؟`
- Reset a conversation with the command plus `reset`, such as `.luffy reset`.
- Each character has separate short memory for each person in each chat.
  Memory lasts 10 minutes and disappears at restart. Character replies default to
  casual Egyptian Arabic, following the supplied examples, unless asked otherwise.
- These are fictional AI roleplay responses and may be wrong. No external actions
  or tools are enabled. Existing permissions and rate-limit checks still apply.
  Set permissions separately for each character if you restrict AI access.

Only AI command text, included quoted text and short AI conversation history are
sent to the configured provider. No phone numbers or profile names are added to
requests by this integration. Do not send secrets or sensitive personal data.
Groq says inference content is not retained by default, but it can be logged for
reliability or abuse investigations for up to 30 days. Account admins can enable
Zero Data Retention. This code does not change the account's data controls.

Groq's published quota summary at the time of this change lists 30 requests/min,
1,000 requests/day, 8,000 tokens/min and 200,000 tokens/day for this model.
The first reached limit applies; the exact account limits in the Console govern.
Quota changes or model retirement can require updating `AI_MODEL`. Rate-limit
errors produce a retry message, never a switch to a paid service.

Provider references:
- https://console.groq.com/docs/openai
- https://console.groq.com/docs/rate-limits
- https://console.groq.com/docs/your-data
- https://console.groq.com/docs/billing-faqs

Tests use mocked provider responses and do not spend API quota. A live provider
check and WhatsApp check are still needed after configuring the real host key.
