import asyncio, json, pathlib, datetime as dt
from playwright.async_api import async_playwright
import sys
sys.path.insert(0, ".")
from reference.loaders import load
from reference.report import build

TODAY = "2026-08-19"

async def js():
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path="/opt/pw-browsers/chromium-1194/chrome-linux/chrome")
        pg = await b.new_page()
        errs = []
        pg.on("pageerror", lambda e: errs.append(str(e)))
        pg.on("console", lambda m: errs.append("console:" + m.text) if m.type == "error" else None)
        await pg.goto("http://localhost:8899/index.html")
        out = await pg.evaluate("""async (today) => {
            const M = window.__mt;
            const load = async (u) => await M.readSheet(await (await fetch(u)).arrayBuffer());
            const att = await load("testdata/attendance.xlsx");
            const stu = await load("testdata/students.xlsx");
            const [y,m,d] = today.split("-").map(Number);
            const rep = M.buildReport(att, stu, Date.UTC(y, m-1, d)/86400000);
            const per = {};
            for (const s of rep.students) {
                per[s.key] = { owed: s.owed, book: s.toSchedule, missed: s.missed.length,
                               plan: s.plan, sched: s.schedule.weekdays.join(","),
                               sh: s.schedule.sessionHours, conf: s.schedule.confident,
                               req: s.months.map(x=>x.required).join("/"),
                               att: s.months.map(x=>x.attended).join("/"),
                               basis: s.months.map(x=>x.basis||"-").join("/") };
            }
            return { totals: { students: rep.students.length, owing: rep.owing.length,
                     owed: rep.owing.reduce((a,s)=>a+s.owed,0), behind: rep.behind.length,
                     book: rep.behind.reduce((a,s)=>a+s.toSchedule,0), held: rep.held.length,
                     never: rep.neverAttended.length,
                     missed: rep.students.reduce((a,s)=>a+s.missed.length,0) },
                     dataThrough: rep.dataThrough.y+"-"+rep.dataThrough.m+"-"+rep.dataThrough.d,
                     per };
        }""", TODAY)
        await b.close()
        return out, errs

def py():
    rep = build(load("testdata/attendance.xlsx", "testdata/students.xlsx"), dt.date.fromisoformat(TODAY))
    per = {}
    for s in rep.students:
        per[s.key] = { "owed": s.owed, "book": s.to_schedule_now, "missed": len(s.missed_dates),
                       "plan": s.plan_hours, "sched": ",".join(str(w) for w in s.schedule.weekdays),
                       "sh": s.schedule.session_hours, "conf": s.schedule.confident,
                       "req": "/".join(str(m.required) for m in s.months),
                       "att": "/".join(str(m.attended) for m in s.months),
                       "basis": "/".join(m.absence_basis or "-" for m in s.months) }
    return { "totals": { "students": len(rep.students), "owing": len(rep.owing),
             "owed": sum(s.owed for s in rep.owing), "behind": len(rep.behind_pace),
             "book": sum(s.to_schedule_now for s in rep.behind_pace), "held": len(rep.held),
             "never": len(rep.never_attended),
             "missed": sum(len(s.missed_dates) for s in rep.students) },
             "dataThrough": f"{rep.data_through.year}-{rep.data_through.month}-{rep.data_through.day}",
             "per": per }

async def main():
    j, errs = await js()
    p = py()
    print("page errors:", errs or "none")
    print("\ntotals")
    for k in p["totals"]:
        a, b = p["totals"][k], j["totals"][k]
        print(f"  {k:<10} py={a:<7} js={b:<7} {'OK' if a==b else '*** MISMATCH ***'}")
    print("  dataThrough py=%s js=%s %s" % (p["dataThrough"], j["dataThrough"], "OK" if p["dataThrough"]==j["dataThrough"] else "*** MISMATCH ***"))
    keys = set(p["per"]) | set(j["per"])
    diffs = []
    for k in keys:
        a, b = p["per"].get(k), j["per"].get(k)
        if a != b: diffs.append((k, a, b))
    print(f"\nper-student field comparison over {len(keys)} students: {len(diffs)} differing")
    for k, a, b in diffs[:6]:
        fields = [f for f in (a or {}) if (a or {}).get(f) != (b or {}).get(f)]
        print("  fields differing:", fields, "| py", {f:(a or {}).get(f) for f in fields}, "| js", {f:(b or {}).get(f) for f in fields})
asyncio.run(main())
