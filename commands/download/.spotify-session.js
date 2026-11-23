import crypto from 'node:crypto';
import {UserError} from '../../utils/errors.js';
const TTL=5*60_000;
export class SpotifySessions {
 constructor(now=Date.now){this.now=now;this.sessions=new Map();this.active=new Set();this.limits=new Map();}
 key(m){return JSON.stringify([m.chat,m.senderNumber || m.sender]);}
 prune(){for(const [k,s] of this.sessions)if(s.expires<=this.now()){s.cancelled=true;this.sessions.delete(k)};for(const[k,s]of this.limits)if(s<=this.now())this.limits.delete(k);}
 create(m,tracks=[]){this.prune();const key=this.key(m);if(this.sessions.size>=500&&!this.sessions.has(key))throw new UserError('Spotify is busy. Try again shortly.');this.cancel(m);const s={token:crypto.randomBytes(8).toString('hex'),expires:this.now()+TTL,tracks};this.sessions.set(key,s);return s;}
 get(m,token){this.prune();const s=this.sessions.get(this.key(m));if(!s||s.token!==token)throw new UserError('This Spotify menu expired or belongs to someone else. Send .spotify again.');return s;}
 cancel(m){const s=this.sessions.get(this.key(m));if(s)s.cancelled=true;this.sessions.delete(this.key(m));}
 rate(m,action,ms){this.prune();const key=this.key(m)+action;if(this.limits.get(key)>this.now())throw new UserError('Please wait before trying this Spotify action again.');if(this.limits.size>=2000&&!this.limits.has(key))throw new UserError('Spotify is busy. Try again shortly.');this.limits.set(key,this.now()+ms);}
 async run(m,action,ms,fn){const key=this.key(m);if(this.active.has(key)||this.active.size>=2)throw new UserError('A Spotify request is already running. Try again shortly.');this.rate(m,action,ms);this.active.add(key);try{return await fn()}finally{this.active.delete(key)}}
}
export const spotifySessions=new SpotifySessions();
