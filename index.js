// index.js - الملف الرئيسي المطور والمعالج بالكامل
// + LogGuard + Watchdog + تنظيف تلقائي + حماية الإشراف + crypto polyfill

"use strict";

// ============================================================
// 🔐 Crypto Polyfill (حل مشكلة crypto is not defined)
// ============================================================

if (typeof globalThis.crypto === "undefined") {
    try {
        const nodeCrypto = require("crypto");
        if (nodeCrypto.webcrypto) {
            globalThis.crypto = nodeCrypto.webcrypto;
        } else {
            globalThis.crypto = nodeCrypto;
        }
    } catch (e) {
        console.error("⚠️ فشل تحميل crypto polyfill");
    }
}

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
// Imports
// ============================================================

const baileys = require("@whiskeysockets/baileys");
const makeWASocket = baileys.default || baileys;
const {
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion
} = baileys;

const fs = require("fs");
const path = require("path");

const settings = require("./settings");
const {
    getOnNotification,
    getOffNotification,
    getViolationMessage,
    getAdminSaluteMsg
} = require("./dark");
const {
    trackMessage,
    handleAntiContact,
    handleAntiLeaveZzs
} = require("./haolk");
const {
    addWarning,
    resetWarnings,
    checkSpamAndViolations,
    cleanupMemory,
    addProtectedAdmin,
    removeProtectedAdmin,
    isProtectedAdmin
} = require("./trim");
const {
    DECOR,
    decorateSuccess,
    decorateError,
    decorateLock,
    decorateRank,
    decorateInfo,
    decorateZarfAlert
} = require("./decor");

// ============================================================
// قاعدة البيانات
// ============================================================

const dbFile = path.join(__dirname, "database.json");

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
    exceptions: {}
};

if (fs.existsSync(dbFile)) {
    try {
        const parsed = JSON.parse(fs.readFileSync(dbFile, "utf8"));
        if (parsed && typeof parsed === "object") {
            db = { ...db, ...parsed };
        }
    } catch (e) {
        _originalError("⚠️ لم يتمكن البوت من قراءة database.json، سيتم إنشاء ملف جديد.");
    }
}

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

function cleanupHaoLkMemory() {
    try {
        const haolk = require("./haolk");
        if (typeof haolk.cleanupRecentMessages === "function") {
            haolk.cleanupRecentMessages();
        }
    } catch {}
}

function runCleanup() {
    try {
        cleanupMemory();
        cleanupKickTracker();
        cleanupHaoLkMemory();
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
// إغلاق نظيف
// ============================================================

function cleanupSocket(sock) {
    if (!sock?.ev) return;
    try {
        sock.ev.removeAllListeners();
    } catch {}
}

// ============================================================
// إنشاء Socket
// ============================================================

async function startBot() {
    if (isReconnecting || shuttingDown) return;

    isReconnecting = true;

    try {
        if (currentSock) {
            cleanupSocket(currentSock);
            currentSock = null;
        }

        const sessionDir = settings.sessionName || settings.sessionFolder || "session";
        const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

        let version;
        try {
            const r = await fetchLatestBaileysVersion();
            version = r?.version;
        } catch {}

        let logger;
        try {
            logger = require("pino")({ level: "silent" });
        } catch {}

        const sockOptions = {
            auth: state,
            printQRInTerminal: false,
            logger,
            markOnlineOnConnect: true,
            syncFullHistory: false
        };
        if (version) sockOptions.version = version;

        const sock = makeWASocket(sockOptions);
        currentSock = sock;

        const owners = getOwnerNumbers();
        const pairingNumber = owners[0] || cleanNumber(settings.botNumber || "");

        if (!sock.authState.creds.registered && pairingNumber) {
            setTimeout(async () => {
                try {
                    if (currentSock !== sock) return;
                    let code = await sock.requestPairingCode(pairingNumber);
                    code = code?.match(/.{1,4}/g)?.join("-") || code;
                    _originalLog(`\n========================================`);
                    _originalLog(`🔑 رمز الاقتران: [ ${code} ]`);
                    _originalLog(`========================================\n`);
                } catch (e) {
                    _originalError("❌ خطأ في رمز الاقتران:", e?.message);
                }
            }, 4000);
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
                lastActivityAt = Date.now();
                startWatchdog();
                _originalLog("✅ تم اتصال البوت بنجاح!");
                return;
            }

            if (connection === "close") {
                stopWatchdog();

                if (shuttingDown) return;

                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const loggedOut = statusCode === DisconnectReason.loggedOut;

                if (loggedOut) {
                    _originalError("🚫 تم تسجيل خروج الجلسة. لن يتم إعادة الاتصال.");
                    currentSock = null;
                    isReconnecting = false;
                    return;
                }

                reconnectAttempts++;
                const delay = Math.min(1000 * Math.pow(2, Math.min(reconnectAttempts, 5)), 30000);
                _originalWarn(`⚠️ انقطع الاتصال. إعادة المحاولة بعد ${Math.ceil(delay / 1000)}ث`);

                if (reconnectTimer) clearTimeout(reconnectTimer);
                reconnectTimer = setTimeout(() => {
                    reconnectTimer = null;
                    isReconnecting = false;
                    startBot().catch(e => _originalError("Reconnect error:", e?.message));
                }, delay);
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

                if (!db.groupSettings[jid]) {
                    db.groupSettings[jid] = DEFAULT_SETTINGS_JID();
                }
                const settingsJid = db.groupSettings[jid];

                // ميزة المغادرين
                if (settingsJid.leave && update.action === "remove") {
                    await handleAntiLeaveZzs(sock, update).catch(() => {});
                }

                // حماية الزرف + حماية الإشراف
                if (update.action === "remove") {
                    const author = update.author;
                    const target = update.participants?.[0];
                    if (!author || !target) return;

                    const botNumber = getBotNumber(sock) + "@s.whatsapp.net";
                    const authorNum = cleanNumber(author.split("@")[0]);
                    const isOwnerAuthor = getOwnerNumbers().includes(authorNum) || author === botNumber;

                    // 🛡️ حماية الإشراف المؤقت
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

                            setTimeout(async () => {
                                try {
                                    await sock.groupSettingUpdate(jid, "not_announcement");
                                    await sock.sendMessage(jid, { text: decorateLock(false) }).catch(() => {});
                                } catch {}
                            }, 3 * 60 * 1000);

                            return;
                        } catch (e) {
                            _originalError("Protected admin action error:", e?.message);
                        }
                    }

                    // ⚔️ حماية الزرف العادية
                    if (settingsJid.antiZarf && !isOwnerAuthor) {
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

        // ========================================================
        // Messages
        // ========================================================
        sock.ev.on("messages.upsert", async ({ messages, type }) => {
            if (type !== "notify") return;
            if (!Array.isArray(messages) || !messages.length) return;

            const msg = messages[0];
            if (!msg?.message) return;

            lastActivityAt = Date.now();

            try {
                await handleIncomingMessage(sock, msg);
            } catch (e) {
                _originalError("Message handling error:", e?.message);
            }
        });

        _originalLog("✅ تم تسجيل جميع Events");

    } catch (e) {
        _originalError("❌ فشل إنشاء Socket:", e?.message);
        isReconnecting = false;
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

    if (!db.groupSettings[jid]) {
        db.groupSettings[jid] = DEFAULT_SETTINGS_JID();
    }
    const settingsJid = db.groupSettings[jid];
    if (settingsJid.supportActive === undefined) settingsJid.supportActive = false;
    if (settingsJid.antiMention === undefined) settingsJid.antiMention = false;
    if (settingsJid.antiZarf === undefined) settingsJid.antiZarf = false;
    if (!settingsJid.filters) {
        settingsJid.filters = { link: true, badword: true, image: true, sticker: true, lang: true, emoji: true };
    }

    const senderNum = cleanNumber(sender.split("@")[0]);
    const ownerNumbers = getOwnerNumbers();
    const isOwner =
        ownerNumbers.includes(senderNum) ||
        msg.key.fromMe ||
        sender === botNumber;

    const hasGlobalAccess = isOwner || (db.globalAuthorized && db.globalAuthorized[sender]);
    const hasLocalAccess = hasGlobalAccess || (db.authorizedUsers?.[jid]?.[sender]);

    if (isGroup && !msg.key.fromMe && !isOwner && !hasLocalAccess) {
        trackMessage(jid, sender, msg.key);
    }

    // ========================================================
    // antiMention
    // ========================================================
    if (isGroup && settingsJid.antiMention && !isOwner && !msg.key.fromMe) {
        const mentionedJids = msg.message.extendedTextMessage?.contextInfo?.mentionedJid || [];

        const hasHighAuthorityMention = mentionedJids.some((target) => {
            const targetNum = target.split("@")[0];
            return ownerNumbers.includes(targetNum) ||
                (db.globalAuthorized && db.globalAuthorized[target]) ||
                (db.authorizedUsers?.[jid]?.[target]);
        });

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

    // ========================================================
    // حماية جهات الاتصال
    // ========================================================
    if (settingsJid.protection && (mContent.contactMessage || mContent.vcardMessage)) {
        if (!isOwner && !msg.key.fromMe) {
            await handleAntiContact(sock, jid, sender, msg).catch(() => {});
            return;
        }
    }

    // ========================================================
    // المراقبة
    // ========================================================
    const isExceptional = db.exceptions?.[jid]?.[sender];
    if (isGroup && settingsJid.monitoring && !isOwner && !isExceptional && !msg.key.fromMe) {
        const violationReason = checkSpamAndViolations(
            sock, jid, sender, msg, mText, mContent, settingsJid.filters
        );

        if (violationReason) {
            try { await sock.sendMessage(jid, { delete: msg.key }); } catch {}

            const groupMeta = await sock.groupMetadata(jid).catch(() => ({ participants: [] }));
            const pInfo = groupMeta.participants.find(p => p.id === sender);
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

    // ========================================================
    // إيموجي عشوائي
    // ========================================================
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

    // ========================================================
    // الأوامر
    // ========================================================
    let command = "";
    let args = [];
    const mentioned = msg.message.extendedTextMessage?.contextInfo?.mentionedJid || [];

    if (mText.startsWith(".")) {
        const parts = mText.slice(1).trim().split(/ +/);
        command = parts.shift().toLowerCase();
        args = parts;
    } else {
        command = mText.trim().toLowerCase();
    }

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

async function handleCommands(ctx) {
    const {
        sock, jid, msg, command, args, mentioned,
        isOwner, hasLocalAccess, settingsJid,
        deleteCommandMessage, sender, senderNum, isGroup
    } = ctx;

    // 1. قائمة الأوامر
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
            `├ .معلومات\n├ .استثناء @عضو\n\n` +
            `🛡️ *الحماية والمراقبة:*\n` +
            `├ .حماية on/off\n├ .مراقبة on/off\n├ .مغادرة on/off\n` +
            `├ .الزرف on/off\n├ .منع_المنشن on/off\n` +
            `├ .مراقبة_روابط on/off\n├ .مراقبة_كلمات on/off\n` +
            `├ .مراقبة_سبام on/off\n├ .مراقبة_صور on/off\n` +
            `├ .مراقبة_لغات on/off\n├ .مراقبة_ايموجي on/off\n\n` +
            `📄 *عام:*\n├ .الدعم on/off\n├ .ابلاغ [نص]\n` +
            `├ .تصفير @عضو\n├ .إعادة_ضبط_المخالفات\n\n` +
            `${DECOR.topLine}`;

        await sock.sendMessage(jid, { text: menuText });
        return;
    }

    // 2. أوامر التبديل
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

    // 3. فورمات
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

    // 4. إعطاء
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

    // 5. منع
    if (command === "منع") {
        await deleteCommandMessage();
        if (!isOwner) return;
        if (mentioned.length > 0) {
            const target = mentioned[0];
            if (db.globalAuthorized) delete db.globalAuthorized[target];
            if (db.authorizedUsers[jid]) delete db.authorizedUsers[jid][target];
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

    // 6. بلاغات 879
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

    // 7. الدعم
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

    // 8. اشرافه
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

    // 9. إلغاء اشرافه
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

    // 10. استثناء
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

    // 11. قفل
    if (command === "قفل") {
        await deleteCommandMessage();
        if (!isOwner && !hasLocalAccess) return;
        try {
            await sock.groupSettingUpdate(jid, "announcement");
            await sock.sendMessage(jid, { text: decorateLock(true) });
        } catch {}
        return;
    }

    // 12. فتح
    if (command === "فتح") {
        await deleteCommandMessage();
        if (!isOwner && !hasLocalAccess) return;
        try {
            await sock.groupSettingUpdate(jid, "not_announcement");
            await sock.sendMessage(jid, { text: decorateLock(false) });
        } catch {}
        return;
    }

    // 13. معلومات
    if (command === "معلومات") {
        await deleteCommandMessage();
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

    // 14. ترقية
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

    // 15. إعفاء
    if (command === "إعفاء" || command === "اعفاء") {
        await deleteCommandMessage();
        if (!isOwner && !hasLocalAccess) return;
        if (mentioned.length > 0) {
            const target = mentioned[0];
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

    // 16. تصفير
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

    // 17. إعادة ضبط المخالفات
    if (command === "إعادة_ضبط_المخالفات" || command === "اعادة_ضبط_المخالفات") {
        await deleteCommandMessage();
        if (!isOwner && !hasLocalAccess) return;
        resetWarnings(null, jid);
        await sock.sendMessage(jid, {
            text: decorateSuccess("إعادة ضبط", "🔄 تم إعادة ضبط جميع مخالفات الأعضاء ✅")
        });
        return;
    }

    // 18. ابلاغ
    if (command === "ابلاغ") {
        await deleteCommandMessage();
        const reportText = args.join(" ");
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

        await startBot();
    } catch (e) {
        _originalError("❌ فشل التشغيل:", e?.message);
    }
}

process.once("SIGINT", () => {
    shuttingDown = true;
    stopWatchdog();
    if (cleanupInterval) clearInterval(cleanupInterval);
    if (reconnectTimer) clearTimeout(reconnectTimer);
    saveDb();
    process.exit(0);
});

process.once("SIGTERM", () => {
    shuttingDown = true;
    stopWatchdog();
    if (cleanupInterval) clearInterval(cleanupInterval);
    if (reconnectTimer) clearTimeout(reconnectTimer);
    saveDb();
    process.exit(0);
});

main().catch(e => _originalError("Fatal:", e?.message));
