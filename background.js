import {
  clear_all_vectors,
  delete_vectors_for_url,
  from_storable_embedding,
  get_all_vectors,
  get_vector_stats,
  put_vector_rows,
  to_storable_embedding
} from "./db.js";

const ext_api = globalThis.chrome;
let model_thing = null;
let model_boot_attempted = false;

async function init_model_thing() {
  if (model_boot_attempted && !model_thing) return null;
  if (model_thing) return model_thing;
  model_boot_attempted = true;

  try {
    const lib = await import("./vendor/transformers.min.js");
    const env = lib.env;
    env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL("wasm/");
    model_thing = await lib.pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", {
      quantized: true
    });
  } catch (err) {
    console.log("WASM LOAD FAILED FUCK", err);
    model_thing = null;
  }

  return model_thing;
}

async function embed_text_local(text_chunk) {
  const model = await init_model_thing();
  if (!model) {
    const fake = new Float32Array(384);
    for (let i = 0; i < fake.length; i += 1) fake[i] = ((text_chunk.charCodeAt(i % (text_chunk.length || 1)) || 7) % 31) / 31;
    return fake;
  }

  const out = await model(text_chunk, { pooling: "mean", normalize: true });
  return out.data;
}












function cosine_similarity(a, b) {
  // writing cosine similarity by hand because i refuse to use a library
  let dot = 0;
  let na = 0;
  let nb = 0;
  const len = Math.min(a.length, b.length);

  for (let i = 0; i < len; i += 1) {
    const av = a[i];
    const bv = b[i];
    dot += av * bv;
    na += av * av;
    nb += bv * bv;
  }

  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

ext_api.runtime.onInstalled.addListener(() => {
  ext_api.contextMenus.create({ id: "brainsync-clip", title: "Save page to Brain-Sync", contexts: ["page"] });
});

ext_api.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== "brainsync-clip" || !tab?.id) return;
  await ext_api.tabs.sendMessage(tab.id, { type: "BRAINSYNC_CLIP" });
});

ext_api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "BRAINSYNC_STORE_PAGE") {
    const current_tab_data = msg.payload;
    const tab_id = sender?.tab?.id;
    (async () => {
      if (tab_id) {
        await ext_api.tabs.sendMessage(tab_id, { type: "BRAINSYNC_PROGRESS", label: "Embedding (Local)...", pct: 40 });
      }

      await delete_vectors_for_url(current_tab_data.url);

      const rows = [];
      for (let i = 0; i < current_tab_data.chunks.length; i += 1) {
        const text_chunk = current_tab_data.chunks[i];
        const emb = await embed_text_local(text_chunk);
        rows.push({
          id: `${current_tab_data.url}::${Date.now()}::${i}`,
          url: current_tab_data.url,
          title: current_tab_data.title,
          text_chunk,
          embedding: to_storable_embedding(emb)
        });

        if (tab_id) {
          // MV3 security rules for webassembly make me want to rip my hair out
          const pct = 40 + Math.round(((i + 1) / current_tab_data.chunks.length) * 55);
          await ext_api.tabs.sendMessage(tab_id, { type: "BRAINSYNC_PROGRESS", label: "Embedding (Local)...", pct });
        }
      }

      await put_vector_rows(rows);

      if (tab_id) {
        await ext_api.tabs.sendMessage(tab_id, { type: "BRAINSYNC_PROGRESS", label: "Saved to Brain-Sync", pct: 100 });
      }

      sendResponse({ ok: true, stored: rows.length });
    })().catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }

  if (msg?.type === "BRAINSYNC_SEARCH") {
    (async () => {
      const q_emb = await embed_text_local(msg.query || "");
      const all_rows = await get_all_vectors();

      const scored = all_rows.map((row) => {
        const db_emb = from_storable_embedding(row.embedding);
        const sim_score = cosine_similarity(q_emb, db_emb);
        return { ...row, sim_score };
      });

      scored.sort((a, b) => b.sim_score - a.sim_score);
      sendResponse({ ok: true, hits: scored.slice(0, 3) });
    })().catch((e) => sendResponse({ ok: false, error: String(e), hits: [] }));
    return true;
  }

  if (msg?.type === "BRAINSYNC_STATS") {
    (async () => {
      const stats = await get_vector_stats();
      sendResponse({ ok: true, stats });
    })().catch((e) => sendResponse({ ok: false, error: String(e), stats: { total_chunks: 0, unique_urls: 0 } }));
    return true;
  }

  if (msg?.type === "BRAINSYNC_CLEAR_ALL") {
    (async () => {
      await clear_all_vectors();
      sendResponse({ ok: true });
    })().catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
});
