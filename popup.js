const query_input = document.getElementById("query");
const search_btn = document.getElementById("searchBtn");
const clip_btn = document.getElementById("clipBtn");
const clear_btn = document.getElementById("clearBtn");
const export_btn = document.getElementById("exportBtn");
const import_btn = document.getElementById("importBtn");
const import_file = document.getElementById("importFile");
const stats_line = document.getElementById("stats");
const recent_box = document.getElementById("recent");
const domains_box = document.getElementById("domains");
const results_box = document.getElementById("results");
const domain_filter = document.getElementById("domainFilter");
const min_score = document.getElementById("minScore");
const notice = document.getElementById("notice");

let last_hits = [];
let notice_timer = null;

function escape_html(value) {
    return String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
}

// status line is separate from results so copying a snippet does not nuke the list
function say(text, bad) {
    notice.textContent = text || "";
    notice.classList.toggle("bad", Boolean(bad));
    clearTimeout(notice_timer);
    if (text) notice_timer = setTimeout(() => { notice.textContent = ""; }, 4000);
}

async function ask(type, payload) {
    const res = await chrome.runtime.sendMessage({ type, payload });
    if (!res || res.ok !== true) throw new Error((res && res.error) || "worker did not answer");
    return res;
}

function when(ts) {
    if (!ts) return "";
    const mins = Math.round((Date.now() - ts) / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.round(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.round(hrs / 24)}d ago`;
}

async function refresh_stats() {
    try {
        const res = await ask("STATS");
        const s = res.stats || { chunks: 0, pages: 0 };
        stats_line.textContent = `${s.chunks} chunks · ${s.pages} pages · ${res.mode} search`;
    } catch (err) {
        stats_line.textContent = "vault unreachable, is the worker asleep?";
    }
}

async function refresh_recent() {
    try {
        const { items } = await ask("RECENT");
        if (!items.length) {
            recent_box.textContent = "no clips yet";
            return;
        }
        recent_box.innerHTML = items
            .map((it) =>
                `<div><a href="${escape_html(it.url)}" target="_blank" rel="noreferrer">` +
                `${escape_html(it.title || it.domain)}</a> ` +
                `<span style="opacity:.55">${escape_html(when(it.clipped_at))}</span></div>`)
            .join("");
    } catch {
        recent_box.textContent = "could not read recent clips";
    }
}

async function refresh_domains() {
    try {
        const { items } = await ask("DOMAINS");
        domains_box.innerHTML = items.length
            ? items.map((it) => `${escape_html(it.domain)} <span style="opacity:.55">${Number(it.chunks) || 0}</span>`).join(" · ")
            : "";
    } catch {
        domains_box.textContent = "";
    }
}

async function refresh_all() {
    await Promise.all([refresh_stats(), refresh_recent(), refresh_domains()]);
}

function highlight(text, words) {
    let out = escape_html(text);
    for (const w of words) {
        const safe = w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        if (safe.length < 2) continue;
        out = out.replace(new RegExp(`(${safe})`, "ig"), "<mark>$1</mark>");
    }
    return out;
}

function render_hits(hits, words) {
    last_hits = hits || [];
    if (!last_hits.length) {
        results_box.textContent = "nothing matched that";
        return;
    }

    results_box.innerHTML = last_hits
        .map((hit) => {
            const snip = String(hit.text_chunk || "").slice(0, 180).replace(/\s+/g, " ");
            return `
        <div class="hit">
          <div><strong>${escape_html(hit.title || hit.url)}</strong>
               <span class="score">${Number(hit.score || 0).toFixed(3)}</span></div>
          <div class="snip">${highlight(snip, words)}</div>
          <div class="acts">
            <a href="${escape_html(hit.url)}" target="_blank" rel="noreferrer">open source</a>
            <button data-copy="${escape_html(snip)}">copy snippet</button>
          </div>
        </div>`;
        })
        .join("");

    results_box.querySelectorAll("[data-copy]").forEach((btn) => {
        btn.addEventListener("click", async () => {
            try {
                await navigator.clipboard.writeText(btn.dataset.copy);
                say("snippet copied");
            } catch {
                say("clipboard blocked, select the text instead", true);
            }
        });
    });
}

search_btn.addEventListener("click", async () => {
    const q = query_input.value.trim();
    if (!q) return;

    search_btn.disabled = true;
    results_box.textContent = "searching...";
    say("");

    try {
        const res = await ask("SEARCH", {
            query: q,
            domain_filter: domain_filter.value.trim(),
            min_score: min_score.value.trim() === "" ? 0 : Number(min_score.value),
            top_k: 5
        });
        const words = q.toLowerCase().split(/\s+/).filter((w) => w.length > 1);
        render_hits(res.hits || [], words);
    } catch (err) {
        results_box.textContent = "search broke";
        say(err.message, true);
    } finally {
        search_btn.disabled = false;
        // the vault may have been filled from a hotkey while this popup sat open
        await refresh_all();
    }
});

query_input.addEventListener("keydown", (ev) => {
    if (ev.key !== "Enter") return;
    if (ev.metaKey || ev.ctrlKey) {
        if (last_hits[0]) chrome.tabs.create({ url: last_hits[0].url });
    } else {
        search_btn.click();
    }
});

clip_btn.addEventListener("click", async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) return;

    clip_btn.disabled = true;
    say("clipping, watch the page corner...");

    try {
        await chrome.tabs.sendMessage(tab.id, { type: "BRAINSYNC_CLIP" });
    } catch {
        try {
            await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
            await chrome.tabs.sendMessage(tab.id, { type: "BRAINSYNC_CLIP" });
        } catch {
            say("cant touch this page, chrome and the store block extensions", true);
        }
    } finally {
        clip_btn.disabled = false;
        // the worker writes async, give it a beat then pull the numbers
        setTimeout(refresh_all, 1200);
    }
});

clear_btn.addEventListener("click", async () => {
    if (!confirm("Wipe every clipped chunk? export first if you want a backup.")) return;

    clear_btn.disabled = true;
    try {
        await ask("CLEAR");
        last_hits = [];
        results_box.textContent = "vault is empty";
        say("wiped");
        await refresh_all();
    } catch (err) {
        say(err.message, true);
    } finally {
        clear_btn.disabled = false;
    }
});

export_btn.addEventListener("click", async () => {
    try {
        const { payload } = await ask("EXPORT");
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
        const href = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = href;
        a.download = `brainsync-${payload.exported_at.slice(0, 10)}.json`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(href), 1000);
        say(`exported ${payload.chunks} chunks`);
    } catch (err) {
        say(err.message, true);
    }
});

import_btn.addEventListener("click", () => import_file.click());

import_file.addEventListener("change", async () => {
    const file = import_file.files && import_file.files[0];
    if (!file) return;

    import_btn.disabled = true;
    try {
        const payload = JSON.parse(await file.text());
        const res = await ask("IMPORT", { payload });
        say(`imported ${res.rows} chunks`);
        await refresh_all();
    } catch (err) {
        say(err.message, true);
    } finally {
        import_file.value = "";
        import_btn.disabled = false;
    }
});

refresh_all();