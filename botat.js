// botat.js - كاشف البوتات الجيل الثاني (ESM - Baileys 6.7.x)
//
// الفلسفة الجديدة: لا إشارة واحدة تحكم. كل عضو يُجمع له 13 إشارة من
// 4 طبقات مستقلة، ولا يُحسم الحكم إلا بتقاطع الإشارات:
//
//   الطبقة 0) الأجهزة (USync): الأجهزة المرتبطة + أرشيف أرقام الأجهزة
//   الطبقة 1) بصمة الرسالة: BAE5 (توقيع Baileys) / 3EB0 / هكس-32 / مختلط
//   الطبقة 2) الحضور (presence): البومة الليلية، المراقب الصامت
//   الطبقة 3) السلوك: غياب الكتابة، الإيقاع الآلي، انعدام الإيصالات
//
// الجديد مقارنة بالجيل الأول:
//   ✦ حل مشكلة LID (أغلب الداخلين الجدد كانوا يفشلون فوراً)
//   ✦ BAE5 صار هو الإشارة الأقوى بدل 3EB0 (3EB0 = واتساب ويب الرسمي أيضاً)
//   ✦ إلغاء الاعتماد على "القراءة الفورية" كدليل (دقتها بالثواني = ضعيفة)
//   ✦ إشارات سلوكية يستحيل على البوت تقليدها كلها معاً

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_FILE = path.join(__dirname, "botat-db.json");

// ============================================================
// الإعدادات الافتراضية
// ============================================================

const DEFAULT_CONFIG = {
    enabled: true,
    receptionGroup: null,
    mainGroup: null,
    autoAdmit: false,
    requireTask: true,
    debug: false,
    thresholds: { review: 7, high: 14 },
    finalizeAfterMs: 5 * 60 * 1000,
    quickReadMs: 2500,
    quickReplyMs: 2000,
    detectMinLinked: 1,
    taskText: "اكتب كلمة *تم* هنا للتوثيق ✅",
    points: {
        linked1: 4,         // جهاز مرتبط واحد (بوت أو ويب — يُفسر مع باقي الإشارات)
        linked2: 5,         // جهازان مرتبطان أو أكثر
        deviceAged: 4,      // رقم جهاز ≥ 15 = جلسات ربط كثيرة (استضافة بوتات)
        multiCompanion: 3,  // 3+ أجهزة مرتبطة
        msgDevice: 2,       // نفّذ المهمة من جهاز مرتبط
        idBaeSig: 6,        // توقيع Baileys المباشر (BAE5 + 16 هكس) — شبه مؤكد
        idWebSig: 3,        // نمط 3EB0 (ويب رسمي أو مكتبة)
        idHex32: 3,         // معرّف 32 خانة هكس نقية (نمط مكتبات)
        companionOnly: 4,   // لا يرسل إلا من جهاز مرتبط أبداً
        noTyping: 1,        // رسالة بدون مؤشر كتابة (يشطب بعد 3 متتالية)
        noTypingPattern: 4, // 5+ رسائل ولا مرة واحدة "يكتب الآن" — بشر شبه مستحيل
        machineCadence: 4,  // فواصل زمنية شبه ثابتة (CV < 0.25) — حلقة تكرار
        receiptVoid: 4,     // 6+ رسائل مرسلة وصفر إيصالات طوال اليوم (Baileys افتراضياً بلا إيصالات)
        nightOwl: 3,        // حضور متكرر أونلاين بين 3-6 فجراً
        silentWatcher: 3,   // 10+ أحداث حضور وصفر رسائل — بوت رصد/سحب صامت
        taskReplyNoType: 3, // رد "تم" خلال 1.5 ثانية بدون أي مؤشر كتابة
        quickRead1: 1,
        quickReadRepeat: 2,
        autoReaction: 3
    }
};

// ============================================================
// التخزين
// ============================================================

let db = { config: {}, members: {}, joinLog: [], detectGroups: {}, stats: {}, lidMap: {} };

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

let saveTimer = null;
function saveDbSoon() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => { saveTimer = null; saveDb(); }, 5000);
    saveTimer.unref?.();
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
const baits = new Map();
const finalizeTimers = new Map();
const scanCache = new Map();       // jid -> { at, result }
const SCAN_CACHE_MS = 5 * 60 * 1000;
const MAX_BAITS = 300;
const PRESENCE_WATCH_MS = 15 * 60 * 1000; // مدة مراقبة الحضور بعد الدخول

let trustedHook = () => false;

export function initBotat({ owners = [], botNumber = "", isTrusted = null } = {}) {
    ownerNumbers = owners.map(n => String(n).replace(/[^0-9]/g, "")).filter(Boolean);
    selfNumber = String(botNumber).replace(/[^0-9]/g, "");
    if (typeof isTrusted === "function") trustedHook = isTrusted;
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

function isExemptIn(group, jid) {
    if (isExempt(jid)) return true;
    try { return !!trustedHook(group, jid); } catch { return false; }
}

// الحل الجذري لمشكلة LID: نحاول دائماً الوصول للرقم الحقيقي
// (تحتاج تفعيل lidMapping: true في إعدادات السوكت — انظر ملاحظات index.js)
function resolvePhoneJid(jid) {
    const s = String(jid || "");
    if (!s.includes("@lid")) return s;
    const mapped = db.lidMap?.[s];
    return mapped || s;
}

function rememberLidMapping(lidJid, phoneJid) {
    if (!lidJid || !phoneJid) return;
    if (!String(lidJid).includes("@lid")) return;
    if (!db.lidMap) db.lidMap = {};
    if (db.lidMap[lidJid] !== phoneJid) {
        db.lidMap[lidJid] = phoneJid;
        if (Object.keys(db.lidMap).length > 3000) {
            delete db.lidMap[Object.keys(db.lidMap)[0]];
        }
        saveDbSoon();
    }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const toId = (p) => (typeof p === "string" ? p : p?.id || "");

// ============================================================
// سجل العضو
// ============================================================

function getRecord(jid, create = true) {
    const key = normalizeJid(resolvePhoneJid(jid));
    if (!db.members[key] && create) {
        db.members[key] = {
            jid: key,
            name: null,
            joinedAt: Date.now(),
            addedBy: null,
            signals: {},
            score: 0,
            level: "clear",
            status: "pending",
            taskDone: false,
            quickReads: 0,
            devices: null,
            alerted: false,
            admitted: false
        };
    }
    return db.members[key] || null;
}

// ============================================================
// 📈 إحصاءات السلوك والحضور (عبر كل القروبات)
// ============================================================

const COMPANION_MIN_MSGS = 5;

function getStats(num, create = true) {
    const now = Date.now();
    const st = db.stats[num];
    if (st) return st;
    if (!create) return null;
    return (db.stats[num] = {
        d0: 0, dx: 0, w: 0, o: 0,        // أجهزة الإرسال + نمط المعرّف
        ids: [],                          // آخر 5 معرّفات
        msgs: 0,                          // عدد الرسائل الكلي
        noType: 0, typed: 0,              // رسائل بلا/مع مؤشر كتابة
        lastTypingAt: 0,
        intervals: [],                    // آخر 12 فاصل زمني (ذاكرة فقط)
        lastMsgAt: 0, firstMsgAt: 0,
        receipts: 0,                      // عدد إيصالات القراءة التي أرسلها
        onlineEvents: 0, nightOnline: 0,  // حضور + حضور ليلي
        lastPresence: null,
        subscribedAt: 0,
        first: now, last: now
    });
}

function observeSender(num, ka) {
    const st = getStats(num);
    const now = Date.now();
    if (ka.device > 0) st.dx++; else st.d0++;
    if (/^3EB0/i.test(ka.id)) st.w++; else st.o++;
    st.ids.push(ka.id);
    if (st.ids.length > 5) st.ids.shift();
    st.last = now;
    return st;
}

// ✍️ تحليل "الكتابة": هل سبق الرسالة مؤشر composing خلال 8 ثوانٍ؟
function observeTyping(num, msgKeyId) {
    const st = getStats(num, false);
    if (!st) return;
    const now = Date.now();
    const hadTyping = st.lastTypingAt && (now - st.lastTypingAt) < 8000;
    if (hadTyping) { st.typed++; st.noType = 0; }
    else { st.noType++; }
    if (st.intervals && st.lastMsgAt && now - st.lastMsgAt < 60000) {
        st.intervals.push(now - st.lastMsgAt);
        if (st.intervals.length > 12) st.intervals.shift();
    }
    st.lastMsgAt = now;
    if (!st.firstMsgAt) st.firstMsgAt = now;
}

// ⏱️ الإيقاع الآلي: معامل الاختلاف (CV) للفواصل الزمنية
// البشر عشوائيون (CV مرتفع)، حلقات البوت شبه ثابتة (CV < 0.25)
function cadenceIsMachine(st) {
    const iv = (st.intervals || []).slice(-8);
    if (iv.length < 6) return false;
    const mean = iv.reduce((a, b) => a + b, 0) / iv.length;
    if (mean < 1200 || mean > 30000) return false; // خارج النطاق = لا حكم
    const variance = iv.reduce((a, b) => a + (b - mean) ** 2, 0) / iv.length;
    const cv = Math.sqrt(variance) / mean;
    return cv < 0.25;
}

function isCompanionOnly(st) {
    return (st.dx >= COMPANION_MIN_MSGS && st.d0 === 0) ||
           (st.w >= COMPANION_MIN_MSGS && st.o === 0);
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

function botPercent(score) {
    return Math.min(99, Math.round((score / cfg().thresholds.high) * 100));
}

// ============================================================
// (الطبقة 2) 👁 الحضور والكتابة — presence.update
// يُرسل من index.js: sock.ev.on("presence.update", ...)
// ============================================================

export async function onPresence(sock, update) {
    try {
        if (!cfg().enabled) return;
        for (const p of update?.presences || []) {
            const jid = resolvePhoneJid(p?.id);
            const num = numOf(jid);
            if (!num || isExempt(jid)) continue;

            const st = getStats(num);
            const now = Date.now();
            const pres = p.lastKnownPresence;

            if (pres === "composing" || pres === "recording") {
                st.lastTypingAt = now;           // ← الذهب: البشر يكتبون قبل ما يرسلون
            } else if (pres === "available") {
                st.onlineEvents++;
                const h = new Date().getHours();
                if (h >= 3 && h <= 6) st.nightOnline++;   // 🌙 البومة الليلية
            }
            st.lastPresence = pres || "unavailable";
            st.last = now;

            // إشارات قابلة للتفعيل فوراً
            const rec = getRecord(jid, false);
            if (rec && !rec.signals.silentWatcher && st.onlineEvents >= 10 && st.msgs === 0) {
                setSignal(rec, "silentWatcher", cfg().points.silentWatcher,
                    `حضور متكرر (${st.onlineEvents} مرة) بدون أي رسالة — مراقب صامت`);
                evaluate(sock, rec, { final: false }).catch(() => {});
            }
        }
        saveDbSoon();
    } catch (e) {
        console.error("botat onPresence:", e?.message);
    }
}

// نطلب الاشتراك بحضور العضو الجديد فور دخوله (يتطلب أن يكون الرقم بين جهات اتصال
// البوت أو أن يكونوا متفاعلين — نجرب وإن فشل لا ضرر)
function watchPresence(sock, jid) {
    try {
        const st = getStats(numOf(jid), false);
        if (st) st.subscribedAt = Date.now();
        sock.presenceSubscribe?.(normalizeJid(resolvePhoneJid(jid))).catch(() => {});
    } catch {}
}

// ============================================================
// (الطبقة 0) الأجهزة المرتبطة - getUSyncDevices مع إعادة محاولة ذكية
// ============================================================

function withTimeout(promise, ms) {
    return Promise.race([
        promise,
        new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))
    ]);
}

// يرجع { ok, count, devices:[ids], maxId, method, error }
export async function getLinkedDevices(sock, memberJid) {
    const resolved = resolvePhoneJid(memberJid);
    const p = parseJid(resolved);
    if (p.server !== "s.whatsapp.net") {
        return { ok: false, count: 0, devices: [], maxId: 0, error: "معرّف LID بلا رقم معروف بعد (فعّل lidMapping أو انتظر أول رسالة منه)" };
    }
    const userJid = `${p.user}@s.whatsapp.net`;

    try {
        if (typeof sock.getUSyncDevices === "function") {
            const list = await withTimeout(sock.getUSyncDevices([userJid], false, false), 20000);
            const ids = (Array.isArray(list) ? list : [])
                .map(d => (typeof d?.device === "number" ? d.device : parseJid(d?.jid).device))
                .filter(n => Number.isFinite(n));
            if (!ids.length) {
                return { ok: false, count: 0, devices: [], maxId: 0, method: "getUSyncDevices", error: "لم تُرجَع أجهزة (الاستعلام رُفض أو الحساب غير ظاهر حالياً)" };
            }
            const linked = ids.filter(id => id > 0);
            return { ok: true, count: linked.length, devices: ids, maxId: Math.max(...ids), method: "getUSyncDevices" };
        }
        return { ok: false, count: 0, devices: [], maxId: 0, error: "getUSyncDevices غير متوفر في هذه النسخة" };
    } catch (e) {
        return { ok: false, count: 0, devices: [], maxId: 0, error: e?.message || String(e) };
    }
}

async function scanDevices(sock, rec) {
    const key = rec.jid;
    const cached = scanCache.get(key);
    let res;
    if (cached && Date.now() - cached.at < SCAN_CACHE_MS) {
        res = cached.result;
    } else {
        // إعادة محاولة حتى 3 مرات مع تراجع أسّي — الاستعلام يفشل كثيراً لحظة الدخول
        let lastErr = null;
        for (let attempt = 0; attempt < 3; attempt++) {
            res = await getLinkedDevices(sock, key);
            if (res.ok) break;
            lastErr = res.error;
            const wait = (/rate|overlimit|limit/i.test(lastErr || "")) ? 30000 : 4000 * (attempt + 1);
            if (cfg().debug) console.log(`[botat] فحص ${key} فشل (محاولة ${attempt + 1}/3): ${lastErr} — انتظار ${wait}ms`);
            await sleep(wait);
        }
        scanCache.set(key, { at: Date.now(), result: res });
    }
    rec.devices = { ok: res.ok, count: res.count, list: res.devices, maxId: res.maxId || 0, method: res.method || null, error: res.error || null, at: Date.now() };

    const P = cfg().points;
    if (res.ok && res.count >= 2) {
        setSignal(rec, "linkedDevices", P.linked2, `${res.count} أجهزة مرتبطة بالرقم`);
    } else if (res.ok && res.count === 1) {
        setSignal(rec, "linkedDevices", P.linked1, "جهاز مرتبط واحد (بوت أو واتساب ويب)");
    } else if (rec.signals.linkedDevices) {
        delete rec.signals.linkedDevices;
        rec.score = Object.values(rec.signals).reduce((a, s) => a + s.points, 0);
    }

    // 🏛 أرشيف الأجهزة: أرقام عالية = جلسات ربط كثيرة = استضافة بوتات
    if (res.ok && res.maxId >= 15) {
        setSignal(rec, "deviceAged", P.deviceAged, `أرقام أجهزة مرتفعة (حتى device ${res.maxId}) = تاريخ ربط جلسات كثير`);
    }
    if (res.ok && res.count >= 3) {
        setSignal(rec, "multiCompanion", P.multiCompanion, `${res.count} أجهزة مرتبطة معاً`);
    }
    return res;
}

// ============================================================
// (2) الحضور: يجب تمرير presence.update من index.js
// ============================================================

export async function onPresence(sock, update) {
    try {
        if (!cfg().enabled) return;
        for (const p of update?.presences || []) {
            const jid = normalizeJid(resolvePhoneJid(p?.id));
            const key = normalizeJid(jid);
            const scan = activeScans.get(key);
            if (!scan || scan.done) continue;

            if (p.lastKnownPresence === "available") {
                scan.presences++;
                const h = new Date().getHours();
                const rec = getRecord(jid, false);
                if (rec && !rec.signals.nightOwl && h >= 3 && h <= 6) {
                    setSignal(rec, "nightOwl", cfg().points.nightOwl, `ظهر أونلاين الساعة ${h} فجراً بدون أي تفاعل — بوت متصل دائماً`);
                }
                if (rec && !rec.signals.instantOnline && Date.now() - scan.startedAt < 10000) {
                    setSignal(rec, "instantOnline", cfg().points.instantOnline, "أونلاين خلال ثوانٍ من دخوله دون أي تفاعل");
                }
            }
        }
    } catch (e) {
        console.error("botat onPresence:", e?.message);
    }
}

// ============================================================
// (3) فخ الإيصال: قراءة فورية لرسالة الترحيب = قارئ آلي
// ============================================================

async function sendWelcomeBait(sock, memberJid) {
    const c = cfg();
    if (!c.receptionGroup) return null;
    const tag = `@${numOf(memberJid)}`;
    try {
        const sent = await sock.sendMessage(c.receptionGroup, {
            text: `أهلاً بك ${tag} 👋\n${c.taskText}`,
            mentions: [memberJid]
        });
        const id = sent?.key?.id;
        if (id) {
            baits.set(id, { sentAt: Date.now(), group: c.receptionGroup, memberJid: normalizeJid(memberJid) });
            if (baits.size > MAX_BAITS) baits.delete(baits.keys().next().value);
        }
        return id;
    } catch (e) {
        console.error("botat: فشل إرسال الترحيب:", e?.message);
        return null;
    }
}

export async function onReceipt(sock, updates) {
    try {
        if (!cfg().enabled || !Array.isArray(updates)) return;
        for (const u of updates) {
            const bait = baits.get(u?.key?.id);
            if (!bait) continue;
            const r = u.receipt || {};
            const reader = normalizeJid(resolvePhoneJid(r.userJid));
            if (!reader || !r.readTimestamp || isExempt(reader)) continue;

            const delay = Number(r.readTimestamp) * 1000 - bait.sentAt;
            if (cfg().debug) console.log(`[botat] قراءة ${numOf(reader)} بعد ${delay}ms`);
            if (delay < 0 || delay > cfg().quickReadMs) continue;

            const rec = getRecord(reader, false);
            if (!rec) continue;
            setSignal(rec, "quickRead", cfg().points.quickRead,
                `قرأ رسالة الترحيب خلال ${Math.max(0, Math.round(delay / 100) / 10)} ثانية (قارئ آلي)`);
            await evaluate(sock, rec, { final: false });
        }
    } catch (e) {
        console.error("botat onReceipt:", e?.message);
    }
}

// ============================================================
// ⏱ الروتين المركزي: فحص كامل خلال 60 ثانية من الدخول
// ============================================================

async function runJoinScan(sock, group, memberJid, addedBy) {
    const key = normalizeJid(memberJid);
    const rec = getRecord(memberJid);
    rec.joinedAt = Date.now();
    rec.addedBy = addedBy ? normalizeJid(addedBy) : null;
    rec.status = "scanning";
    rec.alerted = false;
    saveDb();

    const scan = { startedAt: Date.now(), presences: 0, done: false };
    activeScans.set(key, scan);

    // 1) اشتراك الحضور فوراً (قبل كل شيء — نريد أقصى وقت مراقبة)
    try { sock.presenceSubscribe?.(normalizeJid(resolvePhoneJid(memberJid))).catch(() => {}); } catch {}

    // 2) رسالة الترحيب/الطُعم (إن كان هناك قروب استقبال) — تعمل كفخ إيصال
    sendWelcomeBait(sock, memberJid).catch(() => {});

    // 3) فحص الأجهزة: محاولتان داخل النافذة (0s و 25s) — نترك 10 ثوانٍ هامش قبل النهاية
    const tries = [0, 25000];
    for (const wait of tries) {
        const elapsed = Date.now() - scan.startedAt;
        if (elapsed < wait) await sleep(wait - elapsed);
        if (scan.done) return;

        scanCache.delete(key);
        const res = await getLinkedDevices(sock, memberJid);
        applyDeviceSignals(rec, res);
        if (cfg().debug) console.log(`[botat] فحص ${numOf(key)} في ${group}: ok=${res.ok} linked=${res.count} maxId=${res.maxId}`);
        if (res.ok) break; // نجاح — لا داعي للمحاولة الثانية
    }

    // 4) الحكم النهائي عند 60 ثانية بالضبط
    const remaining = cfg().detectWindowMs - (Date.now() - scan.startedAt);
    if (remaining > 0) await sleep(remaining);
    if (scan.done) return;
    scan.done = true;
    activeScans.delete(key);

    await evaluate(sock, rec, { final: true, group });
    saveDb();
}

function cancelScan(memberJid) {
    const key = normalizeJid(memberJid);
    const scan = activeScans.get(key);
    if (scan) { scan.done = true; activeScans.delete(key); }
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
        if (rec.devices.ok) {
            lines.push(`📱 الأجهزة: [${rec.devices.list.join(", ")}] — المرتبطة: ${rec.devices.count}`);
        } else {
            lines.push(`📱 الأجهزة: ⚠️ تعذر الفحص — ${rec.devices.error}`);
        }
    }
    const sig = Object.values(rec.signals);
    if (sig.length) {
        lines.push("", "*الإشارات:*", ...sig.map(s => `• ${s.reason} (+${s.points})`));
    } else {
        lines.push("", "لا توجد إشارات شك.");
    }
    if (rec.signals.deviceAged || (rec.signals.linkedDevices && rec.signals.nightOwl) || (rec.signals.linkedDevices && rec.signals.quickRead)) {
        lines.push("🤖 *التقدير:* مؤشرات تتقاطع باتجاه بوت");
    } else if (rec.signals.linkedDevices) {
        lines.push("ℹ️ *التقدير:* جهاز مرتبط: واتساب ويب أو بوت — يُفترض الحذر ومراقبته");
    }
    return lines.join("\n");
}

async function notifyOwners(sock, text, mentions = []) {
    for (const n of ownerNumbers) {
        try { await sock.sendMessage(`${n}@s.whatsapp.net`, { text, mentions }); } catch {}
    }
}

async function evaluate(sock, rec, { final = false, group = null } = {}) {
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
        rec.status = "clear";
        if (c.autoAdmit && c.mainGroup && !rec.admitted) {
            await admitToMain(sock, rec.jid).catch(() => {});
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
// 🚨 إنذار داخل القروب المفعّل فيه .كاشف on
// ============================================================

const ALERT_COOLDOWN_MS = 10 * 60 * 1000;
const groupQueues = new Map();

function enqueue(group, fn) {
    const prev = groupQueues.get(group) || Promise.resolve();
    const next = prev.then(fn).catch(() => {});
    groupQueues.set(group, next);
    next.finally(() => { if (groupQueues.get(group) === next) groupQueues.delete(group); });
}

export function isDetectorOn(group) {
    return !!db.detectGroups?.[group];
}

async function alertDetected(sock, group, memberJid, reason) {
    const rec = getRecord(memberJid);
    if (!rec.alertedGroups) rec.alertedGroups = {};
    if (Date.now() - (rec.alertedGroups[group] || 0) < ALERT_COOLDOWN_MS) return false;
    rec.alertedGroups[group] = Date.now();
    rec.status = "review";
    saveDb();

    let locked = false;
    try { await sock.groupSettingUpdate(group, "announcement"); locked = true; } catch {}

    let admins = [];
    try {
        const meta = await sock.groupMetadata(group);
        admins = (meta?.participants || [])
            .filter(p => p.admin)
            .map(p => p.id)
            .filter(id => numOf(id) !== selfNumber && numOf(id) !== numOf(memberJid));
    } catch {}

    const memberTag = `@${numOf(memberJid)}`;
    const adminTags = admins.length ? admins.map(a => `@${numOf(a)}`).join(" ") : "الأدمن";
    const lockLine = locked ? "  تم قفل شات القروب احتياطا وحذرا رجاءا" : "";

    const text =
        `*⌬━─⟐─ ⊱•┇⚠️┇•⊰ ─⟐─━⌬*\n` +
        `═════════════\n` +
        `📛_*تحذير هام*_⛔\n` +
        `═════════════\n` +
        `تم الكشف عن جهاز مرتبط / بوت لدى العضو: \n` +
        `${memberTag}\n` +
        `يرجى من ${adminTags}\n` +
        `التحقق بشأن هذا العضو وعدم ادخاله اي قروب والتعامل معه..${lockLine} \n` +
        `تعاملو معه وتحققو معه..\n` +
        `*⌬━─⟐─ ⊱•┇☢️┇•⊰ ─⟐─━⌬*`;

    try {
        await sock.sendMessage(group, { text, mentions: [memberJid, ...admins] });
    } catch (e) {
        console.error("botat: فشل إرسال تحذير الكشف:", e?.message);
    }

    await notifyOwners(sock,
        reportText(rec, `🚨 كشف: ${reason}`) + `\n📍 القروب: ${group}\n🔒 القفل: ${locked ? "تم" : "فشل (البوت غير مشرف؟)"}`
    ).catch(() => {});
    return true;
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

export async function onParticipantsUpdate(sock, update) {
    try {
        const c = cfg();
        if (!c.enabled) return;
        const group = update?.id;
        if (!group) return;

        // مغادرة/طرد أثناء الفحص → إلغاء الفحص
        if (update.action === "remove") {
            for (const p of update.participants || []) cancelScan(toId(p));
        }

        if (update.action !== "add") return;

        // سجل الدخول لكل القروبات
        for (const p of update.participants || []) {
            db.joinLog.push({ group, member: normalizeJid(toId(p)), by: update.author ? normalizeJid(update.author) : null, at: Date.now() });
        }
        if (db.joinLog.length > 1000) db.joinLog = db.joinLog.slice(-1000);
        saveDb();

        const isReception = !!c.receptionGroup && group === c.receptionGroup;
        if (!isReception && !isDetectorOn(group)) return;

        for (const p of update.participants || []) {
            const id = toId(p);
            if (!id) continue;
            const memberJid = normalizeJid(id);
            if (isExemptIn(group, memberJid)) continue;
            enqueue(group, () => runJoinScan(sock, group, memberJid, update.author));
        }
    } catch (e) {
        console.error("botat onParticipantsUpdate:", e?.message);
    }
}

// رسائل: الغرض الوحيد هنا بناء خريطة LID→رقم (إن أرسل العضو لاحقاً)
// + احتساب إشارات لمن كان تحت الفحص وبدأ يتكلم أثناء النافذة
export async function onMessage(sock, msg) {
    try {
        const pn = msg?.key?.participantPn || msg?.key?.remoteJidPn;
        if (pn) rememberLidMapping(msg.key.participant || msg.key.remoteJid, pn);

        const sender = msg?.key?.participant;
        if (!sender) return;
        const key = normalizeJid(sender);
        const scan = activeScans.get(key);
        if (scan && !scan.done) {
            // بدأ يتكلم أثناء الدقيقة — لا ننتظر، نحسم فوراً بتقرير مبكر
            scan.done = true;
            activeScans.delete(key);
            const rec = getRecord(sender, false);
            if (rec) {
                await evaluate(sock, rec, { final: true, group: msg.key.remoteJid });
                saveDb();
            }
        }
    } catch (e) {
        console.error("botat onMessage:", e?.message);
    }
}

// ============================================================
// الأوامر
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

        if (!isGroup) {
            db.config.enabled = v; saveDb();
            return reply(v ? "✅ تم تشغيل كاشف البوتات (عام)" : "❌ تم إيقاف كاشف البوتات (عام)"), true;
        }

        if (v) {
            db.config.enabled = true;
            db.detectGroups[jid] = true;
        } else {
            delete db.detectGroups[jid];
        }
        saveDb();

        if (!v) return reply("❌ تم إيقاف كاشف البوتات في هذا القروب"), true;

        let adminNote = "";
        try {
            const meta = await sock.groupMetadata(jid);
            const me = (meta?.participants || []).find(p => numOf(p.id) === selfNumber);
            if (!me?.admin) adminNote = "\n⚠️ البوت ليس مشرفاً هنا: سيكشف ويحذّر لكن *لن يستطيع قفل الشات*.";
        } catch {}
        return reply(
            "✅ تم تشغيل كاشف البوتات في هذا القروب\n" +
            "⏱ كل عضو جديد سيُفحص خلال 60 ثانية من دخوله (حتى لو لم يرسل رسالة)." + adminNote
        ), true;
    }

    if (command === "تشخيص_كاشف") {
        const v = onOff(args[0]?.toLowerCase());
        if (v === null) return reply("الاستخدام: `.تشخيص_كاشف on/off`"), true;
        db.config.debug = v; saveDb();
        return reply(v ? "🧪 وضع التشخيص شغّال" : "وضع التشخيص مطفأ"), true;
    }

    if (command === "قبول_تلقائي") {
        const v = onOff(args[0]?.toLowerCase());
        if (v === null) return reply("الاستخدام: `.قبول_تلقائي on/off`"), true;
        db.config.autoAdmit = v; saveDb();
        return reply(v ? "✅ القبول التلقائي للحالات النظيفة شغّال" : "❌ القبول التلقائي مطفأ"), true;
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
        const scanning = activeScans.size;
        return reply(
            `🕵️ *حالة الكاشف*\n` +
            `التشغيل العام: ${c.enabled ? "✅" : "❌"}\n` +
            `الكشف في هذا القروب: ${isGroup && isDetectorOn(jid) ? "✅" : "❌"} | قروبات مفعّلة: ${Object.keys(db.detectGroups || {}).length}\n` +
            `الاستقبال: ${c.receptionGroup ? "معيّن" : "غير معيّن"}\n` +
            `الأساسي: ${c.mainGroup ? "معيّن" : "غير معيّن"}\n` +
            `قبول تلقائي: ${c.autoAdmit ? "نعم" : "لا"}\n` +
            `نافذة الفحص: ${c.detectWindowMs / 1000} ثانية\n` +
            `فحوصات جارية الآن: ${scanning}\n` +
            `أعضاء مفحوصون: ${total} | مشتبه بهم: ${sus}\n` +
            `خريطة LID محلولة: ${Object.keys(db.lidMap || {}).length}`
        ), true;
    }

    if (command === "فحص") {
        const target = pickTarget(ctx);
        if (!target) return reply("الاستخدام: `.فحص @عضو` أو رد على رسالته أو اكتب رقمه"), true;
        const rec = getRecord(target);
        scanCache.delete(rec.jid);
        const res = await getLinkedDevices(sock, rec.jid);
        applyDeviceSignals(rec, res);
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
        for (const [k, s] of activeScans) if (now - s.startedAt > cfg().detectWindowMs + 30000) activeScans.delete(k);
    } catch {}
}
