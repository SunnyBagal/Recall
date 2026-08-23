# ILIKE baseline (commit 7943212)

Raw benchmark samples from the **pre-FTS** retrieval path, where the lexical
arm was `ILIKE '%query%'` over title/summary/og_title/og_description. Measured
at commit `7943212` (clean tree) with the same protocol, hardware, and
fixed-seed query set as the current report.

Contents: `raw/scale1000.json` (arms A, C) and `raw/scale10000.json` (arms
A–E). The 50k run and report for this baseline were interrupted and superseded
before completion — only these raw files exist. An earlier dirty-tree run
(`d9caa4c`) was discarded entirely.

These numbers exist solely as the "before" side of the ILIKE → FTS comparison
in the current report; every other number there comes from the current run.
