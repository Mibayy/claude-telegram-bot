#!/usr/bin/env python3
"""Extract text from a PDF using PyMuPDF."""
import sys
import fitz  # pymupdf

path = sys.argv[1] if len(sys.argv) > 1 else ''
if not path:
    print('ERROR: no PDF path provided', file=sys.stderr)
    sys.exit(1)

try:
    doc = fitz.open(path)
    pages = []
    for i, page in enumerate(doc):
        text = page.get_text()
        if text.strip():
            pages.append(f'--- Page {i+1} ---\n{text}')
    full_text = '\n\n'.join(pages)
    print(f'[PDF: {doc.page_count} pages]\n\n{full_text[:20000]}')
except Exception as e:
    print(f'ERROR: {e}', file=sys.stderr)
    sys.exit(1)
