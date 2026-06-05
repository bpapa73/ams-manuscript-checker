# AMS Manuscript Checker

A web-based compliance tool that analyzes scientific manuscripts submitted to the **American Meteorological Society (AMS)** against the society's official formatting and structural requirements.

## Features

- Accepts `.pdf` and `.docx` manuscript files
- Performs a **30-point compliance check** covering formatting, structure, citations, tables, and figures
- Returns a structured report with pass / fail / warning / not_applicable status for each check
- Server-side deterministic checks for DOCX files (12 checks confirmed without AI)
- Server-side word count overrides for PDF files (abstract and significance statement)
- Privacy-first: files are never stored; Anthropic API does not use data for model training

## Live App

Hosted at [www.sager-papa.com](https://www.sager-papa.com)

## Architecture

| Component | Technology |
|---|---|
| Frontend | Static HTML + Tailwind CSS (`app/index.html`) |
| Backend | Deno/TypeScript serverless function on Base44 (`functions/analyzeManuscript.ts`) |
| AI Model | Claude claude-opus-4-5 (Anthropic API) |
| DOCX parsing | JSZip (XML extraction) |

### DOCX Pipeline
1. JSZip extracts plain text and XML metadata (font, spacing, margins, line numbers, page numbers, table formatting, wrapping)
2. Plain text analysis: word counts, section presence, citation order, appendix figure labels
3. Claude evaluates remaining checks (citations, captions, reference order, section content)
4. `applyDocxOverrides()` replaces 12 of Claude's results with deterministic server-computed values

### PDF Pipeline
1. PDF base64-encoded and sent natively to Claude
2. Claude performs all 30 compliance checks and extracts abstract/significance prose
3. Server runs `countWords()` on extracted prose and overwrites Claude's word counts

## Compliance Checks

All 30 AMS checks are guaranteed in every report via `enforceChecks()`. Checks cover:

- **Formatting:** margins, line spacing, font, paragraph breaks, line numbering, page numbering
- **Length:** abstract (≤250 words), significance statement (≤120 words), body (≤7,500 words)
- **Structure:** section order (title → abstract → significance → body → tables → figures → acknowledgments → data availability → appendix → references)
- **Citations:** Author (Year) format, alphabetical references, no citations in abstract
- **Tables:** captions below, no shading/color/underline, cited in order, no text wrapping
- **Figures:** full captions below, cited in order, no text wrapping, appendix figures labeled A1/B1

See [`docs/AMS_Checks_Reference_Table.md`](docs/AMS_Checks_Reference_Table.md) for the full breakdown of which checks are deterministic vs. AI-inferred.

## Data Privacy

- Files are held in server memory only for the duration of the request — never written to disk or any database
- Anthropic API prohibits use of submitted data for model training by default
- Each request is fully stateless — no conversation history or cross-request caching
- See [privacy.anthropic.com](https://privacy.anthropic.com) for Anthropic's data handling policy

## Cost Estimate

For a typical 15-page manuscript:

| File Type | Est. Input Tokens | Est. Output Tokens | Est. Cost |
|---|---|---|---|
| .docx | ~7,200 | ~2,500 | ~$0.30 |
| .pdf | ~22,000 | ~2,500 | ~$0.52 |

## Environment Variables

| Variable | Description |
|---|---|
| `ANTHROPIC_API_KEY` | Your Anthropic API key — never commit this |

## Documentation

- [`docs/AMS_Checker_Technical_Description.md`](docs/AMS_Checker_Technical_Description.md) — full step-by-step technical description
- [`docs/AMS_Checks_Reference_Table.md`](docs/AMS_Checks_Reference_Table.md) — all 30 checks: method and AI vs. deterministic classification
- [`docs/AMS_Checker_Flowchart.svg`](docs/AMS_Checker_Flowchart.svg) — process flowchart

## License

MIT
