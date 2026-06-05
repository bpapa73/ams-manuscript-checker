import { default as JSZip } from 'npm:jszip@3.10.1';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  try {
    const contentType = req.headers.get('content-type') || '';
    if (!contentType.includes('multipart/form-data')) {
      return Response.json({ error: 'Expected multipart/form-data with file and report fields' }, { status: 400, headers: CORS_HEADERS });
    }

    const formData = await req.formData();
    const file = formData.get('file') as File;
    const reportJson = formData.get('report') as string;

    if (!file) return Response.json({ error: 'No file provided' }, { status: 400, headers: CORS_HEADERS });
    if (!reportJson) return Response.json({ error: 'No report provided' }, { status: 400, headers: CORS_HEADERS });

    const filename = file.name;
    if (!filename.toLowerCase().endsWith('.docx')) {
      return Response.json({ error: 'Auto-fix is only available for .docx files' }, { status: 400, headers: CORS_HEADERS });
    }

    const report = JSON.parse(reportJson);
    const fixableIssues = (report.checks || []).filter(
      (c: any) => c.status === 'fail' && c.fixable === true
    );

    if (fixableIssues.length === 0) {
      return Response.json({
        success: true,
        message: 'No auto-fixable issues found. All remaining issues require manual correction.',
        fixed_file_b64: null,
        fixes_applied: 0
      }, { headers: CORS_HEADERS });
    }

    const fileBuffer = await file.arrayBuffer();
    const zip = await JSZip.loadAsync(fileBuffer);

    let fixesApplied = 0;
    const fixLog: string[] = [];

    // ── Fix: margins ──────────────────────────────────────────────────────────
    const hasMarginFix = fixableIssues.some((i: any) => i.id === 'margins');
    if (hasMarginFix) {
      const docXml = await zip.file('word/document.xml')?.async('text');
      if (docXml) {
        let fixed = docXml;
        // Replace any existing pgMar attributes
        fixed = fixed.replace(
          /<w:pgMar([^/]*?)\/>/g,
          (match: string) => {
            let m = match;
            m = m.replace(/w:top="[^"]*"/, 'w:top="1440"');
            m = m.replace(/w:bottom="[^"]*"/, 'w:bottom="1440"');
            m = m.replace(/w:left="[^"]*"/, 'w:left="1440"');
            m = m.replace(/w:right="[^"]*"/, 'w:right="1440"');
            // Add any missing attributes
            if (!m.includes('w:top=')) m = m.replace('<w:pgMar', '<w:pgMar w:top="1440"');
            if (!m.includes('w:bottom=')) m = m.replace('<w:pgMar', '<w:pgMar w:bottom="1440"');
            if (!m.includes('w:left=')) m = m.replace('<w:pgMar', '<w:pgMar w:left="1440"');
            if (!m.includes('w:right=')) m = m.replace('<w:pgMar', '<w:pgMar w:right="1440"');
            return m;
          }
        );
        zip.file('word/document.xml', fixed);
        fixesApplied++;
        fixLog.push('Margins set to 1 inch on all sides');
      }
    }

    // ── Fix: line spacing ─────────────────────────────────────────────────────
    const hasSpacingFix = fixableIssues.some((i: any) => i.id === 'line_spacing');
    if (hasSpacingFix) {
      // Fix in styles.xml (applies to all Normal text globally)
      const stylesXml = await zip.file('word/styles.xml')?.async('text');
      if (stylesXml) {
        let fixed = stylesXml;
        // Update existing w:spacing with line attributes
        fixed = fixed.replace(
          /(<w:spacing\b[^>]*?)w:line="[^"]*"([^>]*?)w:lineRule="[^"]*"/g,
          '$1w:line="360"$2w:lineRule="auto"'
        );
        // For Normal style: if pPr exists but no spacing, inject it
        fixed = fixed.replace(
          /(<w:style\b[^>]*w:styleId="Normal"[^>]*>[\s\S]*?<w:pPr>)([\s\S]*?)(<\/w:pPr>)/,
          (_m: string, open: string, inner: string, close: string) => {
            if (!inner.includes('w:spacing')) {
              return `${open}${inner}<w:spacing w:line="360" w:lineRule="auto"/>${close}`;
            }
            return _m;
          }
        );
        zip.file('word/styles.xml', fixed);
        fixesApplied++;
        fixLog.push('Line spacing set to 1.5x (360 twips)');
      }

      // Also patch document.xml paragraph spacing
      const docXml = await zip.file('word/document.xml')?.async('text');
      if (docXml) {
        let fixed = docXml;
        // Update existing spacing elements that have line set
        fixed = fixed.replace(
          /(<w:spacing\b[^>]*?)w:line="[^"]*"([^>]*?)w:lineRule="[^"]*"/g,
          '$1w:line="360"$2w:lineRule="auto"'
        );
        zip.file('word/document.xml', fixed);
      }
    }

    // ── Fix: page numbering ───────────────────────────────────────────────────
    const hasPageNumFix = fixableIssues.some((i: any) => i.id === 'page_numbering');
    if (hasPageNumFix) {
      const footerFiles = Object.keys(zip.files).filter(n => n.startsWith('word/footer'));
      let footerHasPageNum = false;
      for (const fname of footerFiles) {
        const fXml = await zip.file(fname)?.async('text') || '';
        if (fXml.includes('PAGE') || fXml.includes('fldChar')) { footerHasPageNum = true; break; }
      }
      if (!footerHasPageNum) {
        const footerXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:ftr xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:p><w:pPr><w:jc w:val="center"/></w:pPr>
    <w:r><w:fldChar w:fldCharType="begin"/></w:r>
    <w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r>
    <w:r><w:fldChar w:fldCharType="end"/></w:r>
  </w:p>
</w:ftr>`;
        zip.file('word/footer1.xml', footerXml);
        fixesApplied++;
        fixLog.push('Page numbering added to footer');
      }
    }

    // ── Generate fixed .docx and return as base64 ─────────────────────────────
    const fixedBuffer = await zip.generateAsync({ type: 'uint8array' });

    // Convert to base64 in chunks to avoid stack overflow on large files
    let base64 = '';
    const chunkSize = 8192;
    for (let i = 0; i < fixedBuffer.length; i += chunkSize) {
      base64 += String.fromCharCode(...fixedBuffer.slice(i, i + chunkSize));
    }
    const b64 = btoa(base64);

    return Response.json({
      success: true,
      fixed_file_b64: b64,
      fixes_applied: fixesApplied,
      fix_log: fixLog
    }, { headers: CORS_HEADERS });

  } catch (error) {
    console.error('fixManuscript error:', error);
    return Response.json({ error: (error as Error).message }, { status: 500, headers: CORS_HEADERS });
  }
});
