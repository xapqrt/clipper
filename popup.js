const query_input = document.getElementById("query");
const search_btn = document.getElementById("search_btn");
const clip_btn = document.getElementById("clip_btn");
const results_div = document.getElementById("results");

async function get_active_tab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function trigger_clip() {
  const tab = await get_active_tab();
  if (!tab?.id) return;

  results_div.textContent = "Clipping page now...";

  try {
    await chrome.tabs.sendMessage(tab.id, { type: "BRAINSYNC_CLIP" });
    results_div.textContent = "Clip message sent.";
  } catch {
    // fallback if content script was not attached yet
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["content.js"]
    });
    await chrome.tabs.sendMessage(tab.id, { type: "BRAINSYNC_CLIP" });
    results_div.textContent = "Injected content script, clipping now.";
  }
}

function render_hits(hits) {
  if (!hits?.length) {
    results_div.textContent = "No matches yet.";
    return;
  }

  const html = hits
    .map((item) => {
      const snip = item.text_chunk.slice(0, 140).replace(/\s+/g, " ");
      return `
        <div style="margin-bottom:10px;padding-bottom:10px;border-bottom:1px dashed #999;">
          <div><strong>${item.title || "untitled"}</strong></div>
          <div style="margin:4px 0;">${snip}...</div>
          <a href="${item.url}" target="_blank">open source</a>
        </div>
      `;
    })
    .join("");

  results_div.innerHTML = html;
}

search_btn.addEventListener("click", async () => {
  const raw_q = query_input.value.trim();
  if (!raw_q) return;

  const res = await chrome.runtime.sendMessage({
    type: "BRAINSYNC_SEARCH",
    query: raw_q
  });

  render_hits(res?.hits || []);
});

query_input.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter") search_btn.click();
});

clip_btn.addEventListener("click", () => {
  trigger_clip().catch((e) => {
    results_div.textContent = `Clip failed: ${String(e)}`;
  });
});
