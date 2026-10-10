// index.js - BOT ALJESI - ESM Version for Baileys 6.7.9

// ============================================================
// 🔐 Crypto Polyfill
// ============================================================

import { webcrypto, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (typeof globalThis.crypto === "undefined") {
    globalThis.crypto = webcrypto;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================
// Imports
// ============================================================

import makeWASocket, {
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion
} from "@whiskeysockets/baileys";

import P from "pino";

import {
    getOnNotification,
    getOffNotification,
    getViolationMessage,
    getAdminSaluteMsg
} from "./dark.js";

import {
    trackMessage,
    handleAntiContact,
    handleAntiLeaveZzs,
    cleanupRecentMessages,
    cleanupPunished,
    isPunished,
    handlePunishedFollowUp,
    normJid
} from "./haolk.js";

import {
    addWarning,
    resetWarnings,
    checkSpamAndViolations,
    cleanupMemory,
    addProtectedAdmin,
    removeProtectedAdmin,
    isProtectedAdmin
} from "./trim.js";

import {
    DECOR,
    decorateSuccess,
    decorateError,
    decorateLock,
    decorateRank,
    decorateInfo,
    decorateZarfAlert
} from "./decor.js";

import {
    initBotat,
    onParticipantsUpdate as botatOnParticipants,
    onMessage as botatOnMessage,
    onReceipt as botatOnReceipt,
    onPresence as botatOnPresence,
    handleBotatCommand,
    cleanupBotat,
    flushBotat
} from "./botat.js";

// Load settings.json
const settingsPath = path.join(__dirname, "settings.json");
let settings = {};
try {
    settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
} catch (e) {
    console.error("⚠️ تعذر قراءة settings.json:", e?.message);
}

if (process.env.OWNERS) settings.owners = process.env.OWNERS.split(",").map(x => x.trim()).filter(Boolean);
if (process.env.BOT_NUMBER) settings.botNumber = process.env.BOT_NUMBER;

const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : __dirname;
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}

// ============================================================
// 🛡️ LogGuard
// ============================================================

const _originalLog = console.log.bind(console);
const _originalError = console.error.bind(console);
const _originalWarn = console.warn.bind(console);

const logGuard = {
    count: 0,
    windowStart: Date.now(),
    WINDOW_MS: 1000,
    MAX_PER_WINDOW: 30,
    dropped: 0,
    silenced: false,
    canLog() {
        const now = Date.now();
        if (now - this.windowStart >= this.WINDOW_MS) {
            this.windowStart = now;
            this.count = 0;
            if (this.silenced) {
                this.silenced = false;
                _originalWarn(`⚠️ [LogGuard] تم استئناف السجلات. تم إسقاط ${this.dropped} سطر.`);
                this.dropped = 0;
            }
        }
        this.count++;
        if (this.count > this.MAX_PER_WINDOW) {
            this.silenced = true;
            this.dropped++;
            return false;
        }
        return true;
    }
};

console.log = (...args) => { if (logGuard.canLog()) _originalLog(...args); };
console.error = (...args) => { if (logGuard.canLog()) _originalError(...args); };
console.warn = (...args) => { if (logGuard.canLog()) _originalWarn(...args); };

// ============================================================
// قاعدة البيانات
// ============================================================

const dbFile = path.join(DATA_DIR, "database.json");

const DEFAULT_SETTINGS_JID = () => ({
    protection: false,
    leave: false,
    monitoring: false,
    emoji: false,
    antiMention: false,
    antiZarf: false,
    supportActive: false,
    filters: { link: true, badword: true, image: true, sticker: true, lang: true, emoji: true }
});

let db = {
    authorizedUsers: {},
    globalAuthorized: {},
    groupSettings: {},
    reportGroup: null,
    blacklistGroups: [],
    exceptions: {},
    backupGroups: {},
    lastBackupAt: {},
    protectedMembers: {},
    pendingUnlocks: {}
};

if (fs.existsSync(dbFile)) {
    try {
        const raw = fs.readFileSync(dbFile, "utf8");
        if (raw.trim()) {
            try {
                const parsed = JSON.parse(raw);
                if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                    db = { ...db, ...parsed };
                }
            } catch (e) {
                try { fs.copyFileSync(dbFile, `${dbFile}.corrupt-${Date.now()}`); } catch {}
                _originalError("⚠️ database.json تالف، حُفظت نسخة منه.");
            }
        }
    } catch (e) {
        _originalError("⚠️ لم يتمكن البوت من قراءة database.json:", e?.message);
    }
}
for (const k of ["authorizedUsers", "globalAuthorized", "groupSettings", "exceptions", "backupGroups", "lastBackupAt", "protectedMembers", "pendingUnlocks"]) {
    if (!db[k] || typeof db[k] !== "object" || Array.isArray(db[k])) db[k] = {};
}
if (!Array.isArray(db.blacklistGroups)) db.blacklistGroups = [];

function saveDb() {
    try {
        const tmp = `${dbFile}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
        fs.renameSync(tmp, dbFile);
    } catch (e) {
        _originalError("❌ خطأ أثناء حفظ قاعدة البيانات:", e?.message);
    }
}

// ============================================================
// Runtime / Global refs
// ============================================================

let currentSock = null;
let reconnectTimer = null;
let isReconnecting = false;
let shuttingDown = false;
let reconnectAttempts = 0;
let pairingCodeRequested = false;
let pairingRetryTimer = null;

const kickTracker = {};
const KICK_TRACKER_TTL_MS = 10 * 60 * 1000;

let watchdogInterval = null;
let lastActivityAt = Date.now();
let cleanupInterval = null;

const WATCHDOG_CHECK_MS = 60 * 1000;
const IDLE_THRESHOLD_MS = 20 * 60 * 1000;
const MAX_IDLE_CHECKS = 15;

// ============================================================
// شبكة أمان
// ============================================================

let lastExceptionAt = 0;
const EXCEPTION_COOLDOWN_MS = 5000;

process.on("uncaughtException", (error) => {
    const now = Date.now();
    if (now - lastExceptionAt < EXCEPTION_COOLDOWN_MS) return;
    lastExceptionAt = now;
    _originalError("❌ Uncaught Exception:", error?.message || error);
});

process.on("unhandledRejection", (reason) => {
    const now = Date.now();
    if (now - lastExceptionAt < EXCEPTION_COOLDOWN_MS) return;
    lastExceptionAt = now;
    _originalError("❌ Unhandled Rejection:", reason?.message || reason);
});

// ============================================================
// Helpers
// ============================================================

function getOwnerNumbers() {
    const list = Array.isArray(settings.owners) ? settings.owners : (settings.owners ? [settings.owners] : []);
    return list.map(n => String(n).replace(/[^0-9]/g, "")).filter(Boolean);
}

function getBotNumber(sock) {
    try {
        return String(sock?.user?.id || "").split(":")[0].replace(/[^0-9]/g, "");
    } catch {
        return "";
    }
}

function cleanNumber(v) {
    if (!v) return "";
    return String(v).replace(/[^0-9]/g, "");
}

function getMentionedJids(m) {
    if (!m) return [];
    const ctx =
        m.extendedTextMessage?.contextInfo ||
        m.imageMessage?.contextInfo ||
        m.videoMessage?.contextInfo ||
        m.documentMessage?.contextInfo ||
        null;
    const list = ctx?.mentionedJid;
    return Array.isArray(list) ? list : [];
}

function getMessageText(msg) {
    if (!msg?.message) return "";
    const m = msg.message;
    return (
        m.conversation ||
        m.extendedTextMessage?.text ||
        m.imageMessage?.caption ||
        m.videoMessage?.caption ||
        m.documentMessage?.caption ||
        ""
    );
}

// ============================================================
// تنظيف الذاكرة
// ============================================================

function cleanupKickTracker() {
    const now = Date.now();
    try {
        for (const jid of Object.keys(kickTracker)) {
            for (const author of Object.keys(kickTracker[jid])) {
                kickTracker[jid][author] = kickTracker[jid][author].filter(t => now - t < KICK_TRACKER_TTL_MS);
                if (kickTracker[jid][author].length === 0) {
                    delete kickTracker[jid][author];
                }
            }
            if (Object.keys(kickTracker[jid]).length === 0) {
                delete kickTracker[jid];
            }
        }
    } catch {}
}

function runCleanup() {
    try {
        cleanupMemory();
        cleanupKickTracker();
        cleanupRecentMessages();
        cleanupBotat();
        cleanupPunished();
    } catch (e) {
        _originalError("Cleanup error:", e?.message);
    }
}

// ============================================================
// Watchdog
// ============================================================

function startWatchdog() {
    lastActivityAt = Date.now();
    if (watchdogInterval) clearInterval(watchdogInterval);

    let idleChecks = 0;

    watchdogInterval = setInterval(() => {
        try {
            const idle = Date.now() - lastActivityAt;

            if (idle > IDLE_THRESHOLD_MS) {
                idleChecks++;
                _originalWarn(`⚠️ Watchdog: خمول ${Math.round(idle / 60000)}د (${idleChecks}/${MAX_IDLE_CHECKS})`);

                if (idleChecks >= MAX_IDLE_CHECKS) {
                    _originalWarn("🔄 Watchdog: إعادة تشغيل الاتصال قسرياً...");
                    idleChecks = 0;
                    try {
                        if (currentSock?.ws) currentSock.ws.close();
                    } catch {}
                }
            } else {
                idleChecks = 0;
            }
        } catch (e) {
            _originalError("Watchdog error:", e?.message);
        }
    }, WATCHDOG_CHECK_MS);
}

function stopWatchdog() {
    if (watchdogInterval) clearInterval(watchdogInterval);
    watchdogInterval = null;
}

// ============================================================
// ⚡ أدوات السرعة
// ============================================================

const DEBUG_INCOMING = !!process.env.BOT_DEBUG;

const WRAPPERS = [
    "ephemeralMessage", "viewOnceMessage", "viewOnceMessageV2",
    "viewOnceMessageV2Extension", "documentWithCaptionMessage", "deviceSentMessage"
];

function unwrapMessage(message) {
    let m = message;
    for (let i = 0; i < 6 && m; i++) {
        const w = WRAPPERS.find(k => m[k]?.message);
        if (!w) break;
        m = m[w].message;
    }
    return m;
}

function isContactMessage(m) {
    if (!m) return false;
    if (m.contactMessage || m.contactsArrayMessage || m.vcardMessage) return true;
    const mime = String(m.documentMessage?.mimetype || "").toLowerCase();
    return mime.includes("vcard");
}

function messageAgeSec(msg) {
    const t = Number(msg?.messageTimestamp?.low ?? msg?.messageTimestamp ?? 0);
    return t ? Math.max(0, Date.now() / 1000 - t) : 0;
}

const botSentIds = new Set();
function rememberBotSent(id) {
    botSentIds.add(id);
    if (botSentIds.size > 3000) botSentIds.delete(botSentIds.values().next().value);
}
function genMessageId() {
    return "3EB0" + randomBytes(18).toString("hex").toUpperCase();
}

const groupMetaCache = new Map();
const GROUP_META_TTL_MS = 10 * 60 * 1000;

function getCachedMeta(jid) {
    const e = groupMetaCache.get(jid);
    return e && Date.now() - e.at < GROUP_META_TTL_MS ? e.meta : undefined;
}

async function getGroupMetaFast(sock, jid) {
    const cached = getCachedMeta(jid);
    if (cached) return cached;
    try {
        const meta = await sock.groupMetadata(jid);
        groupMetaCache.set(jid, { meta, at: Date.now() });
        return meta;
    } catch {
        return null;
    }
}

async function warmGroupCache(sock) {
    try {
        const all = await sock.groupFetchAllParticipating();
        for (const [jid, meta] of Object.entries(all || {})) {
            groupMetaCache.set(jid, { meta, at: Date.now() });
        }
        _originalLog(`⚡ تم تحميل ${groupMetaCache.size} قروب في الكاش`);
    } catch (e) {
        _originalWarn("⚠️ تعذر تحميل كاش القروبات:", e?.message);
    }
}

function applyParticipantsToCache(update) {
    const e = groupMetaCache.get(update?.id);
    if (!e?.meta?.participants) return;
    const ids = (update.participants || []).map(p => (typeof p === "string" ? p : p?.id)).filter(Boolean);
    const list = e.meta.participants;
    if (update.action === "add") {
        for (const id of ids) if (!list.some(p => p.id === id)) list.push({ id, admin: null });
    } else if (update.action === "remove") {
        e.meta.participants = list.filter(p => !ids.includes(p.id));
    } else if (update.action === "promote" || update.action === "demote") {
        for (const p of list) if (ids.includes(p.id)) p.admin = update.action === "promote" ? "admin" : null;
    }
}

function isTrustedSender(jid, sender) {
    const num = cleanNumber(normJid(sender).split("@")[0]);
    if (getOwnerNumbers().includes(num)) return true;
    const norm = normJid(sender);
    const inMap = (obj) => obj && Object.keys(obj).some(k => normJid(k) === norm);
    return inMap(db.globalAuthorized) || inMap(db.authorizedUsers?.[jid]);
}

function isOwnerJid(jid) {
    return getOwnerNumbers().includes(cleanNumber(String(jid || "").split("@")[0].split(":")[0]));
}

function ensureGroupSettings(jid) {
    if (!db.groupSettings[jid]) db.groupSettings[jid] = DEFAULT_SETTINGS_JID();
    const g = db.groupSettings[jid];
    if (g.supportActive === undefined) g.supportActive = false;
    if (g.antiMention === undefined) g.antiMention = false;
    if (g.antiZarf === undefined) g.antiZarf = false;
    if (!g.filters) g.filters = { link: true, badword: true, image: true, sticker: true, lang: true, emoji: true };
    return g;
}

// ============================================================
// 🔓 فتح القروب بعد القفل
// ============================================================

const unlockFails = {};

function scheduleUnlock(jid, ms) {
    if (!jid) return;
    if (!db.pendingUnlocks) db.pendingUnlocks = {};
    db.pendingUnlocks[jid] = Math.max(db.pendingUnlocks[jid] || 0, Date.now() + ms);
    saveDb();
}

async function runUnlockCheck() {
    const sock = currentSock;
    if (!sock?.user || shuttingDown) return;
    const now = Date.now();
    let changed = false;
    for (const [g, at] of Object.entries(db.pendingUnlocks || {})) {
        if (at > now) continue;
        try {
            await sock.groupSettingUpdate(g, "not_announcement");
            delete db.pendingUnlocks[g];
            delete unlockFails[g];
            changed = true;
            await sock.sendMessage(g, { text: decorateLock(false) }).catch(() => {});
        } catch (e) {
            unlockFails[g] = (unlockFails[g] || 0) + 1;
            if (unlockFails[g] >= 5) {
                delete db.pendingUnlocks[g];
                delete unlockFails[g];
                changed = true;
            } else {
                db.pendingUnlocks[g] = Date.now() + 30 * 1000;
                changed = true;
            }
        }
    }
    if (changed) saveDb();
}

// ============================================================
// 🛡️ حماية الإشراف
// ============================================================

function userKey(jid) {
    return cleanNumber(String(jid || "").split("@")[0].split(":")[0]);
}

function getProtectedEntry(groupJid, memberJid) {
    const g = db.protectedMembers?.[groupJid];
    if (!g) return null;
    const k = userKey(memberJid);
    for (const [j, v] of Object.entries(g)) {
        if (userKey(j) === k) return { jid: j, ...v };
    }
    return null;
}

function removeProtectedEntry(groupJid, memberJid) {
    const e = getProtectedEntry(groupJid, memberJid);
    if (!e) return false;
    delete db.protectedMembers[groupJid][e.jid];
    if (Object.keys(db.protectedMembers[groupJid]).length === 0) delete db.protectedMembers[groupJid];
    saveDb();
    return true;
}

async function handleProtectedDemote(sock, update) {
    const jid = update.id;
    const author = update.author;
    if (!jid || !author || !db.protectedMembers?.[jid]) return;

    const authorNum = userKey(author);
    if (authorNum === getBotNumber(sock) || getOwnerNumbers().includes(authorNum)) return;

    const victims = [];
    for (const p of update.participants || []) {
        const pid = typeof p === "string" ? p : p?.id;
        if (!pid || userKey(pid) === authorNum) continue;
        if (getProtectedEntry(jid, pid)) victims.push(pid);
    }
    if (!victims.length) return;

    const [restoreRes, punishRes] = await Promise.allSettled([
        sock.groupParticipantsUpdate(jid, victims, "promote"),
        sock.groupParticipantsUpdate(jid, [author], "demote")
    ]);
    const punished = punishRes.status === "fulfilled" && String(punishRes.value?.[0]?.status || "200") === "200";
    const restored = restoreRes.status === "fulfilled";

    let admins = [];
    const meta = (await sock.groupMetadata(jid).catch(() => null)) || getCachedMeta(jid);
    if (meta?.participants) {
        admins = meta.participants
            .filter(p => p.admin)
            .map(p => p.id)
            .filter(id => userKey(id) !== getBotNumber(sock) && userKey(id) !== authorNum);
    }
    const adminTags = admins.length ? admins.map(a => `@${userKey(a)}`).join(" ") : "الأدمن";
    const victimTags = victims.map(v => `@${userKey(v)}`).join(" ");
    const authorTag = `@${authorNum}`;

    const verdict = punished
        ? "لقد تم سحب اشرافك"
        : "لقد تم إبطال محاولتك" + (restored ? " وإرجاع الاشراف" : "");

    await sock.sendMessage(jid, {
        text:
            `◆━─━─━─⊱⛔⊰─━─━─━◆\n` +
            `${adminTags}\n` +
            `ايها الرتب هناك من حاول نــزع \n` +
            `الاشراف من ${victimTags}\n` +
            `\`المشكوك:\` ${authorTag}\n` +
            `المدعو ${authorTag}.  ${verdict} \n` +
            `لأنك حاولت العبث في اشراف شخص\n` +
            `لديه سلطة عالية وحماية مطلقة. \n` +
            `◆━─━─━─⊱⚠️⊰─━─━─━◆`,
        mentions: [...new Set([...admins, ...victims, author])]
    }).catch(() => {});
}

// ============================================================
// 💾 النسخ الاحتياطي
// ============================================================

const BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

async function sendBackup(sock, groupJid, reason = "تلقائي") {
    try {
        saveDb();
        const buf = fs.readFileSync(dbFile);
        const stamp = new Date().toISOString().slice(0, 16).replace("T", "_").replace(":", "-");
        await sock.sendMessage(groupJid, {
            document: buf,
            mimetype: "application/json",
            fileName: `database-${stamp}.json`,
            caption:
                `💾 *نسخة احتياطية لبيانات البوت* (${reason})\n` +
                `🕒 ${new Date().toLocaleString("ar")}\n` +
                `📦 الحجم: ${(buf.length / 1024).toFixed(1)} KB\n` +
                `احتفظ بالملف، وعند الحاجة ضعه باسم database.json بجانب index.js`
        });
        if (!db.lastBackupAt) db.lastBackupAt = {};
        db.lastBackupAt[groupJid] = Date.now();
        saveDb();
        return true;
    } catch (e) {
        _originalError("❌ فشل إرسال النسخة الاحتياطية:", e?.message);
        return false;
    }
}

async function runBackupCheck() {
    const sock = currentSock;
    if (!sock?.user || shuttingDown) return;
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

    if (isPunished(jid, sender)) {
        handlePunishedFollowUp(sock, jid, sender, msg);
        return true;
    }

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

// ============================================================
// إغلاق نظيف
// ============================================================

function cleanupSocket(sock) {
    if (!sock?.ev) return;
    try {
        sock.ev.removeAllListeners();
    } catch {}
    try {
        sock.ws?.close();
    } catch {}
}

// ============================================================
// 🔑 إدارة الجلسة والاقتران (معدّل - الإصلاح الجذري)
// ============================================================

function getSessionDir() {
    return path.join(DATA_DIR, settings.sessionName || settings.sessionFolder || "session");
}

// 🔥 دالة حذف الجلسة عند تلفها
function wipeSession() {
    const dir = getSessionDir();
    try {
        if (fs.existsSync(dir)) {
            fs.rmSync(dir, { recursive: true, force: true });
            _originalWarn(`🗑️ تم حذف مجلد الجلسة: ${dir}`);
        }
    } catch (e) {
        _originalError("فشل حذف الجلسة:", e?.message);
    }
}

// 🔥 دالة طلب رمز الاقتران مع منع التكرار
async function requestPairingCodeSafe(sock, phoneNumber) {
    if (pairingCodeRequested) return;
    pairingCodeRequested = true;

    const cleanPhone = cleanNumber(phoneNumber);
    if (!cleanPhone || cleanPhone.length < 8) {
        _originalError("❌ رقم الاقتران غير صحيح! تحقق من settings.json → botNumber");
        _originalError("📌 يجب أن يكون الرقم بصيغة دولية بدون + مثل: 966512345678");
        pairingCodeRequested = false;
        return;
    }

    try {
        _originalLog(`📱 طلب رمز اقتران للرقم: ${cleanPhone}`);
        let code = await sock.requestPairingCode(cleanPhone);
        code = code?.match(/.{1,4}/g)?.join("-") || code;

        _originalLog("\n╔════════════════════════════════════╗");
        _originalLog(`║  🔑 رمز الاقتران: [ ${code} ]  ║`);
        _originalLog("╚════════════════════════════════════╝");
        _originalLog("📌 افتح واتساب → الأجهزة المرتبطة → ربط جهاز → ربط برقم الهاتف");
        _originalLog("⏳ الرمز صالح لمدة 60 ثانية فقط\n");

    } catch (e) {
        _originalError("❌ فشل طلب رمز الاقتران:", e?.message);
        pairingCodeRequested = false;
    }
}

function scheduleReconnect(delayMs) {
    if (shuttingDown) return;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        isReconnecting = false;
        startBot().catch(e => _originalError("Reconnect error:", e?.message));
    }, delayMs);
}

async function startBot() {
    if (isReconnecting || shuttingDown) return;

    isReconnecting = true;

    try {
        if (currentSock) {
            cleanupSocket(currentSock);
            currentSock = null;
        }

        const sessionDir = getSessionDir();
        const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

        let version;
        try {
            const r = await fetchLatestBaileysVersion();
            version = r?.version;
        } catch {}

        let logger;
        try {
            logger = P({ level: "silent" });
        } catch {}

        const sockOptions = {
            auth: state,
            printQRInTerminal: false,
            logger,
            markOnlineOnConnect: true,
            syncFullHistory: false,
            browser: ["Ubuntu", "Chrome", "20.0.04"],
            cachedGroupMetadata: async (gid) => getCachedMeta(gid)
        };
        if (version) sockOptions.version = version;

        const sock = makeWASocket(sockOptions);
        currentSock = sock;

        const rawSend = sock.sendMessage.bind(sock);
        sock.sendMessage = (to, content, options = {}) => {
            const id = options?.messageId || genMessageId();
            rememberBotSent(id);
            return rawSend(to, content, { ...options, messageId: id });
        };

        const owners = getOwnerNumbers();
        const pairingNumber = cleanNumber(settings.botNumber || "") || owners[0] || "";

        // 🔥 طلب الرمز فقط إذا لم يكن مسجلاً
        if (!sock.authState.creds.registered && pairingNumber) {
            pairingCodeRequested = false;
            setTimeout(() => requestPairingCodeSafe(sock, pairingNumber), 4000);
        } else if (sock.authState.creds.registered) {
            _originalLog("✅ الجلسة موجودة، جاري الاتصال...");
        }

        sock.ev.on("creds.update", saveCreds);

        // ========================================================
        // Connection
        // ========================================================
        sock.ev.on("connection.update", (update) => {
            const { connection, lastDisconnect } = update || {};

            if (connection === "open") {
                isReconnecting = false;
                reconnectAttempts = 0;
                pairingCodeRequested = false;
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

                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const loggedOut = statusCode === DisconnectReason.loggedOut;
                const badSession = statusCode === 401 || statusCode === 500;

                if (loggedOut || badSession) {
                    _originalError(`🚫 فشل الجلسة (${statusCode}). جاري حذف الجلسة التالفة وطلب رمز جديد...`);
                    cleanupSocket(sock);
                    currentSock = null;
                    wipeSession();
                    pairingCodeRequested = false;
                    reconnectAttempts = 0;
                    scheduleReconnect(3000);
                    return;
                }

                reconnectAttempts++;
                const delay = Math.min(1000 * Math.pow(2, Math.min(reconnectAttempts, 5)), 30000);
                _originalWarn(`⚠️ انقطع الاتصال (${statusCode}). إعادة المحاولة بعد ${Math.ceil(delay / 1000)}ث`);

                scheduleReconnect(delay);
            }
        });

        // ========================================================
        // Group participants update
        // ========================================================
        sock.ev.on("group-participants.update", async (update) => {
            try {
                lastActivityAt = Date.now();

                const jid = update.id;
                if (!jid) return;

                applyParticipantsToCache(update);

                const settingsJid = ensureGroupSettings(jid);

                if (update.action === "add") {
                    botatOnParticipants(sock, update).catch(() => {});
                }

                if (update.action === "demote") {
                    await handleProtectedDemote(sock, update).catch(e =>
                        _originalError("Protected demote error:", e?.message));
                }

                if (settingsJid.leave && update.action === "remove" &&
                    userKey(update.author) !== getBotNumber(sock)) {
                    await handleAntiLeaveZzs(sock, update, { scheduleUnlock }).catch(() => {});
                }

                if (update.action === "remove") {
                    const author = update.author;
                    const target = update.participants?.[0];
                    if (!author || !target) return;

                    const authorNum = userKey(author);
                    const isOwnerAuthor = getOwnerNumbers().includes(authorNum) || authorNum === getBotNumber(sock);

                    if (isProtectedAdmin(jid, author) && !isOwnerAuthor) {
                        try {
                            await sock.groupParticipantsUpdate(jid, [target], "add").catch(() => {});
                            await sock.groupParticipantsUpdate(jid, [author], "demote").catch(() => {});
                            await sock.groupSettingUpdate(jid, "announcement").catch(() => {});
                            removeProtectedAdmin(jid, author);

                            const authorTag = `@${authorNum}`;
                            const targetTag = `@${cleanNumber(target.split("@")[0])}`;
                            await sock.sendMessage(jid, {
                                text:
                                    `${DECOR.topEm}\n` +
                                    `  ${DECOR.warn} *حماية الإشراف تفعّلت* ${DECOR.warn}\n` +
                                    `${DECOR.bottomEm}\n` +
                                    `${DECOR.sepStar}\n` +
                                    `🚨 تم رصد محاولة زرف!\n` +
                                    `${DECOR.sep}\n` +
                                    `👤 المشرف المخالف: ${authorTag}\n` +
                                    `🛡️ العضو المحمي: ${targetTag}\n` +
                                    `${DECOR.sep}\n` +
                                    `✅ تم إعادة العضو المحمي\n` +
                                    `📉 تم سحب رتبة الإشراف من المخالف\n` +
                                    `🔒 تم قفل القروب لمدة 3 دقائق\n` +
                                    `${DECOR.sepStar}\n` +
                                    `┊亗 〘 *بوت الإمبراطور آلَجَيـــــــّيسي* 〙 亗┊`,
                                mentions: [author, target]
                            }).catch(() => {});

                            scheduleUnlock(jid, 3 * 60 * 1000);
                            return;
                        } catch (e) {
                            _originalError("Protected admin action error:", e?.message);
                        }
                    }

                    if (settingsJid.antiZarf && !isOwnerAuthor && !isTrustedSender(jid, author)) {
                        const now = Date.now();
                        if (!kickTracker[jid]) kickTracker[jid] = {};
                        if (!kickTracker[jid][author]) kickTracker[jid][author] = [];

                        kickTracker[jid][author] = kickTracker[jid][author].filter(t => now - t < KICK_TRACKER_TTL_MS);
                        kickTracker[jid][author].push(now);

                        const count = kickTracker[jid][author].length;
                        const userTag = `@${authorNum}`;

                        if (count === 2) {
                            await sock.sendMessage(jid, {
                                text: decorateZarfAlert(userTag, 2),
                                mentions: [author]
                            }).catch(() => {});
                        } else if (count >= 3) {
                            try {
                                await sock.groupParticipantsUpdate(jid, [author], "demote");
                                await sock.groupSettingUpdate(jid, "announcement");

                                await sock.sendMessage(jid, {
                                    text: decorateZarfAlert(userTag, 3),
                                    mentions: [author]
                                }).catch(() => {});

                                kickTracker[jid][author] = [];
                            } catch (e) {
                                _originalError("Zarf action error:", e?.message);
                            }
                        }
                    }
                }
            } catch (e) {
                _originalError("Group update error:", e?.message);
            }
        });

        sock.ev.on("message-receipt.update", (updates) => {
            botatOnReceipt(sock, updates).catch(() => {});
        });

        sock.ev.on("presence.update", (update) => {
            botatOnPresence(sock, update).catch(() => {});
        });

        sock.ev.on("groups.update", (updates) => {
            for (const u of updates || []) {
                const e = groupMetaCache.get(u?.id);
                if (e?.meta) Object.assign(e.meta, u);
            }
        });

        sock.ev.on("messages.upsert", async ({ messages, type }) => {
            if (!Array.isArray(messages) || !messages.length) return;

            const rest = [];
            for (const m of messages) {
                try {
                    if (m?.message) m.message = unwrapMessage(m.message);
                    if (DEBUG_INCOMING) {
                        _originalLog(`[in] type=${type} fromMe=${m?.key?.fromMe} jid=${m?.key?.remoteJid} id=${m?.key?.id} keys=${Object.keys(m?.message || {}).join(",")}`);
                    }
                    if (type === "notify" || (type === "append" && messageAgeSec(m) <= 120)) {
                        if (fastContactGuard(sock, m)) continue;
                    }
                } catch (e) {
                    _originalError("Fast guard error:", e?.message);
                }
                rest.push(m);
            }

            const work = [];
            for (const msg of rest) {
                if (!shouldProcess(msg, type)) continue;
                lastActivityAt = Date.now();
                work.push(
                    handleIncomingMessage(sock, msg).catch(e =>
                        _originalError("Message handling error:", e?.message))
                );
            }
            if (work.length) await Promise.allSettled(work);
        });

        _originalLog("✅ تم تسجيل جميع Events");

    } catch (e) {
        _originalError("❌ فشل إنشاء Socket:", e?.message);
        isReconnecting = false;
        reconnectAttempts++;
        scheduleReconnect(Math.min(1000 * Math.pow(2, Math.min(reconnectAttempts, 5)), 30000));
    }
}

// ============================================================
// معالجة الرسائل
// ============================================================

async function handleIncomingMessage(sock, msg) {
    const jid = msg.key.remoteJid;
    if (!jid) return;

    const botNumber = getBotNumber(sock) + "@s.whatsapp.net";
    const sender = msg.key.fromMe ? botNumber : (msg.key.participant || jid);
    const isGroup = jid.endsWith("@g.us");

    const mText = getMessageText(msg);
    const mContent = msg.message;

    const settingsJid = isGroup ? ensureGroupSettings(jid) : DEFAULT_SETTINGS_JID();

    const senderNum = cleanNumber(sender.split("@")[0]);
    const ownerNumbers = getOwnerNumbers();
    const isOwner =
        ownerNumbers.includes(senderNum) ||
        msg.key.fromMe ||
        sender === botNumber;

    const hasLocalAccess = isOwner || isTrustedSender(jid, sender);

    if (isGroup && !msg.key.fromMe && !isOwner && !hasLocalAccess) {
        trackMessage(jid, sender, msg.key);
    }

    if (isGroup && !msg.key.fromMe) {
        botatOnMessage(sock, msg).catch(() => {});
    }

    if (isGroup && settingsJid.antiMention && !isOwner && !msg.key.fromMe) {
        const mentionedJids = getMentionedJids(msg.message);

        const hasHighAuthorityMention = mentionedJids.some((target) => isTrustedSender(jid, target));

        if (hasHighAuthorityMention || mentionedJids.length >= 10) {
            try { await sock.sendMessage(jid, { delete: msg.key }); } catch {}
            await sock.sendMessage(jid, {
                text: decorateError(
                    "منع المنشن",
                    `⚠️ @${senderNum} يمنع المنشن للرتب العليا والجهات المصرح لها!`
                ),
                mentions: [sender]
            }).catch(() => {});
            return;
        }
    }

    const isExceptional = db.exceptions?.[jid]?.[sender];
    if (isGroup && settingsJid.monitoring && !isOwner && !isExceptional && !msg.key.fromMe) {
        const violationReason = checkSpamAndViolations(
            sock, jid, sender, msg, mText, mContent, settingsJid.filters
        );

        if (violationReason) {
            try { await sock.sendMessage(jid, { delete: msg.key }); } catch {}

            const groupMeta = (await getGroupMetaFast(sock, jid)) || { participants: [] };
            const pInfo = (groupMeta.participants || []).find(p => userKey(p.id) === userKey(sender));
            const isAdmin = pInfo && (pInfo.admin === "admin" || pInfo.admin === "superadmin");

            if (isAdmin) {
                await sock.sendMessage(jid, {
                    text: getAdminSaluteMsg(senderNum),
                    mentions: [sender]
                }).catch(() => {});
                return;
            }

            const count = addWarning(sender, jid);
            const warningMsg = getViolationMessage(`@${senderNum}`, violationReason, count);

            await sock.sendMessage(jid, {
                text: warningMsg,
                mentions: [sender]
            }).catch(() => {});

            if (count >= 10) {
                try { await sock.groupParticipantsUpdate(jid, [sender], "remove"); } catch {}
                resetWarnings(sender, jid);
            }
            return;
        }
    }

    if (settingsJid.emoji && settingsJid.filters.emoji && isGroup && mText && !msg.key.fromMe) {
        if (!global.emojiCounters) global.emojiCounters = {};
        if (!global.emojiCounters[jid]) global.emojiCounters[jid] = 0;
        global.emojiCounters[jid]++;

        if (global.emojiCounters[jid] >= 15) {
            global.emojiCounters[jid] = 0;
            const emojis = ["🔥", "🍎", "☘️", "🍫", "⭐", "🐬", "🍒", "🍂", "⚽"];
            const randomEmoji = emojis[Math.floor(Math.random() * emojis.length)];
            try { await sock.sendMessage(jid, { react: { text: randomEmoji, key: msg.key } }); } catch {}
        }
    }

    let command = "";
    let args = [];
    const mentioned = getMentionedJids(msg.message);

    const trimmedText = mText.trim();
    if (!trimmedText.startsWith(".")) return;
    {
        const parts = trimmedText.slice(1).trim().split(/\s+/);
        command = (parts.shift() || "").toLowerCase();
        args = parts;
    }
    if (!command) return;

    const deleteCommandMessage = async () => {
        if (isGroup && !msg.key.fromMe) {
            try { await sock.sendMessage(jid, { delete: msg.key }); } catch {}
        }
    };

    await handleCommands({
        sock, jid, msg, command, args, mentioned,
        isOwner, hasLocalAccess, settingsJid,
        deleteCommandMessage, sender, senderNum, isGroup
    });
}

// ============================================================
// معالجة الأوامر
// ============================================================

const reportCooldown = new Map();

async function handleCommands(ctx) {
    const {
        sock, jid, msg, command, args, mentioned,
        isOwner, hasLocalAccess, settingsJid,
        deleteCommandMessage, sender, senderNum, isGroup
    } = ctx;

    if (await handleBotatCommand({ ...ctx })) return;

    // .حفظ on/off
    if (command === "حفظ" && getMessageText(msg).trim().startsWith(".")) {
        await deleteCommandMessage();
        if (!isGroup) return;
        if (!isOwner) {
            await sock.sendMessage(jid, {
                text: decorateError("حفظ", "⚠️ أمر `.حفظ` خاص بالمالك الأساسي فقط.")
            });
            return;
        }
        if (!db.backupGroups) db.backupGroups = {};
        const action = args[0]?.toLowerCase();

        if (action === "on") {
            db.backupGroups[jid] = true;
            saveDb();
            await sock.sendMessage(jid, {
                text: decorateSuccess("حفظ البيانات", "💾 تم تفعيل الحفظ في هذا القروب ✅\n📤 سيصل ملف database.json كل 24 ساعة (والنسخة الأولى الآن)")
            });
            await sendBackup(sock, jid, "أول نسخة");
        } else if (action === "off") {
            delete db.backupGroups[jid];
            if (db.lastBackupAt) delete db.lastBackupAt[jid];
            saveDb();
            await sock.sendMessage(jid, {
                text: decorateError("حفظ البيانات", "❌ تم إيقاف الحفظ التلقائي في هذا القروب.")
            });
        } else {
            await sock.sendMessage(jid, {
                text: decorateInfo("استخدام الأمر", "⚠️ الاستخدام:\n.حفظ on\n.حفظ off")
            });
        }
        return;
    }

    // .قائمة on/off
    if ((command === "قائمة" || command === "القائمة") && getMessageText(msg).trim().startsWith(".")) {
        await deleteCommandMessage();
        if (!isOwner && !hasLocalAccess) return;
        if (!isGroup) return;

        const action = args[0]?.toLowerCase();
        if (!Array.isArray(db.blacklistGroups)) db.blacklistGroups = [];

        if (action === "on") {
            if (!db.blacklistGroups.includes(jid)) db.blacklistGroups.push(jid);
            saveDb();
            await sock.sendMessage(jid, {
                text:
                    `◆━─━─━─⊱⊰─━─━─━◆\n` +
                    `تم تعيين هذا الجروب لأخبار \n` +
                    `المؤبدين الذين فشلو في تبنيد\n` +
                    `القروبات. بنجاح 🟢\n` +
                    `◆━─━─━─⊱⊰─━─━─━◆`
            });
        } else if (action === "off") {
            db.blacklistGroups = db.blacklistGroups.filter(g => g !== jid);
            saveDb();
            await sock.sendMessage(jid, {
                text: decorateError("القائمة", "🔴 تم إلغاء تعيين هذا الجروب لأخبار المؤبدين.")
            });
        } else {
            await sock.sendMessage(jid, {
                text: decorateInfo("استخدام الأمر", "⚠️ الاستخدام:\n.قائمة on\n.قائمة off")
            });
        }
        return;
    }

    // .سحب صلاحيات
    if (
        (command === "سحب" && (args[0] === "صلاحيات" || args[0] === "الصلاحيات")) ||
        command === "سحب_صلاحيات"
    ) {
        if (!getMessageText(msg).trim().startsWith(".")) return;
        await deleteCommandMessage();
        if (!isOwner) {
            await sock.sendMessage(jid, {
                text: decorateError("صلاحيات", "⚠️ أمر `.سحب صلاحيات` خاص بالمالك الأساسي فقط.")
            });
            return;
        }

        let target = mentioned[0];
        if (!target) {
            const digits = cleanNumber(args.find(a => cleanNumber(a).length >= 7) || "");
            if (digits) target = `${digits}@s.whatsapp.net`;
        }
        if (!target) {
            await sock.sendMessage(jid, {
                text: decorateInfo("استخدام الأمر", "⚠️ الاستخدام:\n.سحب صلاحيات @عضو")
            });
            return;
        }

        const targetNum = cleanNumber(target.split("@")[0].split(":")[0]);
        if (getOwnerNumbers().includes(targetNum)) {
            await sock.sendMessage(jid, {
                text: decorateError("سحب صلاحيات", "⛔ لا يمكن سحب صلاحيات المالك.")
            });
            return;
        }

        const sameUser = (k) => cleanNumber(String(k).split("@")[0].split(":")[0]) === targetNum;
        let removed = 0;

        for (const k of Object.keys(db.globalAuthorized || {})) {
            if (sameUser(k)) { delete db.globalAuthorized[k]; removed++; }
        }
        for (const g of Object.keys(db.authorizedUsers || {})) {
            for (const k of Object.keys(db.authorizedUsers[g] || {})) {
                if (sameUser(k)) { delete db.authorizedUsers[g][k]; removed++; }
            }
        }
        for (const g of Object.keys(db.groupSettings || {})) {
            try { if (removeProtectedAdmin(g, target)) removed++; } catch {}
        }
        saveDb();

        await sock.sendMessage(jid, {
            text: decorateSuccess(
                "سحب صلاحيات",
                `عزيزي/تي @${targetNum}\n` +
                `⚙️ تم سحب كل صلاحياتك من البوت في جميع القروبات ❌\n` +
                `📊 عدد الصلاحيات المسحوبة: ${removed}`
            ),
            mentions: [target]
        });
        return;
    }

    // قائمة الأوامر
    if (command === "اوامر" || command === "أوامر") {
        await deleteCommandMessage();
        if (!hasLocalAccess && !isOwner) {
            await sock.sendMessage(jid, {
                text: decorateError("صلاحيات", "⛔ تعذر الإرسال. هذا الأمر مخصص للجهات العليا 🚫")
            }, { quoted: msg });
            return;
        }

        const menuText =
            `${DECOR.topEm}\n` +
            `${DECOR.crown} *قائمة أوامر البوت* ${DECOR.crown}\n` +
            `${DECOR.bottomEm}\n\n` +
            `📌 *أوامر الإدارة:*\n` +
            `├ .قفل\n├ .فتح\n├ .ترقية @عضو\n├ .إعفاء @عضو\n` +
            `├ .اشرافه @عضو 🛡️\n├ .الغاء_اشرافه @عضو\n` +
            `├ .احميه @عضو 🛡️ (حماية إشرافه من السحب)\n├ .الغاء_احميه @عضو\n` +
            `├ .سحب صلاحيات @عضو\n├ .قائمة on/off\n├ .حفظ on/off 💾\n` +
            `├ .معلومات\n├ .استثناء @عضو\n\n` +
            `🛡️ *الحماية والمراقبة:*\n` +
            `├ .حماية on/off\n├ .مراقبة on/off\n├ .مغادرة on/off\n` +
            `├ .الزرف on/off\n├ .منع_المنشن on/off\n` +
            `├ .مراقبة_روابط on/off\n├ .مراقبة_كلمات on/off\n` +
            `├ .مراقبة_سبام on/off\n├ .مراقبة_صور on/off\n` +
            `├ .مراقبة_لغات on/off\n├ .مراقبة_ايموجي on/off\n\n` +
            `🕵️ *كاشف البوتات:*\n` +
            `├ .كاشف on/off\n├ .تعيين_استقبال\n├ .تعيين_اساسي\n` +
            `├ .فحص @عضو\n├ .قبول @عضو\n├ .قبول_تلقائي on/off\n` +
            `├ .المشتبهين\n├ .سجل_الدخول\n├ .حالة_الكاشف\n├ .تشخيص_كاشف on/off\n\n` +
            `📄 *عام:*\n├ .الدعم on/off\n├ .ابلاغ [نص]\n` +
            `├ .تصفير @عضو\n├ .إعادة_ضبط_المخالفات\n\n` +
            `${DECOR.topLine}`;

        await sock.sendMessage(jid, { text: menuText });
        return;
    }

    // أوامر التبديل
    const toggleCommands = {
        "منع_المنشن": { key: "antiMention", on: "antiMention" },
        "منع_منشن": { key: "antiMention", on: "antiMention" },
        "الزرف": { key: "antiZarf", on: "antiZarf" },
        "زرف": { key: "antiZarf", on: "antiZarf" },
        "حماية": { key: "protection", on: "protection" },
        "مغادرة": { key: "leave", on: "leave" },
        "مراقبة": { key: "monitoring", on: "monitoring" },
        "مراقبة_روابط": { key: "filters.link", on: "link" },
        "مراقبةروابط": { key: "filters.link", on: "link" },
        "مراقبة_كلمات": { key: "filters.badword", on: "badword" },
        "مراقبةكلمات": { key: "filters.badword", on: "badword" },
        "مراقبة_سبام": { key: "filters.sticker", on: "sticker" },
        "مراقبةسبام": { key: "filters.sticker", on: "sticker" },
        "مراقبة_صور": { key: "filters.image", on: "image" },
        "مراقبةصور": { key: "filters.image", on: "image" },
        "مراقبة_لغات": { key: "filters.lang", on: "lang" },
        "مراقبةلغات": { key: "filters.lang", on: "lang" },
        "مراقبة_ايموجي": { key: "filters.emoji", on: "emoji" },
        "مراقبةايموجي": { key: "filters.emoji", on: "emoji" }
    };

    if (toggleCommands[command]) {
        await deleteCommandMessage();
        if (!isOwner && !hasLocalAccess) return;

        const { key, on } = toggleCommands[command];
        const action = args[0]?.toLowerCase();
        const isOn = action === "on";

        if (key.startsWith("filters.")) {
            const fkey = key.split(".")[1];
            settingsJid.filters[fkey] = isOn;
            if (fkey === "emoji") settingsJid.emoji = isOn;
        } else {
            settingsJid[key] = isOn;
        }
        saveDb();

        const notif = isOn
            ? (getOnNotification(on) || "✅ تم التشغيل")
            : (getOffNotification(on) || "❌ تم الإيقاف");

        await sock.sendMessage(jid, { text: notif });
        return;
    }

    // فورمات
    if (command === "فورمات") {
        await deleteCommandMessage();
        if (!isOwner) {
            await sock.sendMessage(jid, {
                text: decorateError("صلاحيات", "⚠️ أمر `.فورمات` خاص بالمالك الأساسي فقط.")
            });
            return;
        }
        db.groupSettings = {};
        db.globalAuthorized = {};
        db.authorizedUsers = {};
        db.exceptions = {};
        saveDb();
        await sock.sendMessage(jid, {
            text: decorateSuccess("فورمات شامل", "🔄 تم عمل فورمات شامل لجميع الإعدادات ✅")
        });
        return;
    }

    // إعطاء
    if (command === "إعطاء" || command === "اعطاء") {
        await deleteCommandMessage();
        if (!isOwner) {
            await sock.sendMessage(jid, {
                text: decorateError("صلاحيات", "⚠️ أمر `.إعطاء` للمالك الأساسي فقط.")
            });
            return;
        }
        if (mentioned.length > 0) {
            const target = mentioned[0];
            if (!db.globalAuthorized) db.globalAuthorized = {};
            db.globalAuthorized[target] = true;
            saveDb();
            await sock.sendMessage(jid, {
                text: decorateSuccess(
                    "منح صلاحيات",
                    `عزيزي/تي @${target.split("@")[0]}\n` +
                    `⚙️ أصبح بإمكانك استخدام كل أوامر البوت ✅`
                ),
                mentions: [target]
            });
        }
        return;
    }

    // منع
    if (command === "منع") {
        await deleteCommandMessage();
        if (!isOwner) return;
        if (mentioned.length > 0) {
            const target = mentioned[0];
            if (isOwnerJid(target)) return;
            const sameU = (k) => userKey(k) === userKey(target);
            for (const k of Object.keys(db.globalAuthorized || {})) if (sameU(k)) delete db.globalAuthorized[k];
            for (const k of Object.keys(db.authorizedUsers?.[jid] || {})) if (sameU(k)) delete db.authorizedUsers[jid][k];
            saveDb();
            await sock.sendMessage(jid, {
                text: decorateSuccess(
                    "سحب صلاحيات",
                    `عزيزي/تي @${target.split("@")[0]}\n` +
                    `⚙️ تم سحب صلاحيات استخدام البوت ❌`
                ),
                mentions: [target]
            });
        }
        return;
    }

    // بلاغات 879
    if (command === "879") {
        if (!isOwner && !hasLocalAccess) return;
        if (isGroup) {
            try { if (!msg.key.fromMe) await sock.sendMessage(jid, { delete: msg.key }); } catch {}
            for (let i = 879; i <= 883; i++) {
                const reportMessage =
                    `${DECOR.top}\n` +
                    `  🚨 *بلاغ تلقائي رقم ${i}* 🚨\n` +
                    `${DECOR.bottom}\n` +
                    `${DECOR.sepStar}\n` +
                    `⚠️ تنبيه: تم رصد مخالفة/بلاغ مستمر في القروب\n` +
                    `${DECOR.sepStar}`;
                try { await sock.sendMessage(jid, { text: reportMessage }); } catch {}
                await new Promise(r => setTimeout(r, 500));
            }
        }
        return;
    }

    // الدعم
    if (command === "الدعم") {
        await deleteCommandMessage();
        if (!isOwner && !hasLocalAccess) return;
        const action = args[0]?.toLowerCase();
        if (action === "on") {
            settingsJid.supportActive = true;
            db.reportGroup = jid;
            saveDb();
            await sock.sendMessage(jid, {
                text: decorateSuccess("خدمة الدعم", "🛠️ تم تفعيل خدمة الدعم بنجاح ✅")
            });
        } else if (action === "off") {
            settingsJid.supportActive = false;
            if (db.reportGroup === jid) db.reportGroup = null;
            saveDb();
            await sock.sendMessage(jid, {
                text: decorateError("خدمة الدعم", "❌ تم إيقاف خدمة الدعم.")
            });
        } else {
            await sock.sendMessage(jid, {
                text: decorateInfo("استخدام الأمر", "⚠️ الاستخدام:\n.الدعم on\n.الدعم off")
            });
        }
        return;
    }

    // اشرافه
    if (command === "اشرافه" || command === "إشرافه") {
        await deleteCommandMessage();
        if (!isOwner && !hasLocalAccess) {
            await sock.sendMessage(jid, {
                text: decorateError("صلاحيات", "⚠️ هذا الأمر مخصص للجهات العليا فقط.")
            }, { quoted: msg });
            return;
        }

        if (mentioned.length === 0) {
            await sock.sendMessage(jid, {
                text: decorateInfo("استخدام الأمر",
                    "⚠️ الاستخدام الصحيح:\n` .اشرافه @user `\n\n" +
                    "🛡️ سيقوم البوت بحماية إشراف العضو الممنشن\n" +
                    "🚫 إذا حاول زرف/طرد أي شخص → سحب رتبته فوراً + قفل القروب"
                )
            }, { quoted: msg });
            return;
        }

        const target = mentioned[0];
        const targetNum = cleanNumber(target.split("@")[0]);

        try {
            await sock.groupParticipantsUpdate(jid, [target], "promote");
            addProtectedAdmin(jid, target, sender);

            const targetTag = `@${targetNum}`;
            await sock.sendMessage(jid, {
                text:
                    `${DECOR.topEm}\n` +
                    `${DECOR.shield} *إشــرافــه مــحــمــي* ${DECOR.shield}\n` +
                    `${DECOR.sepStar}\n` +
                    `👤 العضو: ${targetTag}\n` +
                    `👑 الرتبة: مشرف محمي 🛡️\n` +
                    `${DECOR.sep}\n` +
                    `✅ تم ترقية العضو بنجاح\n` +
                    `🔒 إشرافه محمي من الاستغلال\n` +
                    `🚫 أي محاولة زرف → سحب فوري للرتبة\n` +
                    `🔐 + قفل القروب تلقائياً\n` +
                    `${DECOR.sepStar}\n` +
                    `${DECOR.bottomEm}`,
                mentions: [target]
            });

        } catch (e) {
            _originalError("اشرافه error:", e?.message);
            await sock.sendMessage(jid, {
                text: decorateError("خطأ", "❌ فشل ترقية العضو. تأكد أن البوت مشرف.")
            });
        }
        return;
    }

    // احميه
    if (command === "احميه" || command === "احمية") {
        if (!getMessageText(msg).trim().startsWith(".")) return;
        await deleteCommandMessage();
        if (!isGroup) return;
        if (!isOwner && !hasLocalAccess) {
            await sock.sendMessage(jid, {
                text: decorateError("صلاحيات", "⚠️ هذا الأمر مخصص للجهات العليا فقط.")
            });
            return;
        }

        let target = mentioned[0] || msg.message?.extendedTextMessage?.contextInfo?.participant;
        if (!target) {
            const digits = cleanNumber(args.find(a => cleanNumber(a).length >= 7) || "");
            if (digits) target = `${digits}@s.whatsapp.net`;
        }
        if (!target) {
            await sock.sendMessage(jid, {
                text: decorateInfo("استخدام الأمر", "⚠️ الاستخدام:\n` .احميه @user `")
            });
            return;
        }

        if (!db.protectedMembers) db.protectedMembers = {};
        if (!db.protectedMembers[jid]) db.protectedMembers[jid] = {};
        const old = getProtectedEntry(jid, target);
        if (old) delete db.protectedMembers[jid][old.jid];
        db.protectedMembers[jid][target] = { addedBy: sender, addedAt: Date.now() };
        saveDb();

        let note = "";
        const meta = await sock.groupMetadata(jid).catch(() => null);
        if (meta?.participants) {
            const me = meta.participants.find(p => userKey(p.id) === getBotNumber(sock));
            const him = meta.participants.find(p => userKey(p.id) === userKey(target));
            if (!me?.admin) note += "\n⚠️ البوت ليس مشرفاً: لن يستطيع إرجاع الاشراف أو سحبه من المعتدي!";
            if (!him?.admin) note += "\nℹ️ العضو ليس مشرفاً حالياً، الحماية تسري متى ما صار مشرفاً.";
        }

        await sock.sendMessage(jid, {
            text:
                `◆━─━─━─⊱🛡️⊰─━─━─━◆\n` +
                `تم تفعيل الحماية المطلقة للعضو @${userKey(target)}\n` +
                `${DECOR.sep}\n` +
                `🚫 أي شخص يحاول سحب اشرافه\n` +
                `↩️ يرجع الاشراف للمحمي فوراً\n` +
                `📉 ويُسحب اشراف المعتدي\n` +
                `◆━─━─━─⊱✅⊰─━─━─━◆` + note,
            mentions: [target]
        });
        return;
    }

    // إلغاء الحماية
    if (command === "الغاء_احميه" || command === "الغاء_حمايه" || command === "الغاء_حماية") {
        if (!getMessageText(msg).trim().startsWith(".")) return;
        await deleteCommandMessage();
        if (!isGroup || (!isOwner && !hasLocalAccess)) return;
        const target = mentioned[0] || msg.message?.extendedTextMessage?.contextInfo?.participant;
        if (!target) return;
        const was = removeProtectedEntry(jid, target);
        await sock.sendMessage(jid, {
            text: decorateSuccess(
                "إلغاء الحماية",
                was ? `🔓 تم إلغاء الحماية عن @${userKey(target)}` : `ℹ️ @${userKey(target)} ليس محمياً`
            ),
            mentions: [target]
        });
        return;
    }

    // إلغاء اشرافه
    if (command === "الغاء_اشرافه" || command === "إلغاء_إشرافه") {
        await deleteCommandMessage();
        if (!isOwner && !hasLocalAccess) return;
        if (mentioned.length === 0) return;

        const target = mentioned[0];
        const targetNum = cleanNumber(target.split("@")[0]);
        const wasProtected = removeProtectedAdmin(jid, target);

        await sock.sendMessage(jid, {
            text: decorateSuccess(
                "إلغاء الحماية",
                wasProtected
                    ? `🔓 تم إلغاء حماية إشراف @${targetNum}\n⚠️ العضو الآن مشرف عادي`
                    : `ℹ️ العضو @${targetNum} ليس مشرفاً محمياً`
            ),
            mentions: [target]
        });
        return;
    }

    // استثناء
    if (command === "استثناء") {
        await deleteCommandMessage();
        if (!isOwner && !hasLocalAccess) return;
        if (mentioned.length > 0) {
            const target = mentioned[0];
            if (!db.exceptions[jid]) db.exceptions[jid] = {};
            db.exceptions[jid][target] = true;
            saveDb();
            await sock.sendMessage(jid, {
                text: decorateSuccess("استثناء عضو", "✅ تم إيقاف مراقبة العضو بنجاح ✅"),
                mentions: [target]
            });
        }
        return;
    }

    // قفل
    if (command === "قفل") {
        await deleteCommandMessage();
        if (!isOwner && !hasLocalAccess) return;
        try {
            await sock.groupSettingUpdate(jid, "announcement");
            await sock.sendMessage(jid, { text: decorateLock(true) });
        } catch {}
        return;
    }

    // فتح
    if (command === "فتح") {
        await deleteCommandMessage();
        if (!isOwner && !hasLocalAccess) return;
        try {
            await sock.groupSettingUpdate(jid, "not_announcement");
            await sock.sendMessage(jid, { text: decorateLock(false) });
        } catch {}
        return;
    }

    // معلومات
    if (command === "معلومات") {
        await deleteCommandMessage();
        if (!isGroup || (!isOwner && !hasLocalAccess)) return;
        try {
            const groupMeta = await sock.groupMetadata(jid);
            const participants = groupMeta.participants;

            const owner = participants.find(p => p.admin === "superadmin");
            const ownerTag = owner ? `@${owner.id.split("@")[0]}` : "لا احد ❗";

            const admins = participants.filter(p => p.admin === "admin" || p.admin === "superadmin").map(p => `@${p.id.split("@")[0]}`);
            const trusted = Object.keys(db.authorizedUsers?.[jid] || {}).map(u => `@${u.split("@")[0]}`);
            const normal = participants.filter(p => !p.admin).slice(0, 4).map(p => `@${p.id.split("@")[0]}`);

            const text =
                `${DECOR.topEm}\n` +
                `${DECOR.crown} *هيكلة القروب* ${DECOR.crown}\n` +
                `${DECOR.bottomEm}\n\n` +
                `👑『 صاحب القروب 』👑\n╠ ${ownerTag}\n\n` +
                `🛡️『 المشرفين 』🛡️\n` +
                (admins.length > 0 ? admins.map(a => `╠ ${a}`).join("\n") : "╠ لا احد ❗") + `\n\n` +
                `👥『 الأعضاء الموثوقين 』👥\n` +
                (trusted.length > 0 ? trusted.map(t => `╠ ${t}`).join("\n") : "╠ لا احد ❗") + `\n\n` +
                `🌟『 الأعضاء 』🌟\n` +
                (normal.length > 0 ? normal.map(m => `╠ ${m}`).join("\n") : "╠ لا احد ❗") + `\n` +
                `${DECOR.topLine}`;

            await sock.sendMessage(jid, { text, mentions: participants.map(p => p.id) });
        } catch {
            await sock.sendMessage(jid, {
                text: decorateError("خطأ", "❌ حدث خطأ أثناء جلب هيكلة القروب.")
            });
        }
        return;
    }

    // ترقية
    if (command === "ترقية") {
        await deleteCommandMessage();
        if (!isOwner && !hasLocalAccess) return;
        if (mentioned.length > 0) {
            const target = mentioned[0];
            try {
                await sock.groupParticipantsUpdate(jid, [target], "promote");
                const currentDate = new Date().toLocaleDateString();
                await sock.sendMessage(jid, {
                    text: decorateRank("promote", `@${target.split("@")[0]}`, currentDate),
                    mentions: [target]
                });
            } catch {}
        }
        return;
    }

    // إعفاء
    if (command === "إعفاء" || command === "اعفاء") {
        await deleteCommandMessage();
        if (!isOwner && !hasLocalAccess) return;
        if (mentioned.length > 0) {
            const target = mentioned[0];
            if (!isOwner && (isOwnerJid(target) || userKey(target) === getBotNumber(sock))) {
                await sock.sendMessage(jid, {
                    text: decorateError("إعفاء", "⛔ لا يمكن سحب إشراف المالك أو البوت.")
                }).catch(() => {});
                return;
            }
            try {
                await sock.groupParticipantsUpdate(jid, [target], "demote");
                await sock.sendMessage(jid, {
                    text: decorateRank("demote", `@${target.split("@")[0]}`),
                    mentions: [target]
                });
            } catch {}
        }
        return;
    }

    // تصفير
    if (command === "تصفير") {
        await deleteCommandMessage();
        if (!isOwner && !hasLocalAccess) return;
        if (mentioned.length > 0) {
            const target = mentioned[0];
            resetWarnings(target, jid);
            await sock.sendMessage(jid, {
                text: decorateSuccess("تصفير مخالفات", "✅ تم تصفير عدد مخالفات العضو بنجاح")
            });
        }
        return;
    }

    // إعادة ضبط المخالفات
    if (command === "إعادة_ضبط_المخالفات" || command === "اعادة_ضبط_المخالفات") {
        await deleteCommandMessage();
        if (!isOwner && !hasLocalAccess) return;
        resetWarnings(null, jid);
        await sock.sendMessage(jid, {
            text: decorateSuccess("إعادة ضبط", "🔄 تم إعادة ضبط جميع مخالفات الأعضاء ✅")
        });
        return;
    }

    // ابلاغ
    if (command === "ابلاغ") {
        await deleteCommandMessage();
        const reportText = args.join(" ").slice(0, 1000);
        const lastReport = reportCooldown.get(sender) || 0;
        if (Date.now() - lastReport < 30 * 1000) return;
        reportCooldown.set(sender, Date.now());
        if (reportCooldown.size > 2000) reportCooldown.delete(reportCooldown.keys().next().value);
        if (!reportText) {
            await sock.sendMessage(jid, {
                text: decorateInfo("استخدام الأمر", "⚠️ يرجى كتابة نص البلاغ.")
            }, { quoted: msg });
            return;
        }

        const targetReportJid = db.reportGroup;
        if (targetReportJid && db.groupSettings[targetReportJid]?.supportActive) {
            const formattedReport =
                `${DECOR.topEm}\n` +
                `${DECOR.sparkle} *شكوى جديدة* ${DECOR.sparkle}\n` +
                `${DECOR.bottomEm}\n\n` +
                `${reportText}\n\n` +
                `${DECOR.topLine}`;
            try {
                await sock.sendMessage(targetReportJid, { text: formattedReport });
                await sock.sendMessage(jid, {
                    text: decorateSuccess("إرسال البلاغ", "📄 تم إرسال بلاغك بنجاح ✅")
                }, { quoted: msg });
            } catch {}
        }
        return;
    }
}

// ============================================================
// بدء التشغيل
// ============================================================

async function main() {
    try {
        _originalLog("╔════════════════════════════════════╗");
        _originalLog("║   🤖 BOT ALJESI START              ║");
        _originalLog("╚════════════════════════════════════╝");

        if (cleanupInterval) clearInterval(cleanupInterval);
        cleanupInterval = setInterval(runCleanup, 10 * 60 * 1000);

        setTimeout(runCleanup, 30 * 1000);

        const backupTimer = setInterval(() => runBackupCheck().catch(() => {}), 30 * 60 * 1000);
        backupTimer.unref?.();
        setTimeout(() => runBackupCheck().catch(() => {}), 90 * 1000);

        const unlockTimer = setInterval(() => runUnlockCheck().catch(() => {}), 15 * 1000);
        unlockTimer.unref?.();

        await startBot();
    } catch (e) {
        _originalError("❌ فشل التشغيل:", e?.message);
    }
}

function shutdown() {
    shuttingDown = true;
    stopWatchdog();
    if (cleanupInterval) clearInterval(cleanupInterval);
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (pairingRetryTimer) clearTimeout(pairingRetryTimer);
    saveDb();
    flushBotat();
    process.exit(0);
}

process.once("SIGINT", () => {
    shutdown();
});

process.once("SIGTERM", () => {
    shutdown();
});

main().catch(e => _originalError("Fatal:", e?.message));
