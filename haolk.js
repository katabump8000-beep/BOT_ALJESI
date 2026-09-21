// haolk.js - حماية جهات الاتصال والتعامل مع المغادرين (مزخرف)

"use strict";

const { DECOR, decorateSuccess, decorateLock } = require("./decor");

const recentMessages = {};
const MAX_MESSAGES_PER_GROUP = 50;
const MESSAGE_TTL_MS = 30 * 60 * 1000;

function trackMessage(jid, sender, msgKey) {
    if (!jid || !sender || !msgKey) return;
    if (!recentMessages[jid]) recentMessages[jid] = [];
    recentMessages[jid].push({ sender, msgKey, ts: Date.now() });
    while (recentMessages[jid].length > MAX_MESSAGES_PER_GROUP) {
        recentMessages[jid].shift();
    }
}

function cleanupRecentMessages() {
    const now = Date.now();
    try {
        for (const jid of Object.keys(recentMessages)) {
            recentMessages[jid] = recentMessages[jid].filter(m => now - m.ts < MESSAGE_TTL_MS);
            if (recentMessages[jid].length === 0) delete recentMessages[jid];
        }
    } catch {}
}

async function handleAntiContact(sock, jid, sender, msg) {
    try {
        if (!msg?.key) return;

        await sock.sendMessage(jid, { delete: msg.key }).catch(() => {});
        await sock.groupSettingUpdate(jid, "announcement").catch(() => {});

        const userTag = `@${sender.split("@")[0]}`;
        await sock.sendMessage(jid, {
            text:
                `${DECOR.top}\n` +
                `   ${DECOR.warn} *محاولة تبنيد فاشلة* ${DECOR.warn}\n` +
                `${DECOR.bottom}\n` +
                `${DECOR.sepStar}\n` +
                `⛔ عزيزي ${userTag}\n` +
                `🚫 محاولتك بتنيد القروب عبر إرسال جهة اتصال باءت بالفشل\n` +
                `${DECOR.sepStar}\n` +
                `${DECOR.topEm}`,
            mentions: [sender]
        }).catch(() => {});

        try { await sock.groupParticipantsUpdate(jid, [sender], "remove"); } catch {}

        await sock.sendMessage(jid, {
            text:
                `${DECOR.topEm}\n` +
                `  ${DECOR.warn} *محاولة تبنيد فاشلة* ${DECOR.warn}\n` +
                `${DECOR.sepStar}\n` +
                `🔒 تم إغلاق القروب احترازياً\n` +
                `⏳ سيتم الفتح بعد 10 دقائق\n` +
                `🙏 يرجى التحلي بالصبر\n` +
                `${DECOR.sepStar}\n` +
                `${DECOR.bottomEm}`
        }).catch(() => {});

        setTimeout(async () => {
            try {
                await sock.groupSettingUpdate(jid, "not_announcement");
                await sock.sendMessage(jid, { text: decorateLock(false) }).catch(() => {});
            } catch {}
        }, 10 * 60 * 1000);

    } catch (err) {
        console.error("خطأ في التعامل مع جهة الاتصال:", err?.message);
    }
}

async function handleAntiLeaveZzs(sock, update) {
    const { id: jid, action, participants } = update || {};
    if (action !== "remove") return;

    const leaver = participants?.[0];
    if (!leaver) return;

    try {
        if (recentMessages[jid]) {
            const userMsgs = recentMessages[jid].filter(m => m.sender === leaver).slice(-15);
            for (const m of userMsgs) {
                try { await sock.sendMessage(jid, { delete: m.msgKey }); } catch {}
            }
            const last10 = recentMessages[jid].slice(-10);
            for (const m of last10) {
                try { await sock.sendMessage(jid, { delete: m.msgKey }); } catch {}
            }
        }

        await sock.groupSettingUpdate(jid, "announcement").catch(() => {});

        await sock.sendMessage(jid, {
            text:
                `${DECOR.top}\n` +
                `    ${DECOR.warn} *تنبيه - عضو غادر* ${DECOR.warn}\n` +
                `${DECOR.bottom}\n` +
                `${DECOR.sepStar}\n` +
                `🛡️ أيها الفانز، لقد خرج أحد الأعضاء\n` +
                `🧹 سيتم تطهير شات القروب\n` +
                `🔒 تم إغلاق القروب لمدة 3 دقائق\n` +
                `⏳ يرجى التحلي بالصبر\n` +
                `${DECOR.sepStar}\n` +
                `${DECOR.topEm}`
        }).catch(() => {});

        setTimeout(async () => {
            try {
                await sock.groupSettingUpdate(jid, "not_announcement");
                await sock.sendMessage(jid, { text: decorateLock(false) }).catch(() => {});
            } catch {}
        }, 3 * 60 * 1000);

    } catch (e) {
        console.error("خطأ في معالجة مغادرة العضو:", e?.message);
    }
}

module.exports = {
    trackMessage,
    handleAntiContact,
    handleAntiLeaveZzs,
    cleanupRecentMessages
};