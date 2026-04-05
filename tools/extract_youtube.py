#!/usr/bin/env python3
"""Extract transcript from a YouTube video."""
import sys
import re

url = sys.argv[1] if len(sys.argv) > 1 else ''
if not url:
    print('ERROR: no URL provided', file=sys.stderr)
    sys.exit(1)

# Extract video ID
match = re.search(r'(?:v=|youtu\.be/)([\w-]{11})', url)
if not match:
    print('ERROR: invalid YouTube URL', file=sys.stderr)
    sys.exit(1)

video_id = match.group(1)

try:
    from youtube_transcript_api import YouTubeTranscriptApi

    ytt_api = YouTubeTranscriptApi()
    # Try French first, then English, then any available
    transcript = None
    for langs in [['fr'], ['en'], None]:
        try:
            if langs:
                transcript = ytt_api.fetch(video_id, languages=langs)
            else:
                transcript = ytt_api.fetch(video_id)
            break
        except Exception:
            continue

    if not transcript:
        print('ERROR: no transcript available', file=sys.stderr)
        sys.exit(1)

    # Combine all text snippets
    full_text = ' '.join(snippet.text for snippet in transcript.snippets)

    # Limit output
    print(full_text[:15000])

except Exception as e:
    print(f'ERROR: {e}', file=sys.stderr)
    sys.exit(1)
