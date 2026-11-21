import http from 'node:http';
import crypto from 'node:crypto';
import config from '../config/config.js';
import authentication from './authentication.js';
import { child } from './logger.js';

const log = child('setup-server');

/**
 * Private browser-based authentication page for cloud hosting
 * (where the terminal is not reachable). Protected by WEB_SETUP_TOKEN.
 * Also exposes GET /health for the hosting provider.
 */

const safeEqual = (a, b) => {
    const x = Buffer.from(String(a));
    const y = Buffer.from(String(b));
    return x.length === y.length && crypto.timingSafeEqual(x, y);
};

const send = (res, status, body, type = 'application/json') => {
    res.writeHead(status, {
        'Content-Type': type,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
        'Referrer-Policy': 'no-referrer'
    });
    res.end(type === 'application/json' ? JSON.stringify(body) : body);
};

const readBody = (req, limit = 2048) =>
    new Promise((resolve, reject) => {
        let data = '';
        req.on('data', (chunk) => {
            data += chunk;
            if (data.length > limit) {
                reject(new Error('Body too large'));
                req.destroy();
            }
        });
        req.on('end', () => resolve(data));
        req.on('error', reject);
    });

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>NEO BOT · Authentication</title>
<style>
body{margin:0;font-family:system-ui,sans-serif;background:#0b141a;color:#e9edef;display:flex;justify-content:center}
main{max-width:420px;width:100%;padding:24px}
h1{letter-spacing:2px;margin:8px 0 4px}h2{font-size:14px;color:#8696a0;margin:0 0 24px;font-weight:500}
.card{background:#111b21;border-radius:16px;padding:20px;margin-bottom:16px}
button{width:100%;padding:14px;border:0;border-radius:24px;background:#00a884;color:#0b141a;font-weight:700;font-size:15px;margin-top:10px;cursor:pointer}
button.alt{background:#202c33;color:#e9edef}
input{width:100%;box-sizing:border-box;padding:12px;border-radius:10px;border:1px solid #2a3942;background:#202c33;color:#e9edef;font-size:16px}
.code{font-size:34px;letter-spacing:6px;text-align:center;font-weight:800;margin:12px 0}
img{width:100%;background:#fff;border-radius:12px}
ol{padding-left:20px;color:#8696a0;line-height:1.7}.err{color:#f15c6d}.ok{color:#00a884}
.hidden{display:none}
</style></head><body><main>
<h1>NEO BOT</h1><h2>AUTHENTICATION</h2>
<div id="choose" class="card hidden">
  <p>Select connection method:</p>
  <input id="phone" inputmode="numeric" placeholder="Phone with country code, e.g. 212XXXXXXXXX">
  <button onclick="choose('phone')">[1] Phone Number</button>
  <button class="alt" onclick="choose('qr')">[2] QR Code</button>
  <p id="formErr" class="err"></p>
</div>
<div id="qr" class="card hidden"><img id="qrImg" alt="QR code">
  <ol><li>Open WhatsApp → Settings</li><li>Linked Devices → Link a Device</li><li>Scan this QR code</li></ol></div>
<div id="pair" class="card hidden"><p>Pairing code for <b id="pPhone"></b></p><div class="code" id="pCode"></div>
  <ol><li>Open WhatsApp</li><li>Go to Linked Devices</li><li>Select Link a Device</li><li>Select "Link with phone number instead"</li><li>Enter the code above</li></ol></div>
<div id="state" class="card"></div>
</main><script>
const token=new URLSearchParams(location.search).get('token')||'';
const H={'Authorization':'Bearer '+token,'Content-Type':'application/json'};
const $=id=>document.getElementById(id);
async function choose(method){$('formErr').textContent='';
  const r=await fetch('/auth/start',{method:'POST',headers:H,body:JSON.stringify({method,phone:$('phone').value})});
  const j=await r.json(); if(!r.ok) $('formErr').textContent=j.error||'Request failed'; poll();}
async function poll(){
  const r=await fetch('/auth/status',{headers:H});
  if(r.status===401){$('state').innerHTML='<p class="err">Unauthorized. Open this page with ?token=YOUR_WEB_SETUP_TOKEN</p>';return;}
  const s=await r.json();
  $('choose').classList.toggle('hidden',s.state!=='awaiting_choice');
  $('qr').classList.toggle('hidden',s.state!=='qr_ready');
  $('pair').classList.toggle('hidden',s.state!=='pairing_code');
  if(s.qrDataUrl) $('qrImg').src=s.qrDataUrl;
  if(s.pairingCode){$('pCode').textContent=s.pairingCode;$('pPhone').textContent=s.phoneMasked||'';}
  const labels={idle:'Starting…',awaiting_choice:'Waiting for your choice.',waiting_qr:'Connecting to WhatsApp…',
    qr_ready:'Scan the QR code. It refreshes automatically.',pairing_code:'Enter the pairing code in WhatsApp.',
    connected:'<span class="ok">Authentication successful. WhatsApp connected. Session saved.</span>',error:''};
  $('state').innerHTML=(labels[s.state]||s.state)+(s.error?'<p class="err">'+s.error+'</p>':'');
}
poll();setInterval(poll,3000);
</script></body></html>`;

let server = null;

export const startSetupServer = () => {
    if (server || !config.setupServer.enabled) return null;
    if (!config.setupServer.token || config.setupServer.token.length < 16) {
        log.error('WEB_SETUP_TOKEN must be set (16+ characters). Web setup page disabled.');
        return null;
    }

    const authorized = (req, url) => {
        const header = req.headers.authorization?.replace(/^Bearer\s+/i, '') || '';
        return safeEqual(header || url.searchParams.get('token') || '', config.setupServer.token);
    };

    server = http.createServer(async (req, res) => {
        const url = new URL(req.url, 'http://localhost');
        try {
            if (req.method === 'GET' && url.pathname === '/health') {
                return send(res, 200, { status: 'ok', auth: authentication.status.state });
            }
            if (req.method === 'GET' && url.pathname === '/') {
                return send(res, 200, PAGE, 'text/html; charset=utf-8');
            }
            if (!authorized(req, url)) return send(res, 401, { error: 'Unauthorized' });

            if (req.method === 'GET' && url.pathname === '/auth/status') {
                const { state, method, qrDataUrl, pairingCode, phoneMasked, error } = authentication.status;
                const hide = state === 'connected';
                return send(res, 200, {
                    state, method, error, phoneMasked,
                    qrDataUrl: hide ? null : qrDataUrl,
                    pairingCode: hide ? null : pairingCode
                });
            }
            if (req.method === 'POST' && url.pathname === '/auth/start') {
                const body = JSON.parse((await readBody(req)) || '{}');
                authentication.submitChoice(body.method, body.phone);
                return send(res, 200, { ok: true });
            }
            return send(res, 404, { error: 'Not found' });
        } catch (error) {
            return send(res, 400, { error: error.code === 'VALIDATION_ERROR' ? error.message : 'Bad request' });
        }
    });

    server.listen(config.setupServer.port, () => {
        log.info({ port: config.setupServer.port }, 'Web setup page is listening. Open /?token=<WEB_SETUP_TOKEN>');
    });
    server.on('error', (error) => log.error(`Setup server error: ${error.message}`));
    return server;
};

export const stopSetupServer = () =>
    new Promise((resolve) => {
        if (!server) return resolve();
        server.close(() => resolve());
        server = null;
    });
