/*
 * ชุดทดสอบหน้าคำนวณอายุ (index.html)
 *
 *   node tests/age-calc.test.mjs
 *
 * รันในเบราว์เซอร์จริง (Playwright/Chromium) และเรียกฟังก์ชันชุดเดียวกับที่หน้าเว็บใช้
 * ผ่าน window.AgeCalc จึงไม่มีการคัดลอกตรรกะมาทดสอบซ้ำ
 *
 * ครอบคลุม
 *   1. ageOf  — exhaustive ทุกคู่วันในช่วง 4 ปี (รวมปีอธิกสุรทิน) + สุ่มช่วงกว้าง
 *               ตรวจ reconstruct / maximality / ขอบเขต / monotonic
 *   2. dayDiff, daysInMonth, addMonths, makeDate (รวมปี ค.ศ. < 100)
 *   3. parseBirth — exhaustive ทุก (วัน, เดือน) ของปีอธิกสุรทิน/ปีปกติ + เคสอินพุตผิด
 *   4. วันเกิดครั้งถัดไป — exhaustive ทั้งปี รวมเคสเกิด 29 ก.พ.
 *   5. วันในสัปดาห์ — เทียบสูตร Zeller ที่เขียนแยกอิสระ + วันอ้างอิงที่รู้คำตอบ
 *   6. ปีนักษัตร — ปีอ้างอิงที่รู้คำตอบ + คาบ 12 ปี + ครบ 12 นักษัตรไม่ซ้ำ
 *   7. ราศีสากล/ไทย — exhaustive ทุกวันในปี เทียบตารางช่วงวันที่เขียนแยกอิสระ
 *   8. DOM — ผลที่แสดงจริงบนหน้าเว็บ, ข้อความ error, ปุ่ม พ.ศ./ค.ศ., localStorage
 *   9. เขตเวลา — รันซ้ำทั้งชุดใน 8 เขตเวลา รวมเขตที่มี DST, DST ตอนเที่ยงคืน,
 *               DST ครึ่งชั่วโมง, UTC+14 และเขตที่เคยข้ามวันทั้งวัน
 *
 * ตัวเลือก: AGE_TEST_DUMP=/path/file.tsv  เพื่อบันทึกผล ageOf ไว้ให้
 * tests/crosscheck_dateutil.py ตรวจซ้ำกับ python-dateutil
 */

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

const require = createRequire(import.meta.url);
let playwright = null;
for (const p of ["playwright", "playwright-core", "/opt/node22/lib/node_modules/playwright"]) {
  try { playwright = require(p); break; } catch { /* ลองตัวถัดไป */ }
}
if (!playwright) {
  console.error("ไม่พบ playwright — ติดตั้งด้วย: npm i -D playwright && npx playwright install chromium");
  process.exit(2);
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PAGE_URL = "file://" + path.join(HERE, "..", "index.html");

let pass = 0;
let cases = 0;                 /* จำนวนเคสย่อยทั้งหมดที่ตรวจ */
const failures = [];
const verbose = !!process.env.AGE_TEST_VERBOSE;
function check(name, ok, detail) {
  if (ok) { pass++; if (verbose) console.log("  ✓ " + name); return; }
  failures.push(name + (detail ? "\n      " + detail : ""));
}
/* ผลจาก page.evaluate ที่คืน { checked, errors } */
function checkBatch(name, res, minChecked = 1) {
  cases += res.checked;
  check(name + " (ตรวจ " + res.checked.toLocaleString("en-US") + " เคส)",
        res.errors.length === 0 && res.checked >= minChecked,
        res.errors.slice(0, 5).join("\n      ") ||
        (res.checked < minChecked ? "ตรวจได้แค่ " + res.checked + " เคส" : ""));
}

const TZS = [
  "UTC",
  "Asia/Bangkok",          /* เขตเวลาเป้าหมาย ไม่มี DST */
  "America/New_York",      /* DST ตอนตี 2 */
  "America/Santiago",      /* DST ตอนเที่ยงคืน — เที่ยงคืนบางวันไม่มีอยู่จริง */
  "Australia/Lord_Howe",   /* DST ครึ่งชั่วโมง */
  "Pacific/Kiritimati",    /* UTC+14 */
  "Pacific/Apia",          /* เคยข้ามทั้งวัน 30 ธ.ค. 2011 */
  "Europe/Lisbon"
];

const dump = process.env.AGE_TEST_DUMP || "";
let dumpRows = null;

const browser = await playwright.chromium.launch();

for (const tz of TZS) {
  const context = await browser.newContext({ timezoneId: tz, locale: "th-TH" });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on("console", m => { if (m.type() === "error") consoleErrors.push(m.text()); });
  page.on("pageerror", e => consoleErrors.push("PAGEERROR: " + e.message));
  await page.goto(PAGE_URL);

  const T = s => `[${tz}] ${s}`;
  const full = tz === "UTC" || tz === "Asia/Bangkok";   /* ชุดใหญ่รันสองเขตหลัก */

  check(T("หน้าเว็บโหลดและเปิด window.AgeCalc"),
        await page.evaluate(() => typeof window.AgeCalc?.compute === "function"));

  /* ---------------- 1. ageOf ---------------- */

  checkBatch(T("ageOf: exhaustive ทุกคู่วัน (เกิด 2000–2003 × วันนี้ 2024–2027)"),
    await page.evaluate((doFull) => {
      const A = window.AgeCalc;
      const iso = (d) => d.toISOString().slice(0, 10);
      const errors = [];
      let checked = 0;
      const bStart = A.makeDate(2000, 0, 1), bEnd = A.makeDate(doFull ? 2003 : 2000, 11, 31);
      const nStart = A.makeDate(2024, 0, 1), nEnd = A.makeDate(doFull ? 2027 : 2024, 11, 31);
      for (let b = new Date(bStart); b <= bEnd; b = A.makeDate(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate() + 1)) {
        let prev = null;
        for (let n = new Date(nStart); n <= nEnd; n = A.makeDate(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate() + 1)) {
          const a = A.ageOf(b, n);
          checked++;
          const tag = b.toISOString().slice(0, 10) + " → " + n.toISOString().slice(0, 10) + " = " + JSON.stringify(a);
          if (a.y < 0 || a.m < 0 || a.m > 11 || a.d < 0 || a.d > 30) { errors.push("ค่าอยู่นอกช่วง: " + tag); continue; }
          const months = a.y * 12 + a.m;
          const anchor = A.addMonths(b, months);
          if (anchor > n) { errors.push("anchor เลยวันนี้: " + tag); continue; }
          if (A.dayDiff(anchor, n) !== a.d) { errors.push("ประกอบกลับไม่ตรง: " + tag); continue; }
          if (A.addMonths(b, months + 1) <= n) { errors.push("นับเดือนไม่สุด: " + tag); continue; }
          if (prev) {
            const cmp = a.y - prev.y || a.m - prev.m || a.d - prev.d;
            if (cmp < 0) errors.push("อายุลดลงเมื่อเวลาเดินหน้า: " + tag + " หลังจาก " + JSON.stringify(prev));
          }
          prev = a;
          if (errors.length > 20) return { checked, errors };
        }
      }
      return { checked, errors };
    }, full), full ? 2000000 : 100000);

  if (full) {
    const rnd = await page.evaluate(() => {
      const A = window.AgeCalc;
      const iso = (d) => d.toISOString().slice(0, 10);
      const errors = []; let checked = 0;
      /* PRNG แบบกำหนดค่าเริ่มต้น เพื่อให้ผลซ้ำได้ทุกครั้ง */
      let s = 12345;
      const rand = (n) => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s % n; };
      const rows = [];
      for (let i = 0; i < 300000; i++) {
        const by = 1900 + rand(200), bm = rand(12), bd = 1 + rand(A.daysInMonth(1900 + 0, bm) === 0 ? 28 : 31);
        const b = A.makeDate(by, bm, bd);
        if (b.getUTCDate() !== bd) continue;              /* วันที่ไม่มีจริง ข้าม */
        const n = A.makeDate(by + rand(130), rand(12), 1 + rand(28));
        if (A.dayDiff(b, n) < 0) continue;
        checked++;
        const a = A.ageOf(b, n);
        const months = a.y * 12 + a.m;
        if (a.y < 0 || a.m < 0 || a.m > 11 || a.d < 0 || a.d > 30) errors.push("นอกช่วง " + b.toISOString().slice(0, 10) + "→" + n.toISOString().slice(0, 10));
        else if (A.dayDiff(A.addMonths(b, months), n) !== a.d) errors.push("ประกอบกลับไม่ตรง " + b.toISOString().slice(0, 10) + "→" + n.toISOString().slice(0, 10));
        else if (A.addMonths(b, months + 1) <= n) errors.push("นับเดือนไม่สุด " + b.toISOString().slice(0, 10) + "→" + n.toISOString().slice(0, 10));
        if (rows.length < 200000) {
          rows.push(iso(b) + "\t" + iso(n) + "\t" + a.y + "\t" + a.m + "\t" + a.d + "\t" + A.dayDiff(b, n));
        }
        if (errors.length > 20) break;
      }
      return { checked, errors, rows };
    });
    checkBatch(T("ageOf: สุ่ม 300,000 คู่ ช่วงปี 1900–2100"), { checked: rnd.checked, errors: rnd.errors }, 100000);
    if (dump && !dumpRows) dumpRows = rnd.rows;
  }

  /* ---------------- 2. helper วันที่ ---------------- */

  checkBatch(T("dayDiff: ตรงกับการนับวันทีละวัน ตลอด 2019–2027 (รวมข้าม DST)"),
    await page.evaluate(() => {
      const A = window.AgeCalc;
      const iso = (d) => d.toISOString().slice(0, 10);
      const errors = []; let checked = 0;
      const base = A.makeDate(2019, 0, 1);
      let cur = new Date(base), i = 0;
      const end = A.makeDate(2027, 11, 31);
      while (cur <= end) {
        if (A.dayDiff(base, cur) !== i) errors.push("นับวันไม่ตรงที่ " + cur.toISOString().slice(0, 10) + " ได้ " + A.dayDiff(base, cur) + " ควรเป็น " + i);
        if (cur.getUTCHours() !== 0) errors.push("ไม่ใช่เที่ยงคืน UTC: " + cur.toISOString());
        checked++; i++;
        cur = A.makeDate(cur.getUTCFullYear(), cur.getUTCMonth(), cur.getUTCDate() + 1);
        if (errors.length > 5) break;
      }
      return { checked, errors };
    }), 3000);

  checkBatch(T("daysInMonth: ตรงกับกฎปีอธิกสุรทิน ปี 1600–2400"),
    await page.evaluate(() => {
      const A = window.AgeCalc;
      const iso = (d) => d.toISOString().slice(0, 10);
      const errors = []; let checked = 0;
      const norm = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
      for (let y = 1600; y <= 2400; y++) {
        const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
        for (let m = 0; m < 12; m++) {
          const want = (m === 1 && leap) ? 29 : norm[m];
          const got = A.daysInMonth(y, m);
          checked++;
          if (got !== want) errors.push(y + "/" + (m + 1) + " ได้ " + got + " ควรเป็น " + want);
          if (errors.length > 5) return { checked, errors };
        }
      }
      return { checked, errors };
    }), 9000);

  checkBatch(T("addMonths: หนีบวันที่ถูกต้อง และย้อนกลับได้ (ทุกวัน × -36..36 เดือน)"),
    await page.evaluate(() => {
      const A = window.AgeCalc;
      const iso = (d) => d.toISOString().slice(0, 10);
      const errors = []; let checked = 0;
      for (let m0 = 0; m0 < 12; m0++) {
        for (let d0 = 1; d0 <= 31; d0++) {
          for (const y0 of [2023, 2024]) {          /* ปีปกติ + ปีอธิกสุรทิน */
            const b = A.makeDate(y0, m0, d0);
            if (b.getUTCDate() !== d0) continue;       /* ไม่มีวันที่นี้ */
            for (let n = -36; n <= 36; n++) {
              const r = A.addMonths(b, n);
              checked++;
              const want = A.makeDate(y0, m0 + n, 1);
              if (r.getUTCMonth() !== want.getUTCMonth() || r.getUTCFullYear() !== want.getUTCFullYear())
                errors.push("เดือนเพี้ยน " + b.toISOString().slice(0, 10) + " +" + n);
              else if (r.getUTCDate() !== Math.min(d0, A.daysInMonth(r.getUTCFullYear(), r.getUTCMonth())))
                errors.push("หนีบวันผิด " + b.toISOString().slice(0, 10) + " +" + n + " → " + r.toISOString().slice(0, 10));
              if (errors.length > 5) return { checked, errors };
            }
          }
        }
      }
      return { checked, errors };
    }), 40000);

  checkBatch(T("makeDate: ปี ค.ศ. 1–99 ไม่ถูกเหมาเป็น 19xx"),
    await page.evaluate(() => {
      const A = window.AgeCalc;
      const iso = (d) => d.toISOString().slice(0, 10);
      const errors = []; let checked = 0;
      for (let y = 1; y <= 120; y++) {
        const d = A.makeDate(y, 5, 15);
        checked++;
        if (d.getUTCFullYear() !== y || d.getUTCMonth() !== 5 || d.getUTCDate() !== 15)
          errors.push("ค.ศ. " + y + " → " + d.toISOString().slice(0, 10));
      }
      return { checked, errors };
    }), 120);

  /* ---------------- 3. parseBirth ---------------- */

  checkBatch(T("parseBirth: exhaustive ทุก (วัน,เดือน) ปีอธิกสุรทิน/ปีปกติ"),
    await page.evaluate(() => {
      const A = window.AgeCalc;
      const iso = (d) => d.toISOString().slice(0, 10);
      const errors = []; let checked = 0;
      const today = A.makeDate(2030, 0, 1);
      const norm = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
      for (const yCE of [2023, 2024, 1900, 2000]) {
        const leap = (yCE % 4 === 0 && yCE % 100 !== 0) || yCE % 400 === 0;
        for (let m = 0; m < 12; m++) {
          const max = (m === 1 && leap) ? 29 : norm[m];
          for (let d = 1; d <= 31; d++) {
            const r = A.parseBirth(String(d), String(m), String(yCE), "ce", today);
            checked++;
            const shouldPass = d <= max;
            if (r.ok !== shouldPass) errors.push(d + "/" + (m + 1) + "/" + yCE + " → ok=" + r.ok + " (ควรเป็น " + shouldPass + ") " + (r.error || ""));
            else if (r.ok && (r.date.getUTCDate() !== d || r.date.getUTCMonth() !== m || r.date.getUTCFullYear() !== yCE))
              errors.push("แปลงวันผิด " + d + "/" + (m + 1) + "/" + yCE);
            if (errors.length > 8) return { checked, errors };
          }
        }
      }
      return { checked, errors };
    }), 1400);

  const parseCases = await page.evaluate(() => {
    const A = window.AgeCalc;
    const today = A.makeDate(2026, 7, 22);            /* 22 ส.ค. 2026 */
    const t = (d, m, y, era) => { const r = A.parseBirth(d, m, y, era, today); return r.ok ? "OK:" + r.date.getUTCFullYear() + "-" + (r.date.getUTCMonth() + 1) + "-" + r.date.getUTCDate() : "ERR:" + r.error; };
    return {
      be2540:      t("15", "5", "2540", "be"),
      ce1997:      t("15", "5", "1997", "ce"),
      feb29leap:   t("29", "1", "2543", "be"),
      feb29nonlp:  t("29", "1", "2542", "be"),
      apr31:       t("31", "3", "2540", "be"),
      today:       t("22", "7", "2569", "be"),
      tomorrow:    t("23", "7", "2569", "be"),
      empty:       t("", "5", "2540", "be"),
      zeroDay:     t("0", "5", "2540", "be"),
      negDay:      t("-5", "5", "2540", "be"),
      day32:       t("32", "5", "2540", "be"),
      junk:        t("abc", "5", "2540", "be"),
      yearJunk:    t("15", "5", "ปี", "be"),
      beTooSmall:  t("15", "5", "100", "be"),
      ce9999:      t("15", "5", "9999", "ce"),
      ce10000:     t("15", "5", "10000", "ce"),
      ceNeg:       t("15", "5", "-100", "ce"),
      beFuture:    t("1", "0", "2600", "be"),
      floatDay:    t("15.9", "5", "2540", "be"),
      spaces:      t(" 15 ", "5", " 2540 ", "be"),
      ce57:        t("15", "5", "57", "ce")
    };
  });
  check(T("parseBirth: 15 มิ.ย. พ.ศ.2540 → ค.ศ. 1997"), parseCases.be2540 === "OK:1997-6-15", parseCases.be2540);
  check(T("parseBirth: โหมด ค.ศ. ให้ผลตรงกัน"), parseCases.ce1997 === "OK:1997-6-15", parseCases.ce1997);
  check(T("parseBirth: 29 ก.พ. ปีอธิกสุรทิน ผ่าน"), parseCases.feb29leap === "OK:2000-2-29", parseCases.feb29leap);
  check(T("parseBirth: 29 ก.พ. ปีปกติ ถูกปฏิเสธ"), parseCases.feb29nonlp.startsWith("ERR:ไม่มีวันที่นี้"), parseCases.feb29nonlp);
  check(T("parseBirth: 31 เม.ย. ถูกปฏิเสธ"), parseCases.apr31.startsWith("ERR:ไม่มีวันที่นี้"), parseCases.apr31);
  check(T("parseBirth: วันนี้ ผ่าน (อายุ 0 วัน)"), parseCases.today === "OK:2026-8-22", parseCases.today);
  check(T("parseBirth: พรุ่งนี้ ถูกปฏิเสธว่าเป็นอนาคต"), parseCases.tomorrow.startsWith("ERR:วันเกิดอยู่ในอนาคต"), parseCases.tomorrow);
  check(T("parseBirth: ช่องว่าง"), parseCases.empty.startsWith("ERR:กรุณากรอก"), parseCases.empty);
  check(T("parseBirth: วันที่ 0"), parseCases.zeroDay.startsWith("ERR:"), parseCases.zeroDay);
  check(T("parseBirth: วันติดลบ"), parseCases.negDay.startsWith("ERR:"), parseCases.negDay);
  check(T("parseBirth: วันที่ 32"), parseCases.day32.startsWith("ERR:"), parseCases.day32);
  check(T("parseBirth: ตัวอักษรในช่องวัน"), parseCases.junk.startsWith("ERR:"), parseCases.junk);
  check(T("parseBirth: ตัวอักษรในช่องปี"), parseCases.yearJunk.startsWith("ERR:"), parseCases.yearJunk);
  check(T("parseBirth: พ.ศ. 100 (ก่อน ค.ศ. 1) ถูกปฏิเสธ"), parseCases.beTooSmall.startsWith("ERR:ปีไม่ถูกต้อง"), parseCases.beTooSmall);
  check(T("parseBirth: ค.ศ. 9999 ยังผ่าน"), parseCases.ce9999.startsWith("ERR:วันเกิดอยู่ในอนาคต"), parseCases.ce9999);
  check(T("parseBirth: ค.ศ. 10000 ถูกปฏิเสธ"), parseCases.ce10000.startsWith("ERR:ปีไม่ถูกต้อง"), parseCases.ce10000);
  check(T("parseBirth: ปีติดลบ ถูกปฏิเสธ"), parseCases.ceNeg.startsWith("ERR:ปีไม่ถูกต้อง"), parseCases.ceNeg);
  check(T("parseBirth: พ.ศ. 2600 เป็นอนาคต"), parseCases.beFuture.startsWith("ERR:วันเกิดอยู่ในอนาคต"), parseCases.beFuture);
  check(T("parseBirth: ทศนิยมถูกตัดเป็นจำนวนเต็ม"), parseCases.floatDay === "OK:1997-6-15", parseCases.floatDay);
  check(T("parseBirth: ช่องว่างหัวท้ายไม่ทำให้พัง"), parseCases.spaces === "OK:1997-6-15", parseCases.spaces);
  check(T("parseBirth: ค.ศ. 57 ต้องเป็นปี 57 ไม่ใช่ 1957"), parseCases.ce57 === "OK:57-6-15", parseCases.ce57);

  /* ---------------- 4. วันเกิดครั้งถัดไป ---------------- */

  checkBatch(T("วันเกิดถัดไป: exhaustive ทุกวันเกิด × ทุกวันในปี 2026–2027"),
    await page.evaluate((doFull) => {
      const A = window.AgeCalc;
      const iso = (d) => d.toISOString().slice(0, 10);
      const errors = []; let checked = 0;
      const births = [];
      for (let m = 0; m < 12; m++) for (let d = 1; d <= 31; d++) {
        for (const y of [1997, 2000, 2024]) {          /* ปีปกติ + ปีอธิกสุรทิน */
          const b = A.makeDate(y, m, d);
          if (b.getUTCDate() === d) births.push(b);
        }
      }
      const nEnd = A.makeDate(doFull ? 2027 : 2026, 11, 31);
      for (const b of births) {
        for (let n = A.makeDate(2026, 0, 1); n <= nEnd; n = A.makeDate(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate() + 1)) {
          const r = A.compute(b, n);
          checked++;
          const nb = r.next.date, left = r.next.daysLeft;
          const tag = "เกิด " + b.toISOString().slice(0, 10) + " วันนี้ " + n.toISOString().slice(0, 10) + " → " + nb.toISOString().slice(0, 10);
          if (left < 0 || left > 366) { errors.push("จำนวนวันคงเหลือผิด " + tag + " (" + left + ")"); }
          else if (A.dayDiff(n, nb) !== left) { errors.push("daysLeft ไม่ตรงกับวันที่ " + tag); }
          else {
            const feb29 = b.getUTCMonth() === 1 && b.getUTCDate() === 29;
            const isBday = (nb.getUTCMonth() === b.getUTCMonth() && nb.getUTCDate() === b.getUTCDate()) ||
                           (feb29 && nb.getUTCMonth() === 1 && nb.getUTCDate() === 28 && A.daysInMonth(nb.getUTCFullYear(), 1) < 29);
            if (!isBday) errors.push("วันที่ได้ไม่ใช่วันเกิด " + tag);
            /* ต้องไม่มีวันเกิดอื่นคั่นระหว่างวันนี้ถึงวันที่ได้ */
            else if (left > 0) {
              for (let k = 0; k < left; k++) {
                const mid = A.makeDate(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate() + k);
                const midIsB = (mid.getUTCMonth() === b.getUTCMonth() && mid.getUTCDate() === b.getUTCDate()) ||
                               (feb29 && mid.getUTCMonth() === 1 && mid.getUTCDate() === 28 && A.daysInMonth(mid.getUTCFullYear(), 1) < 29);
                if (midIsB) { errors.push("ข้ามวันเกิดที่ใกล้กว่า " + tag); break; }
              }
            }
            /* ครบกี่ปี: วันนี้เป็นวันเกิดพอดี = อายุปัจจุบัน, ไม่งั้น = อายุ+1 */
            const wantTurning = left === 0 ? r.age.y : r.age.y + 1;
            if (r.next.turning !== wantTurning)
              errors.push("อายุที่จะครบผิด " + tag + " ได้ " + r.next.turning + " ควรเป็น " + wantTurning);
            /* ตัวนับถอยหลังต้องเป็นศูนย์ในวันเดียวกับที่ตัวเลขอายุเพิ่มขึ้นพอดี
               (invariant ข้อนี้คือจุดที่เคยไม่ตรงกันในเคสเกิด 29 ก.พ.) */
            const isAnniversary = r.age.m === 0 && r.age.d === 0;
            if (isAnniversary !== (left === 0))
              errors.push("วันครบรอบไม่ตรงกับวันที่อายุเพิ่ม " + tag +
                          " (อายุ " + r.age.y + "y " + r.age.m + "m " + r.age.d + "d, เหลือ " + left + " วัน)");
          }
          if (errors.length > 10) return { checked, errors };
        }
      }
      return { checked, errors };
    }, full), full ? 200000 : 100000);

  /* ---------------- 5. วันในสัปดาห์ ---------------- */

  checkBatch(T("วันในสัปดาห์: ตรงกับสูตร Zeller ตลอดปี 1800–2200"),
    await page.evaluate(() => {
      const A = window.AgeCalc;
      const iso = (d) => d.toISOString().slice(0, 10);
      const errors = []; let checked = 0;
      /* Zeller เขียนแยกอิสระ: 0=เสาร์ 1=อาทิตย์ ... */
      function zeller(y, m, d) {
        if (m < 3) { m += 12; y -= 1; }
        const K = y % 100, J = Math.floor(y / 100);
        const h = (d + Math.floor(13 * (m + 1) / 5) + K + Math.floor(K / 4) + Math.floor(J / 4) + 5 * J) % 7;
        return (h + 6) % 7;   /* → 0=อาทิตย์ */
      }
      for (let y = 1800; y <= 2200; y += 1) {
        for (let m = 0; m < 12; m++) {
          for (const d of [1, 13, 15, 28, A.daysInMonth(y, m)]) {
            const dt = A.makeDate(y, m, d);
            checked++;
            if (dt.getUTCDay() !== zeller(y, m + 1, d))
              errors.push(dt.toISOString().slice(0, 10) + " ได้ " + dt.getUTCDay() + " Zeller ว่า " + zeller(y, m + 1, d));
            if (errors.length > 5) return { checked, errors };
          }
        }
      }
      return { checked, errors };
    }), 20000);

  const anchors = await page.evaluate(() => {
    const A = window.AgeCalc;
    const f = (y, m, d) => A.DAYS[A.makeDate(y, m - 1, d).getUTCDay()].name;
    return {
      k9:    f(1927, 12, 5),    /* 5 ธ.ค. 2470 — วันจันทร์ */
      k10:   f(1952, 7, 28),    /* 28 ก.ค. 2495 — วันจันทร์ */
      moon:  f(1969, 7, 20),    /* 20 ก.ค. 1969 — วันอาทิตย์ */
      y2k:   f(2000, 1, 1),     /* 1 ม.ค. 2000 — วันเสาร์ */
      today: f(2026, 8, 22)     /* 22 ส.ค. 2026 — วันเสาร์ */
    };
  });
  check(T("วันอ้างอิง: 5 ธ.ค. 2470 = วันจันทร์"), anchors.k9 === "จันทร์", anchors.k9);
  check(T("วันอ้างอิง: 28 ก.ค. 2495 = วันจันทร์"), anchors.k10 === "จันทร์", anchors.k10);
  check(T("วันอ้างอิง: 20 ก.ค. 1969 = วันอาทิตย์"), anchors.moon === "อาทิตย์", anchors.moon);
  check(T("วันอ้างอิง: 1 ม.ค. 2000 = วันเสาร์"), anchors.y2k === "เสาร์", anchors.y2k);
  check(T("วันอ้างอิง: 22 ส.ค. 2026 = วันเสาร์"), anchors.today === "เสาร์", anchors.today);

  /* ---------------- 6. ปีนักษัตร ---------------- */

  const zod = await page.evaluate(() => {
    const A = window.AgeCalc;
    const known = {                       /* ปีนักษัตรตามปีปฏิทินที่ทราบแน่ชัด */
      1900: "ชวด", 1911: "กุน", 1932: "วอก", 1957: "ระกา", 1976: "มะโรง",
      1988: "มะโรง", 1997: "ฉลู", 2000: "มะโรง", 2008: "ชวด", 2016: "วอก",
      2020: "ชวด", 2024: "มะโรง", 2025: "มะเส็ง", 2026: "มะเมีย", 2032: "ชวด", 2100: "วอก"
    };
    const errors = []; let checked = 0;
    for (const y in known) {
      checked++;
      const got = A.zodiacYear(Number(y)).name;
      if (got !== known[y]) errors.push("ค.ศ. " + y + " ได้ ปี" + got + " ควรเป็น ปี" + known[y]);
    }
    /* คาบ 12 ปี และครบ 12 นักษัตรไม่ซ้ำในทุกช่วง 12 ปีติดกัน */
    for (let y = 1; y <= 3000; y++) {
      checked++;
      if (A.zodiacYear(y).name !== A.zodiacYear(y + 12).name) errors.push("คาบ 12 ปีไม่ตรงที่ " + y);
      const set = new Set();
      for (let k = 0; k < 12; k++) set.add(A.zodiacYear(y + k).name);
      if (set.size !== 12) errors.push("12 ปีติดกันมีนักษัตรซ้ำที่ " + y);
      if (errors.length > 5) break;
    }
    return { checked, errors };
  });
  checkBatch(T("ปีนักษัตร: ปีอ้างอิง + คาบ 12 ปี + ไม่ซ้ำ"), zod, 3000);

  /* ---------------- 7. ราศี ---------------- */

  checkBatch(T("ราศีสากล: exhaustive ทุกวันในปี (ปีปกติ+ปีอธิกสุรทิน) เทียบตารางอิสระ"),
    await page.evaluate(() => {
      const A = window.AgeCalc;
      const iso = (d) => d.toISOString().slice(0, 10);
      /* ตารางช่วงวัน เขียนแยกอิสระจากตารางในหน้าเว็บ: [ชื่อ, เริ่ม m/d, จบ m/d] */
      const ranges = [
        ["มังกร", [12, 22], [1, 19]], ["กุมภ์", [1, 20], [2, 18]], ["มีน", [2, 19], [3, 20]],
        ["เมษ", [3, 21], [4, 19]], ["พฤษภ", [4, 20], [5, 20]], ["เมถุน", [5, 21], [6, 20]],
        ["กรกฎ", [6, 21], [7, 22]], ["สิงห์", [7, 23], [8, 22]], ["กันย์", [8, 23], [9, 22]],
        ["ตุล", [9, 23], [10, 22]], ["พิจิก", [10, 23], [11, 21]], ["ธนู", [11, 22], [12, 21]]
      ];
      function want(m, d) {
        for (const [name, s, e] of ranges) {
          const inRange = s[0] <= e[0]
            ? ((m > s[0] || (m === s[0] && d >= s[1])) && (m < e[0] || (m === e[0] && d <= e[1])))
            : ((m > s[0] || (m === s[0] && d >= s[1])) || (m < e[0] || (m === e[0] && d <= e[1])));
          if (inRange) return name;
        }
        return "?";
      }
      const errors = []; let checked = 0;
      for (const y of [2023, 2024]) {
        for (let m = 0; m < 12; m++) {
          for (let d = 1; d <= A.daysInMonth(y, m); d++) {
            const got = A.signFrom(A.WEST, A.makeDate(y, m, d)).name;
            checked++;
            if (got !== want(m + 1, d)) errors.push(d + "/" + (m + 1) + " ได้ " + got + " ควรเป็น " + want(m + 1, d));
            if (errors.length > 5) return { checked, errors };
          }
        }
      }
      return { checked, errors };
    }), 700);

  checkBatch(T("ราศีไทย: exhaustive ทุกวันในปี เทียบตารางอิสระ"),
    await page.evaluate(() => {
      const A = window.AgeCalc;
      const iso = (d) => d.toISOString().slice(0, 10);
      const ranges = [
        ["ธนู", [12, 16], [1, 13]], ["มังกร", [1, 14], [2, 12]], ["กุมภ์", [2, 13], [3, 14]],
        ["มีน", [3, 15], [4, 12]], ["เมษ", [4, 13], [5, 14]], ["พฤษภ", [5, 15], [6, 14]],
        ["เมถุน", [6, 15], [7, 15]], ["กรกฎ", [7, 16], [8, 16]], ["สิงห์", [8, 17], [9, 16]],
        ["กันย์", [9, 17], [10, 16]], ["ตุล", [10, 17], [11, 15]], ["พิจิก", [11, 16], [12, 15]]
      ];
      function want(m, d) {
        for (const [name, s, e] of ranges) {
          const inRange = s[0] <= e[0]
            ? ((m > s[0] || (m === s[0] && d >= s[1])) && (m < e[0] || (m === e[0] && d <= e[1])))
            : ((m > s[0] || (m === s[0] && d >= s[1])) || (m < e[0] || (m === e[0] && d <= e[1])));
          if (inRange) return name;
        }
        return "?";
      }
      const errors = []; let checked = 0;
      for (const y of [2023, 2024]) {
        for (let m = 0; m < 12; m++) {
          for (let d = 1; d <= A.daysInMonth(y, m); d++) {
            const got = A.signFrom(A.THAI, A.makeDate(y, m, d)).name;
            checked++;
            if (got !== want(m + 1, d)) errors.push(d + "/" + (m + 1) + " ได้ " + got + " ควรเป็น " + want(m + 1, d));
            if (errors.length > 5) return { checked, errors };
          }
        }
      }
      return { checked, errors };
    }), 700);

  checkBatch(T("ราศี: ทุกวันในปีต้องได้ราศีเดียว และครบ 12 ราศี"),
    await page.evaluate(() => {
      const A = window.AgeCalc;
      const iso = (d) => d.toISOString().slice(0, 10);
      const errors = [];
      let checked = 0;
      for (const table of [A.WEST, A.THAI]) {
        const seen = new Set();
        for (let m = 0; m < 12; m++) {
          for (let d = 1; d <= A.daysInMonth(2024, m); d++) {
            const s = A.signFrom(table, A.makeDate(2024, m, d));
            checked++;
            if (!s || !s.name) { errors.push("ไม่ได้ราศีที่ " + d + "/" + (m + 1)); continue; }
            seen.add(s.name);
          }
        }
        if (seen.size !== 12) errors.push("ได้ราศีไม่ครบ 12 (" + seen.size + ")");
      }
      return { checked, errors };
    }), 700);

  /* ---------------- 8. DOM ---------------- */

  const dom = await page.evaluate(async () => {
    const out = {};
    const $ = id => document.getElementById(id);
    const set = (d, m, y, era) => {
      $("d").value = d; $("m").value = m; $("y").value = y;
      document.querySelector('#era button[data-era="' + era + '"]').click();
      $("go").click();
    };
    out.hiddenAtStart = !$("result").classList.contains("show") || $("y").value !== "";

    set("15", "5", "2540", "be");
    out.shown = $("result").classList.contains("show");
    out.err = $("err").textContent;
    out.bstr = $("bstr").innerText.replace(/\n/g, " | ");
    out.dow = $("dow").innerText.replace(/\n/g, " | ");
    out.chin = $("chin").innerText.replace(/\n/g, " | ");
    out.zwest = $("zwest").innerText.replace(/\n/g, " | ");
    out.zthai = $("zthai").innerText.replace(/\n/g, " | ");
    out.warnHidden = $("warn").style.display === "none";

    /* ตัวเลขบนหน้าเว็บต้องตรงกับที่ compute() คำนวณ */
    const A = window.AgeCalc;
    const r = A.compute(A.makeDate(1997, 5, 15), A.startOfDay(new Date()));
    out.ageMatches = $("ay").textContent === String(r.age.y) &&
                     $("am").textContent === String(r.age.m) &&
                     $("ad").textContent === String(r.age.d);
    out.totalHasDays = $("total").innerText.indexOf(r.totalDays.toLocaleString("th-TH") + " วัน") === 0;
    out.nextHasDays = $("next").innerText.indexOf(String(r.next.daysLeft)) >= 0 || r.next.daysLeft === 0;

    /* สลับไป ค.ศ. แล้วกรอกปี ค.ศ. ต้องได้ผลเดียวกัน */
    set("15", "5", "1997", "ce");
    out.ceSameAge = $("ay").textContent === String(r.age.y) && $("bstr").innerText.indexOf("15 มิถุนายน 2540") === 0;

    /* วันที่ไม่มีจริง */
    set("31", "1", "2540", "be");
    out.errFeb31 = $("err").textContent;
    /* อนาคต */
    set("1", "0", "2600", "be");
    out.errFuture = $("err").textContent;
    /* กรอกไม่ครบ */
    set("", "0", "", "be");
    out.errEmpty = $("err").textContent;

    /* เกิด 29 ก.พ. → ต้องมีหมายเหตุ */
    set("29", "1", "2543", "be");
    out.feb29Note = $("note").innerText.indexOf("29 ก.พ.") >= 0;
    out.feb29Next = $("next").innerText.replace(/\n/g, " | ");

    /* เกิดก่อนสงกรานต์ → ต้องมีหมายเหตุนักษัตร */
    set("1", "0", "2540", "be");
    out.songkranNote = $("note").innerText.indexOf("สงกรานต์") >= 0;
    set("1", "6", "2540", "be");
    out.noSongkranNote = $("note").innerText.indexOf("สงกรานต์") < 0;

    /* สลับ พ.ศ./ค.ศ. ผิด → ต้องเตือน (แต่ยังแสดงผล) */
    set("15", "5", "1997", "be");     /* 1997 - 543 = ค.ศ. 1454 */
    out.warnShown = $("warn").style.display !== "none" && $("warn").innerText.indexOf("พ.ศ./ค.ศ.") >= 0;
    out.warnStillRenders = $("result").classList.contains("show") && $("ay").textContent !== "0";

    /* localStorage: ค่าที่กรอกล่าสุดถูกบันทึก */
    set("9", "8", "2530", "be");
    out.saved = localStorage.getItem("age-calc");

    /* กด Enter ในช่องปี = กดปุ่มคำนวณ */
    $("d").value = "2"; $("m").value = "3"; $("y").value = "2535";
    $("y").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    out.enterWorks = $("bstr").innerText.indexOf("2 เมษายน 2535") === 0;
    return out;
  });

  check(T("DOM: ยังไม่แสดงผลลัพธ์ก่อนกดคำนวณ"), dom.hiddenAtStart);
  check(T("DOM: กดคำนวณแล้วแสดงผล ไม่มี error"), dom.shown && dom.err === "", dom.err);
  check(T("DOM: วันเกิดแสดง 15 มิถุนายน 2540 / ค.ศ. 1997"), dom.bstr.startsWith("15 มิถุนายน 2540") && dom.bstr.includes("ค.ศ. 1997 · 15/06/1997"), dom.bstr);
  check(T("DOM: 15 มิ.ย. 2540 = วันอาทิตย์ สีแดง"), dom.dow.includes("วันอาทิตย์") && dom.dow.includes("แดง"), dom.dow);
  check(T("DOM: ปี 2540 = ปีฉลู (ปีวัว)"), dom.chin.includes("ปีฉลู") && dom.chin.includes("ปีวัว") && dom.chin.includes("พ.ศ. 2540"), dom.chin);
  check(T("DOM: ราศีเมถุน (Gemini)"), dom.zwest.includes("ราศีเมถุน") && dom.zwest.includes("Gemini"), dom.zwest);
  check(T("DOM: ราศีไทยแสดงผล"), dom.zthai.includes("ราศี"), dom.zthai);
  check(T("DOM: ตัวเลขอายุตรงกับ compute()"), dom.ageMatches);
  check(T("DOM: ยอดรวมวันตรงกับ compute()"), dom.totalHasDays);
  check(T("DOM: วันเกิดถัดไปแสดงจำนวนวัน"), dom.nextHasDays);
  check(T("DOM: กรอก ค.ศ. 1997 ได้ผลเท่ากับ พ.ศ. 2540"), dom.ceSameAge);
  check(T("DOM: 31 ก.พ. ขึ้น error"), dom.errFeb31.startsWith("ไม่มีวันที่นี้"), dom.errFeb31);
  check(T("DOM: วันเกิดอนาคตขึ้น error"), dom.errFuture.startsWith("วันเกิดอยู่ในอนาคต"), dom.errFuture);
  check(T("DOM: กรอกไม่ครบขึ้น error"), dom.errEmpty.startsWith("กรุณากรอก"), dom.errEmpty);
  check(T("DOM: เกิด 29 ก.พ. มีหมายเหตุ"), dom.feb29Note);
  check(T("DOM: เกิด 29 ก.พ. วันครบรอบ = 29 ก.พ. หรือ 28 ก.พ."), /29 กุมภาพันธ์|28 กุมภาพันธ์/.test(dom.feb29Next), dom.feb29Next);
  check(T("DOM: เกิดก่อนสงกรานต์มีหมายเหตุนักษัตร"), dom.songkranNote);
  check(T("DOM: เกิดหลังสงกรานต์ไม่มีหมายเหตุนั้น"), dom.noSongkranNote);
  check(T("DOM: สลับ พ.ศ./ค.ศ. ผิดแล้วมีคำเตือน"), dom.warnShown);
  check(T("DOM: คำเตือนไม่บล็อกการแสดงผล"), dom.warnStillRenders);
  check(T("DOM: ไม่มีคำเตือนในเคสปกติ"), dom.warnHidden);
  check(T("DOM: บันทึกค่าที่กรอกลง localStorage"), (dom.saved || "").includes('"y":"2530"'), dom.saved);
  check(T("DOM: กด Enter แล้วคำนวณ"), dom.enterWorks);

  /* ---------------- 8b. อ่านง่าย: คอนทราสต์สีและขนาดตัวอักษร ---------------- */

  checkBatch(T("คอนทราสต์สี: ตัวอักษรทุกชิ้นบนหน้าผ่านเกณฑ์ WCAG (ปกติ ≥7:1, ตัวใหญ่ ≥4.5:1)"),
    await page.evaluate(() => {
      /* คำนวณอัตราส่วนคอนทราสต์ตามสูตร WCAG 2.x */
      function lum(rgb) {
        const c = rgb.map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
        return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
      }
      function parse(col) {
        const m = col.match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/);
        return m ? { rgb: [+m[1], +m[2], +m[3]], a: m[4] === undefined ? 1 : +m[4] } : null;
      }
      function bgOf(el) {
        for (let n = el; n; n = n.parentElement) {
          const c = parse(getComputedStyle(n).backgroundColor);
          if (c && c.a > 0) return c.rgb;
        }
        return [255, 255, 255];
      }
      function ratio(a, b) {
        const l1 = lum(a), l2 = lum(b);
        return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
      }
      const errors = []; let checked = 0;
      const els = document.querySelectorAll("body *");
      for (const el of els) {
        /* เฉพาะชิ้นที่มีข้อความของตัวเองและมองเห็นได้ */
        const own = Array.from(el.childNodes).some(n => n.nodeType === 3 && n.textContent.trim());
        if (!own) continue;
        const cs = getComputedStyle(el);
        if (cs.display === "none" || cs.visibility === "hidden" || +cs.opacity === 0) continue;
        if (!el.offsetParent && cs.position !== "fixed") continue;
        const fg = parse(cs.color);
        if (!fg) continue;
        const size = parseFloat(cs.fontSize);
        const bold = +cs.fontWeight >= 700;
        const large = size >= 24 || (bold && size >= 18.66);
        const need = large ? 4.5 : 7;          /* ตั้งเกณฑ์ AAA สำหรับตัวอักษรปกติ */
        const got = ratio(fg.rgb, bgOf(el));
        checked++;
        if (got < need) {
          errors.push((el.id ? "#" + el.id : el.className || el.tagName) +
            ' "' + el.textContent.trim().slice(0, 25) + '" ' + got.toFixed(2) + ":1 ต้องการ " + need + ":1");
        }
        if (errors.length > 8) break;
      }
      return { checked, errors };
    }), 15);

  checkBatch(T("ขนาดตัวอักษร: ข้อความทุกชิ้นไม่เล็กกว่า 16px และปุ่มกดได้ไม่ต่ำกว่า 44px"),
    await page.evaluate(() => {
      const errors = []; let checked = 0;
      for (const el of document.querySelectorAll("body *")) {
        const cs = getComputedStyle(el);
        if (cs.display === "none" || !el.offsetParent) continue;
        const own = Array.from(el.childNodes).some(n => n.nodeType === 3 && n.textContent.trim());
        if (own) {
          checked++;
          const size = parseFloat(cs.fontSize);
          if (size < 16) errors.push((el.id ? "#" + el.id : el.className || el.tagName) + " ขนาด " + size + "px");
        }
        if (el.tagName === "BUTTON" || el.tagName === "INPUT" || el.tagName === "SELECT") {
          checked++;
          const r = el.getBoundingClientRect();
          if (r.height < 44) errors.push((el.id || el.textContent.trim().slice(0, 10)) + " สูงแค่ " + Math.round(r.height) + "px");
        }
        if (errors.length > 8) break;
      }
      return { checked, errors };
    }), 20);

  const zoom = await page.evaluate(async () => {
    const root = document.documentElement;
    const before = getComputedStyle(root).fontSize;
    const bigBtn = document.querySelector('#sizes button[data-scale="1.35"]');
    bigBtn.click();
    const after = getComputedStyle(root).fontSize;
    const tileAfter = parseFloat(getComputedStyle(document.getElementById("ay")).fontSize);
    const pressed = bigBtn.getAttribute("aria-pressed");
    const saved = localStorage.getItem("age-calc-scale");
    document.querySelector('#sizes button[data-scale="1"]').click();
    return { before, after, tileAfter, pressed, saved, reset: getComputedStyle(root).fontSize };
  });
  check(T("ขนาดตัวอักษร: ปุ่มขยายทำงานและจำค่าไว้"),
        parseFloat(zoom.after) > parseFloat(zoom.before) && zoom.pressed === "true" &&
        zoom.saved === "1.35" && zoom.tileAfter >= 50 && parseFloat(zoom.reset) < parseFloat(zoom.after),
        JSON.stringify(zoom));

  /* โหลดหน้าใหม่ → ต้องคืนค่าที่บันทึกไว้และคำนวณให้เลย */
  await page.reload();
  const restored = await page.evaluate(() => ({
    d: document.getElementById("d").value,
    y: document.getElementById("y").value,
    shown: document.getElementById("result").classList.contains("show"),
    bstr: document.getElementById("bstr").innerText.split("\n")[0]
  }));
  check(T("DOM: โหลดใหม่แล้วคืนค่าที่กรอกไว้เดิม"), restored.d === "2" && restored.y === "2535" && restored.shown && restored.bstr === "2 เมษายน 2535", JSON.stringify(restored));

  /* localStorage เสียหาย → ต้องไม่พัง */
  await page.evaluate(() => localStorage.setItem("age-calc", "{ไม่ใช่ JSON"));
  await page.reload();
  const broken = await page.evaluate(() => ({
    ok: typeof window.AgeCalc?.compute === "function",
    shown: document.getElementById("result").classList.contains("show")
  }));
  check(T("DOM: localStorage เสียหายแล้วหน้ายังทำงาน"), broken.ok && !broken.shown, JSON.stringify(broken));
  await page.evaluate(() => localStorage.clear());

  /* นาฬิกาบนหัวหน้าเว็บ */
  const clock = await page.evaluate(() => document.getElementById("now").textContent);
  check(T("DOM: แถบวันปัจจุบันแสดงผล"), /^วันนี้: วัน\S+ที่ \d+ \S+ \d{4} · \d\d:\d\d:\d\d น\. \(ค\.ศ\. \d{4}\)$/.test(clock), clock);

  check(T("ไม่มี console error"), consoleErrors.length === 0, consoleErrors.join(" | "));

  await context.close();
}

await browser.close();

if (dump && dumpRows) {
  fs.writeFileSync(dump, dumpRows.join("\n") + "\n");
  console.log("บันทึกผล ageOf " + dumpRows.length.toLocaleString("en-US") + " แถวไว้ที่ " + dump);
}

console.log("\n" + "=".repeat(60));
console.log("ผ่าน " + pass + " รายการ / ไม่ผ่าน " + failures.length + " รายการ" +
            "  (รวมเคสย่อยที่ตรวจ " + cases.toLocaleString("en-US") + " เคส ใน " + TZS.length + " เขตเวลา)");
if (failures.length) {
  console.log("\nรายการที่ไม่ผ่าน:");
  for (const f of failures) console.log("  ✗ " + f);
  process.exit(1);
}
console.log("ผ่านทั้งหมด ✓");
