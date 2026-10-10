// index.js - BOT ALJESI - ESM - رمز اقتران واحد فقط

import { webcrypto, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (typeof globalThis.crypto === "undefined") globalThis.crypto = webcrypto;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

import makeWASocket, {
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion
} from "@whiskeysockets/baileys";
import P from "pino";
import { getOnNotification, getOffNotification, getViolationMessage, getAdminSaluteMsg } from "./dark.js";
import { trackMessage, handleAntiContact, handleAntiLeaveZzs, cleanupRecentMessages, cleanupPunished, isPunished, handlePunishedFollowUp, normJid } from "./haolk.js";
import { addWarning, resetWarnings, checkSpamAndViolations, cleanupMemory, addProtectedAdmin, removeProtectedAdmin, isProtectedAdmin } from "./trim.js";
import { DECOR, decorateSuccess, decorateError, decorateLock, decorateRank, decorateInfo, decorateZarfAlert } from "./decor.js";
import { initBotat, onParticipantsUpdate as botatOnParticipants, onMessage as botatOnMessage, onReceipt as botatOnReceipt, onPresence as botatOnPresence, handleBotatCommand, cleanupBotat, flushBotat } from "./botat.js";

// ====== Settings ======
const settingsPath = path.join(__dirname, "settings.json");
let settings = {};
try { settings = JSON.parse(fs.readFileSync(settingsPath, "utf8")); } catch (e) { console.error("⚠️ settings.json:", e?.message); }
if (process.env.OWNERS) settings.owners = process.env.OWNERS.split(",").map(x => x.trim()).filter(Boolean);
if (process.env.BOT_NUMBER) settings.botNumber = process.env.BOT_NUMBER;

const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : __dirname;
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}

// ====== LogGuard ======
const _originalLog = console.log.bind(console);
const _originalError = console.error.bind(console);
const _originalWarn = console.warn.bind(console);

const logGuard = { count:0, windowStart:Date.now(), WINDOW_MS:1000, MAX_PER_WINDOW:30, dropped:0, silenced:false,
    canLog() {
        const now = Date.now();
        if (now - this.windowStart >= this.WINDOW_MS) {
            this.windowStart = now; this.count = 0;
            if (this.silenced) { this.silenced = false; _originalWarn(`⚠️ [LogGuard] استئناف.`); this.dropped = 0; }
        }
        this.count++;
        if (this.count > this.MAX_PER_WINDOW) { this.silenced = true; this.dropped++; return false; }
        return true;
    }
};
console.log = (...a) => { if (logGuard.canLog()) _originalLog(...a); };
console.error = (...a) => { if (logGuard.canLog()) _originalError(...a); };
console.warn = (...a) => { if (logGuard.canLog()) _originalWarn(...a); };

// ====== Database ======
const dbFile = path.join(DATA_DIR, "database.json");
const DEFAULT_SETTINGS_JID = () => ({
    protection:false, leave:false, monitoring:false, emoji:false,
    antiMention:false, antiZarf:false, supportActive:false,
    filters:{ link:true, badword:true, image:true, sticker:true, lang:true, emoji:true }
});

let db = { authorizedUsers:{}, globalAuthorized:{}, groupSettings:{}, reportGroup:null, blacklistGroups:[], exceptions:{}, backupGroups:{}, lastBackupAt:{}, protectedMembers:{}, pendingUnlocks:{} };

if (fs.existsSync(dbFile)) {
    try {
        const raw = fs.readFileSync(dbFile, "utf8");
        if (raw.trim()) {
            try { const p = JSON.parse(raw); if (p && typeof p === "object" && !Array.isArray(p)) db = { ...db, ...p }; }
            catch (e) { try { fs.copyFileSync(dbFile, `${dbFile}.corrupt-${Date.now()}`); } catch {} _originalError("⚠️ DB تالف."); }
        }
    } catch (e) { _originalError("⚠️ DB:", e?.message); }
}
for (const k of ["authorizedUsers","globalAuthorized","groupSettings","exceptions","backupGroups","lastBackupAt","protectedMembers","pendingUnlocks"]) {
    if (!db[k] || typeof db[k] !== "object" || Array.isArray(db[k])) db[k] = {};
}
if (!Array.isArray(db.blacklistGroups)) db.blacklistGroups = [];

function saveDb() {
    try { const tmp = `${dbFile}.tmp`; fs.writeFileSync(tmp, JSON.stringify(db, null, 2)); fs.renameSync(tmp, dbFile); }
    catch (e) { _originalError("❌ حفظ DB:", e?.message); }
}

// ====== Runtime ======
let currentSock = null;
let reconnectTimer = null;
let isReconnecting = false;
let shuttingDown = false;
let reconnectAttempts = 0;
let lastPairingCode = null;
let pairingCodeShown = false;
let pairingCodeTimer = null;

const kickTracker = {};
const KICK_TRACKER_TTL_MS = 10 * 60 * 1000;
let watchdogInterval = null;
let lastActivityAt = Date.now();
let cleanupInterval = null;
const WATCHDOG_CHECK_MS = 60 * 1000;
const IDLE_THRESHOLD_MS = 20 * 60 * 1000;
const MAX_IDLE_CHECKS = 15;

let lastExceptionAt = 0;
const EXCEPTION_COOLDOWN_MS = 5000;
process.on("uncaughtException", (e) => { const n = Date.now(); if (n - lastExceptionAt < EXCEPTION_COOLDOWN_MS) return; lastExceptionAt = n; _originalError("❌ Uncaught:", e?.message || e); });
process.on("unhandledRejection", (r) => { const n = Date.now(); if (n - lastExceptionAt < EXCEPTION_COOLDOWN_MS) return; lastExceptionAt = n; _originalError("❌ Unhandled:", r?.message || r); });

// ====== Helpers ======
function getOwnerNumbers() {
    const l = Array.isArray(settings.owners) ? settings.owners : (settings.owners ? [settings.owners] : []);
    return l.map(n => String(n).replace(/[^0-9]/g, "")).filter(Boolean);
}
function getBotNumber(sock) { try { return String(sock?.user?.id || "").split(":")[0].replace(/[^0-9]/g, ""); } catch { return ""; } }
function cleanNumber(v) { return v ? String(v).replace(/[^0-9]/g, "") : ""; }
function getMentionedJids(m) {
    if (!m) return [];
    const ctx = m.extendedTextMessage?.contextInfo || m.imageMessage?.contextInfo || m.videoMessage?.contextInfo || m.documentMessage?.contextInfo || null;
    return Array.isArray(ctx?.mentionedJid) ? ctx.mentionedJid : [];
}
function getMessageText(msg) {
    if (!msg?.message) return "";
    const m = msg.message;
    return m.conversation || m.extendedTextMessage?.text || m.imageMessage?.caption || m.videoMessage?.caption || m.documentMessage?.caption || "";
}
function cleanupKickTracker() {
    const now = Date.now();
    try {
        for (const jid of Object.keys(kickTracker)) {
            for (const a of Object.keys(kickTracker[jid])) {
                kickTracker[jid][a] = kickTracker[jid][a].filter(t => now - t < KICK_TRACKER_TTL_MS);
                if (!kickTracker[jid][a].length) delete kickTracker[jid][a];
            }
            if (!Object.keys(kickTracker[jid]).length) delete kickTracker[jid];
        }
    } catch {}
}
function runCleanup() { try { cleanupMemory(); cleanupKickTracker(); cleanupRecentMessages(); cleanupBotat(); cleanupPunished(); } catch (e) { _originalError("Cleanup:", e?.message); } }

function startWatchdog() {
    lastActivityAt = Date.now();
    if (watchdogInterval) clearInterval(watchdogInterval);
    let idle = 0;
    watchdogInterval = setInterval(() => {
        try {
            const i = Date.now() - lastActivityAt;
            if (i > IDLE_THRESHOLD_MS) {
                idle++;
                _originalWarn(`⚠️ Watchdog: خمول ${Math.round(i/60000)}د (${idle}/${MAX_IDLE_CHECKS})`);
                if (idle >= MAX_IDLE_CHECKS) { idle = 0; try { if (currentSock?.ws) currentSock.ws.close(); } catch {} }
            } else idle = 0;
        } catch (e) { _originalError("Watchdog:", e?.message); }
    }, WATCHDOG_CHECK_MS);
}
function stopWatchdog() { if (watchdogInterval) clearInterval(watchdogInterval); watchdogInterval = null; }

const DEBUG_INCOMING = !!process.env.BOT_DEBUG;
const WRAPPERS = ["ephemeralMessage","viewOnceMessage","viewOnceMessageV2","viewOnceMessageV2Extension","documentWithCaptionMessage","deviceSentMessage"];
function unwrapMessage(m) { let x = m; for (let i = 0; i < 6 && x; i++) { const w = WRAPPERS.find(k => x[k]?.message); if (!w) break; x = x[w].message; } return x; }
function isContactMessage(m) {
    if (!m) return false;
    if (m.contactMessage || m.contactsArrayMessage || m.vcardMessage) return true;
    return String(m.documentMessage?.mimetype || "").toLowerCase().includes("vcard");
}
function messageAgeSec(msg) { const t = Number(msg?.messageTimestamp?.low ?? msg?.messageTimestamp ?? 0); return t ? Math.max(0, Date.now()/1000 - t) : 0; }

const botSentIds = new Set();
function rememberBotSent(id) { botSentIds.add(id); if (botSentIds.size > 3000) botSentIds.delete(botSentIds.values().next().value); }
function genMessageId() { return "3EB0" + randomBytes(18).toString("hex").toUpperCase(); }

const groupMetaCache = new Map();
const GROUP_META_TTL_MS = 10 * 60 * 1000;
function getCachedMeta(jid) { const e = groupMetaCache.get(jid); return e && Date.now() - e.at < GROUP_META_TTL_MS ? e.meta : undefined; }
async function getGroupMetaFast(sock, jid) {
    const c = getCachedMeta(jid); if (c) return c;
    try { const m = await sock.groupMetadata(jid); groupMetaCache.set(jid, { meta: m, at: Date.now() }); return m; } catch { return null; }
}
async function warmGroupCache(sock) {
    try {
        const all = await sock.groupFetchAllParticipating();
        for (const [j, m] of Object.entries(all || {})) groupMetaCache.set(j, { meta: m, at: Date.now() });
        _originalLog(`⚡ تم تحميل ${groupMetaCache.size} قروب في الكاش`);
    } catch (e) { _originalWarn("⚠️ كاش:", e?.message); }
}
function applyParticipantsToCache(u) {
    const e = groupMetaCache.get(u?.id); if (!e?.meta?.participants) return;
    const ids = (u.participants || []).map(p => (typeof p === "string" ? p : p?.id)).filter(Boolean);
    const l = e.meta.participants;
    if (u.action === "add") for (const id of ids) if (!l.some(p => p.id === id)) l.push({ id, admin: null });
    else if (u.action === "remove") e.meta.participants = l.filter(p => !ids.includes(p.id));
    else if (u.action === "promote" || u.action === "demote") for (const p of l) if (ids.includes(p.id)) p.admin = u.action === "promote" ? "admin" : null;
}
function isTrustedSender(jid, sender) {
    const num = cleanNumber(normJid(sender).split("@")[0]);
    if (getOwnerNumbers().includes(num)) return true;
    const n = normJid(sender);
    const inMap = (o) => o && Object.keys(o).some(k => normJid(k) === n);
    return inMap(db.globalAuthorized) || inMap(db.authorizedUsers?.[jid]);
}
function isOwnerJid(jid) { return getOwnerNumbers().includes(cleanNumber(String(jid || "").split("@")[0].split(":")[0])); }
function ensureGroupSettings(jid) {
    if (!db.groupSettings[jid]) db.groupSettings[jid] = DEFAULT_SETTINGS_JID();
    const g = db.groupSettings[jid];
    if (g.supportActive === undefined) g.supportActive = false;
    if (g.antiMention === undefined) g.antiMention = false;
    if (g.antiZarf === undefined) g.antiZarf = false;
    if (!g.filters) g.filters = { link:true, badword:true, image:true, sticker:true, lang:true, emoji:true };
    return g;
}

const unlockFails = {};
function scheduleUnlock(jid, ms) {
    if (!jid) return;
    if (!db.pendingUnlocks) db.pendingUnlocks = {};
    db.pendingUnlocks[jid] = Math.max(db.pendingUnlocks[jid] || 0, Date.now() + ms);
    saveDb();
}
async function runUnlockCheck() {
    const sock = currentSock; if (!sock?.user || shuttingDown) return;
    const now = Date.now(); let ch = false;
    for (const [g, at] of Object.entries(db.pendingUnlocks || {})) {
        if (at > now) continue;
        try {
            await sock.groupSettingUpdate(g, "not_announcement");
            delete db.pendingUnlocks[g]; delete unlockFails[g]; ch = true;
            await sock.sendMessage(g, { text: decorateLock(false) }).catch(() => {});
        } catch (e) {
            unlockFails[g] = (unlockFails[g] || 0) + 1;
            if (unlockFails[g] >= 5) { delete db.pendingUnlocks[g]; delete unlockFails[g]; ch = true; }
            else { db.pendingUnlocks[g] = Date.now() + 30000; ch = true; }
        }
    }
    if (ch) saveDb();
}

function userKey(jid) { return cleanNumber(String(jid || "").split("@")[0].split(":")[0]); }
function getProtectedEntry(gj, mj) {
    const g = db.protectedMembers?.[gj]; if (!g) return null;
    const k = userKey(mj);
    for (const [j, v] of Object.entries(g)) if (userKey(j) === k) return { jid: j, ...v };
    return null;
}
function removeProtectedEntry(gj, mj) {
    const e = getProtectedEntry(gj, mj); if (!e) return false;
    delete db.protectedMembers[gj][e.jid];
    if (!Object.keys(db.protectedMembers[gj]).length) delete db.protectedMembers[gj];
    saveDb(); return true;
}
async function handleProtectedDemote(sock, update) {
    const jid = update.id, author = update.author;
    if (!jid || !author || !db.protectedMembers?.[jid]) return;
    const aNum = userKey(author);
    if (aNum === getBotNumber(sock) || getOwnerNumbers().includes(aNum)) return;
    const victims = [];
    for (const p of update.participants || []) {
        const pid = typeof p === "string" ? p : p?.id;
        if (!pid || userKey(pid) === aNum) continue;
        if (getProtectedEntry(jid, pid)) victims.push(pid);
    }
    if (!victims.length) return;
    const [r1, r2] = await Promise.allSettled([
        sock.groupParticipantsUpdate(jid, victims, "promote"),
        sock.groupParticipantsUpdate(jid, [author], "demote")
    ]);
    const punished = r2.status === "fulfilled" && String(r2.value?.[0]?.status || "200") === "200";
    const restored = r1.status === "fulfilled";
    let admins = [];
    const meta = (await sock.groupMetadata(jid).catch(() => null)) || getCachedMeta(jid);
    if (meta?.participants) admins = meta.participants.filter(p => p.admin).map(p => p.id).filter(id => userKey(id) !== getBotNumber(sock) && userKey(id) !== aNum);
    const adminTags = admins.length ? admins.map(a => `@${userKey(a)}`).join(" ") : "الأدمن";
    const victimTags = victims.map(v => `@${userKey(v)}`).join(" ");
    const authorTag = `@${aNum}`;
    const verdict = punished ? "لقد تم سحب اشرافك" : "لقد تم إبطال محاولتك" + (restored ? " وإرجاع الاشراف" : "");
    await sock.sendMessage(jid, {
        text: `◆━─━─━─⊱⛔⊰─━─━─━◆\n${adminTags}\nايها الرتب هناك من حاول نــزع \nالاشراف من ${victimTags}\n\`المشكوك:\` ${authorTag}\nالمدعو ${authorTag}.  ${verdict} \nلأنك حاولت العبث في اشراف شخص\nلديه سلطة عالية وحماية مطلقة. \n◆━─━─━─⊱⚠️⊰─━─━─━◆`,
        mentions: [...new Set([...admins, ...victims, author])]
    }).catch(() => {});
}

const BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
async function sendBackup(sock, gj, reason = "تلقائي") {
    try {
        saveDb();
        const buf = fs.readFileSync(dbFile);
        const stamp = new Date().toISOString().slice(0, 16).replace("T", "_").replace(":", "-");
        await sock.sendMessage(gj, { document: buf, mimetype: "application/json", fileName: `database-${stamp}.json`, caption: `💾 *نسخة احتياطية* (${reason})\n🕒 ${new Date().toLocaleString("ar")}\n📦 ${(buf.length/1024).toFixed(1)} KB` });
        if (!db.lastBackupAt) db.lastBackupAt = {};
        db.lastBackupAt[gj] = Date.now();
        saveDb(); return true;
    } catch (e) { _originalError("❌ Backup:", e?.message); return false; }
}
async function runBackupCheck() {
    const sock = currentSock; if (!sock?.user || shuttingDown) return;
    for (const g of Object.keys(db.backupGroups || {})) {
        if (!db.backupGroups[g]) continue;
        const last = db.lastBackupAt?.[g] || 0;
        if (Date.now() - last >= BACKUP_INTERVAL_MS) await sendBackup(sock, g);
    }
}

const contactHooks = {
    scheduleUnlock,
    getReportGroups: () => (Array.isArray(db.blacklistGroups) ? db.blacklistGroups : []),
    getGroupName: async (jid) => (await getGroupMetaFast(currentSock, jid))?.subject
};
function fastContactGuard(sock, msg) {
    const jid = msg?.key?.remoteJid;
    if (!jid || !jid.endsWith("@g.us") || msg.key.fromMe) return false;
    const sender = msg.key.participant;
    if (!sender) return false;
    if (!db.groupSettings[jid]?.protection) return false;
    if (isPunished(jid, sender)) { handlePunishedFollowUp(sock, jid, sender, msg); return true; }
    if (!isContactMessage(msg.message)) return false;
    if (isTrustedSender(jid, sender)) return false;
    handleAntiContact(sock, jid, sender, msg, contactHooks);
    return true;
}
function shouldProcess(msg, type) {
    if (!msg?.message) return false;
    if (msg.key?.id && botSentIds.has(msg.key.id)) return false;
    if (type === "notify") return true;
    if (type === "append" && msg.key?.fromMe && messageAgeSec(msg) <= 30) return true;
    return false;
}
function cleanupSocket(sock) {
    if (!sock?.ev) return;
    try { sock.ev.removeAllListeners(); } catch {}
    try { sock.ws?.close(); } catch {}
}
function getSessionDir() { return path.join(DATA_DIR, settings.sessionName || settings.sessionFolder || "session"); }
function scheduleReconnect(ms) {
    if (shuttingDown) return;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => { reconnectTimer = null; isReconnecting = false; startBot().catch(e => _originalError("Reconnect:", e?.message)); }, ms);
}

// ====== 🔑 رمز اقتران واحد فقط ======
async function showPairingCodeOnce(sock, phone) {
    if (pairingCodeShown) { _originalLog(`ℹ️ الرمز الحالي: [ ${lastPairingCode} ] — لم يُطلب رمز جديد.`); return; }
    pairingCodeShown = true;
    const p = cleanNumber(phone);
    if (!p || p.length < 8) { _originalError("❌ رقم غير صحيح في settings.json → botNumber"); return; }
    try {
        _originalLog(`📱 طلب رمز اقتران للرقم: ${p}`);
        let code = await sock.requestPairingCode(p);
        code = code?.match(/.{1,4}/g)?.join("-") || code;
        lastPairingCode = code;
        _originalLog("\n╔════════════════════════════════════╗");
        _originalLog(`║  🔑 رمز الاقتران: [ ${code} ]  ║`);
        _originalLog("╚════════════════════════════════════╝");
        _originalLog("📌 افتح واتساب → الأجهزة المرتبطة → ربط جهاز → ربط برقم الهاتف");
        _originalLog("⏳ الرمز ثابت ولا يتغير. أدخله في واتساب الآن.");
        _originalLog("⚠️ إذا فشل، أوقف البوت (Ctrl+C) وأعد التشغيل.\n");
    } catch (e) { _originalError("❌ فشل الرمز:", e?.message); pairingCodeShown = false; }
}

async function startBot() {
    if (isReconnecting || shuttingDown) return;
    isReconnecting = true;
    try {
        if (currentSock) { cleanupSocket(currentSock); currentSock = null; }
        const { state, saveCreds } = await useMultiFileAuthState(getSessionDir());
        let version; try { const r = await fetchLatestBaileysVersion(); version = r?.version; } catch {}
        let logger; try { logger = P({ level: "silent" }); } catch {}
        const opts = {
            auth: state, printQRInTerminal: false, logger,
            markOnlineOnConnect: true, syncFullHistory: false,
            browser: ["Ubuntu", "Chrome", "20.0.04"],
            cachedGroupMetadata: async (gid) => getCachedMeta(gid)
        };
        if (version) opts.version = version;
        const sock = makeWASocket(opts);
        currentSock = sock;
        const rawSend = sock.sendMessage.bind(sock);
        sock.sendMessage = (to, content, o = {}) => { const id = o?.messageId || genMessageId(); rememberBotSent(id); return rawSend(to, content, { ...o, messageId: id }); };

        const owners = getOwnerNumbers();
        const pairingNumber = cleanNumber(settings.botNumber || "") || owners[0] || "";

        if (!sock.authState.creds.registered && pairingNumber) {
            if (!pairingCodeShown) {
                _originalLog("⏳ انتظار 12 ثانية قبل طلب الرمز...");
                if (pairingCodeTimer) clearTimeout(pairingCodeTimer);
                pairingCodeTimer = setTimeout(() => { if (currentSock === sock) showPairingCodeOnce(sock, pairingNumber); }, 12000);
            } else if (lastPairingCode) {
                _originalLog(`ℹ️ إعادة اتصال — الرمز الحالي: [ ${lastPairingCode} ]`);
            }
        } else if (sock.authState.creds.registered) {
            _originalLog("✅ الجلسة موجودة، جاري الاتصال...");
        }

        sock.ev.on("creds.update", saveCreds);

        sock.ev.on("connection.update", (u) => {
            const { connection, lastDisconnect } = u || {};
            if (connection === "open") {
                isReconnecting = false; reconnectAttempts = 0;
                pairingCodeShown = false; lastPairingCode = null;
                lastActivityAt = Date.now();
                startWatchdog();
                initBotat({ owners: getOwnerNumbers(), botNumber: getBotNumber(sock), isTrusted: isTrustedSender });
                warmGroupCache(sock);
                _originalLog("✅ تم اتصال البوت بنجاح!");
                return;
            }
            if (connection === "close") {
                stopWatchdog();
                if (shuttingDown) return;
                const sc = lastDisconnect?.error?.output?.statusCode;
                reconnectAttempts++;
                const d = Math.min(1000 * Math.pow(2, Math.min(reconnectAttempts, 5)), 30000);
                _originalWarn(`⚠️ انقطع (${sc}). إعادة المحاولة بعد ${Math.ceil(d/1000)}ث`);
                scheduleReconnect(d);
            }
        });

        sock.ev.on("group-participants.update", async (update) => {
            try {
                lastActivityAt = Date.now();
                const jid = update.id; if (!jid) return;
                applyParticipantsToCache(update);
                const sJid = ensureGroupSettings(jid);
                if (update.action === "add") botatOnParticipants(sock, update).catch(() => {});
                if (update.action === "demote") await handleProtectedDemote(sock, update).catch(e => _originalError("Protected:", e?.message));
                if (sJid.leave && update.action === "remove" && userKey(update.author) !== getBotNumber(sock)) {
                    await handleAntiLeaveZzs(sock, update, { scheduleUnlock }).catch(() => {});
                }
                if (update.action === "remove") {
                    const author = update.author, target = update.participants?.[0];
                    if (!author || !target) return;
                    const aNum = userKey(author);
                    const isOA = getOwnerNumbers().includes(aNum) || aNum === getBotNumber(sock);
                    if (isProtectedAdmin(jid, author) && !isOA) {
                        try {
                            await sock.groupParticipantsUpdate(jid, [target], "add").catch(() => {});
                            await sock.groupParticipantsUpdate(jid, [author], "demote").catch(() => {});
                            await sock.groupSettingUpdate(jid, "announcement").catch(() => {});
                            removeProtectedAdmin(jid, author);
                            const aT = `@${aNum}`, tT = `@${cleanNumber(target.split("@")[0])}`;
                            await sock.sendMessage(jid, {
                                text: `${DECOR.topEm}\n  ${DECOR.warn} *حماية الإشراف تفعّلت* ${DECOR.warn}\n${DECOR.bottomEm}\n${DECOR.sepStar}\n🚨 تم رصد محاولة زرف!\n${DECOR.sep}\n👤 المشرف المخالف: ${aT}\n🛡️ العضو المحمي: ${tT}\n${DECOR.sep}\n✅ تم إعادة العضو المحمي\n📉 تم سحب رتبة الإشراف من المخالف\n🔒 تم قفل القروب لمدة 3 دقائق\n${DECOR.sepStar}\n┊亗 〘 *بوت الإمبراطور آلَجَيـــــــّيسي* 〙 亗┊`,
                                mentions: [author, target]
                            }).catch(() => {});
                            scheduleUnlock(jid, 3 * 60 * 1000);
                            return;
                        } catch (e) { _originalError("Protected:", e?.message); }
                    }
                    if (sJid.antiZarf && !isOA && !isTrustedSender(jid, author)) {
                        const now = Date.now();
                        if (!kickTracker[jid]) kickTracker[jid] = {};
                        if (!kickTracker[jid][author]) kickTracker[jid][author] = [];
                        kickTracker[jid][author] = kickTracker[jid][author].filter(t => now - t < KICK_TRACKER_TTL_MS);
                        kickTracker[jid][author].push(now);
                        const c = kickTracker[jid][author].length;
                        const uT = `@${aNum}`;
                        if (c === 2) await sock.sendMessage(jid, { text: decorateZarfAlert(uT, 2), mentions: [author] }).catch(() => {});
                        else if (c >= 3) {
                            try {
                                await sock.groupParticipantsUpdate(jid, [author], "demote");
                                await sock.groupSettingUpdate(jid, "announcement");
                                await sock.sendMessage(jid, { text: decorateZarfAlert(uT, 3), mentions: [author] }).catch(() => {});
                                kickTracker[jid][author] = [];
                            } catch (e) { _originalError("Zarf:", e?.message); }
                        }
                    }
                }
            } catch (e) { _originalError("Group update:", e?.message); }
        });

        sock.ev.on("message-receipt.update", (u) => botatOnReceipt(sock, u).catch(() => {}));
        sock.ev.on("presence.update", (u) => botatOnPresence(sock, u).catch(() => {}));
        sock.ev.on("groups.update", (us) => {
            for (const u of us || []) { const e = groupMetaCache.get(u?.id); if (e?.meta) Object.assign(e.meta, u); }
        });

        sock.ev.on("messages.upsert", async ({ messages, type }) => {
            if (!Array.isArray(messages) || !messages.length) return;
            const rest = [];
            for (const m of messages) {
                try {
                    if (m?.message) m.message = unwrapMessage(m.message);
                    if (DEBUG_INCOMING) _originalLog(`[in] type=${type} fromMe=${m?.key?.fromMe} jid=${m?.key?.remoteJid} id=${m?.key?.id}`);
                    if (type === "notify" || (type === "append" && messageAgeSec(m) <= 120)) {
                        if (fastContactGuard(sock, m)) continue;
                    }
                } catch (e) { _originalError("Fast guard:", e?.message); }
                rest.push(m);
            }
            const work = [];
            for (const msg of rest) {
                if (!shouldProcess(msg, type)) continue;
                lastActivityAt = Date.now();
                work.push(handleIncomingMessage(sock, msg).catch(e => _originalError("Msg:", e?.message)));
            }
            if (work.length) await Promise.allSettled(work);
        });

        _originalLog("✅ تم تسجيل جميع Events");
    } catch (e) {
        _originalError("❌ فشل Socket:", e?.message);
        isReconnecting = false;
        reconnectAttempts++;
        scheduleReconnect(Math.min(1000 * Math.pow(2, Math.min(reconnectAttempts, 5)), 30000));
    }
}

// ====== Handle Messages ======
async function handleIncomingMessage(sock, msg) {
    const jid = msg.key.remoteJid; if (!jid) return;
    const botNumber = getBotNumber(sock) + "@s.whatsapp.net";
    const sender = msg.key.fromMe ? botNumber : (msg.key.participant || jid);
    const isGroup = jid.endsWith("@g.us");
    const mText = getMessageText(msg);
    const mContent = msg.message;
    const sJid = isGroup ? ensureGroupSettings(jid) : DEFAULT_SETTINGS_JID();
    const sNum = cleanNumber(sender.split("@")[0]);
    const owners = getOwnerNumbers();
    const isOwner = owners.includes(sNum) || msg.key.fromMe || sender === botNumber;
    const hasLA = isOwner || isTrustedSender(jid, sender);

    if (isGroup && !msg.key.fromMe && !isOwner && !hasLA) trackMessage(jid, sender, msg.key);
    if (isGroup && !msg.key.fromMe) botatOnMessage(sock, msg).catch(() => {});

    if (isGroup && sJid.antiMention && !isOwner && !msg.key.fromMe) {
        const mj = getMentionedJids(msg.message);
        const hasH = mj.some(t => isTrustedSender(jid, t));
        if (hasH || mj.length >= 10) {
            try { await sock.sendMessage(jid, { delete: msg.key }); } catch {}
            await sock.sendMessage(jid, { text: decorateError("منع المنشن", `⚠️ @${sNum} يمنع المنشن للرتب العليا!`), mentions: [sender] }).catch(() => {});
            return;
        }
    }

    const isEx = db.exceptions?.[jid]?.[sender];
    if (isGroup && sJid.monitoring && !isOwner && !isEx && !msg.key.fromMe) {
        const vr = checkSpamAndViolations(sock, jid, sender, msg, mText, mContent, sJid.filters);
        if (vr) {
            try { await sock.sendMessage(jid, { delete: msg.key }); } catch {}
            const gm = (await getGroupMetaFast(sock, jid)) || { participants: [] };
            const pi = (gm.participants || []).find(p => userKey(p.id) === userKey(sender));
            const isAdm = pi && (pi.admin === "admin" || pi.admin === "superadmin");
            if (isAdm) { await sock.sendMessage(jid, { text: getAdminSaluteMsg(sNum), mentions: [sender] }).catch(() => {}); return; }
            const c = addWarning(sender, jid);
            await sock.sendMessage(jid, { text: getViolationMessage(`@${sNum}`, vr, c), mentions: [sender] }).catch(() => {});
            if (c >= 10) { try { await sock.groupParticipantsUpdate(jid, [sender], "remove"); } catch {} resetWarnings(sender, jid); }
            return;
        }
    }

    if (sJid.emoji && sJid.filters.emoji && isGroup && mText && !msg.key.fromMe) {
        if (!global.emojiCounters) global.emojiCounters = {};
        if (!global.emojiCounters[jid]) global.emojiCounters[jid] = 0;
        global.emojiCounters[jid]++;
        if (global.emojiCounters[jid] >= 15) {
            global.emojiCounters[jid] = 0;
            const em = ["🔥","🍎","☘️","🍫","⭐","🐬","🍒","🍂","⚽"];
            try { await sock.sendMessage(jid, { react: { text: em[Math.floor(Math.random()*em.length)], key: msg.key } }); } catch {}
        }
    }

    let command = "", args = [];
    const mentioned = getMentionedJids(msg.message);
    const tt = mText.trim();
    if (!tt.startsWith(".")) return;
    { const p = tt.slice(1).trim().split(/\s+/); command = (p.shift() || "").toLowerCase(); args = p; }
    if (!command) return;

    const delCmd = async () => { if (isGroup && !msg.key.fromMe) { try { await sock.sendMessage(jid, { delete: msg.key }); } catch {} } };

    await handleCommands({ sock, jid, msg, command, args, mentioned, isOwner, hasLocalAccess: hasLA, settingsJid: sJid, deleteCommandMessage: delCmd, sender, senderNum: sNum, isGroup });
}

// ====== Commands ======
const reportCooldown = new Map();

async function handleCommands(ctx) {
    const { sock, jid, msg, command, args, mentioned, isOwner, hasLocalAccess, settingsJid, deleteCommandMessage, sender, senderNum, isGroup } = ctx;
    if (await handleBotatCommand({ ...ctx })) return;

    if (command === "حفظ" && getMessageText(msg).trim().startsWith(".")) {
        await deleteCommandMessage(); if (!isGroup) return;
        if (!isOwner) { await sock.sendMessage(jid, { text: decorateError("حفظ", "⚠️ للمالك فقط.") }); return; }
        if (!db.backupGroups) db.backupGroups = {};
        const a = args[0]?.toLowerCase();
        if (a === "on") { db.backupGroups[jid] = true; saveDb(); await sock.sendMessage(jid, { text: decorateSuccess("حفظ", "💾 مفعّل ✅") }); await sendBackup(sock, jid, "أول نسخة"); }
        else if (a === "off") { delete db.backupGroups[jid]; if (db.lastBackupAt) delete db.lastBackupAt[jid]; saveDb(); await sock.sendMessage(jid, { text: decorateError("حفظ", "❌ موقوف.") }); }
        else await sock.sendMessage(jid, { text: decorateInfo("استخدام", ".حفظ on/off") });
        return;
    }

    if ((command === "قائمة" || command === "القائمة") && getMessageText(msg).trim().startsWith(".")) {
        await deleteCommandMessage(); if (!isOwner && !hasLocalAccess) return; if (!isGroup) return;
        const a = args[0]?.toLowerCase();
        if (!Array.isArray(db.blacklistGroups)) db.blacklistGroups = [];
        if (a === "on") { if (!db.blacklistGroups.includes(jid)) db.blacklistGroups.push(jid); saveDb(); await sock.sendMessage(jid, { text: `◆━─━─━─⊱⊰─━─━─━◆\nتم تعيين هذا الجروب لأخبار \nالمؤبدين. بنجاح 🟢\n◆━─━─━─⊱⊰─━─━─━◆` }); }
        else if (a === "off") { db.blacklistGroups = db.blacklistGroups.filter(g => g !== jid); saveDb(); await sock.sendMessage(jid, { text: decorateError("القائمة", "🔴 ملغي.") }); }
        else await sock.sendMessage(jid, { text: decorateInfo("استخدام", ".قائمة on/off") });
        return;
    }

    if ((command === "سحب" && (args[0] === "صلاحيات" || args[0] === "الصلاحيات")) || command === "سحب_صلاحيات") {
        await deleteCommandMessage();
        if (!isOwner) { await sock.sendMessage(jid, { text: decorateError("صلاحيات", "⚠️ للمالك فقط.") }); return; }
        let target = mentioned[0];
        if (!target) { const d = cleanNumber(args.find(a => cleanNumber(a).length >= 7) || ""); if (d) target = `${d}@s.whatsapp.net`; }
        if (!target) { await sock.sendMessage(jid, { text: decorateInfo("استخدام", ".سحب صلاحيات @عضو") }); return; }
        const tN = cleanNumber(target.split("@")[0].split(":")[0]);
        if (getOwnerNumbers().includes(tN)) { await sock.sendMessage(jid, { text: decorateError("سحب", "⛔ لا يمكن سحب صلاحيات المالك.") }); return; }
        const same = (k) => cleanNumber(String(k).split("@")[0].split(":")[0]) === tN;
        let rm = 0;
        for (const k of Object.keys(db.globalAuthorized || {})) if (same(k)) { delete db.globalAuthorized[k]; rm++; }
        for (const g of Object.keys(db.authorizedUsers || {})) for (const k of Object.keys(db.authorizedUsers[g] || {})) if (same(k)) { delete db.authorizedUsers[g][k]; rm++; }
        for (const g of Object.keys(db.groupSettings || {})) { try { if (removeProtectedAdmin(g, target)) rm++; } catch {} }
        saveDb();
        await sock.sendMessage(jid, { text: decorateSuccess("سحب صلاحيات", `عزيزي/تي @${tN}\n⚙️ تم سحب كل صلاحياتك ❌\n📊 العدد: ${rm}`), mentions: [target] });
        return;
    }

    if (command === "اوامر" || command === "أوامر") {
        await deleteCommandMessage();
        if (!hasLocalAccess && !isOwner) { await sock.sendMessage(jid, { text: decorateError("صلاحيات", "⛔ للجهات العليا فقط") }, { quoted: msg }); return; }
        const menu = `${DECOR.topEm}\n${DECOR.crown} *قائمة أوامر البوت* ${DECOR.crown}\n${DECOR.bottomEm}\n\n📌 *الإدارة:*\n├ .قفل\n├ .فتح\n├ .ترقية @\n├ .إعفاء @\n├ .اشرافه @\n├ .الغاء_اشرافه @\n├ .احميه @\n├ .الغاء_احميه @\n├ .سحب صلاحيات @\n├ .قائمة on/off\n├ .حفظ on/off\n├ .معلومات\n├ .استثناء @\n\n🛡️ *الحماية:*\n├ .حماية on/off\n├ .مراقبة on/off\n├ .مغادرة on/off\n├ .الزرف on/off\n├ .منع_المنشن on/off\n├ .مراقبة_روابط on/off\n├ .مراقبة_كلمات on/off\n├ .مراقبة_سبام on/off\n├ .مراقبة_صور on/off\n├ .مراقبة_لغات on/off\n├ .مراقبة_ايموجي on/off\n\n🕵️ *كاشف:*\n├ .كاشف on/off\n├ .تعيين_استقبال\n├ .تعيين_اساسي\n├ .فحص @\n├ .قبول @\n├ .قبول_تلقائي on/off\n├ .المشتبهين\n├ .سجل_الدخول\n├ .حالة_الكاشف\n├ .تشخيص_كاشف on/off\n\n📄 *عام:*\n├ .الدعم on/off\n├ .ابلاغ [نص]\n├ .تصفير @\n├ .إعادة_ضبط_المخالفات\n\n${DECOR.topLine}`;
        await sock.sendMessage(jid, { text: menu });
        return;
    }

    const toggles = {
        "منع_المنشن": { key: "antiMention", on: "antiMention" }, "منع_منشن": { key: "antiMention", on: "antiMention" },
        "الزرف": { key: "antiZarf", on: "antiZarf" }, "زرف": { key: "antiZarf", on: "antiZarf" },
        "حماية": { key: "protection", on: "protection" }, "مغادرة": { key: "leave", on: "leave" },
        "مراقبة": { key: "monitoring", on: "monitoring" },
        "مراقبة_روابط": { key: "filters.link", on: "link" }, "مراقبةروابط": { key: "filters.link", on: "link" },
        "مراقبة_كلمات": { key: "filters.badword", on: "badword" }, "مراقبةكلمات": { key: "filters.badword", on: "badword" },
        "مراقبة_سبام": { key: "filters.sticker", on: "sticker" }, "مراقبةسبام": { key: "filters.sticker", on: "sticker" },
        "مراقبة_صور": { key: "filters.image", on: "image" }, "مراقبةصور": { key: "filters.image", on: "image" },
        "مراقبة_لغات": { key: "filters.lang", on: "lang" }, "مراقبةلغات": { key: "filters.lang", on: "lang" },
        "مراقبة_ايموجي": { key: "filters.emoji", on: "emoji" }, "مراقبةايموجي": { key: "filters.emoji", on: "emoji" }
    };

    if (toggles[command]) {
        await deleteCommandMessage();
        if (!isOwner && !hasLocalAccess) return;
        const { key, on } = toggles[command];
        const isOn = args[0]?.toLowerCase() === "on";
        if (key.startsWith("filters.")) { const fk = key.split(".")[1]; settingsJid.filters[fk] = isOn; if (fk === "emoji") settingsJid.emoji = isOn; }
        else settingsJid[key] = isOn;
        saveDb();
        const notif = isOn ? (getOnNotification(on) || "✅ مفعّل") : (getOffNotification(on) || "❌ موقوف");
        await sock.sendMessage(jid, { text: notif });
        return;
    }

    if (command === "فورمات") {
        await deleteCommandMessage();
        if (!isOwner) { await sock.sendMessage(jid, { text: decorateError("صلاحيات", "⚠️ للمالك فقط.") }); return; }
        db.groupSettings = {}; db.globalAuthorized = {}; db.authorizedUsers = {}; db.exceptions = {};
        saveDb();
        await sock.sendMessage(jid, { text: decorateSuccess("فورمات", "🔄 فورمات شامل ✅") });
        return;
    }

    if (command === "إعطاء" || command === "اعطاء") {
        await deleteCommandMessage();
        if (!isOwner) { await sock.sendMessage(jid, { text: decorateError("صلاحيات", "⚠️ للمالك فقط.") }); return; }
        if (mentioned.length > 0) {
            const t = mentioned[0];
            if (!db.globalAuthorized) db.globalAuthorized = {};
            db.globalAuthorized[t] = true; saveDb();
            await sock.sendMessage(jid, { text: decorateSuccess("منح صلاحيات", `عزيزي/تي @${t.split("@")[0]}\n⚙️ أصبح بإمكانك استخدام كل الأوامر ✅`), mentions: [t] });
        }
        return;
    }

    if (command === "منع") {
        await deleteCommandMessage();
        if (!isOwner) return;
        if (mentioned.length > 0) {
            const t = mentioned[0];
            if (isOwnerJid(t)) return;
            const same = (k) => userKey(k) === userKey(t);
            for (const k of Object.keys(db.globalAuthorized || {})) if (same(k)) delete db.globalAuthorized[k];
            for (const k of Object.keys(db.authorizedUsers?.[jid] || {})) if (same(k)) delete db.authorizedUsers[jid][k];
            saveDb();
            await sock.sendMessage(jid, { text: decorateSuccess("سحب صلاحيات", `عزيزي/تي @${t.split("@")[0]}\n⚙️ تم سحب صلاحياتك ❌`), mentions: [t] });
        }
        return;
    }

    if (command === "879") {
        if (!isOwner && !hasLocalAccess) return;
        if (isGroup) {
            try { if (!msg.key.fromMe) await sock.sendMessage(jid, { delete: msg.key }); } catch {}
            for (let i = 879; i <= 883; i++) {
                try { await sock.sendMessage(jid, { text: `${DECOR.top}\n  🚨 *بلاغ ${i}* 🚨\n${DECOR.bottom}\n${DECOR.sepStar}\n⚠️ تنبيه: بلاغ مستمر\n${DECOR.sepStar}` }); } catch {}
                await new Promise(r => setTimeout(r, 500));
            }
        }
        return;
    }

    if (command === "الدعم") {
        await deleteCommandMessage();
        if (!isOwner && !hasLocalAccess) return;
        const a = args[0]?.toLowerCase();
        if (a === "on") { settingsJid.supportActive = true; db.reportGroup = jid; saveDb(); await sock.sendMessage(jid, { text: decorateSuccess("الدعم", "🛠️ مفعّل ✅") }); }
        else if (a === "off") { settingsJid.supportActive = false; if (db.reportGroup === jid) db.reportGroup = null; saveDb(); await sock.sendMessage(jid, { text: decorateError("الدعم", "❌ موقوف.") }); }
        else await sock.sendMessage(jid, { text: decorateInfo("استخدام", ".الدعم on/off") });
        return;
    }

    if (command === "اشرافه" || command === "إشرافه") {
        await deleteCommandMessage();
        if (!isOwner && !hasLocalAccess) { await sock.sendMessage(jid, { text: decorateError("صلاحيات", "⚠️ للجهات العليا فقط.") }, { quoted: msg }); return; }
        if (mentioned.length === 0) { await sock.sendMessage(jid, { text: decorateInfo("استخدام", "`.اشرافه @user`\n🛡️ يحمي إشرافه\n🚫 زرف → سحب فوري + قفل") }, { quoted: msg }); return; }
        const t = mentioned[0];
        const tN = cleanNumber(t.split("@")[0]);
        try {
            await sock.groupParticipantsUpdate(jid, [t], "promote");
            addProtectedAdmin(jid, t, sender);
            await sock.sendMessage(jid, {
                text: `${DECOR.topEm}\n${DECOR.shield} *إشــرافــه مــحــمــي* ${DECOR.shield}\n${DECOR.sepStar}\n👤 العضو: @${tN}\n👑 الرتبة: مشرف محمي 🛡️\n${DECOR.sep}\n✅ تم ترقية العضو\n🔒 إشرافه محمي\n🚫 زرف → سحب فوري\n🔐 + قفل القروب\n${DECOR.sepStar}\n${DECOR.bottomEm}`,
                mentions: [t]
            });
        } catch (e) { _originalError("اشرافه:", e?.message); await sock.sendMessage(jid, { text: decorateError("خطأ", "❌ تأكد أن البوت مشرف.") }); }
        return;
    }

    if (command === "احميه" || command === "احمية") {
        await deleteCommandMessage();
        if (!isGroup) return;
        if (!isOwner && !hasLocalAccess) { await sock.sendMessage(jid, { text: decorateError("صلاحيات", "⚠️ للجهات العليا فقط.") }); return; }
        let t = mentioned[0] || msg.message?.extendedTextMessage?.contextInfo?.participant;
        if (!t) { const d = cleanNumber(args.find(a => cleanNumber(a).length >= 7) || ""); if (d) t = `${d}@s.whatsapp.net`; }
        if (!t) { await sock.sendMessage(jid, { text: decorateInfo("استخدام", "`.احميه @user`") }); return; }
        if (!db.protectedMembers) db.protectedMembers = {};
        if (!db.protectedMembers[jid]) db.protectedMembers[jid] = {};
        const old = getProtectedEntry(jid, t);
        if (old) delete db.protectedMembers[jid][old.jid];
        db.protectedMembers[jid][t] = { addedBy: sender, addedAt: Date.now() };
        saveDb();
        let note = "";
        const meta = await sock.groupMetadata(jid).catch(() => null);
        if (meta?.participants) {
            const me = meta.participants.find(p => userKey(p.id) === getBotNumber(sock));
            const him = meta.participants.find(p => userKey(p.id) === userKey(t));
            if (!me?.admin) note += "\n⚠️ البوت ليس مشرفاً!";
            if (!him?.admin) note += "\nℹ️ العضو ليس مشرفاً حالياً.";
        }
        await sock.sendMessage(jid, {
            text: `◆━─━─━─⊱🛡️⊰─━─━─━◆\nتم تفعيل الحماية المطلقة للعضو @${userKey(t)}\n${DECOR.sep}\n🚫 أي شخص يحاول سحب اشرافه\n↩️ يرجع الاشراف للمحمي فوراً\n📉 ويُسحب اشراف المعتدي\n◆━─━─━─⊱✅⊰─━─━─━◆${note}`,
            mentions: [t]
        });
        return;
    }

    if (command === "الغاء_احميه" || command === "الغاء_حمايه" || command === "الغاء_حماية") {
        await deleteCommandMessage();
        if (!isGroup || (!isOwner && !hasLocalAccess)) return;
        const t = mentioned[0] || msg.message?.extendedTextMessage?.contextInfo?.participant;
        if (!t) return;
        const was = removeProtectedEntry(jid, t);
        await sock.sendMessage(jid, { text: decorateSuccess("إلغاء الحماية", was ? `🔓 تم إلغاء الحماية عن @${userKey(t)}` : `ℹ️ @${userKey(t)} ليس محمياً`), mentions: [t] });
        return;
    }

    if (command === "الغاء_اشرافه" || command === "إلغاء_إشرافه") {
        await deleteCommandMessage();
        if (!isOwner && !hasLocalAccess) return;
        if (mentioned.length === 0) return;
        const t = mentioned[0];
        const tN = cleanNumber(t.split("@")[0]);
        const was = removeProtectedAdmin(jid, t);
        await sock.sendMessage(jid, { text: decorateSuccess("إلغاء الحماية", was ? `🔓 تم إلغاء حماية إشراف @${tN}\n⚠️ مشرف عادي` : `ℹ️ @${tN} ليس مشرفاً محمياً`), mentions: [t] });
        return;
    }

    if (command === "استثناء") {
        await deleteCommandMessage();
        if (!isOwner && !hasLocalAccess) return;
        if (mentioned.length > 0) {
            const t = mentioned[0];
            if (!db.exceptions[jid]) db.exceptions[jid] = {};
            db.exceptions[jid][t] = true; saveDb();
            await sock.sendMessage(jid, { text: decorateSuccess("استثناء", "✅ تم إيقاف مراقبة العضو ✅"), mentions: [t] });
        }
        return;
    }

    if (command === "قفل") {
        await deleteCommandMessage();
        if (!isOwner && !hasLocalAccess) return;
        try { await sock.groupSettingUpdate(jid, "announcement"); await sock.sendMessage(jid, { text: decorateLock(true) }); } catch {}
        return;
    }

    if (command === "فتح") {
        await deleteCommandMessage();
        if (!isOwner && !hasLocalAccess) return;
        try { await sock.groupSettingUpdate(jid, "not_announcement"); await sock.sendMessage(jid, { text: decorateLock(false) }); } catch {}
        return;
    }

    if (command === "معلومات") {
        await deleteCommandMessage();
        if (!isGroup || (!isOwner && !hasLocalAccess)) return;
        try {
            const gm = await sock.groupMetadata(jid);
            const ps = gm.participants;
            const o = ps.find(p => p.admin === "superadmin");
            const oT = o ? `@${o.id.split("@")[0]}` : "لا احد ❗";
            const ad = ps.filter(p => p.admin).map(p => `@${p.id.split("@")[0]}`);
            const tr = Object.keys(db.authorizedUsers?.[jid] || {}).map(u => `@${u.split("@")[0]}`);
            const nm = ps.filter(p => !p.admin).slice(0, 4).map(p => `@${p.id.split("@")[0]}`);
            const text = `${DECOR.topEm}\n${DECOR.crown} *هيكلة القروب* ${DECOR.crown}\n${DECOR.bottomEm}\n\n👑『 صاحب القروب 』👑\n╠ ${oT}\n\n🛡️『 المشرفين 』🛡️\n${ad.length ? ad.map(a => `╠ ${a}`).join("\n") : "╠ لا احد ❗"}\n\n👥『 الموثوقين 』👥\n${tr.length ? tr.map(t => `╠ ${t}`).join("\n") : "╠ لا احد ❗"}\n\n🌟『 الأعضاء 』🌟\n${nm.length ? nm.map(m => `╠ ${m}`).join("\n") : "╠ لا احد ❗"}\n${DECOR.topLine}`;
            await sock.sendMessage(jid, { text, mentions: ps.map(p => p.id) });
        } catch { await sock.sendMessage(jid, { text: decorateError("خطأ", "❌ فشل جلب الهيكلة.") }); }
        return;
    }

    if (command === "ترقية") {
        await deleteCommandMessage();
        if (!isOwner && !hasLocalAccess) return;
        if (mentioned.length > 0) {
            const t = mentioned[0];
            try {
                await sock.groupParticipantsUpdate(jid, [t], "promote");
                await sock.sendMessage(jid, { text: decorateRank("promote", `@${t.split("@")[0]}`, new Date().toLocaleDateString()), mentions: [t] });
            } catch {}
        }
        return;
    }

    if (command === "إعفاء" || command === "اعفاء") {
        await deleteCommandMessage();
        if (!isOwner && !hasLocalAccess) return;
        if (mentioned.length > 0) {
            const t = mentioned[0];
            if (!isOwner && (isOwnerJid(t) || userKey(t) === getBotNumber(sock))) { await sock.sendMessage(jid, { text: decorateError("إعفاء", "⛔ لا يمكن سحب إشراف المالك/البوت.") }).catch(() => {}); return; }
            try {
                await sock.groupParticipantsUpdate(jid, [t], "demote");
                await sock.sendMessage(jid, { text: decorateRank("demote", `@${t.split("@")[0]}`), mentions: [t] });
            } catch {}
        }
        return;
    }

    if (command === "تصفير") {
        await deleteCommandMessage();
        if (!isOwner && !hasLocalAccess) return;
        if (mentioned.length > 0) { resetWarnings(mentioned[0], jid); await sock.sendMessage(jid, { text: decorateSuccess("تصفير", "✅ تم التصفير ✅") }); }
        return;
    }

    if (command === "إعادة_ضبط_المخالفات" || command === "اعادة_ضبط_المخالفات") {
        await deleteCommandMessage();
        if (!isOwner && !hasLocalAccess) return;
        resetWarnings(null, jid);
        await sock.sendMessage(jid, { text: decorateSuccess("إعادة ضبط", "🔄 تم إعادة ضبط الجميع ✅") });
        return;
    }

    if (command === "ابلاغ") {
        await deleteCommandMessage();
        const rT = args.join(" ").slice(0, 1000);
        const lR = reportCooldown.get(sender) || 0;
        if (Date.now() - lR < 30000) return;
        reportCooldown.set(sender, Date.now());
        if (reportCooldown.size > 2000) reportCooldown.delete(reportCooldown.keys().next().value);
        if (!rT) { await sock.sendMessage(jid, { text: decorateInfo("استخدام", "⚠️ اكتب نص البلاغ.") }, { quoted: msg }); return; }
        const tRJ = db.reportGroup;
        if (tRJ && db.groupSettings[tRJ]?.supportActive) {
            try {
                await sock.sendMessage(tRJ, { text: `${DECOR.topEm}\n${DECOR.sparkle} *شكوى جديدة* ${DECOR.sparkle}\n${DECOR.bottomEm}\n\n${rT}\n\n${DECOR.topLine}` });
                await sock.sendMessage(jid, { text: decorateSuccess("إرسال البلاغ", "📄 تم الإرسال ✅") }, { quoted: msg });
            } catch {}
        }
        return;
    }
}

// ====== Main ======
async function main() {
    try {
        _originalLog("╔════════════════════════════════════╗");
        _originalLog("║   🤖 BOT ALJESI START              ║");
        _originalLog("╚════════════════════════════════════╝");
        if (cleanupInterval) clearInterval(cleanupInterval);
        cleanupInterval = setInterval(runCleanup, 10 * 60 * 1000);
        setTimeout(runCleanup, 30 * 1000);
        const bt = setInterval(() => runBackupCheck().catch(() => {}), 30 * 60 * 1000);
        bt.unref?.();
        setTimeout(() => runBackupCheck().catch(() => {}), 90 * 1000);
        const ut = setInterval(() => runUnlockCheck().catch(() => {}), 15 * 1000);
        ut.unref?.();
        await startBot();
    } catch (e) { _originalError("❌ فشل التشغيل:", e?.message); }
}

function shutdown() {
    shuttingDown = true; stopWatchdog();
    if (cleanupInterval) clearInterval(cleanupInterval);
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (pairingCodeTimer) clearTimeout(pairingCodeTimer);
    saveDb(); flushBotat();
    process.exit(0);
}

process.once("SIGINT", () => shutdown());
process.once("SIGTERM", () => shutdown());
main().catch(e => _originalError("Fatal:", e?.message));
