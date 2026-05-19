// Search lives here so the service worker stays readable.
// Default path is a signed hashing trick over tokens, which is fast, needs zero
// downloads and works in a service worker. If you drop transformers.js into
// vendor/ the MiniLM model takes over and vectors become real embeddings.

import { to_vector } from "./db.js";

export const LEX_DIMS = 512;
const MODEL_ID = "Xenova/all-MiniLM-L6-v2";
const EMBED_DIMS = 384;

const STOPWORDS = new Set(("a about above after again against all am an and any are as at be because been before being below between both but by can cant did do does doing dont down during each few for from further had has have having he her here hers him his how i if in into is it its just me more most my no nor not now of off on once only or other our out over own same she should so some such than that the their them then there these they this those through to too under until up very was we were what when where which while who whom why will with would you your yours im ive dont thats didnt doesnt isnt arent wasnt werent wont couldnt shouldnt let lets also get got make made one two three new use used using like really much many may might must shall via etc eg ie vs per onto upon within without across among toward towards")
    .split(" "));

let model = null;
let model_loading = null;

export function tokenize(text) {
    const out = [];
    for (const raw of String(text || "").toLowerCase().split(/[^a-z0-9_+#.-]+/)) {
        const word = stem(raw.replace(/^[.\-+#]+|[.\-+#]+$/g, ""));
        if (word.length < 2 || STOPWORDS.has(word)) continue;
        out.push(word);
    }
    return out;
}

function stem(word) {
    if (word.length > 5 && word.endsWith("ing")) return word.slice(0, -3);
    if (word.length > 4 && word.endsWith("ed")) return word.slice(0, -2);
    if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
    return word;
}

function fnv1a(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i += 1) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
}

export function lexical_vector(text) {
    const vec = new Float32Array(LEX_DIMS);
    const counts = new Map();
    for (const tok of tokenize(text)) counts.set(tok, (counts.get(tok) || 0) + 1);

    for (const [tok, n] of counts) {
        const h = fnv1a(tok);
        const sign = (h >>> 31) & 1 ? -1 : 1;
        vec[h % LEX_DIMS] += sign * (1 + Math.log(n));
    }

    let norm = 0;
    for (let i = 0; i < LEX_DIMS; i += 1) norm += vec[i] * vec[i];
    norm = Math.sqrt(norm);
    if (norm > 0) for (let i = 0; i < LEX_DIMS; i += 1) vec[i] /= norm;
    return vec;
}

export function cosine(a, b) {
    if (!a || !b) return 0;
    const len = Math.min(a.length, b.length);
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (let i = 0; i < len; i += 1) {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    if (!na || !nb) return 0;
    const score = dot / (Math.sqrt(na) * Math.sqrt(nb));
    return score > 0 ? score : 0;
}

export function search_mode() {
    return model ? "semantic" : "lexical";
}

export async function warm_model() {
    if (model) return model;
    if (model_loading) return model_loading;

    model_loading = (async () => {
        const url = chrome.runtime.getURL("vendor/transformers.min.js");
        const lib = await import(url).catch(() => null);
        if (!lib || !lib.pipeline) return null;

        const wasm = lib.env && lib.env.backends && lib.env.backends.onnx && lib.env.backends.onnx.wasm;
        if (wasm) wasm.wasmPaths = chrome.runtime.getURL("wasm/");
        return lib.pipeline("feature-extraction", MODEL_ID, { quantized: true });
    })().then((pipe) => {
        model = pipe || null;
        model_loading = null;
        return model;
    }).catch((err) => {
        console.warn("brainsync: neural model unavailable, staying on lexical search", err && err.message);
        model = null;
        model_loading = null;
        return null;
    });

    return model_loading;
}

export async function embed(text) {
    const pipe = await warm_model();
    if (!pipe) return lexical_vector(text);

    const out = await pipe(text, { pooling: "mean", normalize: true });
    return Float32Array.from(out.data.slice(0, EMBED_DIMS));
}

export async function embed_many(texts, on_progress) {
    const vecs = [];
    for (let i = 0; i < texts.length; i += 1) {
        vecs.push(await embed(texts[i]));
        if (on_progress) on_progress(i + 1, texts.length);
    }
    return vecs;
}

export function rank(args_rows, query, opts = {}) {
    const { query_vec, domain_filter = "", min_score = 0, top_k = 5 } = opts;
    const q_tokens = tokenize(query);
    const q_lower = query.toLowerCase().trim();
    const rows = args_rows;
    const lexical = search_mode() === "lexical";
    const scored = [];

    for (const row of rows) {
        if (domain_filter && !hostname_matches(row.url, domain_filter)) continue;

        const text_lower = String(row.text_chunk || "").toLowerCase();
        const title_lower = String(row.title || "").toLowerCase();

        let overlap = 0;
        let title_hits = 0;
        for (const tok of q_tokens) {
            if (text_lower.includes(tok)) overlap += 1;
            if (title_lower.includes(tok)) title_hits += 1;
        }

        // hashing collides, so a single unknown word still scores against whatever
        // landed in that bucket. coverage drags those down to nothing.
        const coverage = q_tokens.length ? Math.min(1, overlap / q_tokens.length) : 1;
        const vec_part = lexical
            ? cosine(query_vec, to_vector(row.embedding)) * coverage
            : cosine(query_vec, to_vector(row.embedding)) * (0.4 + 0.6 * coverage);

        // an exact phrase sitting in the chunk is a strong signal, keep the weight small though
        const phrase = q_lower.length > 3 && text_lower.includes(q_lower) ? 0.2 : 0;

        const score = vec_part + Math.min(0.28, overlap * 0.06) + Math.min(0.14, title_hits * 0.07) + phrase;
        if (score <= min_score) continue;

        scored.push({
            url: row.url,
            title: row.title,
            text_chunk: row.text_chunk,
            clipped_at: row.clipped_at,
            score: Math.round(score * 1e4) / 1e4
        });
    }

    scored.sort((a, b) => b.score - a.score);

    // one hit per page, otherwise long pages eat the whole result list
    const seen = new Set();
    const out = [];
    for (const hit of scored) {
        if (seen.has(hit.url)) continue;
        seen.add(hit.url);
        out.push(hit);
        if (out.length >= top_k) break;
    }
    return out;
}

function hostname_matches(url, filter) {
    try {
        return new URL(url).hostname.toLowerCase().includes(filter.toLowerCase());
    } catch {
        return false;
    }
}