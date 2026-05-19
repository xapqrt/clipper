import {
    all_rows,
    drop_url,
    domain_counts,
    export_vault,
    hostname_of,
    import_vault,
    normalize_url,
    put_rows,
    recent_clips,
    to_storable,
    vault_stats,
    wipe_vault
} from "./db.js";
import { embed, embed_many, rank, search_mode, warm_model } from "./vectors.js";

const MENU_ID = "brainsync-clip";

async function nudge(tab_id, label, pct) {
    if (!tab_id) return;
    try {
        await chrome.tabs.sendMessage(tab_id, { type: "BRAINSYNC_PROGRESS", label, pct });
    } catch {
        // tab moved or will not talk to us, progress is only a nicety
    }
}

// content scripts are declared for <all_urls> but the host may have been loaded
// before an extension reload, so inject and retry once
async function clip_tab(tab_id) {
    if (!tab_id) return false;
    try {
        await chrome.tabs.sendMessage(tab_id, { type: "BRAINSYNC_CLIP" });
        return true;
    } catch {
        await chrome.scripting.executeScript({ target: { tabId: tab_id }, files: ["content.js"] });
        await chrome.tabs.sendMessage(tab_id, { type: "BRAINSYNC_CLIP" });
        return true;
    }
}

function clip_page(payload, tab_id) {
    const url = normalize_url(payload.url);
    const chunks = Array.isArray(payload.chunks) ? payload.chunks.filter((c) => c && c.trim()) : [];
    if (!url || !chunks.length) throw new Error("nothing readable on that page");

    return (async () => {
        await nudge(tab_id, "Warming up search...", 15);
        // get the engine to boot before we start timing progress
        await warm_model();

        const stamped_at = Date.now();
        await drop_url(url);

        const vecs = await embed_many(chunks, (done, total) => {
            nudge(tab_id, "Embedding locally...", 20 + Math.round((done / total) * 70));
        });

        const rows = chunks.map((text_chunk, i) => ({
            id: `${url}::${stamped_at}::${i}`,
            url,
            title: String(payload.title || "").trim(),
            text_chunk,
            embedding: to_storable(vecs[i]),
            clipped_at: stamped_at,
            source: payload.source || "page"
        }));

        await put_rows(rows);
        await nudge(tab_id, `Saved ${rows.length} chunks`, 100);

        return {
            chunks: rows.length,
            domain: hostname_of(url),
            mode: search_mode()
        };
    })();
}

const handlers = {
    async CLIP(msg, sender) {
        return clip_page(msg.payload, sender.tab && sender.tab.id);
    },

    async SEARCH(msg) {
        const opts = msg.payload || {};
        const query = String(opts.query || "").trim();
        if (!query) return { hits: [] };

        const rows = await all_rows();
        const query_vec = await embed(query);
        const hits = rank(rows, query, {
            query_vec,
            domain_filter: String(opts.domain_filter || "").trim(),
            min_score: Number.isFinite(Number(opts.min_score)) ? Number(opts.min_score) : 0,
            top_k: Math.min(25, Math.max(1, Number(opts.top_k) || 5))
        });

        return { hits, mode: search_mode() };
    },

    async STATS() {
        const stats = await vault_stats();
        return { stats, mode: search_mode() };
    },

    async RECENT() {
        return { items: await recent_clips(8) };
    },

    async DOMAINS() {
        return { items: await domain_counts(8) };
    },

    async CLEAR() {
        await wipe_vault();
        return { ok: true };
    },

    async EXPORT() {
        return { payload: await export_vault() };
    },

    async IMPORT(msg) {
        const rows = await import_vault(msg.payload);
        return { rows, stats: await vault_stats() };
    }
};

chrome.runtime.onInstalled.addListener(() => {
    chrome.contextMenus.removeAll(() => {
        chrome.contextMenus.create({ id: MENU_ID, title: "Save page to Brain-Sync", contexts: ["page"] });
    });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId !== MENU_ID) return;
    clip_tab(tab && tab.id).catch((err) => console.warn("brainsync: clip from menu failed", err.message));
});

chrome.commands.onCommand.addListener(async (command) => {
    if (command !== "brainsync-clip") return;
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) return;
    clip_tab(tab.id).catch((err) => console.warn("brainsync: hotkey clip failed", err.message));
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    const fn = msg && handlers[msg.type];
    if (!fn) return false;

    Promise.resolve()
        .then(() => fn(msg, sender))
        .then((result) => sendResponse({ ok: true, ...result }))
        .catch((err) => {
            console.warn(`brainsync: ${msg.type} failed`, err && err.message);
            sendResponse({ ok: false, error: (err && err.message) || String(err) });
        });
    return true;
});