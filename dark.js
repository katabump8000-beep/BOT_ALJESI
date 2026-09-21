// dark.js - إدارة الإشعارات والرسائل (مزخرف بالكامل)

"use strict";

const { decorateToggle, decorateWarning, decorateSuccess } = require("./decor");

function getOnNotification(type) {
    const titles = {
        protection: "حماية فائقة ضد المخربين",
        leave: "التعامل مع المغادرين",
        monitoring: "مراقبة المخالفات",
        antiMention: "منع المنشن",
        antiZarf: "حماية الزرف",
        link: "مراقبة الروابط",
        badword: "مراقبة الكلمات",
        sticker: "مراقبة السبام",
        image: "مراقبة الصور",
        lang: "مراقبة اللغات",
        emoji: "مراقبة الإيموجي",
        supportActive: "خدمة الدعم"
    };
    const emojis = {
        protection: "🛡️",
        leave: "🚪",
        monitoring: "👁️",
        antiMention: "🔕",
        antiZarf: "⚔️",
        link: "🔗",
        badword: "🚫",
        sticker: "🖼️",
        image: "📸",
        lang: "🌐",
        emoji: "😀",
        supportActive: "🛠️"
    };
    return decorateToggle(titles[type] || type, true, emojis[type] || "⚙️");
}

function getOffNotification(type) {
    const titles = {
        protection: "حماية فائقة ضد المخربين",
        leave: "التعامل مع المغادرين",
        monitoring: "مراقبة المخالفات",
        antiMention: "منع المنشن",
        antiZarf: "حماية الزرف",
        link: "مراقبة الروابط",
        badword: "مراقبة الكلمات",
        sticker: "مراقبة السبام",
        image: "مراقبة الصور",
        lang: "مراقبة اللغات",
        emoji: "مراقبة الإيموجي",
        supportActive: "خدمة الدعم"
    };
    const emojis = {
        protection: "🛡️",
        leave: "🚪",
        monitoring: "👁️",
        antiMention: "🔕",
        antiZarf: "⚔️",
        link: "🔗",
        badword: "🚫",
        sticker: "🖼️",
        image: "📸",
        lang: "🌐",
        emoji: "😀",
        supportActive: "🛠️"
    };
    return decorateToggle(titles[type] || type, false, emojis[type] || "⚙️");
}

function getViolationMessage(userTag, reason, count) {
    return decorateWarning(userTag, reason, count);
}

function getAdminSaluteMsg(userTag) {
    return decorateSuccess(
        "تحية للأدمن",
        `🫡 تحياتي لك يا أدمن @${userTag}\n` +
        `✅ تم مسح رسالتك المخالفة احتراماً لرتبتك\n` +
        `📌 رجاءً الالتزام بالقوانين`
    );
}

module.exports = {
    getOnNotification,
    getOffNotification,
    getViolationMessage,
    getAdminSaluteMsg
};