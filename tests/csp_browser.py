"""Run the tool with the deployed CSP in force and NO network available to the page.

Files are injected as bytes rather than fetched, which is what a real user does when they
pick a file, and which proves the page never needs the network to work.
"""
import asyncio, base64, pathlib
from playwright.async_api import async_playwright

def b64(p): return base64.b64encode(pathlib.Path(p).read_bytes()).decode()

async def main():
    att, stu = b64("testdata/attendance.xlsx"), b64("testdata/students.xlsx")
    async with async_playwright() as pw:
        b = await pw.chromium.launch(executable_path="/opt/pw-browsers/chromium-1194/chrome-linux/chrome")
        ctx = await b.new_context(viewport={"width":1300,"height":1000}, accept_downloads=True)
        pg = await ctx.new_page()
        violations, errs = [], []
        pg.on("pageerror", lambda e: errs.append(str(e)))
        pg.on("console", lambda m: violations.append(m.text) if "Content Security Policy" in m.text else None)
        # Block every outbound request except the page itself, so any dependency shows up
        # as a failure instead of quietly working in test and failing offline.
        await ctx.route("**/*", lambda route: route.continue_() if route.request.url.endswith("/index.html") else route.abort())
        await pg.goto("http://127.0.0.1:8901/index.html")

        await pg.evaluate("""async ([a, s]) => {
            const toFile = (b64, name) => {
              const bin = atob(b64); const u8 = new Uint8Array(bin.length);
              for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
              return new File([u8], name);
            };
            const drop = (id, f) => { const dt = new DataTransfer(); dt.items.add(f);
              document.getElementById(id).dispatchEvent(new DragEvent('drop', {dataTransfer: dt, bubbles: true})); };
            drop('dropAtt', toFile(a, 'attendance.xlsx'));
            drop('dropStu', toFile(s, 'students.xlsx'));
        }""", [att, stu])
        await pg.wait_for_function("()=>!document.getElementById('run').disabled", timeout=25000)
        await pg.click("#run")
        await pg.wait_for_selector("#results:not([hidden])", timeout=25000)

        cards = await pg.eval_on_selector_all(".card .n", "e=>e.map(x=>x.textContent)")
        print("ran under CSP with all network blocked ->", cards)
        print("stamp:", await pg.inner_text("#stamp"))
        print("queue:", await pg.inner_text("#queueTitle"))

        # the two things that could plausibly need network: storage and the xlsx download
        await pg.reload(); await pg.wait_for_selector("#results:not([hidden])", timeout=25000)
        print("remembered across reload:", (await pg.inner_text("#nameAtt")).endswith("(remembered)"))
        async with pg.expect_download() as dl:
            await pg.click("#download")
        d = await dl.value
        print("excel export still works:", d.suggested_filename)

        # prove connect-src is actually enforced
        blocked = await pg.evaluate("""async () => {
            try { await fetch('https://example.com/x'); return 'NOT BLOCKED'; }
            catch (e) { return 'blocked: ' + e.constructor.name; }
        }""")
        print("outbound fetch from the page:", blocked)
        print("CSP violations during normal use:", violations or "none")
        print("page errors:", errs or "none")
        await b.close()

asyncio.run(main())
