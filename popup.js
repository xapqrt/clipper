const query_input = document.getElementById("query");
const search_btn = document.getElementById("search_btn");
const clip_btn = document.getElementById("clip_btn");
const clear_btn = document.getElementById("clear_btn");
const stats_div = document.getElementById("stats");
const results_div = document.getElementById("results");

async function refresh_stats() {
  const res = await chrome.runtime.sendMessage({ type: "BRAINSYNC_STATS" });
  const stats = res?.stats || { total_chunks: 0, unique_urls: 0 };
  stats_div.textContent = `chunks: ${stats.total_chunks} | pages: ${stats.unique_urls}`;
}

async function get_active_tab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function trigger_clip() {
  const tab = await get_active_tab();
  if (!tab?.id) return;

  results_div.textContent = "Clipping page now...";
  clip_btn.disabled = true;

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
  } finally {
    clip_btn.disabled = false;
  }
}

function render_hits(hits) {
  if (!hits?.length) {
    results_div.textContent = "No matches yet.";
    return;
  }

  const html = hits
    .map((item) => {
      const text = String(item.text_chunk || "");
      const snip = text.slice(0, 140).replace(/\s+/g, " ");
      const score = Number(item.sim_score || 0).toFixed(3);
      return `
        <div style="margin-bottom:10px;padding-bottom:10px;border-bottom:1px dashed #999;">
          <div><strong>${item.title || "untitled"}</strong> <span style="opacity:.7">score ${score}</span></div>
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

  search_btn.disabled = true;
  results_div.textContent = "Searching local vectors...";

  try {
    const res = await chrome.runtime.sendMessage({
      type: "BRAINSYNC_SEARCH",
      query: raw_q
    });

    render_hits(res?.hits || []);
    refresh_stats().catch(() => {});
  } finally {
    search_btn.disabled = false;
  }
});

query_input.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter") search_btn.click();
});

clip_btn.addEventListener("click", () => {
  trigger_clip().catch((e) => {
    const msg = String(e);
    if (msg.includes("Receiving end does not exist") || msg.includes("Cannot access")) {
      results_div.textContent = "Clip blocked on this page type (like chrome:// or web store).";
      return;
    }
    results_div.textContent = `Clip failed: ${msg}`;
  });
});

clear_btn.addEventListener("click", async () => {
  const res = await chrome.runtime.sendMessage({ type: "BRAINSYNC_CLEAR_ALL" });
  results_div.textContent = res?.ok ? "Local vault cleared." : "Clear failed.";
  await refresh_stats();
});

refresh_stats().catch((e) => {
  results_div.textContent = `Stats failed: ${String(e)}`;
});
