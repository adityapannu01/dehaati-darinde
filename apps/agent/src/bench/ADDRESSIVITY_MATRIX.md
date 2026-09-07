# Addressivity confusion matrix (§2.6)

⚠️ SYNTHETIC transcript (see bench/addressivity-fixture.ts header). Replace
with a real recorded two-person session and re-run for a number to report.

Utterances: 21 human turns, prefilter only (no model).

| axis | τ | TP | FP | TN | FN | precision | recall | F1 |
|---|--:|--:|--:|--:|--:|--:|--:|--:|
| addressed | 0.5 | 3 | 0 | 11 | 7 | 1.00 | 0.30 | 0.46 |
| addressed | 0.6 | 3 | 0 | 11 | 7 | 1.00 | 0.30 | 0.46 |
| addressed | 0.7 | 3 | 0 | 11 | 7 | 1.00 | 0.30 | 0.46 |
| salient | 0.5 | 11 | 0 | 8 | 2 | 1.00 | 0.85 | 0.92 |
| salient | 0.6 | 11 | 0 | 8 | 2 | 1.00 | 0.85 | 0.92 |
| salient | 0.7 | 11 | 0 | 8 | 2 | 1.00 | 0.85 | 0.92 |

Reference points from published systems: ~2.1% false-trigger at τ=0.70;
F1 degrades 0.98 (one speaker) → 0.91 (four speakers).
