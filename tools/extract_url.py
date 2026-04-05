#!/usr/bin/env python3
"""Extract text from a URL using trafilatura."""
import sys
import trafilatura

url = sys.argv[1] if len(sys.argv) > 1 else ''
if not url:
    print('ERROR: no URL provided', file=sys.stderr)
    sys.exit(1)

downloaded = trafilatura.fetch_url(url)
if not downloaded:
    print('ERROR: could not fetch URL', file=sys.stderr)
    sys.exit(1)

text = trafilatura.extract(downloaded, include_comments=False, include_tables=True)
if not text:
    print('ERROR: could not extract text', file=sys.stderr)
    sys.exit(1)

# Limit output
print(text[:15000])
