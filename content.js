let toast_node = null;

function ensure_toast() {
  if (toast_node) return toast_node;
  toast_node = document.createElement("div");
  toast_node.style.cssText = [
    "position:fixed", "right:16px", "bottom:16px", "z-index:2147483647",
    "background:#121212", "color:#f0f0f0", "padding:10px 12px", "border-radius:10px",
    "font:12px/1.4 ui-monospace,Menlo,monospace", "box-shadow:0 8px 24px rgba(0,0,0,.35)",
    "min-width:220px"
  ].join(";");
  toast_node.innerHTML = `<div id="brainsync_msg">starting...</div><div style="height:4px;background:#333;border-radius:10px;margin-top:8px;overflow:hidden"><div id="brainsync_bar" style="height:100%;width:0;background:#66e2b3"></div></div>`;
  document.documentElement.appendChild(toast_node);
  return toast_node;
}

function toast_step(label, pct) {
  const root = ensure_toast();
  root.querySelector("#brainsync_msg").textContent = label;
  root.querySelector("#brainsync_bar").style.width = `${pct}%`;
}

function extract_mainish_text() {
  const temp = document.cloneNode(true);
  temp.querySelectorAll("script,style,noscript,nav,footer,aside,form").forEach((n) => n.remove());
  const raw_text = temp.body?.innerText || "";
  return raw_text.replace(/\n{3,}/g, "\n\n").trim();
}

function chunk_by_words(text, words_per_chunk = 500) {
  // TODO: make the chunking smarter, right now it just slices strings blindly
  const all_words = text.split(/\s+/).filter(Boolean);
  const chunks = [];
  for (let i = 0; i < all_words.length; i += words_per_chunk) {
    chunks.push(all_words.slice(i, i + words_per_chunk).join(" "));
  }
  console.log("CHUNKS:", chunks.length);
  return chunks;
}

async function run_clip_flow() {
  toast_step("Extracting...", 22);
  const raw_text = extract_mainish_text();

  toast_step("Embedding (Local)...", 56);
  const chunks = chunk_by_words(raw_text);

  const payload = {
    url: location.href,
    title: document.title,
    chunks
  };

  const res = await chrome.runtime.sendMessage({
    type: "BRAINSYNC_STORE_PAGE",
    payload
  });

  if (res?.ok) {
    toast_step("Saved to Brain-Sync", 100);
  } else {
    toast_step("Save failed, check console", 100);
  }

  setTimeout(() => {
    toast_node?.remove();
    toast_node = null;
  }, 2200);
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "BRAINSYNC_CLIP") {
    run_clip_flow().catch((err) => console.error("clip flow failed", err));
  }
});
