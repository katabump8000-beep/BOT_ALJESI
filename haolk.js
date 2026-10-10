// haolk.js - حماية جهات الاتصال والتعامل مع المغادرين (ESM)

import { DECOR, decorateLock } from "./decor.js";

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

// ============================================================
// ⚡ حماية جهات الاتصال - نسخة فائقة السرعة
// ============================================================
// المبدأ:
//   1) أول جهة اتصال => طرد + حذف في نفس اللحظة (بالتوازي، بدون await متسلسل)
//   2) أي رسالة تصل بعدها من نفس الشخص (الفيضان اللي بالطريق) => حذف فوري
//   3) بعد ما تنتهي الضربة => التحذيرات + القفل + استمارة القائمة (خارج المسار الحرج)

const PUNISH_WINDOW_MS = 60 * 1000;      // مدة اعتبار المرسل "معاقَب" وحذف كل ما يصل منه
const LOCK_REOPEN_MS = 10 * 60 * 1000;   // فتح القروب بعد القفل الاحترازي

// ✏️ نصوص الاستمارة (عدّلها من هنا)
const FORM_STATUS = "مؤبد تبنيد";
const FORM_NICK = "عرصا وعاهرة وفاشل";
const FORM_OWNER = "آلَجَيـــــــًّسًـــــي";
const FORM_TRIGGER = ".مؤبد";
const RLM = "\u200F";

const punished = new Map();      // "group|user" -> { until, startedAt, contacts, deleted, failed, lastDoneAt }
const deletedIds = new Set();    // لمنع حذف نفس الرسالة مرتين
let punishedCleanupTimer = null;

function normJid(jid) {
    const s = String(jid || "");
    const at = s.indexOf("@");
    if (at < 0) return s;
    const left = s.slice(0, at).split(":")[0].split("_")[0];
    return `${left}${s.slice(at)}`;
}

function isPunished(jid, sender) {
    const rec = punished.get(`${jid}|${normJid(sender)}`);
    return !!rec && rec.until > Date.now();
}

function rememberDeleted(id) {
    deletedIds.add(id);
    if (deletedIds.size > 2000) deletedIds.delete(deletedIds.values().next().value);
}

// حذف فوري: لا await قبل الإرسال، مع إعادة محاولة واحدة
function fireDelete(sock, jid, key, rec) {
    if (!key?.id || deletedIds.has(key.id)) return;
    rememberDeleted(key.id);

    const attempt = (retry) =>
        sock.sendMessage(jid, { delete: key })
            .then(() => { rec.deleted++; rec.lastDoneAt = Date.now(); })
            .catch(() => {
                if (retry) return attempt(false);
                rec.failed++; rec.lastDoneAt = Date.now();
            });
    attempt(true);
}

// طرد مع إعادة محاولة سريعة عند الفشل
function fireKick(sock, jid, who, attemptsLeft = 3) {
    sock.groupParticipantsUpdate(jid, [who], "remove")
        .then((res) => {
            const st = String(res?.[0]?.status || "200");
            if (st !== "200" && attemptsLeft > 1) {
                setTimeout(() => fireKick(sock, jid, who, attemptsLeft - 1), 250);
            }
        })
        .catch(() => {
            if (attemptsLeft > 1) setTimeout(() => fireKick(sock, jid, who, attemptsLeft - 1), 250);
        });
}

// رسالة تصل من شخص معاقَب: حذف فوري بغض النظر عن نوعها
function handlePunishedFollowUp(sock, jid, sender, msg) {
    const rec = punished.get(`${jid}|${normJid(sender)}`);
    if (!rec) return;
    rec.until = Date.now() + PUNISH_WINDOW_MS;
    rec.contacts++;
    fireDelete(sock, jid, msg.key, rec);
}

function buildForm(groupName, tag) {
    return [
        `${RLM}\`إستمارة الوورك\``,
        ``,
        `${RLM}_*الـحـالـة*_: ┊ ${FORM_STATUS} ┊`,
        `${RLM}_*الـلــقـب*_: ┊ ${FORM_NICK} ┊`,
        `${RLM}_*الطــرف*_: ┊ ${groupName} ┊`,
        `${RLM}_*المسؤول*_: ┊ ${FORM_OWNER} ┊`,
        `${RLM}${RLM}_*المنشن*_: ┊ ${tag} ┊`,
        ``,
        `${RLM}╮──────────────╭`,
        `${RLM}                    ▅تــوقــيــع▅`,
        `${RLM}🍷 *𝑭. 𝑰. 𝑹* 🍂`,
        `${RLM}╯──────────────╰`
    ].join("\n");
}

// إرسال الاستمارة ثم الرد عليها بـ .مؤبد (مع إعادة محاولة وخطة بديلة + أخطاء ظاهرة)
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function sendWithRetry(fn, label, tries = 3) {
    for (let i = 1; i <= tries; i++) {
        try {
            const r = await fn();
            return r || true;
        } catch (e) {
            console.error(`❌ ${label} (محاولة ${i}/${tries}):`, e?.message || e);
            if (i < tries) await sleep(500 * i);
        }
    }
    return null;
}

async function sendBlacklistForms(sock, targets, groupName, who) {
    const tag = `@${who.split("@")[0]}`;
    const text = buildForm(groupName, tag);

    for (const target of targets) {
        const formMsg = await sendWithRetry(
            () => sock.sendMessage(target, { text, mentions: [who] }),
            "إرسال الاستمارة"
        );
        if (!formMsg) continue;

        await sleep(400);   // فاصل صغير بين الاستمارة والرد

        // الرد المقتبس على الاستمارة (كائن الرسالة كاملاً، أو نبنيه يدوياً لو ما رجع)
        const quotable = (formMsg && formMsg !== true && formMsg.key && formMsg.message)
            ? formMsg
            : (formMsg?.key ? { key: formMsg.key, message: { extendedTextMessage: { text } } } : null);

        let ok = null;
        if (quotable) {
            ok = await sendWithRetry(
                () => sock.sendMessage(target, { text: FORM_TRIGGER }, { quoted: quotable }),
                "رد .مؤبد (مقتبس)", 2
            );
        }
        if (!ok) {
            // خطة بديلة: إرسال .مؤبد بدون اقتباس بدل ما ينقطع كلياً
            ok = await sendWithRetry(
                () => sock.sendMessage(target, { text: FORM_TRIGGER }),
                "رد .مؤبد (بدون اقتباس)", 2
            );
        }
        if (!ok) console.error("🚫 تعذر إرسال .مؤبد نهائياً إلى", target);
    }
}

// المدخل الرئيسي: يُستدعى مباشرة من index.js (متزامن، لا ينتظر شيئاً)
// hooks = { getGroupName(jid), getReportGroups() }
function handleAntiContact(sock, jid, sender, msg, hooks = {}) {
    const who = normJid(sender);
    const key = `${jid}|${who}`;
    const now = Date.now();

    let rec = punished.get(key);
    const first = !rec || rec.until < now;
    if (first) {
        rec = { until: now + PUNISH_WINDOW_MS, startedAt: now, contacts: 0, deleted: 0, failed: 0, lastDoneAt: now };
        punished.set(key, rec);
    }
    rec.until = now + PUNISH_WINDOW_MS;
    rec.contacts++;

    if (first) fireKick(sock, jid, who);   // الطرد أولاً: يقطع الفيضان
    fireDelete(sock, jid, msg.key, rec);   // والحذف في نفس اللحظة

    if (first) {
        postStrike(sock, jid, who, sender, rec, hooks).catch(() => {});
    }
}

// كل ما بعد الضربة الأولى (خارج المسار الحرج)
async function postStrike(sock, jid, who, senderRaw, rec, hooks) {
    // نمهل الفيضان يصل ويُحذف قبل ما نبدأ بالرسائل
    await new Promise(r => setTimeout(r, 1500));

    // تقرير السرعة (يفيدك تشوف الأداء الفعلي)
    const took = rec.lastDoneAt - rec.startedAt;
    console.log(`⚡ ضربة جهات اتصال: ${rec.contacts} رسالة | محذوف ${rec.deleted} | فشل ${rec.failed} | آخر حذف بعد ${took}ms`);

    const userTag = `@${who.split("@")[0]}`;

    // القفل الاحترازي (بالتوازي مع التحذير)
    sock.groupSettingUpdate(jid, "announcement").catch(() => {});

    sock.sendMessage(jid, {
        text:
            `${DECOR.top}\n` +
            `   ${DECOR.warn} *محاولة تبنيد فاشلة* ${DECOR.warn}\n` +
            `${DECOR.bottom}\n` +
            `${DECOR.sepStar}\n` +
            `⛔ عزيزي ${userTag}\n` +
            `🚫 محاولتك بتبنيد القروب عبر إرسال جهة اتصال باءت بالفشل\n` +
            `🗑️ تم حذف ${rec.contacts} رسالة وطرد المرسل\n` +
            `${DECOR.sepStar}\n` +
            `${DECOR.topEm}`,
        mentions: [who]
    }).catch(() => {});

    sock.sendMessage(jid, {
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

    scheduleReopen(sock, jid, LOCK_REOPEN_MS, hooks);

    // 📋 استمارة القائمة (.قائمة on) + الرد عليها بـ .مؤبد
    try {
        const targets = (hooks.getReportGroups?.() || []).filter(Boolean);
        if (targets.length) {
            const groupName = (await hooks.getGroupName?.(jid)) || "غير معروف";
            await sendBlacklistForms(sock, targets, groupName, who);
        }
    } catch (e) {
        console.error("خطأ الاستمارة:", e?.message);
    }
}

function cleanupPunished() {
    const now = Date.now();
    for (const [k, v] of punished) if (v.until < now) punished.delete(k);
}

// فتح القروب بعد القفل: يُسجَّل في قاعدة البيانات (حتى لا يبقى القروب مقفلاً إذا أُعيد تشغيل البوت)
function scheduleReopen(sock, jid, ms, hooks = {}) {
    if (typeof hooks.scheduleUnlock === "function") {
        hooks.scheduleUnlock(jid, ms);
        return;
    }
    setTimeout(async () => {
        try {
            await sock.groupSettingUpdate(jid, "not_announcement");
            await sock.sendMessage(jid, { text: decorateLock(false) }).catch(() => {});
        } catch {}
    }, ms);
}

async function handleAntiLeaveZzs(sock, update, hooks = {}) {
    const { id: jid, action, participants } = update || {};
    if (action !== "remove") return;

    const leaver = participants?.[0];
    if (!leaver) return;

    try {
        if (recentMessages[jid]) {
            const leaverKey = normJid(leaver);
            const userMsgs = recentMessages[jid].filter(m => normJid(m.sender) === leaverKey).slice(-15);
            const last10 = recentMessages[jid].slice(-10);
            const seen = new Set();
            for (const m of [...userMsgs, ...last10]) {
                const id = m.msgKey?.id;
                if (!id || seen.has(id)) continue;   // لا نحذف نفس الرسالة مرتين
                seen.add(id);
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

        scheduleReopen(sock, jid, 3 * 60 * 1000, hooks);

    } catch (e) {
        console.error("خطأ في معالجة مغادرة العضو:", e?.message);
    }
}

export {
    trackMessage,
    handleAntiContact,
    handleAntiLeaveZzs,
    cleanupRecentMessages,
    cleanupPunished,
    isPunished,
    handlePunishedFollowUp,
    normJid
};
