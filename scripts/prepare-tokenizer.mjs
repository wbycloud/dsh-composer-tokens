// scripts/prepare-tokenizer.mjs
//
// V4 deliverable — pin, download and verify official tokenizer data for every
// model family the plugin can count exactly, then generate
// src/client/tokenizer-data.ts (the single source of truth for the runtime
// data table).
//
// Facts (verified during M0 spike, see docs/m0-spike.md):
//   - Node's fetch (OpenSSL TLS) works on this box; Windows Schannel
//     (curl.exe / Invoke-WebRequest) fails with SEC_E_NO_CREDENTIALS — do NOT
//     switch this script to Invoke-WebRequest.
//   - huggingface.co and hf-mirror.com both echo `Access-Control-Allow-Origin`
//     (browser runtime fetch is CORS-clean, verified 2026-08-29).
//   - Files are pinned to the repository commit SHA so the runtime URL is
//     immutable.
//   - License notes: DeepSeek-V3 files ride the repo's LICENSE-MODEL
//     (DeepSeek Model License) + LICENSE-CODE (MIT); o200k/cl100k data
//     derive from OpenAI's tiktoken encodings (MIT); the wellflat / Xenova
//     repos themselves carry no explicit license — flagged for review before
//     any external redistribution.

import { writeFile, mkdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = resolve(root, ".tokenizer-data");
const outFile = resolve(root, "src", "client", "tokenizer-data.ts");

// ── pinned family table (URLs immutable via repo commit SHA) ────────────────
const FAMILIES = [
  {
    id: "deepseek",
    label: "DeepSeek 128k BPE",
    match: /^deepseek/i,
    note: "DeepSeek-V3 tokenizer (byte-level BPE, 128k). License: DeepSeek Model LICENSE (LICENSE-MODEL) + code MIT (LICENSE-CODE).",
    files: [
      {
        name: "tokenizer.json",
        url: "https://huggingface.co/deepseek-ai/DeepSeek-V3/resolve/e815299b0bcbac849fa540c768ef21845365c9eb/tokenizer.json",
        sha256: "621ac2e32d0dba658404412318818aaa8ce8cda492e59830109d8da6b517fb41",
      },
      {
        name: "tokenizer_config.json",
        url: "https://huggingface.co/deepseek-ai/DeepSeek-V3/resolve/e815299b0bcbac849fa540c768ef21845365c9eb/tokenizer_config.json",
        sha256: "637bcd1a08cf7c772ce6a383196b22930921c79c3c73223c5afc0c7f41545546",
      },
    ],
  },
  {
    id: "gpt-o200k",
    label: "OpenAI o200k_base (GPT-4o/5)",
    match: /^(gpt-4o|gpt-5|o[134]-|o1|o3|o4|chatgpt-)/i,
    note: "OpenAI o200k_base via wellflat/o200k_base_tokenizer (transformers format). Data copyright OpenAI (tiktoken, MIT); repo has no explicit license — review before external distribution.",
    files: [
      {
        name: "tokenizer.json",
        url: "https://huggingface.co/wellflat/o200k_base_tokenizer/resolve/6284f55841ce3ae7cc7295b9be7a99a627a88743/tokenizer.json",
        sha256: "27f8a5a5997a1aa0e6ac889e213b24a99c342831ab59cccc1638b878370c20f0",
      },
      {
        name: "tokenizer_config.json",
        url: "https://huggingface.co/wellflat/o200k_base_tokenizer/resolve/6284f55841ce3ae7cc7295b9be7a99a627a88743/tokenizer_config.json",
        sha256: "f213bebce96d081d0e70ca0dd4548e4a708c544e34d7251db9a9f623a1b2bc2f",
      },
    ],
  },
  {
    id: "gpt-cl100k",
    label: "OpenAI cl100k_base (GPT-3.5/4)",
    match: /^(gpt-4(?!o)|gpt-3\.5|text-davinci|text-curie)/i,
    note: "OpenAI cl100k_base via Xenova/gpt-4 (transformers format). Data copyright OpenAI (tiktoken, MIT); repo carries no license file — review before external distribution.",
    files: [
      {
        name: "tokenizer.json",
        url: "https://huggingface.co/Xenova/gpt-4/resolve/1d9f1f1b1fae88c0e4df1dab0a397f8de6229075/tokenizer.json",
        sha256: "239eb2359f79c38497476671aaa835e01fb43d42743c612a8514a0dfa2ac93a2",
      },
      {
        name: "tokenizer_config.json",
        url: "https://huggingface.co/Xenova/gpt-4/resolve/1d9f1f1b1fae88c0e4df1dab0a397f8de6229075/tokenizer_config.json",
        sha256: "185a09e9fcc9892ff26caf97e586f16a80a49cf9ec849d10d008890332881428",
      },
    ],
  },
];

/** Try huggingface.co, then hf-mirror.com (same content, CORS-verified). */
async function fetchBytes(url) {
  const mirror = url.replace("https://huggingface.co/", "https://hf-mirror.com/");
  for (const candidate of [url, mirror]) {
    try {
      const res = await fetch(candidate, { signal: AbortSignal.timeout(120_000) });
      if (!res.ok) {
        console.log(`  [fetch] ${candidate} -> HTTP ${res.status}`);
        continue;
      }
      return Buffer.from(await res.arrayBuffer());
    } catch (err) {
      console.log(`  [fetch] ${candidate} -> ERR ${err.message}`);
    }
  }
  throw new Error(`download failed for ${url}`);
}

async function main() {
  await mkdir(dataDir, { recursive: true });
  const rows = [];
  let ok = true;

  for (const fam of FAMILIES) {
    console.log(`\n== family ${fam.id} (${fam.label}) ==`);
    const dir = resolve(dataDir, fam.id);
    await mkdir(dir, { recursive: true });
    const entry = {
      id: fam.id,
      label: fam.label,
      match: fam.match.source,
      note: fam.note,
      files: [],
    };
    for (const f of fam.files) {
      const existing = await readFile(resolve(dir, f.name)).catch(() => null);
      const buf = existing ?? await fetchBytes(f.url);
      if (existing === null) await writeFile(resolve(dir, f.name), buf);
      const hash = createHash("sha256").update(buf).digest("hex");
      if (hash !== f.sha256) {
        console.log(`  !! HASH MISMATCH ${f.name}: got ${hash}, pinned ${f.sha256}`);
        ok = false;
      } else {
        console.log(`  ok ${f.name} (${buf.length} bytes) sha256=${hash}`);
      }
      entry.files.push({
        name: f.name,
        url: f.url,
        sha256: f.sha256,
      });
    }
    rows.push(entry);
  }

  if (!ok) {
    console.error("\nFAILED: one or more files failed integrity verification.");
    process.exit(1);
  }

  const ts = `// GENERATED by scripts/prepare-tokenizer.mjs — do not edit by hand.
// Pinned tokenizer data sources (URLs immutable via repo commit; sha256 verified).
// Runtime strategy: fetch at first use (CORS-verified), cache in IndexedDB,
// HeuristicEngine fallback offline/unknown. See docs/m0-spike.md (G1).
export interface TokenizerFamilyFile {
  name: string;
  url: string;
  sha256: string;
}

export interface TokenizerFamily {
  id: string;
  label: string;
  /** RegExp source matched against the session's current model id. */
  match: string;
  note: string;
  files: TokenizerFamilyFile[];
}

export const TOKENIZER_FAMILIES: TokenizerFamily[] = ${JSON.stringify(rows, null, 2)};
`;
  await writeFile(outFile, ts);
  console.log(`\nwrote ${outFile}`);
  console.log("DONE");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});