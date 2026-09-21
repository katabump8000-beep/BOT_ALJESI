// decor.js - نظام الزخرفة الموحّد للبوت

"use strict";

// ============================================================
// 🎨 الزخارف الأساسية
// ============================================================

const DECOR = {
    top:    "◆━─━─━─⊱ ⚠️ ⊰─━─━─━◆",
    topEm:  "❆━━━━━═⏣⊰ 🔥 ⊱⏣═━━━━━❆",
    topLine:"*▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬*",
    bottom: "◆━─━─━─⊱ ⚠️ ⊰─━─━─━◆",
    bottomEm:"❆━━━━━═⏣⊰ 🔥 ⊱⏣═━━━━━❆",
    bottomLine:"*▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬*",

    sep:    "┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈",
    sepStar:"✦ ━━━━━━━━━━━━━━━ ✦",
    sepDiam:"◇◆◇◆◇◆◇◆◇◆◇◆◇◆◇",

    crown: "👑",
    shield:"🛡️",
    warn:  "⚠️",
    check: "✅",
    cross: "❌",
    fire:  "🔥",
    lock:  "🔒",
    unlock:"🔓",
    star:  "⭐",
    sparkle:"✨"
};

function decorateToggle(title, isOn, emoji = "⚙️") {
    const icon = isOn ? DECOR.check : DECOR.cross;
    const status = isOn ? "🟢 تم التشغيل" : "🔴 تم الإيقاف";
    return (
        `${DECOR.topEm}\n` +
        `${DECOR.crown} *${title}* ${DECOR.crown}\n` +
        `${DECOR.sepStar}\n` +
        `${icon} ${emoji} ${status} بنجاح\n` +
        `${DECOR.sepStar}\n` +
        `${DECOR.bottomEm}`
    );
}

function decorateWarning(userTag, reason, count) {
    return (
        `${DECOR.top}\n` +
        `        ${DECOR.warn} *مــخــالــفــة* ${DECOR.warn}\n` +
        `${DECOR.bottom}\n` +
        `${DECOR.sep}\n` +
        `👤 العضو: ${userTag}\n` +
        `${DECOR.sep}\n` +
        `📌 السبب: *${reason}*\n` +
        `${DECOR.sep}\n` +
        `📊 عدد المخالفات: *${count}* / 10\n` +
        `${DECOR.sep}\n` +
        `⚠️ تنبيه: سيتم طردك عند وصول المخالفات إلى 10\n` +
        `${DECOR.sep}\n` +
        `┊亗 〘 بوت الإمبراطور آلَجَيـــــــّيسي 〙 亗┊`
    );
}

function decorateSuccess(title, body) {
    return (
        `${DECOR.topEm}\n` +
        `${DECOR.sparkle} *${title}* ${DECOR.sparkle}\n` +
        `${DECOR.sepStar}\n` +
        `${body}\n` +
        `${DECOR.sepStar}\n` +
        `${DECOR.bottomEm}`
    );
}

function decorateError(title, body) {
    return (
        `${DECOR.top}\n` +
        `${DECOR.warn} *${title}* ${DECOR.warn}\n` +
        `${DECOR.sepStar}\n` +
        `${body}\n` +
        `${DECOR.sepStar}\n` +
        `${DECOR.bottom}`
    );
}

function decorateLock(isLocked) {
    if (isLocked) {
        return (
            `${DECOR.topEm}\n` +
            `       ${DECOR.lock} *تم قفل القروب* ${DECOR.lock}\n` +
            `${DECOR.sepStar}\n` +
            `⛔ لا يمكن للأعضاء الإرسال حالياً\n` +
            `${DECOR.sepStar}\n` +
            `${DECOR.bottomEm}`
        );
    }
    return (
        `${DECOR.topEm}\n` +
        `       ${DECOR.unlock} *تم فتح القروب* ${DECOR.unlock}\n` +
        `${DECOR.sepStar}\n` +
        `✅ يمكن للأعضاء الإرسال الآن\n` +
        `${DECOR.sepStar}\n` +
        `${DECOR.bottomEm}`
    );
}

function decorateRank(action, userTag, extra = "") {
    if (action === "promote") {
        return (
            `${DECOR.topEm}\n` +
            `${DECOR.crown} *إعــلان تــرقــيــة* ${DECOR.crown}\n` +
            `${DECOR.sepStar}\n` +
            `🎊 نهنئ العضو ${userTag}\n` +
            `📅 التاريخ: ${extra}\n` +
            `📈 [عضو] ⏩ [مشرف]\n` +
            `${DECOR.sepStar}\n` +
            `${DECOR.bottomEm}`
        );
    }
    return (
        `${DECOR.top}\n` +
        `${DECOR.warn} *تــجــريــد رتــبــة* ${DECOR.warn}\n` +
        `${DECOR.sepStar}\n` +
        `❌ تم سحب الرتبة من ${userTag}\n` +
        `📉 [مشرف] ⏪ [عضو]\n` +
        `${DECOR.sepStar}\n` +
        `${DECOR.bottom}`
    );
}

function decorateInfo(title, body) {
    return (
        `${DECOR.topLine}\n` +
        `${DECOR.star} *${title}* ${DECOR.star}\n` +
        `${DECOR.topLine}\n\n` +
        `${body}\n\n` +
        `${DECOR.bottomLine}`
    );
}

function decorateZarfAlert(userTag, level = 2) {
    if (level === 2) {
        return (
            `${DECOR.top}\n` +
            `    ${DECOR.warn} *حماية الزرف* ${DECOR.warn}\n` +
            `${DECOR.bottom}\n` +
            `${DECOR.sepStar}\n` +
            `⚠️ ${userTag} أنت الآن في وضع الشك!\n` +
            `🚫 ممنوع تعمل هالشي مرة تانية!\n` +
            `${DECOR.sepStar}\n` +
            `${DECOR.topEm}`
        );
    }
    return (
        `${DECOR.topEm}\n` +
        `  ${DECOR.warn} *إجراء حماية مشدد* ${DECOR.warn}\n` +
        `${DECOR.bottomEm}\n` +
        `${DECOR.sepStar}\n` +
        `❌ تم سحب رتبة الإشراف من: ${userTag}\n` +
        `🔒 تم قفل شات المجموعة لحمايتها\n` +
        `📢 العضو تحت المراقبة المشددة!\n` +
        `${DECOR.sepStar}\n` +
        `${DECOR.topEm}`
    );
}

module.exports = {
    DECOR,
    decorateToggle,
    decorateWarning,
    decorateSuccess,
    decorateError,
    decorateLock,
    decorateRank,
    decorateInfo,
    decorateZarfAlert
};