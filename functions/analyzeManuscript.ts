import Anthropic from 'npm:@anthropic-ai/sdk@0.24.0';

const anthropic = new Anthropic({ apiKey: Deno.env.get('ANTHROPIC_API_KEY') });

function toBase64(buffer: Uint8Array): string {
  let binary = '';
  const chunkSize = 8192;
  for (let i = 0; i < buffer.length; i += chunkSize) {
    const chunk = buffer.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter((w: string) => w.length > 0).length;
}

// ─── Extract plain text from DOCX ────────────────────────────────────────────
async function extractDocxText(buffer: ArrayBuffer): Promise<string> {
  const { default: JSZip } = await import('npm:jszip@3.10.1');
  const zip = await JSZip.loadAsync(buffer);
  const docXml = await zip.file('word/document.xml')?.async('text');
  if (!docXml) return '';
  return docXml
    .replace(/<w:br[^/]*/g, '\n')
    .replace(/<w:p[ >]/g, '\n')
    .replace(/<w:p\/>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#x([0-9A-Fa-f]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\n{3,}/g, '\n\n').trim();
}

// ─── Extract section text from plain text by heading keyword ─────────────────
function extractSection(text: string, startPattern: RegExp, endPatterns: RegExp[]): string {
  const lines = text.split('\n');
  let inSection = false;
  const sectionLines: string[] = [];
  for (const line of lines) {
    if (!inSection) {
      if (startPattern.test(line.trim())) { inSection = true; continue; }
    } else {
      if (endPatterns.some(p => p.test(line.trim()))) break;
      sectionLines.push(line);
    }
  }
  return sectionLines.join('\n').trim();
}

// ─── Check if table/figure references appear in ascending order ──────────────
function checkCitationOrder(text: string, pattern: RegExp): { inOrder: boolean; found: number[] } {
  const matches = [...text.matchAll(pattern)];
  const nums = matches.map(m => parseInt(m[1])).filter(n => !isNaN(n));
  if (nums.length === 0) return { inOrder: true, found: [] };
  let inOrder = true;
  for (let i = 1; i < nums.length; i++) {
    if (nums[i] < nums[i - 1]) { inOrder = false; break; }
  }
  return { inOrder, found: nums };
}

// ─── Extract all metadata + deterministic checks from DOCX XML ───────────────
async function extractDocxMetadata(buffer: ArrayBuffer, plainText: string): Promise<Record<string, any>> {
  const { default: JSZip } = await import('npm:jszip@3.10.1');
  const zip = await JSZip.loadAsync(buffer);
  const metadata: Record<string, any> = {};

  // ── Styles: font size, line spacing ──
  const stylesXml = await zip.file('word/styles.xml')?.async('text');
  if (stylesXml) {
    const szMatches = [...stylesXml.matchAll(/\bw:sz\b[^>]*\bw:val="(\d+)"/g)];
    const szValues = szMatches.map(m => parseInt(m[1])).filter(v => v > 0);
    if (szValues.length > 0) {
      const freq: Record<number, number> = {};
      szValues.forEach(v => { freq[v] = (freq[v] || 0) + 1; });
      const dominant = Object.entries(freq).sort((a, b) => b[1] - a[1])[0];
      metadata.fontSizeHalfPts = parseInt(dominant[0]);
      metadata.fontSizePt = metadata.fontSizeHalfPts / 2;
    }
    const lineMatch = stylesXml.match(/\bw:line\b[^>]*?w:val="(\d+)"|w:line="(\d+)"/);
    metadata.lineSpacingValue = lineMatch ? (lineMatch[1] || lineMatch[2]) : null;
  }

  // ── Settings: line numbering ──
  const settingsXml = await zip.file('word/settings.xml')?.async('text');
  if (settingsXml) {
    metadata.hasLineNumbers = settingsXml.includes('w:lnNumType') || settingsXml.includes('w:lnNum ');
  }

  // ── Document XML: margins, page numbers, tables, wrapping, font color ──
  const docXml = await zip.file('word/document.xml')?.async('text');
  if (docXml) {
    // Margins
    const top    = docXml.match(/w:top="(\d+)"/)?.[1];
    const bottom = docXml.match(/w:bottom="(\d+)"/)?.[1];
    const left   = docXml.match(/w:left="(\d+)"/)?.[1];
    const right  = docXml.match(/w:right="(\d+)"/)?.[1];
    metadata.margins = { top, bottom, left, right };
    metadata.marginsInches = {
      top:    top    ? (parseInt(top)    / 1440).toFixed(2) : null,
      bottom: bottom ? (parseInt(bottom) / 1440).toFixed(2) : null,
      left:   left   ? (parseInt(left)   / 1440).toFixed(2) : null,
      right:  right  ? (parseInt(right)  / 1440).toFixed(2) : null,
    };

    // Page & line numbering
    metadata.hasPageNumbers = /PAGE/.test(docXml) && docXml.includes('w:fldChar');
    metadata.hasLineNumbers = metadata.hasLineNumbers || docXml.includes('w:lnNumType') || docXml.includes('<w:lnNum ');
    const docLineMatch = docXml.match(/w:line="(\d+)"/);
    if (docLineMatch && !metadata.lineSpacingValue) metadata.lineSpacingValue = docLineMatch[1];

    // Footer
    const footerFile = zip.file('word/footer1.xml');
    if (footerFile) {
      const footerXml = await footerFile.async('text');
      metadata.hasPageNumbersInFooter = /PAGE/.test(footerXml) || footerXml.includes('w:fldChar');
      metadata.footerContent = footerXml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
    }
    const footerFiles = Object.keys(zip.files).filter(n => n.startsWith('word/footer'));
    for (const fname of footerFiles) {
      const fXml = await zip.file(fname)?.async('text') || '';
      if (/PAGE/.test(fXml) || fXml.includes('fldChar')) { metadata.hasPageNumbersInFooter = true; break; }
    }

    // Table shading, color, underline
    const tableBlocks = [...docXml.matchAll(/<w:tbl[\s>][\s\S]*?<\/w:tbl>/g)].map(m => m[0]);
    const WHITE_FILLS = new Set(['FFFFFF', 'ffffff', 'auto', 'none', '']);
    let tableHasShading = false;
    let tableHasNonBlackText = false;
    for (const tbl of tableBlocks) {
      const shdMatches = [...tbl.matchAll(/w:shd[^>]*w:fill="([^"]+)"/g)];
      for (const m of shdMatches) {
        if (!WHITE_FILLS.has(m[1])) { tableHasShading = true; break; }
      }
      const colorMatches = [...tbl.matchAll(/w:color[^>]*w:val="([^"]+)"/g)];
      for (const m of colorMatches) {
        if (!WHITE_FILLS.has(m[1]) && m[1].toLowerCase() !== '000000' && m[1].toLowerCase() !== 'auto') {
          tableHasNonBlackText = true; break;
        }
      }
      const ulMatches = [...tbl.matchAll(/w:u[^>]*w:val="([^"]+)"/g)];
      for (const m of ulMatches) {
        if (m[1] !== 'none') { tableHasShading = true; break; }
      }
    }
    metadata.tableShading = tableHasShading;
    metadata.tableNonBlackText = tableHasNonBlackText;
    metadata.tableCount = tableBlocks.length;

    // Text wrapping around objects (applies to both tables and figures)
    metadata.objectTextWrapping = docXml.includes('wp:wrapSquare') || docXml.includes('wp:wrapTight') || docXml.includes('wp:wrapThrough');

    // Non-black font color anywhere in document body
    const bodyColorMatches = [...docXml.matchAll(/w:color[^>]*w:val="([^"]+)"/g)];
    metadata.hasNonBlackBodyText = bodyColorMatches.some(m => {
      const v = m[1].toLowerCase();
      return !WHITE_FILLS.has(v) && v !== '000000' && v !== 'auto';
    });

    // Paragraph indentation or spacing (paragraph breaks)
    metadata.hasParagraphIndent = docXml.includes('w:firstLine') || /w:before="[1-9]/.test(docXml) || /w:after="[1-9]/.test(docXml);

    // Section headings in document order (from XML paragraph styles)
    // Extracts text of paragraphs styled as Heading1/Heading2 or ALL CAPS lines
    const headingMatches = [...docXml.matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)];
    const headings: string[] = [];
    for (const pm of headingMatches) {
      const para = pm[0];
      const isHeading = /w:styleId="Heading[12]"|w:val="Heading[12]"/.test(para)
        || /w:pStyle[^>]*w:val="[Hh]eading[12]"/.test(para);
      if (isHeading) {
        const text = para.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
        if (text.length > 1) headings.push(text.toUpperCase());
      }
    }
    metadata.headingSequence = headings;
  }

  // ── Plain-text derived checks ──────────────────────────────────────────────

  // Section presence (heading keyword scan on plain text)
  const upperText = plainText.toUpperCase();
  metadata.hasAbstract            = /^\s*ABSTRACT\s*$/m.test(plainText) || upperText.includes('\nABSTRACT\n') || upperText.startsWith('ABSTRACT');
  metadata.hasSignificanceStmt    = /SIGNIFICANCE STATEMENT/i.test(plainText);
  metadata.hasAcknowledgments     = /ACKNOWLEDGM/i.test(plainText);
  metadata.hasDataAvailability    = /DATA AVAILABILITY/i.test(plainText);
  metadata.hasReferences          = /^\s*REFERENCES\s*$/im.test(plainText);
  metadata.hasAppendix            = /^\s*APPENDIX/im.test(plainText);

  // Word counts — server-side deterministic
  const SECTION_END_PATTERNS = [
    /^SIGNIFICANCE STATEMENT$/i, /^[1-9]\.\s/i, /^INTRODUCTION$/i,
    /^ABSTRACT$/i, /^REFERENCES$/i, /^ACKNOWLEDGM/i, /^DATA AVAILABILITY/i,
    /^APPENDIX/i, /^TABLE\s+\d/i, /^FIGURE\s+\d/i, /^FIG\.\s*\d/i
  ];

  const abstractText = extractSection(plainText, /^ABSTRACT$/i, SECTION_END_PATTERNS.filter(p => !/ABSTRACT/i.test(p.source)));
  const sigText      = extractSection(plainText, /^SIGNIFICANCE STATEMENT$/i, SECTION_END_PATTERNS.filter(p => !/SIGNIFICANCE/i.test(p.source)));

  // Body text: everything between intro and references/tables/figures
  const bodyText = extractSection(plainText,
    /^(1\.?\s*(INTRODUCTION|BACKGROUND)|INTRODUCTION)$/i,
    [/^REFERENCES$/i, /^ACKNOWLEDGM/i, /^DATA AVAILABILITY/i, /^TABLE\s+1/i, /^FIGURE\s+1/i, /^FIG\.\s*1/i, /^APPENDIX/i]
  );

  metadata.abstractWordCount      = abstractText ? countWords(abstractText) : null;
  metadata.significanceWordCount  = sigText      ? countWords(sigText)      : 0;
  metadata.bodyWordCount          = bodyText     ? countWords(bodyText)     : null;
  metadata.abstractTextExtracted  = abstractText || null;
  metadata.significanceTextExtracted = sigText   || null;

  // Abstract: no citations or URLs
  const abstractNoCitations = abstractText
    ? !/\([A-Z][a-z]+.{1,30}\d{4}\)|https?:\/\/|\[\d+\]/.test(abstractText)
    : null;
  metadata.abstractNoCitations = abstractNoCitations;

  // Table citation order in body
  const tableCiteOrder = checkCitationOrder(plainText, /[Tt]able\s+(\d+)/g);
  metadata.tablesCitedInOrder = tableCiteOrder.inOrder;
  metadata.tablesCited        = tableCiteOrder.found;

  // Figure citation order in body
  const figCiteOrder = checkCitationOrder(plainText, /[Ff]ig(?:ure|\.)\s*(\d+)/g);
  metadata.figuresCitedInOrder = figCiteOrder.inOrder;
  metadata.figuresCited        = figCiteOrder.found;

  // Appendix figures labeled A1, B1, etc.
  const appendixText = extractSection(plainText, /^APPENDIX/im, [/^REFERENCES$/i]);
  if (appendixText) {
    const hasFigLabel    = /[Ff]ig(?:ure|\.)\s*[A-Z]\d+/.test(appendixText);  // A1, B2
    const hasWrongLabel  = /[Ff]ig(?:ure|\.)\s*\d+/.test(appendixText);        // plain Fig. 1
    metadata.appendixFiguresLabeled = hasFigLabel && !hasWrongLabel ? true
      : (!hasFigLabel && !hasWrongLabel ? null : false);
  } else {
    metadata.appendixFiguresLabeled = null; // no appendix
  }

  return metadata;
}

// ─── Apply all deterministic overrides to Claude's report ────────────────────
function applyDocxOverrides(report: Record<string, any>, meta: Record<string, any>): void {
  const checks = report.checks as any[];
  const find = (id: string) => checks.find(c => c.id === id);
  const override = (id: string, status: 'pass' | 'fail' | 'not_applicable', details: string) => {
    const c = find(id);
    if (c) { c.status = status; c.details = details; }
  };

  // Abstract word count
  if (meta.abstractWordCount != null) {
    const n = meta.abstractWordCount;
    report.word_counts.abstract = n;
    override('abstract_length',
      n <= 250 ? 'pass' : 'fail',
      `Abstract is ${n} words (limit: 250). ${n <= 250 ? 'Within limit.' : 'Exceeds limit by ' + (n - 250) + ' words.'}`
    );
    console.log('[docx wordcount] abstract=' + n);
  }

  // Significance word count
  if (meta.significanceWordCount != null) {
    const n = meta.significanceWordCount;
    report.word_counts.significance_statement = n;
    if (n === 0) {
      override('significance_length', 'not_applicable', 'No Significance Statement detected.');
    } else {
      override('significance_length',
        n <= 120 ? 'pass' : 'fail',
        `Significance Statement is ${n} words (limit: 120). ${n <= 120 ? 'Within limit.' : 'Exceeds limit by ' + (n - 120) + ' words.'}`
      );
    }
    console.log('[docx wordcount] significance=' + n);
  }

  // Body word count
  if (meta.bodyWordCount != null) {
    const n = meta.bodyWordCount;
    report.word_counts.body_text = n;
    override('body_length',
      n <= 7500 ? 'pass' : 'fail',
      `Body text is approximately ${n} words (limit: 7,500). ${n <= 7500 ? 'Within limit.' : 'Exceeds limit by ' + (n - 7500) + ' words.'}`
    );
    console.log('[docx wordcount] body=' + n);
  }

  // Table shading/color/underline
  if (meta.tableCount > 0) {
    const hasViolation = meta.tableShading || meta.tableNonBlackText;
    override('table_no_shading',
      hasViolation ? 'fail' : 'pass',
      hasViolation
        ? `XML detected: ${meta.tableShading ? 'shading/underline ' : ''}${meta.tableNonBlackText ? 'non-black text color' : ''} in tables.`
        : 'No shading, color, or underline detected in tables (XML-verified).'
    );
  }

  // Text wrapping
  override('table_no_wrapping',
    meta.objectTextWrapping ? 'fail' : 'pass',
    meta.objectTextWrapping
      ? 'Text wrapping detected around objects (wrapSquare/wrapTight/wrapThrough found in XML).'
      : 'No text wrapping around tables detected (XML-verified).'
  );
  override('figure_no_wrapping',
    meta.objectTextWrapping ? 'fail' : 'pass',
    meta.objectTextWrapping
      ? 'Text wrapping detected around objects (wrapSquare/wrapTight/wrapThrough found in XML).'
      : 'No text wrapping around figures detected (XML-verified).'
  );

  // Paragraph breaks
  if (meta.hasParagraphIndent != null) {
    override('paragraph_breaks',
      meta.hasParagraphIndent ? 'pass' : 'fail',
      meta.hasParagraphIndent
        ? 'Paragraph indentation or spacing detected (XML-verified).'
        : 'No paragraph indentation or inter-paragraph spacing detected in XML.'
    );
  }

  // Abstract no citations
  if (meta.abstractNoCitations != null) {
    override('abstract_no_citations',
      meta.abstractNoCitations ? 'pass' : 'fail',
      meta.abstractNoCitations
        ? 'No citations, footnotes, or URLs detected in abstract (text-verified).'
        : 'Citation, footnote, or URL pattern detected in abstract text.'
    );
  }

  // Data Availability Statement presence
  override('data_availability',
    meta.hasDataAvailability ? 'pass' : 'fail',
    meta.hasDataAvailability
      ? 'Data Availability Statement heading detected (text-verified).'
      : 'No Data Availability Statement heading found in document.'
  );

  // Table citation order
  if (meta.tablesCited.length > 0) {
    override('tables_cited_order',
      meta.tablesCitedInOrder ? 'pass' : 'fail',
      meta.tablesCitedInOrder
        ? `Tables cited in order: ${meta.tablesCited.join(', ')} (text-verified).`
        : `Tables cited out of order: ${meta.tablesCited.join(', ')} (text-verified).`
    );
  }

  // Figure citation order
  if (meta.figuresCited.length > 0) {
    override('figures_cited_order',
      meta.figuresCitedInOrder ? 'pass' : 'fail',
      meta.figuresCitedInOrder
        ? `Figures cited in order: ${meta.figuresCited.join(', ')} (text-verified).`
        : `Figures cited out of order: ${meta.figuresCited.join(', ')} (text-verified).`
    );
  }

  // Appendix figure labels
  if (meta.appendixFiguresLabeled === true) {
    override('appendix_figures', 'pass', 'Appendix figures use A1/B1 label format (text-verified).');
  } else if (meta.appendixFiguresLabeled === false) {
    override('appendix_figures', 'fail', 'Appendix figures do not use A1/B1 label format (text-verified).');
  } else {
    override('appendix_figures', 'not_applicable', 'No appendix figures detected.');
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      }
    });
  }

  const corsHeaders = { 'Access-Control-Allow-Origin': '*' };

  try {
    let fileBuffer: ArrayBuffer;
    let filename: string;
    let isDocx: boolean;

    const contentType = req.headers.get('content-type') || '';

    if (contentType.includes('multipart/form-data')) {
      const formData = await req.formData();
      const file = formData.get('file') as File;
      if (!file) return Response.json({ error: 'No file provided' }, { status: 400, headers: corsHeaders });
      filename = file.name;
      isDocx = filename.toLowerCase().endsWith('.docx');
      fileBuffer = await file.arrayBuffer();
    } else {
      const body = await req.json().catch(() => ({}));
      const { submissionId } = body;
      if (!submissionId) return Response.json({ error: 'No file or submissionId provided' }, { status: 400, headers: corsHeaders });
      const { createClientFromRequest } = await import('npm:@base44/sdk@0.8.25');
      const base44 = createClientFromRequest(req);
      const submission = await base44.asServiceRole.entities.ManuscriptSubmission.get(submissionId);
      if (!submission) return Response.json({ error: 'Submission not found' }, { status: 404, headers: corsHeaders });
      await base44.asServiceRole.entities.ManuscriptSubmission.update(submissionId, { status: 'analyzing' });
      const fileResponse = await fetch(submission.file_url);
      if (!fileResponse.ok) throw new Error('Could not fetch uploaded file');
      fileBuffer = await fileResponse.arrayBuffer();
      filename = submission.filename || 'manuscript';
      isDocx = submission.file_type === 'docx';
    }

    const systemPrompt = buildSystemPrompt();
    let report: Record<string, any>;

    if (!isDocx) {
      // ── PDF pipeline ──────────────────────────────────────────────────────
      const fileBytes = new Uint8Array(fileBuffer);
      const base64Content = toBase64(fileBytes);

      const response = await anthropic.messages.create({
        model: 'claude-opus-4-5',
        max_tokens: 8192,
        system: systemPrompt,
        messages: [{ role: 'user', content: [
          { type: 'text', text: 'Please analyze this AMS manuscript PDF for compliance and return the JSON report.' },
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64Content } }
        ]}]
      });

      const responseText = response.content[0].type === 'text' ? response.content[0].text : '';
      report = enforceChecks(parseReport(responseText));
      report.word_counts = report.word_counts || {};
      const claudeWordCounts = { ...report.word_counts };
      console.log('[pdf wordcount] Claude baseline:', JSON.stringify(claudeWordCounts));

      const abstractText: string  = report.extracted_text?.abstract || '';
      const significanceText: string = report.extracted_text?.significance_statement || '';

      if (abstractText) {
        const n = countWords(abstractText);
        report.word_counts.abstract = n;
        console.log('[pdf wordcount] abstract (server)=' + n);
        const c = report.checks?.find((c: any) => c.id === 'abstract_length');
        if (c) {
          c.status  = n <= 250 ? 'pass' : 'fail';
          c.details = `Abstract is ${n} words (limit: 250). ${n <= 250 ? 'Within limit.' : 'Exceeds limit by ' + (n - 250) + ' words.'}`;
        }
      }

      if (significanceText) {
        const n = countWords(significanceText);
        report.word_counts.significance_statement = n;
        console.log('[pdf wordcount] significance (server)=' + n);
        const c = report.checks?.find((c: any) => c.id === 'significance_length');
        if (c) {
          c.status  = n <= 120 ? 'pass' : 'fail';
          c.details = `Significance Statement is ${n} words (limit: 120). ${n <= 120 ? 'Within limit.' : 'Exceeds limit by ' + (n - 120) + ' words.'}`;
        }
      } else {
        report.word_counts.significance_statement = claudeWordCounts.significance_statement ?? 0;
      }

      if (claudeWordCounts.body_text != null) {
        report.word_counts.body_text = claudeWordCounts.body_text;
      }

    } else {
      // ── DOCX pipeline ─────────────────────────────────────────────────────
      const text = await extractDocxText(fileBuffer);
      const meta = await extractDocxMetadata(fileBuffer, text);

      const contentForClaude = `DOCUMENT METADATA (treat all XML-extracted values as ground truth):
- Font size: ${meta.fontSizePt ? meta.fontSizePt + 'pt' : 'not detected'} (raw: ${meta.fontSizeHalfPts ?? 'n/a'} half-pts)
- Line spacing: ${meta.lineSpacingValue || 'not detected'} (240=single, 360=1.5x, 480=double)
- Line numbering (XML): ${meta.hasLineNumbers ? 'YES' : 'NO'}
- Page numbering (XML): ${meta.hasPageNumbers || meta.hasPageNumbersInFooter ? 'YES' : 'NO'}
- Footer: ${meta.footerContent || 'none'}
- Margins (inches): top=${meta.marginsInches?.top}", bottom=${meta.marginsInches?.bottom}", left=${meta.marginsInches?.left}", right=${meta.marginsInches?.right}"
- Tables detected: ${meta.tableCount ?? 0}
- Table shading/non-white fill (XML): ${meta.tableShading ? 'YES — violation found' : 'NO'}
- Non-black text color in tables (XML): ${meta.tableNonBlackText ? 'YES — violation found' : 'NO'}
- Text wrapping around objects (XML): ${meta.objectTextWrapping ? 'YES — violation found' : 'NO'}
- Paragraph indentation/spacing (XML): ${meta.hasParagraphIndent ? 'YES' : 'NO'}
- Non-black font color in body (XML): ${meta.hasNonBlackBodyText ? 'YES — violation found' : 'NO'}
- Abstract present (text scan): ${meta.hasAbstract ? 'YES' : 'NO'}
- Significance Statement present (text scan): ${meta.hasSignificanceStmt ? 'YES' : 'NO'}
- Acknowledgments present (text scan): ${meta.hasAcknowledgments ? 'YES' : 'NO'}
- Data Availability Statement present (text scan): ${meta.hasDataAvailability ? 'YES' : 'NO'}
- References section present (text scan): ${meta.hasReferences ? 'YES' : 'NO'}
- Appendix present (text scan): ${meta.hasAppendix ? 'YES' : 'NO'}
- Abstract word count (server): ${meta.abstractWordCount ?? 'could not extract'}
- Significance word count (server): ${meta.significanceWordCount ?? 0}
- Body word count (server): ${meta.bodyWordCount ?? 'could not extract'}
- Tables cited in order (text scan): ${meta.tablesCited.length > 0 ? (meta.tablesCitedInOrder ? 'YES — ' + meta.tablesCited.join(',') : 'NO — ' + meta.tablesCited.join(',')) : 'no table references found'}
- Figures cited in order (text scan): ${meta.figuresCited.length > 0 ? (meta.figuresCitedInOrder ? 'YES — ' + meta.figuresCited.join(',') : 'NO — ' + meta.figuresCited.join(',')) : 'no figure references found'}
- Appendix figure labels (text scan): ${meta.appendixFiguresLabeled === true ? 'CORRECT (A1/B1 format)' : meta.appendixFiguresLabeled === false ? 'INCORRECT (plain Fig.N used)' : 'no appendix figures'}
NOTES:
- Use ALL XML/text-scan values above as ground truth for checks they cover.
- Do NOT override XML-confirmed values with visual inference.
- If line numbers appear inline in text (e.g. "1  Title"), count line numbering as present.
DOCUMENT TEXT:
${text}`;

      const response = await anthropic.messages.create({
        model: 'claude-opus-4-5',
        max_tokens: 8192,
        system: systemPrompt,
        messages: [{ role: 'user', content: `Analyze this AMS manuscript for compliance and return the JSON report.\n\n${contentForClaude}` }]
      });

      const responseText = response.content[0].type === 'text' ? response.content[0].text : '';
      report = enforceChecks(parseReport(responseText));

      // Apply all deterministic overrides on top of Claude's output
      applyDocxOverrides(report, meta);
    }

    return Response.json({ success: true, report }, { headers: corsHeaders });

  } catch (error) {
    return Response.json({ error: (error as Error).message }, { status: 500, headers: corsHeaders });
  }
});

// ─── Canonical 30-check list ─────────────────────────────────────────────────
const CANONICAL_CHECKS = [
  { id: 'margins',               category: 'Formatting', requirement: 'Margins ~1 inch all sides' },
  { id: 'line_spacing',          category: 'Formatting', requirement: '1.5 line spacing throughout' },
  { id: 'font',                  category: 'Formatting', requirement: '12pt black font' },
  { id: 'paragraph_breaks',      category: 'Formatting', requirement: 'Paragraph breaks with indent or extra space' },
  { id: 'line_numbering',        category: 'Formatting', requirement: 'Line numbering throughout' },
  { id: 'page_numbering',        category: 'Formatting', requirement: 'Sequential page numbering' },
  { id: 'abstract_length',       category: 'Length',     requirement: 'Abstract <= 250 words' },
  { id: 'significance_length',   category: 'Length',     requirement: 'Significance Statement <= 120 words' },
  { id: 'body_length',           category: 'Length',     requirement: 'Body <= 7,500 words' },
  { id: 'title_page',            category: 'Structure',  requirement: 'Title Page present and first' },
  { id: 'abstract_present',      category: 'Structure',  requirement: 'Abstract present and in order' },
  { id: 'significance_order',    category: 'Structure',  requirement: 'Significance Statement in correct order (if present)' },
  { id: 'body_text_order',       category: 'Structure',  requirement: 'Body Text in correct order' },
  { id: 'tables_order',          category: 'Structure',  requirement: 'Tables in correct order' },
  { id: 'figures_order',         category: 'Structure',  requirement: 'Figures in correct order' },
  { id: 'acknowledgments',       category: 'Structure',  requirement: 'Acknowledgments disclose funding/conflicts' },
  { id: 'data_availability',     category: 'Structure',  requirement: 'Data Availability Statement present' },
  { id: 'appendix_order',        category: 'Structure',  requirement: 'Appendix in correct order (if present)' },
  { id: 'references_order',      category: 'Structure',  requirement: 'References last, alphabetical, not numbered' },
  { id: 'citation_format',       category: 'Citations',  requirement: 'Author (Year) citation format used' },
  { id: 'references_alpha',      category: 'Citations',  requirement: 'References listed alphabetically' },
  { id: 'abstract_no_citations', category: 'Citations',  requirement: 'No footnotes/citations/URLs in abstract' },
  { id: 'table_captions',        category: 'Tables',     requirement: 'Table captions beneath tables' },
  { id: 'table_no_shading',      category: 'Tables',     requirement: 'No shading/color/underline in tables' },
  { id: 'tables_cited_order',    category: 'Tables',     requirement: 'Tables cited in order' },
  { id: 'table_no_wrapping',     category: 'Tables',     requirement: 'No text wrapping around tables' },
  { id: 'figure_captions',       category: 'Figures',    requirement: 'Full captions beneath figures' },
  { id: 'figures_cited_order',   category: 'Figures',    requirement: 'Figures cited in order' },
  { id: 'figure_no_wrapping',    category: 'Figures',    requirement: 'No text wrapping around figures' },
  { id: 'appendix_figures',      category: 'Figures',    requirement: 'Appendix figures labeled A1, B1, etc.' },
];

function enforceChecks(report: Record<string, any>): Record<string, any> {
  const existing = report.checks || [];
  const existingIds = new Set(existing.map((c: any) => c.id));
  for (const canonical of CANONICAL_CHECKS) {
    if (!existingIds.has(canonical.id)) {
      existing.push({
        id: canonical.id,
        category: canonical.category,
        requirement: canonical.requirement,
        status: 'not_applicable',
        details: 'Not evaluated.',
        fixable: false,
        fix_description: null
      });
    }
  }
  const orderMap = new Map(CANONICAL_CHECKS.map((c, i) => [c.id, i]));
  existing.sort((a: any, b: any) => (orderMap.get(a.id) ?? 999) - (orderMap.get(b.id) ?? 999));
  report.checks = existing;
  return report;
}

function parseReport(responseText: string): Record<string, any> {
  try {
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (jsonMatch) return JSON.parse(jsonMatch[0]);
  } catch { /* ignore */ }
  return {
    overall_status: 'fail',
    summary: 'Report parsing failed.',
    word_counts: { abstract: null, significance_statement: null, body_text: null },
    checks: []
  };
}

function buildSystemPrompt(): string {
  return `You are an expert manuscript compliance checker for the American Meteorological Society (AMS).
Analyze manuscripts against AMS formatting and manuscript component requirements.
Return a structured JSON report only — no prose outside the JSON.

AMS Requirements:
FORMATTING: 1) Margins ~1 inch all sides 2) 1.5 line spacing throughout 3) 12pt black font 4) Paragraph breaks with indent or extra space 5) Line numbering throughout 6) Sequential page numbering
LENGTH: 7) Abstract <= 250 words 8) Significance Statement <= 120 words 9) Body <= 7,500 words
STRUCTURE ORDER: 10) Title Page 11) Abstract 12) Significance Statement (if present) 13) Body Text 14) Tables 15) Figures 16) Acknowledgments (must disclose funding/conflicts) 17) Data Availability Statement 18) Appendix (if any) 19) References (alphabetical, NOT numbered)
CITATIONS: 20) Author (Year) format 21) Alphabetical references 22) No footnotes/citations/URLs in abstract
TABLES: 23) Captions beneath 24) No shading/color/underline 25) Cited in order 26) No text wrapping
FIGURES: 27) Full captions beneath 28) Cited in order 29) No text wrapping 30) Appendix figures labeled A1, B1, etc.

IMPORTANT: In the "extracted_text" field (PDF only), copy the verbatim prose of the Abstract and Significance Statement. Do NOT include line numbers. This text will be word-counted server-side.

When DOCUMENT METADATA is provided, treat ALL XML-extracted and text-scan values as ground truth. Do NOT override them with your own inference. Focus your analysis on checks not covered by the metadata (e.g. citation format, section content quality, reference alphabetical order, table/figure captions).

Return exactly this JSON:
{
  "overall_status": "pass" | "fail",
  "summary": "Brief summary",
  "word_counts": { "abstract": number, "significance_statement": number, "body_text": number },
  "extracted_text": {
    "abstract": "verbatim abstract prose (PDF only), or null",
    "significance_statement": "verbatim significance prose (PDF only), or null"
  },
  "checks": [{
    "id": "check_id",
    "category": "Formatting"|"Length"|"Structure"|"Citations"|"Tables"|"Figures",
    "requirement": "Short requirement description",
    "status": "pass"|"fail"|"warning"|"not_applicable",
    "details": "Specific findings",
    "fixable": true|false,
    "fix_description": "What would fix this"|null
  }]
}

Use these exact check IDs: margins, line_spacing, font, paragraph_breaks, line_numbering, page_numbering, abstract_length, significance_length, body_length, title_page, abstract_present, significance_order, body_text_order, tables_order, figures_order, acknowledgments, data_availability, appendix_order, references_order, citation_format, references_alpha, abstract_no_citations, table_captions, table_no_shading, tables_cited_order, table_no_wrapping, figure_captions, figures_cited_order, figure_no_wrapping, appendix_figures

You MUST return all 30 checks. If a check cannot be evaluated, set status to "not_applicable".`;
}
