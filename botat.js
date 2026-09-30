// botat.js - كاشف حسابات البوتات لقروب الاستقبال (ESM - Baileys 6.7.9)
//
// الفكرة: كل عضو جديد في "الاستقبال" يُجمع له نقاط شك من عدة إشارات،
// وبعدها يُقبل أو يُحوَّل لمراجعة المالك. لا يوجد طرد تلقائي أبداً.
//
// الإشارات:
//   1) الأجهزة المرتبطة للرقم (getUSyncDevices)         -> ضعيفة/متوسطة (واتساب ويب يظهر بنفس الشكل)
//   2) جهاز الإرسال عند تنفيذ المهمة (device في participant) -> متوسطة
//   3) بصمة معرّف الرسالة (key.id)                        -> ضعيفة (تحتاج معايرة بوضع التشخيص)
//   4) فخ الإيصالات: قراءة فورية لرسالة الترحيب            -> متوسطة عند التكرار
//   5) تفاعل/رد فوري غير مطلوب بعد رسالة الترحيب          -> متوسطة
//   + سجل دخول (من أضاف من ومتى) لتحليل الحوادث لاحقاً

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_FILE = path.join(__dirname, "botat-db.json");

// ============================================================
// الإعدادات الافتراضية (تُحفظ وتتعدل بالأوامر)
// ============================================================

const DEFAULT_CONFIG = {
    enabled: true,
    receptionGroup: null,      // يُضبط بالأمر .تعيين_استقبال
    mainGroup: null,           // يُضبط بالأمر .تعيين_اساسي
    autoAdmit: false,          // قبول تلقائي للحالات النظيفة (مطفأ افتراضياً)
    requireTask: true,         // لا قبول تلقائي قبل ما ينفذ العضو المهمة (رسالة)
    debug: false,              // يطبع بصمات الرسائل للمعايرة
    thresholds: { review: 3, high: 6 },
    finalizeAfterMs: 3 * 60 * 1000,   // مهلة الحكم النهائي بعد الدخول
    quickReadMs: 2500,                // القراءة الأسرع من هذا تعتبر آلية
    quickReplyMs: 2500,               // تفاعل خلال هذه المدة بعد الترحيب يعتبر آلياً
    taskText: "اكتب كلمة *تم* هنا للتوثيق ✅",
    points: {
        linked1: 1,        // جهاز مرتبط واحد
        linked2: 2,        // جهازان مرتبطان أو أكثر
        msgDevice: 3,      // أرسل رسالة المهمة من جهاز غير 0
        idBaeSig: 3,       // معرّف يبدأ BAE5 (توقيع Baileys قديم)
        idLongWebSig: 2,   // 3EB0 بطول 36+ (نمط Baileys الحديث المحتمل)
        quickRead1: 1,
        quickReadRepeat: 2,
        autoReaction: 3
    }
};

// ============================================================
// التخزين
// ============================================================

let db = { config: {}, members: {}, joinLog: [] };

try {
    if (fs.existsSync(DB_FILE)) {
        const parsed = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
        if (parsed && typeof parsed === "object") db = { ...db, ...parsed };
    }
} catch (e) {
    console.error("⚠️ botat: تعذر قراءة botat-db.json، سيتم إنشاء ملف جديد.");
}

function saveDb() {
    try {
        const tmp = `${DB_FILE}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
        fs.renameSync(tmp, DB_FILE);
    } catch (e) {
        console.error("❌ botat: خطأ حفظ القاعدة:", e?.message);
    }
}

function cfg() {
    return {
        ...DEFAULT_CONFIG,
        ...db.config,
        thresholds: { ...DEFAULT_CONFIG.thresholds, ...(db.config?.thresholds || {}) },
        points: { ...DEFAULT_CONFIG.points, ...(db.config?.points || {}) }
    };
}

// ============================================================
// حالة الذاكرة
// ============================================================

let ownerNumbers = [];
let selfNumber = "";
const baits = new Map();          // messageId -> { sentAt, group }
const finalizeTimers = new Map(); // memberKey -> timeout
const scanCache = new Map();      // memberKey -> { at, result }
const SCAN_CACHE_MS = 5 * 60 * 1000;
const MAX_BAITS = 300;

export function initBotat({ owners = [], botNumber = "" } = {}) {
    ownerNumbers = owners.map(n => String(n).replace(/[^0-9]/g, "")).filter(Boolean);
    selfNumber = String(botNumber).replace(/[^0-9]/g, "");
}

// ============================================================
// أدوات JID
// ============================================================

export function parseJid(jid) {
    const s = String(jid || "");
    const at = s.indexOf("@");
    const server = at >= 0 ? s.slice(at + 1) : "";
    const left = at >= 0 ? s.slice(0, at) : s;
    const colon = left.indexOf(":");
    const userPart = colon >= 0 ? left.slice(0, colon) : left;
    const device = colon >= 0 ? parseInt(left.slice(colon + 1), 10) || 0 : 0;
    const user = userPart.split("_")[0];
    return { user, device, server };
}

function normalizeJid(jid) {
    const p = parseJid(jid);
    return p.user && p.server ? `${p.user}@${p.server}` : String(jid || "");
}

function numOf(jid) {
    return parseJid(jid).user.replace(/[^0-9]/g, "");
}

function isExempt(jid) {
    const n = numOf(jid);
    return !n || n === selfNumber || ownerNumbers.includes(n);
}

// ============================================================
// سجل العضو + النقاط
// ============================================================

function getRecord(jid, create = true) {
    const key = normalizeJid(jid);
    if (!db.members[key] && create) {
        db.members[key] = {
            jid: key,
            name: null,
            joinedAt: Date.now(),
            addedBy: null,
            signals: {},
            score: 0,
            level: "clear",
            status: "pending",      // pending | waiting | clear | review | admitted | blocked
            taskDone: false,
            quickReads: 0,
            devices: null,
            alerted: false,
            admitted: false
        };
    }
    return db.members[key] || null;
}

function setSignal(rec, key, points, reason) {
    if (!points) return;
    rec.signals[key] = { points, reason, at: Date.now() };
    rec.score = Object.values(rec.signals).reduce((a, s) => a + s.points, 0);
}

export function classify(score) {
    const t = cfg().thresholds;
    if (score >= t.high) return "high";
    if (score >= t.review) return "review";
    return "clear";
}

const LEVEL_LABEL = { clear: "🟢 نظيف", review: "🟡 مراجعة", high: "🔴 شك عالٍ" };

// ============================================================
// (1) الأجهزة المرتبطة - getUSyncDevices
// ============================================================

function withTimeout(promise, ms) {
    return Promise.race([
        promise,
        new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))
    ]);
}

// يرجع { ok, count, devices:[ids], method, error }
export async function getLinkedDevices(sock, memberJid) {
    const p = parseJid(memberJid);
    if (p.server !== "s.whatsapp.net") {
        return { ok: false, count: 0, devices: [], error: "الحساب بصيغة LID غير مدعومة في هذه النسخة" };
    }
    const userJid = `${p.user}@s.whatsapp.net`;

    try {
        // المسار الأساسي: getUSyncDevices(jids, useCache, ignoreZeroDevices)
        if (typeof sock.getUSyncDevices === "function") {
            const list = await withTimeout(sock.getUSyncDevices([userJid], false, false), 20000);
            const ids = (Array.isArray(list) ? list : [])
                .map(d => (typeof d?.device === "number" ? d.device : parseJid(d?.jid).device));
            if (!ids.length) return { ok: false, count: 0, devices: [], method: "getUSyncDevices", error: "لم تُرجَع أجهزة (الرقم غير مسجل أو فشل الاستعلام)" };
            const linked = ids.filter(id => id > 0);
            return { ok: true, count: linked.length, devices: ids, method: "getUSyncDevices" };
        }

        // مسار احتياطي: executeUSyncQuery
        if (typeof sock.executeUSyncQuery === "function") {
            const B = await import("@whiskeysockets/baileys");
            const lib = { ...(B.default || {}), ...B };
            if (lib.USyncQuery && lib.USyncUser) {
                const q = new lib.USyncQuery().withDeviceProtocol().withUser(new lib.USyncUser().withId(userJid));
                const res = await withTimeout(sock.executeUSyncQuery(q), 20000);
                const item = res?.list?.[0];
                const raw = item?.devices?.deviceList || item?.devices || [];
                const ids = (Array.isArray(raw) ? raw : []).map(d => (typeof d?.id === "number" ? d.id : 0));
                if (!ids.length) return { ok: false, count: 0, devices: [], method: "executeUSyncQuery", error: "نتيجة فارغة" };
                return { ok: true, count: ids.filter(i => i > 0).length, devices: ids, method: "executeUSyncQuery" };
            }
        }
        return { ok: false, count: 0, devices: [], error: "لا getUSyncDevices ولا executeUSyncQuery في هذه النسخة" };
    } catch (e) {
        return { ok: false, count: 0, devices: [], error: e?.message || String(e) };
    }
}

async function scanDevices(sock, rec) {
    const key = rec.jid;
    const cached = scanCache.get(key);
    let res;
    if (cached && Date.now() - cached.at < SCAN_CACHE_MS) {
        res = cached.result;
    } else {
        res = await getLinkedDevices(sock, rec.jid);
        scanCache.set(key, { at: Date.now(), result: res });
    }
    rec.devices = { ok: res.ok, count: res.count, list: res.devices, method: res.method || null, error: res.error || null, at: Date.now() };

    const P = cfg().points;
    if (res.ok && res.count >= 2) {
        setSignal(rec, "linkedDevices", P.linked2, `${res.count} أجهزة مرتبطة بالرقم`);
    } else if (res.ok && res.count === 1) {
        setSignal(rec, "linkedDevices", P.linked1, "جهاز مرتبط واحد (قد يكون واتساب ويب)");
    } else if (rec.signals.linkedDevices) {
        delete rec.signals.linkedDevices;
        rec.score = Object.values(rec.signals).reduce((a, s) => a + s.points, 0);
    }
    return res;
}

// ============================================================
// (2)+(3) جهاز الإرسال وبصمة المعرّف
// ============================================================

export function analyzeKey(key) {
    const id = String(key?.id || "");
    const device = parseJid(key?.participant || "").device;
    const P = cfg().points;
    const found = [];

    if (device > 0) {
        found.push({ key: "msgDevice", points: P.msgDevice, reason: `نفّذ المهمة من جهاز مرتبط (device ${device})` });
    }
    if (/^BAE5/i.test(id)) {
        found.push({ key: "idFingerprint", points: P.idBaeSig, reason: `معرّف الرسالة بتوقيع BAE5 (${id.length} حرف)` });
    } else if (/^3EB0/i.test(id) && id.length >= 36) {
        found.push({ key: "idFingerprint", points: P.idLongWebSig, reason: `معرّف بنمط 3EB0 طويل (${id.length} حرف)` });
    }
    return { id, device, found };
}

// ============================================================
// (4) فخ الإيصالات + رسالة الترحيب (تعمل كمهمة وكطُعم)
// ============================================================

async function sendWelcomeBait(sock, memberJid) {
    const c = cfg();
    if (!c.receptionGroup) return;
    const tag = `@${numOf(memberJid)}`;
    try {
        const sent = await sock.sendMessage(c.receptionGroup, {
            text: `أهلاً بك ${tag} 👋\n${c.taskText}`,
            mentions: [memberJid]
        });
        const id = sent?.key?.id;
        if (id) {
            baits.set(id, { sentAt: Date.now(), group: c.receptionGroup });
            if (baits.size > MAX_BAITS) baits.delete(baits.keys().next().value);
        }
        const rec = getRecord(memberJid);
        rec.baitSentAt = Date.now();
        saveDb();
    } catch (e) {
        console.error("botat: فشل إرسال الترحيب:", e?.message);
    }
}

// حدث message-receipt.update: [{ key, receipt:{ userJid, readTimestamp } }]
export async function onReceipt(sock, updates) {
    try {
        const c = cfg();
        if (!c.enabled || !Array.isArray(updates)) return;

        for (const u of updates) {
            const bait = baits.get(u?.key?.id);
            if (!bait) continue;
            const r = u.receipt || {};
            const reader = r.userJid;
            if (!reader || !r.readTimestamp || isExempt(reader)) continue;

            const readMs = Number(r.readTimestamp) * 1000;   // الدقة بالثواني فقط
            const delay = readMs - bait.sentAt;
            if (c.debug) console.log(`[botat] قراءة ${numOf(reader)} بعد ${delay}ms`);
            if (delay > c.quickReadMs) continue;

            const rec = getRecord(reader, false);
            if (!rec) continue;
            rec.quickReads = (rec.quickReads || 0) + 1;
            if (rec.quickReads === 1) {
                setSignal(rec, "quickRead", c.points.quickRead1, "قراءة فورية لرسالة الترحيب");
            } else {
                setSignal(rec, "quickRead", c.points.quickReadRepeat, `قراءة فورية متكررة (${rec.quickReads} مرات)`);
            }
            await evaluate(sock, rec, { final: false });
        }
        saveDb();
    } catch (e) {
        console.error("botat onReceipt:", e?.message);
    }
}

// ============================================================
// التقييم والقرار
// ============================================================

function reportText(rec, title = "تقرير فحص عضو") {
    const lines = [
        `🕵️ *${title}*`,
        `👤 الرقم: ${numOf(rec.jid)}${rec.name ? ` (${rec.name})` : ""}`,
        `📊 النقاط: ${rec.score} - ${LEVEL_LABEL[classify(rec.score)]}`
    ];
    if (rec.addedBy) lines.push(`➕ أضافه: ${numOf(rec.addedBy)}`);
    if (rec.devices) {
        lines.push(rec.devices.ok
            ? `📱 الأجهزة: ${rec.devices.list.length} (المرتبطة: ${rec.devices.count})`
            : `📱 الأجهزة: تعذر الفحص - ${rec.devices.error}`);
    }
    lines.push(`✅ نفّذ المهمة: ${rec.taskDone ? "نعم" : "لا"}`);
    const sig = Object.values(rec.signals);
    if (sig.length) {
        lines.push("", "*الإشارات:*", ...sig.map(s => `• ${s.reason} (+${s.points})`));
    } else {
        lines.push("", "لا توجد إشارات شك.");
    }
    return lines.join("\n");
}

async function notifyOwners(sock, text, mentions = []) {
    for (const n of ownerNumbers) {
        try { await sock.sendMessage(`${n}@s.whatsapp.net`, { text, mentions }); } catch {}
    }
}

async function evaluate(sock, rec, { final = false } = {}) {
    const c = cfg();
    rec.level = classify(rec.score);

    if (rec.level === "high" && !rec.alerted) {
        rec.alerted = true;
        rec.status = "review";
        await notifyOwners(sock, reportText(rec, "⚠️ تنبيه فوري: شك عالٍ"));
        saveDb();
        return;
    }

    if (!final) return;

    if (rec.level === "clear") {
        if (c.requireTask && !rec.taskDone) {
            rec.status = "waiting";
            if (!rec.alerted) {
                rec.alerted = true;
                await notifyOwners(sock, reportText(rec, "لم ينفذ المهمة بعد (لا حكم)"));
            }
        } else {
            rec.status = "clear";
            if (c.autoAdmit && c.mainGroup && !rec.admitted) {
                await admitToMain(sock, rec.jid).catch(() => {});
            }
        }
    } else {
        rec.status = "review";
        if (!rec.alerted) {
            rec.alerted = true;
            await notifyOwners(sock, reportText(rec, "عضو يحتاج مراجعة"));
        }
    }
    saveDb();
}

// ============================================================
// الإدخال إلى الأساسي
// ============================================================

export async function admitToMain(sock, memberJid) {
    const c = cfg();
    if (!c.mainGroup) return { ok: false, reason: "لم يُعيَّن القروب الأساسي" };
    const rec = getRecord(memberJid);

    try {
        const res = await sock.groupParticipantsUpdate(c.mainGroup, [normalizeJid(memberJid)], "add");
        const status = String(res?.[0]?.status || "");
        if (status === "200") {
            rec.admitted = true;
            rec.status = "admitted";
            saveDb();
            return { ok: true };
        }
        // غالباً 403 = خصوصية تمنع الإضافة المباشرة -> رابط دعوة في الاستقبال
        const code = await sock.groupInviteCode(c.mainGroup);
        if (code && c.receptionGroup) {
            await sock.sendMessage(c.receptionGroup, {
                text: `@${numOf(memberJid)} تم قبولك ✅\nادخل الأساسي من هنا:\nhttps://chat.whatsapp.com/${code}`,
                mentions: [memberJid]
            });
        }
        rec.status = "admitted";
        rec.admitted = true;
        saveDb();
        return { ok: true, invite: true, status };
    } catch (e) {
        return { ok: false, reason: e?.message || String(e) };
    }
}

// ============================================================
// الأحداث الواردة من index.js
// ============================================================

// group-participants.update
export async function onParticipantsUpdate(sock, update) {
    try {
        const c = cfg();
        if (!c.enabled || update?.action !== "add") return;

        // سجل الدخول لكل القروبات (لتحليل الحوادث)
        for (const p of update.participants || []) {
            db.joinLog.push({ group: update.id, member: normalizeJid(p), by: update.author ? normalizeJid(update.author) : null, at: Date.now() });
        }
        if (db.joinLog.length > 1000) db.joinLog = db.joinLog.slice(-1000);
        saveDb();

        if (!c.receptionGroup || update.id !== c.receptionGroup) return;

        for (const p of update.participants || []) {
            const memberJid = normalizeJid(p);
            if (isExempt(memberJid)) continue;

            const rec = getRecord(memberJid);
            rec.joinedAt = Date.now();
            rec.addedBy = update.author ? normalizeJid(update.author) : null;
            rec.status = "pending";
            rec.alerted = false;

            await scanDevices(sock, rec);
            await sendWelcomeBait(sock, memberJid);
            await evaluate(sock, rec, { final: false });
            scheduleFinalize(sock, memberJid);
            saveDb();
        }
    } catch (e) {
        console.error("botat onParticipantsUpdate:", e?.message);
    }
}

function scheduleFinalize(sock, memberJid) {
    const key = normalizeJid(memberJid);
    if (finalizeTimers.has(key)) clearTimeout(finalizeTimers.get(key));
    const t = setTimeout(async () => {
        finalizeTimers.delete(key);
        const rec = getRecord(key, false);
        if (rec) await evaluate(sock, rec, { final: true }).catch(() => {});
    }, cfg().finalizeAfterMs);
    t.unref?.();
    finalizeTimers.set(key, t);
}

// messages.upsert (رسائل القروبات فقط)
export async function onMessage(sock, msg) {
    try {
        const c = cfg();
        if (!c.enabled || !c.receptionGroup) return;
        const group = msg?.key?.remoteJid;
        if (group !== c.receptionGroup || msg.key.fromMe) return;

        const participant = msg.key.participant;
        if (!participant || isExempt(participant)) return;

        const rec = getRecord(participant);
        if (msg.pushName) rec.name = msg.pushName;

        // عضو قديم لم يُفحص بعد
        if (!rec.devices) {
            await scanDevices(sock, rec);
            scheduleFinalize(sock, participant);
        }

        const ka = analyzeKey(msg.key);
        if (c.debug) {
            console.log(`[botat] رسالة ${numOf(participant)} | id=${ka.id} (${ka.id.length}) | device=${ka.device}`);
        }
        for (const f of ka.found) setSignal(rec, f.key, f.points, f.reason);

        const isReaction = !!msg.message?.reactionMessage;
        const sinceBait = rec.baitSentAt ? Date.now() - rec.baitSentAt : Infinity;

        if (isReaction && sinceBait <= c.quickReplyMs) {
            setSignal(rec, "autoReaction", c.points.autoReaction, `تفاعل تلقائي بعد ${sinceBait}ms من الترحيب`);
        }

        // أي رسالة نصية = تنفيذ المهمة
        const hasText = !!(msg.message?.conversation || msg.message?.extendedTextMessage?.text);
        if (hasText && !rec.taskDone) {
            rec.taskDone = true;
            rec.taskAt = Date.now();
        }

        await evaluate(sock, rec, { final: false });
        saveDb();
    } catch (e) {
        console.error("botat onMessage:", e?.message);
    }
}

// ============================================================
// الأوامر (تعمل بالنقطة فقط لتفادي التفعيل بالغلط)
// ============================================================

function getText(msg) {
    const m = msg?.message || {};
    return m.conversation || m.extendedTextMessage?.text || "";
}

function pickTarget(ctx) {
    const { msg, mentioned, args } = ctx;
    if (mentioned?.length) return mentioned[0];
    const quoted = msg.message?.extendedTextMessage?.contextInfo?.participant;
    if (quoted) return quoted;
    const digits = String(args?.[0] || "").replace(/[^0-9]/g, "");
    if (digits.length >= 7) return `${digits}@s.whatsapp.net`;
    return null;
}

const BOTAT_COMMANDS = new Set([
    "كاشف", "تعيين_استقبال", "تعيين_اساسي", "قبول_تلقائي",
    "فحص", "قبول", "المشتبهين", "سجل_الدخول", "تشخيص_كاشف", "حالة_الكاشف"
]);

// يرجع true إذا عالج الأمر
export async function handleBotatCommand(ctx) {
    const { sock, jid, msg, command, args, isOwner, hasLocalAccess, isGroup } = ctx;
    if (!BOTAT_COMMANDS.has(command)) return false;
    if (!getText(msg).trim().startsWith(".")) return false;
    if (!isOwner && !hasLocalAccess) return true;

    const reply = (text, mentions = []) => sock.sendMessage(jid, { text, mentions }, { quoted: msg }).catch(() => {});
    const onOff = a => (a === "on" ? true : a === "off" ? false : null);

    if (command === "كاشف") {
        const v = onOff(args[0]?.toLowerCase());
        if (v === null) return reply("الاستخدام: `.كاشف on` أو `.كاشف off`"), true;
        db.config.enabled = v; saveDb();
        return reply(v ? "✅ تم تشغيل كاشف البوتات" : "❌ تم إيقاف كاشف البوتات"), true;
    }

    if (command === "تشخيص_كاشف") {
        const v = onOff(args[0]?.toLowerCase());
        if (v === null) return reply("الاستخدام: `.تشخيص_كاشف on/off`"), true;
        db.config.debug = v; saveDb();
        return reply(v ? "🧪 وضع التشخيص شغّال (البصمات تظهر في سجل السيرفر)" : "وضع التشخيص مطفأ"), true;
    }

    if (command === "قبول_تلقائي") {
        const v = onOff(args[0]?.toLowerCase());
        if (v === null) return reply("الاستخدام: `.قبول_تلقائي on/off`"), true;
        db.config.autoAdmit = v; saveDb();
        return reply(v ? "✅ القبول التلقائي للحالات النظيفة شغّال" : "❌ القبول التلقائي مطفأ (القبول يدوي)"), true;
    }

    if (command === "تعيين_استقبال" || command === "تعيين_اساسي") {
        if (!isOwner) return reply("⚠️ للمالك فقط"), true;
        if (!isGroup) return reply("⚠️ اكتب الأمر داخل القروب المطلوب"), true;
        if (command === "تعيين_استقبال") db.config.receptionGroup = jid;
        else db.config.mainGroup = jid;
        saveDb();
        return reply(command === "تعيين_استقبال" ? "✅ هذا القروب صار *الاستقبال*" : "✅ هذا القروب صار *الأساسي*"), true;
    }

    if (command === "حالة_الكاشف") {
        const c = cfg();
        const total = Object.keys(db.members).length;
        const sus = Object.values(db.members).filter(m => classify(m.score) !== "clear").length;
        return reply(
            `🕵️ *حالة الكاشف*\n` +
            `التشغيل: ${c.enabled ? "✅" : "❌"}\n` +
            `الاستقبال: ${c.receptionGroup ? "معيّن" : "غير معيّن"}\n` +
            `الأساسي: ${c.mainGroup ? "معيّن" : "غير معيّن"}\n` +
            `قبول تلقائي: ${c.autoAdmit ? "نعم" : "لا"}\n` +
            `تشخيص: ${c.debug ? "نعم" : "لا"}\n` +
            `أعضاء مفحوصون: ${total} | مشتبه بهم: ${sus}`
        ), true;
    }

    if (command === "فحص") {
        const target = pickTarget(ctx);
        if (!target) return reply("الاستخدام: `.فحص @عضو` أو رد على رسالته أو اكتب رقمه"), true;
        const rec = getRecord(target);
        scanCache.delete(rec.jid);
        await scanDevices(sock, rec);
        rec.level = classify(rec.score);
        saveDb();
        return reply(reportText(rec)), true;
    }

    if (command === "قبول") {
        const target = pickTarget(ctx);
        if (!target) return reply("الاستخدام: `.قبول @عضو`"), true;
        const r = await admitToMain(sock, target);
        return reply(r.ok ? (r.invite ? "✅ تم إرسال رابط الأساسي له في الاستقبال" : "✅ تمت إضافته للأساسي")
                          : `❌ فشل: ${r.reason}`), true;
    }

    if (command === "المشتبهين") {
        const list = Object.values(db.members)
            .filter(m => classify(m.score) !== "clear")
            .sort((a, b) => b.score - a.score)
            .slice(0, 15);
        if (!list.length) return reply("لا يوجد مشتبه بهم حالياً ✅"), true;
        return reply("🕵️ *المشتبه بهم:*\n" + list.map(m =>
            `• ${numOf(m.jid)}${m.name ? ` (${m.name})` : ""} - ${m.score} ${LEVEL_LABEL[classify(m.score)]}`
        ).join("\n")), true;
    }

    if (command === "سجل_الدخول") {
        const last = db.joinLog.slice(-10).reverse();
        if (!last.length) return reply("السجل فارغ"), true;
        return reply("📜 *آخر عمليات الدخول:*\n" + last.map(j =>
            `• ${numOf(j.member)} ← أضافه: ${j.by ? numOf(j.by) : "رابط/غير معروف"} | ${new Date(j.at).toLocaleString("ar")}`
        ).join("\n")), true;
    }

    return false;
}

// ============================================================
// تنظيف
// ============================================================

export function cleanupBotat() {
    try {
        const now = Date.now();
        for (const [id, b] of baits) if (now - b.sentAt > 60 * 60 * 1000) baits.delete(id);
        for (const [k, v] of scanCache) if (now - v.at > SCAN_CACHE_MS) scanCache.delete(k);
    } catch {}
}
