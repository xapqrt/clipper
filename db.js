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

export function to_storable_embedding(float32) {
  return Array.from(float32);
}

export function from_storable_embedding(maybe_arr) {
  return new Float32Array(maybe_arr || []);
}
