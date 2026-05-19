const DB_NAME = "brainsync_vault";
const DB_VERSION = 2;
const STORE = "chunks";

let db_handle = null;
let db_pending = null;

export function open_vault() {
    if (db_handle) return Promise.resolve(db_handle);
    if (db_pending) return db_pending;

    db_pending = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);

        req.onupgradeneeded = () => {
            const db = req.result;
            let store;
            if (!db.objectStoreNames.contains(STORE)) {
                store = db.createObjectStore(STORE, { keyPath: "id" });
            } else {
                store = req.transaction.objectStore(STORE);
            }
            if (!store.indexNames.contains("url")) store.createIndex("url", "url", { unique: false });
            if (!store.indexNames.contains("clipped_at")) store.createIndex("clipped_at", "clipped_at", { unique: false });
        };

        req.onsuccess = () => {
            const db = req.result;
            // if another tab wants to bump the version we have to let go of our handle
            db.onversionchange = () => { db.close(); db_handle = null; db_pending = null; };
            resolve(db);
        };
        req.onerror = () => { db_pending = null; reject(req.error); };
        req.onblocked = () => { db_pending = null; reject(new Error("vault upgrade blocked by another tab")); };
    }).then((db) => {
        db_handle = db;
        db_pending = null;
        return db;
    });

    return db_pending;
}

export function normalize_url(url) {
    try {
        const u = new URL(url);
        u.hash = "";
        return u.toString();
    } catch {
        return String(url || "");
    }
}

export function hostname_of(url) {
    try {
        return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
    } catch {
        return "";
    }
}

function clean_row(row) {
    if (!row || !row.url || !Array.isArray(row.embedding)) return null;
    return {
        id: String(row.id),
        url: normalize_url(row.url),
        title: String(row.title || ""),
        text_chunk: String(row.text_chunk || ""),
        embedding: row.embedding.map((n) => Number(n) || 0),
        clipped_at: Number(row.clipped_at) || 0,
        source: String(row.source || "page")
    };
}

export async function put_rows(rows) {
    const db = await open_vault();

    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, "readwrite");
        const store = tx.objectStore(STORE);
        for (const row of rows) store.put(row);
        tx.oncomplete = () => resolve(rows.length);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error("write aborted"));
    });
}

export async function drop_url(url) {
    const db = await open_vault();
    const target = normalize_url(url);
    if (!target) return 0;

    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, "readwrite");
        const store = tx.objectStore(STORE);
        const req = store.index("url").openCursor(IDBKeyRange.only(target));
        let killed = 0;
        req.onsuccess = () => {
            const cursor = req.result;
            if (!cursor) return;
            cursor.delete();
            killed += 1;
            cursor.continue();
        };
        req.onerror = () => reject(req.error);
        tx.oncomplete = () => resolve(killed);
        tx.onerror = () => reject(tx.error);
    });
}

export async function all_rows() {
    const db = await open_vault();

    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, "readonly");
        const req = tx.objectStore(STORE).getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error);
    });
}

export async function wipe_vault() {
    const db = await open_vault();

    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, "readwrite");
        tx.objectStore(STORE).clear();
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => reject(tx.error);
    });
}

export async function vault_stats() {
    const db = await open_vault();

    const chunks = await new Promise((resolve, reject) => {
        const req = db.transaction(STORE, "readonly").objectStore(STORE).count();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });

    // non-unique index counts only exact matches so just walk the keys
    const pages = await new Promise((resolve, reject) => {
        const seen = new Set();
        const req = db.transaction(STORE, "readonly").objectStore(STORE).index("url").openKeyCursor();
        req.onsuccess = () => {
            const cursor = req.result;
            if (!cursor) return resolve(seen.size);
            seen.add(cursor.key);
            cursor.continue();
        };
        req.onerror = () => reject(req.error);
    });

    return { chunks, pages };
}

export async function domain_counts(limit = 8) {
    const rows = await all_rows();
    const tally = new Map();
    for (const row of rows) {
        const host = hostname_of(row.url);
        if (!host) continue;
        tally.set(host, (tally.get(host) || 0) + 1);
    }
    return Array.from(tally.entries())
        .map(([domain, chunks]) => ({ domain, chunks }))
        .sort((a, b) => b.chunks - a.chunks)
        .slice(0, Math.max(1, limit));
}

export async function recent_clips(limit = 8) {
    const rows = await all_rows();
    const best = new Map();

    for (const row of rows) {
        const prev = best.get(row.url);
        if (!prev || (row.clipped_at || 0) >= (prev.clipped_at || 0)) best.set(row.url, row);
    }

    return Array.from(best.values())
        .sort((a, b) => (b.clipped_at || 0) - (a.clipped_at || 0))
        .slice(0, Math.max(1, limit))
        .map((row) => ({
            url: row.url,
            title: row.title || row.url,
            domain: hostname_of(row.url),
            clipped_at: row.clipped_at || 0
        }));
}

export async function export_vault() {
    const rows = await all_rows();
    return {
        kind: "brainsync-vault",
        schema: DB_VERSION,
        exported_at: new Date().toISOString(),
        chunks: rows.length,
        rows: rows.map(clean_row)
    };
}

export async function import_vault(payload) {
    if (!payload || !Array.isArray(payload.rows)) throw new Error("that file is not a brainsync backup");

    const db = await open_vault();
    const good = payload.rows.map(clean_row).filter(Boolean);
    if (!good.length) throw new Error("backup had no usable chunks in it");

    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, "readwrite");
        const store = tx.objectStore(STORE);
        for (const row of good) store.put(row);
        tx.oncomplete = () => resolve(good.length);
        tx.onerror = () => reject(tx.error);
    });
}

export function to_storable(vec) {
    return Array.from(vec, (n) => Math.round(n * 1e5) / 1e5);
}

export function to_vector(arr) {
    return Float32Array.from(arr || []);
}