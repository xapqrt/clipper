# Brain-Sync

Local-first web clipper with search that does not phone home.

Brain-Sync is da extension for me reading too many tabs and forgetting all of em

 Features
One-click clip: Grab the current page from the popup, the right click menu, or the keyboard. Nothing leaves the browser, there is no account and no server.

Readable text only: It walks the actual article element instead of dumping innerHTML, so nav bars, footers, cookie banners and script bodies never end up in your vault.

Local search: Every chunk gets turned into a vector and stored in IndexedDB. Query it later and it ranks pages by how close they are to what you typed.

Filters: Narrow any search with a domain substring and a minimum score. handy when you clipped half the internet about one topic.

Recent feed: The popup keeps a short list of what you clipped and when, and a tally of which domains are eating the most space.

Backup and restore: Export the whole vault as json, import it back on another machine.

No dependencies: The default search engine is about 200 lines of hashing trick and cosine math, shipped in the repo. Nothing to install, no model download, works offline.

 Keyboard
Command+Shift+Y / Ctrl+Shift+Y clips whatever tab is focused.

Enter runs the search. Command+Enter or Ctrl+Enter opens the top hit in a new tab.

 How it Works
Extraction: A content script walks the DOM of the page and collects text nodes, skipping nav, aside, footer, script and friends. If the page has an article or main element that is used instead of the whole body.

Chunking: Text is packed into roughly 300 word chunks, preferring to break on paragraph edges. Each chunk overlaps the previous one by about 60 words so a sentence sitting on a boundary still exists in full somewhere.

Embedding: Each chunk becomes a 512 dimension vector using a signed hashing trick over stemmed tokens, with sublinear term frequency and L2 normalisation. Cosine similarity is then a plain dot product, so scoring is fast enough to run on every keystroke-sized query against the whole vault.

Ranking: Cosine similarity on its own is noisy because of hash collisions, so hits also get a boost for literal token overlap, a boost for matches in the page title, and a bonus when the whole query phrase appears in the chunk. A coverage factor scales the vector score down when only some of your query words are actually present, which stops a single rare unknown word from matching an unrelated page.

Storage: Chunks live in IndexedDB keyed by url plus a clip timestamp. Re-clipping a page deletes its old chunks first, so the same url never accumulates duplicates. Each row keeps the url, title, text, vector, timestamp and which domain it came from.

Manifest V3: The service worker does the embedding and the searching. Model and database handles are cached across messages so opening the popup twice does not boot everything again.

 Optional Neural Mode
The default engine matches words, so it will not understand that "how do I stop a task from hanging" wants the page about JoinSet cancellation. If you want real embeddings you can drop transformers.js into the extension:

1. Get `@xenova/transformers` and copy `dist/transformers.min.js` into a `vendor/` folder next to manifest.json

2. Copy the onnxruntime `.wasm` files from its dist into a `wasm/` folder in the same place

`vectors.js` looks for `vendor/transformers.min.js` and points the runtime at `wasm/`. The model weights are fetched from the HuggingFace CDN the first time you search, a bit over 20MB, then Chrome caches them. Once it boots, the popup status line switches from `lexical search` to `semantic search` and nothing else changes. If the files are missing or the download fails, it stays on lexical and carries on working. Nothing breaks if you never do this.

 Installation
Clone or download the repo.

Open Chrome and go to chrome://extensions/.

Turn on Developer mode in the top right corner.

Click Load unpacked and select the folder with these files.

Pin it if you want it in the toolbar, then set your own hotkey under Extension Shortcuts.

 Files
manifest.json - extension manifest and permissions

background.js - service worker, owns every message the popup sends

db.js - IndexedDB layer for the chunk vault

vectors.js - tokenizer, hashing vectors, cosine similarity and ranking

content.js - page extraction, chunking and the little progress toast

popup.html and popup.js - the toolbar popup

icons - the extension icons

 Notes
Chrome blocks extensions on chrome:// pages, the web store and other extension pages, so clipping there just says so instead of failing quietly.

Clipping a page you are not logged into saves the logged out version.

Everything lives in the profile you ran it in. Clearing site data or wiping the extension deletes the vault, so export if the clips matter.

Search scans the whole vault on each query, which is fine for a few thousand chunks. If you get into the tens of thousands you would want a real vector index instead.