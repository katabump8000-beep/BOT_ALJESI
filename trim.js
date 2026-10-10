// trim.js - كشف المخالفات والكلمات المحظورة + حماية الإشراف (ESM)

// ============================================================
// التخزين المؤقت
// ============================================================

const warnings = {};
const WARNING_TTL_MS = 24 * 60 * 60 * 1000;

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

const LINK_REGEX = /(https?:\/\/|www\.|chat\.whatsapp\.com\/|wa\.me\/|whatsapp\.com\/channel\/|t\.me\/|discord\.gg\/)/i;

const FORBIDDEN_EMOJIS = ["💩", "🖕", "👙", "💋", "👄", "🫦"];

// ============================================================
// ⚙️ إعدادات مراقبة الملصقات
// ============================================================

const STICKER_TIME_WINDOW_MS = 8 * 1000; // ⏱️ نافذة زمنية: 8 ثواني
const STICKER_MAX_COUNT = 4;             // 📊 الحد الأقصى: 4 ملصقات

// ============================================================
// أدوات
// ============================================================

// تطبيع النص: يشيل التشكيل والتطويل والرموز الخفية والترقيم ويوحّد الألف/الياء
function cleanText(text) {
    if (!text) return "";
    return String(text)
        .normalize("NFKC")
        .replace(/[\u064B-\u065F\u0670\u0640\u200B-\u200F\u202A-\u202E\u2060\uFEFF]/g, "")
        .replace(/[أإآٱ]/g, "ا")
        .replace(/ى/g, "ي")
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, " ")
        .replace(/\s+/g, " ")
        .trim();
}

const BAD_WORDS_NORM = [...new Set(BAD_WORDS.map(cleanText).filter(Boolean))];

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

    // 1. الروابط (غير حساسة لحالة الأحرف)
    if (filters.link && mText && LINK_REGEX.test(String(mText).normalize("NFKC"))) {
        return "ارسالك رابط";
    }

    // 2. الكلمات المحظورة (تدعم العبارات المتعددة الكلمات)
    if (filters.badword && cleaned) {
        const padded = ` ${cleaned} `;
        for (const bw of BAD_WORDS_NORM) {
            if (padded.includes(` ${bw} `)) {
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
        const imgKey = `${jid}|${sender}`;
        if (!global.userImages[imgKey]) global.userImages[imgKey] = { count: 0, updatedAt: Date.now() };

        const entry = global.userImages[imgKey];
        if (Date.now() - entry.updatedAt > 60 * 1000) entry.count = 0;
        entry.count++;
        entry.updatedAt = Date.now();

        if (entry.count >= 5) {
            entry.count = 0;
            return "إرفاق صور بشكل متتالي";
        }
    }

    // ============================================================
    // 6. الملصقات المتتالية (🚨 معدّل)
    // ============================================================
    // 📌 القاعدة الجديدة: 4 ملصقات خلال 8 ثواني = مخالفة
    if (filters.sticker && mContent && mContent.stickerMessage) {
        if (!global.userStickers) global.userStickers = {};
        const stkKey = `${jid}|${sender}`;
        if (!global.userStickers[stkKey]) {
            global.userStickers[stkKey] = {
                timestamps: [],
                updatedAt: Date.now()
            };
        }

        const entry = global.userStickers[stkKey];
        const now = Date.now();

        // إزالة الطوابع الزمنية القديمة (التي مضى عليها أكثر من 8 ثواني)
        entry.timestamps = (entry.timestamps || []).filter(
            ts => now - ts < STICKER_TIME_WINDOW_MS
        );

        // إضافة الملصق الحالي
        entry.timestamps.push(now);
        entry.updatedAt = now;

        // إذا وصل إلى 4 ملصقات خلال 8 ثواني → مخالفة
        if (entry.timestamps.length >= STICKER_MAX_COUNT) {
            entry.timestamps = []; // إعادة ضبط
            return `ارسال ${STICKER_MAX_COUNT} ملصقات متتالية خلال 8 ثواني`;
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
// تنظيف الذاكرة
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
// 🛡️ حماية الإشراف المؤقت
// ============================================================

const protectedAdmins = {};

function pKey(jid) {
    return String(jid || "").split("@")[0].split(":")[0];
}

function addProtectedAdmin(jid, memberJid, addedBy) {
    if (!jid || !memberJid) return false;
    if (!protectedAdmins[jid]) protectedAdmins[jid] = {};
    protectedAdmins[jid][pKey(memberJid)] = {
        addedBy,
        addedAt: Date.now(),
        locked: true
    };
    return true;
}

function removeProtectedAdmin(jid, memberJid) {
    if (!protectedAdmins[jid]) return false;
    const k = pKey(memberJid);
    if (protectedAdmins[jid][k]) {
        delete protectedAdmins[jid][k];
        if (Object.keys(protectedAdmins[jid]).length === 0) {
            delete protectedAdmins[jid];
        }
        return true;
    }
    return false;
}

function isProtectedAdmin(jid, memberJid) {
    return !!(protectedAdmins[jid] && protectedAdmins[jid][pKey(memberJid)]);
}

function getProtectedAdmins(jid) {
    return protectedAdmins[jid] || {};
}

function cleanupProtectedAdmins() {
    // حماية دائمة بدون TTL
}

export {
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
