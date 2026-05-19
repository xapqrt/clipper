// injected on every page. guard against double injection, executeScript after an
// extension reload re-runs this file and we do not want two listeners fighting
if (!window.__brainsync_loaded) {
    window.__brainsync_loaded = true;

    const SKIP_TAGS = new Set([
        "SCRIPT", "STYLE", "NOSCRIPT", "NAV", "FOOTER", "ASIDE", "FORM", "IFRAME",
        "SVG", "CANVAS", "VIDEO", "AUDIO", "BUTTON", "SELECT", "TEMPLATE", "HEAD"
    ]);

    const BLOCK_TAGS = new Set([
        "P", "DIV", "SECTION", "ARTICLE", "MAIN", "LI", "UL", "OL", "DL", "DD", "DT",
        "TR", "TD", "BR", "HR", "H1", "H2", "H3", "H4", "H5", "H6", "PRE", "CODE",
        "BLOCKQUOTE", "TABLE", "FIGURE", "FIGCAPTION", "HEADER", "FOOTER", "ASIDE"
    ]);

    const WORDS_PER_CHUNK = 300;
    const OVERLAP_WORDS = 60;
    const MAX_CHUNKS = 160;

    let toast_host = null;
    let toast_ui = null;
    let clipping = false;

    function ensure_toast() {
        if (toast_ui && toast_host && toast_host.isConnected) return toast_ui;

        toast_host = document.createElement("div");
        // shadow root so the page stylesheet cant reach in and wreck it
        toast_host.style.cssText = "position:fixed;right:16px;bottom:16px;z-index:2147483647";
        const shadow = toast_host.attachShadow({ mode: "closed" });

        const card = document.createElement("div");
        card.style.cssText = [
            "background:#12161c", "color:#e6edf3", "padding:10px 12px",
            "border-radius:10px", "min-width:230px",
            "font:12px/1.4 ui-monospace,Menlo,monospace",
            "box-shadow:0 8px 24px rgba(0,0,0,.4)",
            "border:1px solid #2b3440"
        ].join(";");
        card.innerHTML =
            '<div class="msg">working...</div>' +
            '<div style="height:4px;background:#242c36;border-radius:10px;margin-top:8px;overflow:hidden">' +
            '<div class="bar" style="height:100%;width:0;background:#66e2b3;transition:width .2s"></div></div>';

        shadow.appendChild(card);
        (document.body || document.documentElement).appendChild(toast_host);

        toast_ui = {
            say(label, pct) {
                card.querySelector(".msg").textContent = label;
                card.querySelector(".bar").style.width = `${Math.max(0, Math.min(100, pct))}%`;
            },
            close(delay) {
                setTimeout(() => {
                    if (toast_host) toast_host.remove();
                    toast_host = null;
                    toast_ui = null;
                }, delay);
            }
        };
        return toast_ui;
    }

    // walking the live dom beats cloneNode on pages with a few thousand nodes
    function collect_text(node, out, depth) {
        if (depth > 40) return;
        for (const kid of node.childNodes) {
            if (kid.nodeType === 3) {
                out.push(kid.nodeValue);
                continue;
            }
            if (kid.nodeType !== 1) continue;
            if (SKIP_TAGS.has(kid.tagName)) continue;
            if (kid.getAttribute("aria-hidden") === "true") continue;

            const block = BLOCK_TAGS.has(kid.tagName);
            if (block) out.push("\n");
            collect_text(kid, out, depth + 1);
            if (block) out.push("\n");
        }
    }

    function readable_text() {
        const root =
            document.querySelector("article, main, [role=main]") ||
            document.querySelector("#content") ||
            document.body;
        if (!root) return "";

        const raw = [];
        collect_text(root, raw, 0);

        return raw
            .join("")
            .replace(/\r/g, "")
            .replace(/[ \t ]+/g, " ")
            .replace(/ *\n */g, "\n")
            .replace(/\n{3,}/g, "\n\n")
            .trim();
    }

    // pack on paragraph edges where possible and overlap a bit so a sentence
    // sitting on a boundary still exists in full inside one chunk
    function split_chunks(text) {
        const paras = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
        if (!paras.length) return [];

        const chunks = [];
        let buf = [];
        let words = 0;

        const flush = () => {
            if (buf.length) chunks.push(buf.join("\n\n"));
            buf = [];
            words = 0;
        };

        for (const para of paras) {
            const size = para.split(/\s+/).length;
            if (words + size > WORDS_PER_CHUNK && buf.length) flush();
            buf.push(para);
            words += size;

            if (words >= WORDS_PER_CHUNK) {
                const joined = buf.join("\n\n").split(/\s+/);
                const tail = joined.slice(Math.max(0, joined.length - OVERLAP_WORDS)).join(" ");
                flush();
                buf = tail ? [tail] : [];
                words = tail ? tail.split(/\s+/).length : 0;
            }

            if (chunks.length >= MAX_CHUNKS) break;
        }
        flush();
        return chunks.slice(0, MAX_CHUNKS);
    }

    async function run_clip() {
        if (clipping) return;
        clipping = true;

        const toast = ensure_toast();
        try {
            toast.say("Reading page...", 10);
            const text = readable_text();
            if (text.length < 200) {
                toast.say("Not much readable text here", 100);
                toast.close(1800);
                return;
            }

            const chunks = split_chunks(text);
            if (!chunks.length) {
                toast.say("Nothing chunkable, page too small", 100);
                toast.close(1800);
                return;
            }

            toast.say(`Embedding ${chunks.length} chunks`, 20);
            const res = await chrome.runtime.sendMessage({
                type: "CLIP",
                payload: { url: location.href, title: document.title, chunks }
            });

            toast.say(res && res.ok ? `Saved ${res.chunks} chunks` : "Save failed", 100);
            toast.close(2400);
        } catch (err) {
            console.warn("brainsync: clip failed", err && err.message);
            toast.say("Clip failed, check the worker log", 100);
            toast.close(3000);
        } finally {
            clipping = false;
        }
    }

    chrome.runtime.onMessage.addListener((msg) => {
        if (!msg) return;
        if (msg.type === "BRAINSYNC_CLIP") run_clip();
        if (msg.type === "BRAINSYNC_PROGRESS") ensure_toast().say(String(msg.label || "working..."), Number(msg.pct) || 0);
    });

    window.addEventListener("pagehide", () => toast_host && toast_host.remove());
}