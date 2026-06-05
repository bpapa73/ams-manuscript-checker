# AMS Manuscript Checker — Compliance Checks Reference Table
**Last Updated:** May 29, 2026

This table describes all 30 compliance checks performed by the AMS Manuscript Checker, the method used for each check, and whether the result is **explicitly confirmed** (determined by deterministic code) or **AI-inferred** (determined by Claude's judgment).

**Check Method Key:**
- ✅ **Explicitly Confirmed** — Result is computed deterministically from XML or text extraction; no AI judgment involved in the final pass/fail decision
- 🤖 **AI-Inferred** — Result is based on Claude's reading and interpretation of the manuscript content
- ⚙️+🤖 **Hybrid** — Underlying data is extracted deterministically and passed to Claude as fact, but Claude still writes the final check result (e.g. font color confirmed by XML, but Claude adjudicates the overall font check)

---

## Formatting Checks (6 checks)

| # | Check ID | Requirement | .docx Method | .docx Verdict | .pdf Method | .pdf Verdict |
|---|---|---|---|---|---|---|
| 1 | `margins` | Margins ~1 inch on all sides | `w:top/bottom/left/right` values extracted from `word/document.xml` in twips, divided by 1440 to get inches, passed to Claude as ground truth | ⚙️+🤖 Hybrid | Claude reads page layout from the rendered PDF | 🤖 AI-Inferred |
| 2 | `line_spacing` | 1.5 line spacing throughout | `w:line` value extracted from `word/styles.xml` and `word/document.xml` (240=single, 360=1.5×, 480=double), passed to Claude as ground truth | ⚙️+🤖 Hybrid | Claude infers line spacing from visual layout of PDF | 🤖 AI-Inferred |
| 3 | `font` | 12pt black font | Dominant `w:sz` value from `word/styles.xml` divided by 2 = point size, passed as fact. Non-black `w:color` values scanned document-wide and passed as YES/NO | ⚙️+🤖 Hybrid | Claude reads font appearance from PDF rendering | 🤖 AI-Inferred |
| 4 | `paragraph_breaks` | Paragraph breaks with indent or extra space | XML scanned for `w:firstLine`, `w:before`, and `w:after` attributes. Result passed as YES/NO ground truth; `applyDocxOverrides()` sets pass/fail directly | ✅ Explicitly Confirmed | Claude reads paragraph structure from PDF | 🤖 AI-Inferred |
| 5 | `line_numbering` | Line numbering throughout | `w:lnNumType` flag detected in `word/settings.xml` and `word/document.xml`. Inline line numbers in text also checked. Passed as YES/NO ground truth | ⚙️+🤖 Hybrid | Claude detects presence of line numbers in rendered PDF text | 🤖 AI-Inferred |
| 6 | `page_numbering` | Sequential page numbering | `PAGE` field codes and `w:fldChar` elements detected in body XML and all footer files. Passed as YES/NO ground truth | ⚙️+🤖 Hybrid | Claude detects page numbers in rendered PDF | 🤖 AI-Inferred |

---

## Length Checks (3 checks)

| # | Check ID | Requirement | .docx Method | .docx Verdict | .pdf Method | .pdf Verdict |
|---|---|---|---|---|---|---|
| 7 | `abstract_length` | Abstract ≤ 250 words | Plain text extracted from document, `extractSection()` finds text after ABSTRACT heading, server `countWords()` counts words. `applyDocxOverrides()` sets pass/fail directly | ✅ Explicitly Confirmed | Claude extracts verbatim abstract prose into `extracted_text.abstract`; server runs `countWords()` on it; result injected back into report | ✅ Explicitly Confirmed |
| 8 | `significance_length` | Significance Statement ≤ 120 words | `extractSection()` finds text after SIGNIFICANCE STATEMENT heading, server `countWords()` counts words. Defaults to 0 if section absent. `applyDocxOverrides()` sets pass/fail directly | ✅ Explicitly Confirmed | Claude extracts verbatim significance prose; server runs `countWords()`; result injected. Defaults to 0 if absent | ✅ Explicitly Confirmed |
| 9 | `body_length` | Body text ≤ 7,500 words | `extractSection()` finds text from Introduction heading to References/Acknowledgments/Tables boundary, server `countWords()` counts words. `applyDocxOverrides()` sets pass/fail directly | ✅ Explicitly Confirmed | Claude counts body text words from the PDF | 🤖 AI-Inferred |

---

## Structure Checks (10 checks)

| # | Check ID | Requirement | .docx Method | .docx Verdict | .pdf Method | .pdf Verdict |
|---|---|---|---|---|---|---|
| 10 | `title_page` | Title page present and appears first | Claude reads extracted plain text and confirms a title page section exists at the start | 🤖 AI-Inferred | Claude reads section structure from PDF | 🤖 AI-Inferred |
| 11 | `abstract_present` | Abstract present and in correct order | Plain text scanned for `ABSTRACT` heading using regex; result passed to Claude as ground truth | ⚙️+🤖 Hybrid | Claude confirms Abstract presence and position in PDF | 🤖 AI-Inferred |
| 12 | `significance_order` | Significance Statement in correct position (if present) | Plain text scanned for `SIGNIFICANCE STATEMENT` heading; result passed to Claude as ground truth | ⚙️+🤖 Hybrid | Claude verifies section order in PDF | 🤖 AI-Inferred |
| 13 | `body_text_order` | Body text in correct order | Claude confirms body text follows title, abstract, and significance statement sections using extracted plain text | 🤖 AI-Inferred | Claude confirms section order in PDF | 🤖 AI-Inferred |
| 14 | `tables_order` | Tables in correct position (after body, before figures) | Claude reads section order from extracted plain text | 🤖 AI-Inferred | Claude reads section order from PDF | 🤖 AI-Inferred |
| 15 | `figures_order` | Figures in correct position (after tables) | Claude reads section order from extracted plain text | 🤖 AI-Inferred | Claude reads section order from PDF | 🤖 AI-Inferred |
| 16 | `acknowledgments` | Acknowledgments present and discloses funding/conflicts | Plain text scanned for `ACKNOWLEDGM` heading keyword (presence only). Claude evaluates whether the content discloses funding/conflicts | ⚙️+🤖 Hybrid (presence confirmed, content inferred) | Claude reads Acknowledgments content from PDF | 🤖 AI-Inferred |
| 17 | `data_availability` | Data Availability Statement present | Plain text scanned for `DATA AVAILABILITY` keyword. `applyDocxOverrides()` sets pass/fail directly based on presence | ✅ Explicitly Confirmed | Claude searches PDF for Data Availability Statement | 🤖 AI-Inferred |
| 18 | `appendix_order` | Appendix in correct position (if present) | Plain text scanned for `APPENDIX` heading; result passed to Claude as ground truth | ⚙️+🤖 Hybrid | Claude verifies Appendix position in PDF | 🤖 AI-Inferred |
| 19 | `references_order` | References last, alphabetical, not numbered | Plain text scanned for `REFERENCES` heading; presence passed to Claude. Claude evaluates alphabetical order and absence of numbering | ⚙️+🤖 Hybrid (presence confirmed, order inferred) | Claude reads References section from PDF | 🤖 AI-Inferred |

---

## Citation Checks (3 checks)

| # | Check ID | Requirement | .docx Method | .docx Verdict | .pdf Method | .pdf Verdict |
|---|---|---|---|---|---|---|
| 20 | `citation_format` | Author (Year) citation format used in body | Claude scans the body text for in-text citation patterns and confirms they follow Author (Year) format | 🤖 AI-Inferred | Claude scans body text in PDF for citation format | 🤖 AI-Inferred |
| 21 | `references_alpha` | References listed alphabetically | Claude reads the References section and verifies entries are in alphabetical order by first author surname | 🤖 AI-Inferred | Claude reads References section from PDF | 🤖 AI-Inferred |
| 22 | `abstract_no_citations` | No footnotes, citations, or URLs in the abstract | `extractSection()` isolates abstract text; regex scans for `(Author YYYY)`, `[N]`, and `http://` patterns. `applyDocxOverrides()` sets pass/fail directly | ✅ Explicitly Confirmed | Claude reads abstract text from PDF and checks for citations | 🤖 AI-Inferred |

---

## Table Checks (4 checks)

| # | Check ID | Requirement | .docx Method | .docx Verdict | .pdf Method | .pdf Verdict |
|---|---|---|---|---|---|---|
| 23 | `table_captions` | Table captions placed beneath tables | Claude reads extracted plain text and identifies whether caption text appears below each table | 🤖 AI-Inferred | Claude identifies table/caption layout in PDF | 🤖 AI-Inferred |
| 24 | `table_no_shading` | No shading, color, or underline in tables | All `<w:tbl>` blocks extracted from raw XML. Each scanned for `w:shd w:fill` (non-white values), `w:color w:val` (non-black values), and `w:u w:val` (non-none underline). `applyDocxOverrides()` sets pass/fail directly | ✅ Explicitly Confirmed | Claude visually reads table formatting from PDF rendering | 🤖 AI-Inferred |
| 25 | `tables_cited_order` | Tables cited in text in sequential order (Table 1, 2, 3…) | Regex `[Tt]able\s+(\d+)` extracts all table reference numbers from full plain text; ascending order verified programmatically. `applyDocxOverrides()` sets pass/fail directly | ✅ Explicitly Confirmed | Claude scans body text for Table reference order in PDF | 🤖 AI-Inferred |
| 26 | `table_no_wrapping` | No text wrapping around tables | Full `word/document.xml` scanned for `wp:wrapSquare`, `wp:wrapTight`, `wp:wrapThrough` elements. `applyDocxOverrides()` sets pass/fail directly | ✅ Explicitly Confirmed | Claude reads table layout from PDF | 🤖 AI-Inferred |

---

## Figure Checks (4 checks)

| # | Check ID | Requirement | .docx Method | .docx Verdict | .pdf Method | .pdf Verdict |
|---|---|---|---|---|---|---|
| 27 | `figure_captions` | Full captions placed beneath figures | Claude reads extracted plain text and identifies caption text below figure placeholders or embedded figures | 🤖 AI-Inferred | Claude reads figure/caption layout from PDF | 🤖 AI-Inferred |
| 28 | `figures_cited_order` | Figures cited in text in sequential order (Fig. 1, 2, 3…) | Regex `[Ff]ig(?:ure|\.)\s*(\d+)` extracts all figure reference numbers from full plain text; ascending order verified programmatically. `applyDocxOverrides()` sets pass/fail directly | ✅ Explicitly Confirmed | Claude scans body text for Figure reference order in PDF | 🤖 AI-Inferred |
| 29 | `figure_no_wrapping` | No text wrapping around figures | Same XML wrapping scan as `table_no_wrapping` — `wp:wrapSquare/Tight/Through` covers both figures and tables. `applyDocxOverrides()` sets pass/fail directly | ✅ Explicitly Confirmed | Claude reads figure layout from PDF | 🤖 AI-Inferred |
| 30 | `appendix_figures` | Appendix figures labeled A1, B1, etc. (not Fig. 1) | `extractSection()` isolates appendix text. Regex checks for `Fig. A1/B1` format and flags plain `Fig. N` as a violation. `applyDocxOverrides()` sets pass/fail directly | ✅ Explicitly Confirmed | Claude reads appendix figure labels from PDF | 🤖 AI-Inferred |

---

## Summary: Explicitly Confirmed vs. AI-Inferred by File Type

| Category | .docx Explicitly Confirmed | .docx Hybrid | .docx AI-Inferred | .pdf Explicitly Confirmed | .pdf AI-Inferred |
|---|---|---|---|---|---|
| Formatting (6) | 1 | 5 | 0 | 0 | 6 |
| Length (3) | 3 | 0 | 0 | 2 | 1 |
| Structure (10) | 1 | 5 | 4 | 0 | 10 |
| Citations (3) | 1 | 0 | 2 | 0 | 3 |
| Tables (4) | 3 | 0 | 1 | 0 | 4 |
| Figures (4) | 3 | 0 | 1 | 0 | 4 |
| **Total (30)** | **12** | **10** | **8** | **2** | **28** |

**Note on Hybrid checks (.docx):** For these checks, the underlying data (margins in inches, line spacing code, line/page numbering flags, section presence flags) is extracted deterministically from XML or plain text and passed to Claude as explicit ground truth facts. Claude is instructed not to override these values. While Claude writes the final check entry, it is constrained to use verified data — reducing (but not eliminating) AI inference risk.

---

## Reliability Tiers

**Highest reliability — fully deterministic:**
`abstract_length`, `significance_length`, `body_length` (docx), `paragraph_breaks`, `table_no_shading`, `tables_cited_order`, `table_no_wrapping`, `figures_cited_order`, `figure_no_wrapping`, `appendix_figures`, `abstract_no_citations`, `data_availability`

**High reliability — deterministic data, Claude adjudicates:**
`margins`, `line_spacing`, `font`, `line_numbering`, `page_numbering`, `abstract_present`, `significance_order`, `acknowledgments` (presence), `appendix_order`, `references_order` (presence)

**Moderate reliability — Claude reads plain text:**
`title_page`, `body_text_order`, `tables_order`, `figures_order`, `table_captions`, `figure_captions`, `citation_format`, `references_alpha`

**All 30 checks are guaranteed** to appear in every report via the `enforceChecks()` post-processing function, which injects `not_applicable` for any check Claude omits.
