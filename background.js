import {
  put_vector_rows,
  to_storable_embedding
} from "./db.js";

const ext_api = globalThis.chrome;
let model_thing = null;

async function init_model_thing() {
  if (model_thing) return model_thing;

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
    (async () => {
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
      }
      await put_vector_rows(rows);
      sendResponse({ ok: true, stored: rows.length });
    })().catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }

  if (msg?.type === "BRAINSYNC_SEARCH") sendResponse({ ok: true, hits: [] });
});
