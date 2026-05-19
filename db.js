const DB_NAME = "brainsync_vector_db";
const DB_VERSION = 1;
const STORE = "vector_chunks";

let vector_db = null;

export async function open_vector_db() {
  if (vector_db) return vector_db;

  vector_db = await new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const os = db.createObjectStore(STORE, { keyPath: "id" });
        os.createIndex("url", "url", { unique: false });
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

  return vector_db;
}











export async function put_vector_rows(rows) {
  const db = await open_vector_db();

  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const st = tx.objectStore(STORE);

    for (const row of rows) {
      st.put({
        id: row.id,
        url: row.url,
        title: row.title,
        text_chunk: row.text_chunk,
        embedding: row.embedding
      });
    }

    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
}

export async function delete_vectors_for_url(url) {
  if (!url) return;

  const db = await open_vector_db();

  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const st = tx.objectStore(STORE);
    const idx = st.index("url");
    const req = idx.openCursor(IDBKeyRange.only(url));

    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return;
      st.delete(cursor.primaryKey);
      cursor.continue();
    };

    req.onerror = () => reject(req.error);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
}














export async function get_all_vectors() {
  const db = await open_vector_db();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const st = tx.objectStore(STORE);
    const req = st.getAll();

    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}












export async function clear_all_vectors() {
  const db = await open_vector_db();

  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const st = tx.objectStore(STORE);
    st.clear();
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
}

export async function get_vector_stats() {
  const db = await open_vector_db();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const st = tx.objectStore(STORE);
    const req = st.getAll();

    req.onsuccess = () => {
      const rows = req.result || [];
      const urls = new Set(rows.map((r) => r.url).filter(Boolean));
      resolve({ total_chunks: rows.length, unique_urls: urls.size });
    };

    req.onerror = () => reject(req.error);
  });
}

export async function get_domain_counts(limit = 10) {
  const rows = await get_all_vectors();
  const counts = new Map();

  for (const row of rows) {
    try {
      const domain = new URL(row.url).hostname.toLowerCase();
      counts.set(domain, (counts.get(domain) || 0) + 1);
    } catch {
      // ignore malformed urls
    }
  }

  return Array.from(counts.entries())
    .map(([domain, chunks]) => ({ domain, chunks }))
    .sort((a, b) => b.chunks - a.chunks)
    .slice(0, Math.max(1, Number(limit || 10)));
}

export async function export_all_vectors_payload() {
  const rows = await get_all_vectors();
  return {
    schema: 1,
    exported_at: new Date().toISOString(),
    count: rows.length,
    rows
  };
}












export async function import_vectors_payload(payload) {
  if (!payload || !Array.isArray(payload.rows)) {
    throw new Error("invalid import payload");
  }

  const db = await open_vector_db();

  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const st = tx.objectStore(STORE);

    for (const row of payload.rows) {
      if (!row?.id || !row?.url || !Array.isArray(row?.embedding)) continue;
      st.put({
        id: row.id,
        url: row.url,
        title: row.title || "",
        text_chunk: row.text_chunk || "",
        embedding: row.embedding
      });
    }

    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
}

export function to_storable_embedding(float32) {
  return Array.from(float32);
}

export function from_storable_embedding(maybe_arr) {
  return new Float32Array(maybe_arr || []);
}
