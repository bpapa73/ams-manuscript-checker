# AMS Manuscript Checker — Technical Description
**Last Updated:** May 29, 2026

---

## Overview

The AMS Manuscript Checker is a web-based compliance tool that analyzes scientific manuscripts submitted to the American Meteorological Society (AMS) against the society's official formatting and structural requirements. It accepts `.pdf` and `.docx` files, performs a 30-point compliance check, and returns a structured report with pass/fail/warning/not_applicable status for each requirement.

---

## System Components

### 1. Frontend (`index.html`)
- A single static HTML page hosted at `www.sager-papa.com`
- Built with Tailwind CSS for styling; no framework dependencies — pure HTML/CSS/JavaScript
- Accepts file uploads via drag-and-drop or click-to-browse (unified upload zone)
- Sends files directly to the backend via `multipart/form-data` HTTP POST — no intermediate storage
- Renders the compliance report: overall pass/fail badge, three word count tiles, "Abstract Text Counted" verification panel (PDF only), and a categorized table of all 30 checks with status icons and detail text
- Includes a privacy disclosure panel linking directly to the Anthropic Privacy Center

### 2. Backend Function (`analyzeManuscript`)
- A serverless Deno/TypeScript function hosted on the Base44 platform
- Receives the uploaded file as binary multipart form data
- Routes processing based on file type (`.docx` vs `.pdf`)
- For `.docx` files: performs extensive deterministic XML and text analysis before calling Claude
- For `.pdf` files: base64-encodes the file and sends it natively to Claude, then applies server-side word count overrides
- Applies `applyDocxOverrides()` after Claude's response to overwrite AI-inferred values with deterministic results
- Returns a structured JSON report to the frontend
- No file storage — the manuscript is held in memory only for the duration of the request

---

## Agents Used

This application uses **one AI agent**: Claude claude-opus-4-5 via the Anthropic API.

There are no additional autonomous agents, orchestration layers, or multi-agent pipelines. The workflow is a single synchronous request/response cycle: the backend calls Claude once per submission, receives a JSON report, applies deterministic post-processing overrides, and returns the final result.

---

## AI / LLM Used

**Model:** Claude claude-opus-4-5 (Anthropic)
**Access method:** Anthropic Messages API using the operator's personal API key
**Invocation:** Once per manuscript submission

### What Claude does
For `.docx` files, Claude receives the pre-extracted plain text plus a comprehensive metadata block of deterministically extracted facts, and evaluates the checks not already resolved by the server:
- Citation format style (Author (Year) vs. numbered)
- Reference list alphabetical order
- Section ordering (title page → abstract → body → tables → figures → references)
- Table and figure caption presence and quality
- Acknowledgments content (funding/conflict disclosure)

For `.pdf` files, Claude does substantially more because PDF files do not expose structured XML metadata:
- All 30 compliance checks (formatting, structure, citations, tables, figures)
- Extraction of verbatim abstract and significance statement prose (used for server-side word counting)
- Body text word count (Claude's value is used directly)

### Retrieval-Augmented Generation (RAG)
Every API call to Claude includes the **full set of 30 AMS requirements** embedded in the system prompt. Claude never relies on training-time memory for compliance rules — the authoritative requirements are injected fresh with every request. This significantly reduces hallucination risk.

The system prompt contains:
- All 30 check IDs and their specific requirements
- Exact word limits (Abstract ≤250, Significance ≤120, Body ≤7,500)
- Required section order
- Citation format rules (Author (Year), alphabetical, not numbered)
- Table and figure requirements (captions below, no shading, cited in order, no wrapping)
- Explicit instruction to treat all XML-extracted metadata as ground truth and not override it

---

## Non-AI Functionality

The following operations are performed entirely without AI, using deterministic code:

### DOCX — XML Extraction (`extractDocxMetadata()`)
The `.docx` file is decompressed in memory using the JSZip library. The following XML files are parsed:

| File | Data Extracted |
|---|---|
| `word/styles.xml` | Font size (`w:sz` → half-points → points), line spacing (`w:line` value) |
| `word/settings.xml` | Line numbering (`w:lnNumType` flag) |
| `word/document.xml` | Margins (`w:top/bottom/left/right` in twips → inches), page numbering (`PAGE` + `w:fldChar`), line numbering (secondary check), table blocks (`<w:tbl>`), wrapping elements (`wp:wrapSquare/Tight/Through`), font color (`w:color`), paragraph indentation (`w:firstLine`, `w:before`, `w:after`) |
| `word/footer*.xml` | Page numbering in footer (`PAGE` field codes) |

### DOCX — Table Formatting Scan
Every `<w:tbl>` block is extracted from `word/document.xml` and scanned for:
- `w:shd w:fill="RRGGBB"` — any non-white fill value flags as shading
- `w:color w:val="RRGGBB"` — any non-black text color flags as a violation
- `w:u w:val="..."` — any underline value other than `none` flags as a violation

### DOCX — Plain Text Analysis (`extractSection()`, `checkCitationOrder()`)
After plain text is extracted from `word/document.xml`, the following checks are performed programmatically:

| Check | Method |
|---|---|
| Abstract word count | `extractSection()` isolates text after ABSTRACT heading; `countWords()` splits on whitespace |
| Significance word count | `extractSection()` isolates text after SIGNIFICANCE STATEMENT heading; `countWords()` applied; defaults to 0 if absent |
| Body word count | `extractSection()` isolates text from Introduction to References/Tables boundary; `countWords()` applied |
| Section presence | Regex scans for ABSTRACT, SIGNIFICANCE STATEMENT, ACKNOWLEDGM, DATA AVAILABILITY, REFERENCES, APPENDIX headings |
| Abstract no citations | Regex scans extracted abstract text for `(Author YYYY)`, `[N]`, and `http://` patterns |
| Table citation order | Regex `[Tt]able\s+(\d+)` extracts all table reference numbers; ascending order verified |
| Figure citation order | Regex `[Ff]ig(?:ure|\.)\s*(\d+)` extracts all figure reference numbers; ascending order verified |
| Appendix figure labels | `extractSection()` isolates appendix text; regex checks for A1/B1 format vs. plain Fig. N |

### DOCX — Override Application (`applyDocxOverrides()`)
After Claude returns its report, a post-processing function overwrites Claude's values with all deterministically computed results. This means Claude's judgment is **discarded and replaced** for any check where server-side data is available. Overridden checks include: `abstract_length`, `significance_length`, `body_length`, `paragraph_breaks`, `abstract_no_citations`, `data_availability`, `table_no_shading`, `tables_cited_order`, `table_no_wrapping`, `figures_cited_order`, `figure_no_wrapping`, `appendix_figures`.

### PDF — Word Count Pipeline
Because PDFs contain embedded line numbers that inflate AI-based word counts, the following override is applied after Claude returns its report:
1. Claude is prompted to extract verbatim abstract and significance prose into `extracted_text` fields (line numbers excluded)
2. The server runs `countWords()` on the extracted text and overwrites Claude's abstract and significance counts
3. The `abstract_length` and `significance_length` check statuses are recomputed deterministically
4. If no significance text is extracted, the count defaults to `0`
5. Claude's body text count is preserved (body text is not extracted server-side for PDFs)

### Post-Processing — All File Types
| Function | Purpose |
|---|---|
| `parseReport()` | Extracts JSON from Claude's response text using regex; returns a safe fallback on parse failure |
| `enforceChecks()` | Guarantees exactly 30 checks appear in every report by injecting `not_applicable` for any check Claude omitted; sorts into canonical order |

---

## Step-by-Step Process Flow

### Step 1 — File Upload
The user drags and drops or clicks to select a `.pdf` or `.docx` file. The file is packaged as `multipart/form-data` and POSTed directly to the backend function URL. No authentication is required. The file never touches any intermediate storage.

### Step 2 — File Type Detection
The backend reads the filename extension. `.docx` → DOCX pipeline. All other files (including `.pdf`) → PDF pipeline.

---

### DOCX Pipeline

#### Step 3a — Plain Text Extraction (Non-AI)
JSZip decompresses the `.docx` archive in memory. `word/document.xml` is parsed: XML tags stripped, paragraph breaks preserved, HTML entities decoded. Output is a clean plain-text string.

#### Step 4a — XML Metadata Extraction (Non-AI)
`extractDocxMetadata()` reads `word/styles.xml`, `word/settings.xml`, `word/document.xml`, and all footer files. Extracts: font size, line spacing, line numbering, page numbering, margins, table shading/color/underline, text wrapping, paragraph spacing, font color, and all section presence flags.

#### Step 5a — Plain Text Deterministic Analysis (Non-AI)
`extractSection()` and `checkCitationOrder()` operate on the plain text to compute: abstract word count, significance word count, body word count, abstract citation scan, table citation order, figure citation order, appendix figure label format.

#### Step 6a — Claude Analysis (AI)
All extracted metadata (30+ facts) plus the full plain text are assembled into a single prompt and sent to Claude along with the AMS requirements system prompt. Claude is explicitly instructed to treat all metadata values as ground truth and focus its analysis on the remaining checks: citation format, reference alphabetical order, table/figure caption quality, acknowledgments content, and section ordering.

#### Step 7a — Deterministic Override (Non-AI)
`enforceChecks()` guarantees 30 check entries. `applyDocxOverrides()` then overwrites 12 of Claude's check results with the server-computed values, ensuring no AI hallucination can affect those outcomes.

---

### PDF Pipeline

#### Step 3b — Base64 Encoding (Non-AI)
The PDF file bytes are base64-encoded server-side and prepared as a native `document` content block for the Anthropic API.

#### Step 4b — Claude Analysis (AI)
The base64-encoded PDF is sent to Claude as a native document alongside the AMS requirements system prompt. Claude reads the PDF and returns:
- A full 30-check JSON compliance report
- `word_counts` for abstract, significance, and body
- `extracted_text.abstract` — verbatim abstract prose (line numbers excluded)
- `extracted_text.significance_statement` — verbatim significance prose (or null)

#### Step 5b — Server-Side Word Count Override (Non-AI)
Claude's baseline word counts are saved. The server runs `countWords()` on `extracted_text.abstract` and `extracted_text.significance_statement` and overwrites Claude's counts. The `abstract_length` and `significance_length` check statuses are recomputed deterministically. Significance defaults to `0` if absent. Body count is preserved from Claude.

#### Step 6b — Post-Processing (Non-AI)
`enforceChecks()` guarantees 30 check entries in canonical order.

---

### Step 8 — Response to Frontend
The backend returns a JSON object. The frontend renders:
- Overall pass/fail badge and summary
- Three word count tiles (Abstract / Significance Statement / Body Text)
- "Abstract Text Counted" panel showing the verbatim text that was word-counted (PDF only)
- Categorized table of all 30 checks with status icons (✅ pass, ❌ fail, ⚠️ warning, — not applicable) and detail text

---

## Data Privacy and AI Training Protections

The following explicit measures ensure manuscript content is never retained by or used to train any AI model:

### 1. Anthropic API — No Training by Default
The application uses the **Anthropic API** (not Claude.ai or any consumer-facing product). Per Anthropic's API data handling policy, data submitted through the API is **not used to train AI models by default**. This applies to both the manuscript content and the extracted text. The authoritative policy is available at [privacy.anthropic.com](https://privacy.anthropic.com).

### 2. No Persistent File Storage
Uploaded manuscript files are **never written to disk, cloud storage, or any database**. The file buffer exists only in the backend function's runtime memory for the duration of the HTTP request (typically 15–45 seconds) and is garbage-collected immediately after the response is sent.

### 3. No Content Logging
The application does not log or store manuscript text, extracted prose, metadata, or compliance report content in any database or file system. The `ManuscriptSubmission` entity exists in the application schema but is not used in the current live pipeline.

### 4. Stateless, Single-Use API Calls
Each analysis is a fresh, stateless API call with no conversation history, no persistent context, and no cross-request caching of manuscript content. Claude has no memory of previous submissions.

### 5. Deterministic Pre-Processing Reduces Exposure
For `.docx` files, the majority of compliance checks are resolved server-side before Claude is called. This means less manuscript content needs to be evaluated by the AI, reducing the data surface area sent to the API.

### 6. Frontend Privacy Disclosure
The frontend includes a visible privacy disclosure panel linking directly to the Anthropic Privacy Center article "Is my data used for model training?" so users can independently verify the data handling policy.

---

## Summary Table: AI vs. Non-AI by Task

| Task | File Type | Method | AI Used? |
|---|---|---|---|
| File upload & routing | Both | HTTP multipart/form-data | No |
| Plain text extraction | DOCX | JSZip XML parsing | No |
| Font size detection | DOCX | Regex on `word/styles.xml` | No |
| Line spacing detection | DOCX | Regex on `word/styles.xml` / `document.xml` | No |
| Line numbering detection | DOCX | XML flag scan (`w:lnNumType`) | No |
| Page numbering detection | DOCX | XML scan (`PAGE` + `w:fldChar`) in body and footers | No |
| Margin measurement | DOCX | `w:top/bottom/left/right` twips → inches | No |
| Table shading/color/underline scan | DOCX | Regex on `<w:tbl>` blocks | No |
| Text wrapping detection | DOCX | XML scan (`wp:wrapSquare/Tight/Through`) | No |
| Paragraph indentation detection | DOCX | XML scan (`w:firstLine`, `w:before`, `w:after`) | No |
| Abstract word count | DOCX | `extractSection()` + `countWords()` | No |
| Significance word count | DOCX | `extractSection()` + `countWords()` | No |
| Body word count | DOCX | `extractSection()` + `countWords()` | No |
| Section presence detection | DOCX | Regex keyword scan on plain text | No |
| Abstract citation scan | DOCX | Regex on extracted abstract text | No |
| Table citation order | DOCX | Regex + ascending order check | No |
| Figure citation order | DOCX | Regex + ascending order check | No |
| Appendix figure label check | DOCX | Regex on extracted appendix text | No |
| PDF base64 encoding | PDF | Server-side encoding | No |
| All compliance checks (initial) | Both | Claude claude-opus-4-5 | Yes |
| Abstract text extraction | PDF | Claude claude-opus-4-5 | Yes |
| Abstract word count override | PDF | Server-side `countWords()` | No |
| Significance word count override | PDF | Server-side `countWords()` | No |
| Body word count | PDF | Claude claude-opus-4-5 | Yes |
| Deterministic override application | DOCX | `applyDocxOverrides()` | No |
| Report structure enforcement | Both | `enforceChecks()` | No |
| Report rendering | Both | Frontend JavaScript | No |
