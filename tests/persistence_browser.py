import asyncio, pathlib
from playwright.async_api import async_playwright

# Bytes, not fetch: the page's CSP sets connect-src 'none', so files must be handed
# over the way a real user picking a file does.
import base64
def _b64(p): return base64.b64encode(pathlib.Path(p).read_bytes()).decode()

DROP = """async (p) => {
  const toFile = (b64, name) => { const bin = atob(b64); const u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return new File([u], name); };
  const drop = (id, f) => { const dt = new DataTransfer(); dt.items.add(f);
    document.getElementById(id).dispatchEvent(new DragEvent('drop', {dataTransfer: dt, bubbles: true})); };
  drop('dropAtt', toFile(p.att, 'attendance.xlsx'));
  drop('dropStu', toFile(p.stu, 'students.xlsx'));
}"""

async def main():
    async with async_playwright() as pw:
        b = await pw.chromium.launch(executable_path="/opt/pw-browsers/chromium-1194/chrome-linux/chrome")
        ctx = await b.new_context(viewport={"width":1300,"height":1000})
        pg = await ctx.new_page()
        errs=[]; pg.on("pageerror", lambda e: errs.append(str(e)))

        await pg.goto("http://localhost:8899/index.html")
        print("1. fresh load note:", (await pg.inner_text("#storageNote"))[:70], "...")
        print("   forget button hidden:", await pg.is_hidden("#forget"))

        await pg.evaluate(DROP, {"att": _b64("testdata/attendance.xlsx"), "stu": _b64("testdata/students.xlsx")})
        await pg.wait_for_function("() => !document.getElementById('run').disabled", timeout=15000)
        await pg.wait_for_function("() => !document.getElementById('forget').hidden", timeout=8000)
        print("2. after drop, forget visible:", not await pg.is_hidden("#forget"))
        print("   note:", (await pg.inner_text("#storageNote"))[:60], "...")

        # RELOAD: should restore and auto-run without any interaction
        await pg.reload()
        await pg.wait_for_selector("#results:not([hidden])", timeout=20000)
        print("3. after reload, auto-restored and auto-ran with no clicks")
        print("   stamp:", await pg.inner_text("#stamp"))
        print("   attendance label:", await pg.inner_text("#nameAtt"))
        cards = await pg.eval_on_selector_all(".card", "els => els.map(e => e.querySelector('.n').textContent)")
        print("   cards:", cards)

        # FORGET
        await pg.click("#forget")
        await pg.wait_for_function("() => document.getElementById('results').hidden", timeout=8000)
        print("4. after forget, results hidden:", await pg.is_hidden("#results"),
              "| run disabled:", await pg.is_disabled("#run"),
              "| labels cleared:", (await pg.inner_text("#nameAtt")) == "")
        await pg.reload()
        await pg.wait_for_timeout(1500)
        print("5. after reload post-forget, run still disabled:", await pg.is_disabled("#run"),
              "| results hidden:", await pg.is_hidden("#results"))
        print("page errors:", errs or "none")
        await pg.screenshot(path="/tmp/persist.png")
        await b.close()

asyncio.run(main())
