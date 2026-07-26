"""Channel adapters. Transport only — no tutoring logic (§13).

Imports are lazy because the realtime adapter needs the `livekit` extra, and
the core must stay importable (and testable) without it.
"""
