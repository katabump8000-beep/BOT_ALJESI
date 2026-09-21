// trim.js - كشف المخالفات والكلمات المحظورة + حماية الإشراف

"use strict";

// ============================================================
// التخزين المؤقت (مع تنظيف دوري)
// ============================================================

const warnings = {};
const WARNING_TTL_MS = 24 * 60 * 60 * 1000; // 24 ساعة

setInterval(() => {
    const now = Date.now();
    for (const key of Object.keys(warnings)) {
        const entry = warnings[key];
        if (entry && typeof entry === "object" && (now - entry.updatedAt) > WARNING_TTL_MS) {
            delete warnings[key];
        }
    }
}, 60 * 60 * 1000).unref?.();

const BAD_WORDS = [
    "كس", "كسمك", "كسي", "انيك", "نيكمك", "نيج", "أنيج", "انيك اختك", "أنيك اختك",
    "طيزك", "طيزها", "متناك", "منتاك", "متناكة", "كسها", "قحب", "قحبة", "منيوكة",
    "منيوك", "سكس", "xxxx", "سكسي", "سكسية", "ممحون", "عاهرة", "أنيك امك", "انيج امك",
    "نياك", "نايكك", "تلحس", "تلحسي", "تمص", "تمصلي", "ابوسك", "يلعن", "يلعن دين"
];

const FORBIDDEN_EMOJIS = ["💩", "🖕", "👙", "💋", "👄", "🫦"];

// ============================================================
// أدوات
// ============================================================

function cleanText(text) {
    if (!text) return "";
    return text.replace(/[\u064B-\u065F\u0670]/g, "").toLowerCase().trim();
}

function normalizeFilters(filtersObj) {
    const defaults = {
        link: true,
        badword: true,
        image: true,
        sticker: true,
        lang: true,
        emoji: true
    };

    if (!filtersObj || typeof filtersObj !== "object") {
        return { ...defaults };
    }

    return {
        link: filtersObj.link !== false,
        badword: filtersObj.badword !== false,
        image: filtersObj.image !== false,
        sticker: filtersObj.sticker !== false,
        lang: filtersObj.lang !== false,
        emoji: filtersObj.emoji !== false
    };
}

// ============================================================
// كشف المخالفات
// ============================================================

function checkSpamAndViolations(sock, jid, sender, msg, mText, mContent, filtersObj) {
    const filters = normalizeFilters(filtersObj);
    const cleaned = cleanText(mText);

    // 1. الروابط
    if (filters.link && mText && (
        mText.includes("http://") ||
        mText.includes("https://") ||
        mText.includes("chat.whatsapp.com/") ||
        mText.includes("wa.me/")
    )) {
        return "ارسالك رابط";
    }

    // 2. الكلمات المحظورة
    if (filters.badword && cleaned) {
        const words = cleaned.split(/\s+/);
        for (const word of words) {
            if (BAD_WORDS.includes(word)) {
                return "ارسلت كلمة تسيء سمعة القروب";
            }
        }
    }

    // 3. الإيموجي المحظور
    if (filters.emoji && mText) {
        for (const emo of FORBIDDEN_EMOJIS) {
            if (mText.includes(emo)) {
                return "ارسلت ايموجي يخالف معايير القروب";
            }
        }
    }

    // 4. اللغات غير العربية
    if (filters.lang && mText) {
        const englishChars = (mText.match(/[a-zA-Z]/g) || []).length;
        if (englishChars > 15) {
            return "ارسال لغة ثانية غير العربية";
        }
    }

    // 5. الصور المتتالية
    if (filters.image && mContent && mContent.imageMessage) {
        if (!global.userImages) global.userImages = {};
        if (!global.userImages[sender]) global.userImages[sender] = { count: 0, updatedAt: Date.now() };

        const entry = global.userImages[sender];
        if (Date.now() - entry.updatedAt > 60 * 1000) entry.count = 0;
        entry.count++;
        entry.updatedAt = Date.now();

        if (entry.count >= 5) {
            entry.count = 0;
            return "إرفاق صور بشكل متتالي";
        }
    }

    // 6. الملصقات المتتالية
    if (filters.sticker && mContent && mContent.stickerMessage) {
        if (!global.userStickers) global.userStickers = {};
        if (!global.userStickers[sender]) global.userStickers[sender] = { count: 0, updatedAt: Date.now() };

        const entry = global.userStickers[sender];
        if (Date.now() - entry.updatedAt > 60 * 1000) entry.count = 0;
        entry.count++;
        entry.updatedAt = Date.now();

        if (entry.count >= 3) {
            entry.count = 0;
            return "ارفاق 3 ملصقات متتالية";
        }
    }

    return null;
}

// ============================================================
// التحذيرات
// ============================================================

function addWarning(sender, jid) {
    const key = `${jid}_${sender}`;
    if (!warnings[key] || typeof warnings[key] !== "object") {
        warnings[key] = { count: 0, updatedAt: Date.now() };
    }
    warnings[key].count++;
    warnings[key].updatedAt = Date.now();
    return warnings[key].count;
}

function resetWarnings(sender, jid) {
    if (sender) {
        const key = `${jid}_${sender}`;
        if (warnings[key]) {
            warnings[key] = { count: 0, updatedAt: Date.now() };
        }
    } else {
        for (const k of Object.keys(warnings)) {
            if (k.startsWith(`${jid}_`)) {
                warnings[k] = { count: 0, updatedAt: Date.now() };
            }
        }
    }
}

// ============================================================
// تنظيف الذاكرة العامة
// ============================================================

function cleanupMemory() {
    const now = Date.now();
    const MAX_AGE = 30 * 60 * 1000;

    try {
        if (global.userImages) {
            for (const k of Object.keys(global.userImages)) {
                if (now - (global.userImages[k]?.updatedAt || 0) > MAX_AGE) {
                    delete global.userImages[k];
                }
            }
        }
        if (global.userStickers) {
            for (const k of Object.keys(global.userStickers)) {
                if (now - (global.userStickers[k]?.updatedAt || 0) > MAX_AGE) {
                    delete global.userStickers[k];
                }
            }
        }
    } catch {}
}

// ============================================================
// 🛡️ حماية الإشراف المؤقت (اشرافه)
// ============================================================

const protectedAdmins = {};

function addProtectedAdmin(jid, memberJid, addedBy) {
    if (!jid || !memberJid) return false;
    if (!protectedAdmins[jid]) protectedAdmins[jid] = {};
    protectedAdmins[jid][memberJid] = {
        addedBy,
        addedAt: Date.now(),
        locked: true
    };
    return true;
}

function removeProtectedAdmin(jid, memberJid) {
    if (!protectedAdmins[jid]) return false;
    if (protectedAdmins[jid][memberJid]) {
        delete protectedAdmins[jid][memberJid];
        if (Object.keys(protectedAdmins[jid]).length === 0) {
            delete protectedAdmins[jid];
        }
        return true;
    }
    return false;
}

function isProtectedAdmin(jid, memberJid) {
    return !!(protectedAdmins[jid] && protectedAdmins[jid][memberJid]);
}

function getProtectedAdmins(jid) {
    return protectedAdmins[jid] || {};
}

function cleanupProtectedAdmins() {
    // حماية دائمة بدون TTL
}

module.exports = {
    checkSpamAndViolations,
    addWarning,
    resetWarnings,
    cleanupMemory,
    addProtectedAdmin,
    removeProtectedAdmin,
    isProtectedAdmin,
    getProtectedAdmins,
    cleanupProtectedAdmins
};