#!/usr/bin/env python3
"""ตรวจผล ageOf ของหน้าคำนวณอายุ ซ้ำกับ python-dateutil (relativedelta) ซึ่งเป็น
implementation อิสระคนละภาษา คนละอัลกอริทึม

    AGE_TEST_DUMP=/tmp/ageof.tsv node tests/age-calc.test.mjs
    python3 tests/crosscheck_dateutil.py /tmp/ageof.tsv

ไฟล์ .tsv มีคอลัมน์: วันเกิด, วันที่เทียบ, ปี, เดือน, วัน, จำนวนวันรวม
"""
import sys
from collections import Counter
from datetime import date
from dateutil.relativedelta import relativedelta

path = sys.argv[1] if len(sys.argv) > 1 else "/tmp/ageof.tsv"
rows = total_mismatch = 0
diff_kinds = Counter()
samples = []
day_bad = 0

with open(path, encoding="utf-8") as fh:
    for line in fh:
        b_s, n_s, y, m, d, td = line.rstrip("\n").split("\t")
        b = date(*map(int, b_s.split("-")))
        n = date(*map(int, n_s.split("-")))
        y, m, d, td = int(y), int(m), int(d), int(td)
        rows += 1

        if (n - b).days != td:
            day_bad += 1
            if len(samples) < 10:
                samples.append(f"จำนวนวันรวมไม่ตรง {b_s} → {n_s}: หน้าเว็บ {td} / python {(n - b).days}")

        rd = relativedelta(n, b)
        if (rd.years, rd.months, rd.days) != (y, m, d):
            total_mismatch += 1
            # จัดกลุ่มว่าต่างกันเพราะอะไร (ปกติคือเคสวันเกิดเป็นวันท้ายเดือน)
            kind = "วันเกิดเป็นวันท้ายเดือน" if b.day >= 28 else "อื่น ๆ"
            diff_kinds[kind] += 1
            if len(samples) < 10:
                samples.append(f"{b_s} → {n_s}: หน้าเว็บ {y}y {m}m {d}d / dateutil {rd.years}y {rd.months}m {rd.days}d")

print(f"เทียบทั้งหมด {rows:,} คู่")
print(f"จำนวนวันรวม (total days) ไม่ตรง: {day_bad:,}")
print(f"ปี/เดือน/วัน ไม่ตรงกับ dateutil: {total_mismatch:,}  {dict(diff_kinds)}")
for s in samples:
    print("   ", s)
sys.exit(1 if day_bad else 0)
