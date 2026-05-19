import {
  clear_all_vectors,
  delete_vectors_for_url,
  export_all_vectors_payload,
  from_storable_embedding,
  get_domain_counts,
  get_all_vectors,
  get_vector_stats,
  import_vectors_payload,
  put_vector_rows,
  to_storable_embedding
} from "./db.js";

const ext_api = globalThis.chrome;
let model_thing = null;
let model_boot_attempted = false;

async function safe_send_progress(tab_id, label, pct) {
  if (!tab_id) return;
  try {
    await ext_api.tabs.sendMessage(tab_id, { type: "BRAINSYNC_PROGRESS", label, pct });
  } catch {
    // tab may have navigated or disallow messaging; progress is best-effort
  }
}

async function trigger_clip_on_tab(tab_id) {
  if (!tab_id) return;

  try {
    await ext_api.tabs.sendMessage(tab_id, { type: "BRAINSYNC_CLIP" });
  } catch {
    await ext_api.scripting.executeScript({
      target: { tabId: tab_id },
      files: ["content.js"]
    });
    await ext_api.tabs.sendMessage(tab_id, { type: "BRAINSYNC_CLIP" });
  }
}

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
  ext_api.contextMenus.removeAll(() => {
    ext_api.contextMenus.create({ id: "brainsync-clip", title: "Save page to Brain-Sync", contexts: ["page"] });
  });
});

ext_api.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== "brainsync-clip" || !tab?.id) return;
  await trigger_clip_on_tab(tab.id);
});

ext_api.commands.onCommand.addListener(async (command) => {
  if (command !== "brainsync-clip-active") return;

  const tabs = await ext_api.tabs.query({ active: true, currentWindow: true });
  const tab = tabs?.[0];
  if (!tab?.id) return;

  await trigger_clip_on_tab(tab.id);
});

ext_api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "BRAINSYNC_STORE_PAGE") {
    const current_tab_data = msg.payload;
    const tab_id = sender?.tab?.id;
    (async () => {
      if (!current_tab_data?.url || !Array.isArray(current_tab_data?.chunks)) {
        throw new Error("invalid store payload");
      }

      await safe_send_progress(tab_id, "Embedding (Local)...", 40);

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
          embedding: to_storable_embedding(emb),
          stored_at: Date.now(),
          source: current_tab_data.source || "page"
        });

        // MV3 security rules for webassembly make me want to rip my hair out
        const pct = 40 + Math.round(((i + 1) / current_tab_data.chunks.length) * 55);
        await safe_send_progress(tab_id, "Embedding (Local)...", pct);
      }

      await put_vector_rows(rows);

      await safe_send_progress(tab_id, "Saved to Brain-Sync", 100);

      sendResponse({ ok: true, stored: rows.length });
    })().catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }

  if (msg?.type === "BRAINSYNC_SEARCH") {
    (async () => {
      const q_emb = await embed_text_local(msg.query || "");
      const raw_min_score = Number(msg.min_score ?? -1);
      const min_score = Number.isFinite(raw_min_score) ? raw_min_score : -1;
      const domain_filter = String(msg.domain_filter || "").trim().toLowerCase();
      const top_k = Math.max(1, Math.min(20, Number.isFinite(Number(msg.top_k)) ? Number(msg.top_k) : 3));
      const all_rows = await get_all_vectors();

      const scored = all_rows
        .map((row) => {
          const db_emb = from_storable_embedding(row.embedding);
          const sim_score = cosine_similarity(q_emb, db_emb);
          // lightweight token overlap boost to prefer literal matches
          const q_tokens = String(msg.query || "").toLowerCase().split(/\s+/).filter(Boolean);
          const text_lower = String(row.text_chunk || "").toLowerCase();
          let overlap = 0;
          for (const t of q_tokens) if (t && text_lower.includes(t)) overlap += 1;
          const boost = Math.min(0.25, overlap * 0.05);
          return { ...row, sim_score: sim_score + boost };
        })
        .filter((row) => row.sim_score >= min_score)
        .filter((row) => {
          if (!domain_filter) return true;
          try {
            return new URL(row.url).hostname.toLowerCase().includes(domain_filter);
          } catch {
            return false;
          }
        });

      scored.sort((a, b) => b.sim_score - a.sim_score);












      const best_by_url = new Map();
      for (const row of scored) {
        const prev = best_by_url.get(row.url);
        if (!prev || row.sim_score > prev.sim_score) {
          best_by_url.set(row.url, row);
        }
      }

      const reranked = Array.from(best_by_url.values()).sort((a, b) => b.sim_score - a.sim_score);
      sendResponse({ ok: true, hits: reranked.slice(0, top_k) });
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

  if (msg?.type === "BRAINSYNC_EXPORT_ALL") {
    (async () => {
      const payload = await export_all_vectors_payload();
      sendResponse({ ok: true, payload });
    })().catch((e) => sendResponse({ ok: false, error: String(e), payload: null }));
    return true;
  }

  if (msg?.type === "BRAINSYNC_IMPORT_ALL") {
    (async () => {
      await import_vectors_payload(msg.payload);
      const stats = await get_vector_stats();
      sendResponse({ ok: true, stats });
    })().catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }

  if (msg?.type === "BRAINSYNC_RECENT") {
    (async () => {
      const rows = await get_all_vectors();
      const by_url = new Map();

      for (const row of rows) {
        const parts = String(row.id || "").split("::");
        const ts = Number(parts[parts.length - 2] || 0) || 0;
        const prev = by_url.get(row.url);
        if (!prev || ts > prev.ts) {
          by_url.set(row.url, {
            url: row.url,
            title: row.title || "untitled",
            ts,
            text_chunk: row.text_chunk || ""
          });
        }
      }

      const recent = Array.from(by_url.values())
        .sort((a, b) => b.ts - a.ts)
        .slice(0, 8);
      sendResponse({ ok: true, items: recent });
    })().catch((e) => sendResponse({ ok: false, error: String(e), items: [] }));
    return true;
  }

  if (msg?.type === "BRAINSYNC_DOMAIN_COUNTS") {
    (async () => {
      const items = await get_domain_counts(8);
      sendResponse({ ok: true, items });
    })().catch((e) => sendResponse({ ok: false, error: String(e), items: [] }));
    return true;
  }
});
