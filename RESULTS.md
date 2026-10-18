# Community results

How fast and how energy-efficient local models are on real PCs, measured by WattLlama.

**Add yours:** open your WattLlama page, scroll to **Share your result**, pick a model and click
**Open a GitHub issue**. The form is filled in for you; nothing is sent until you submit it.
A maintainer adds the row here.

- **Wh / 1k tok** = whole-PC energy while the model generated, per 1,000 generated tokens
  (GPU, CPU and RAM measured; rest of the PC and PSU loss estimated, see the README). Lower is better.
- **tok/s** = generated tokens per second of busy time, averaged over everything measured
  (real use, not a synthetic benchmark), so prompt length and agent pauses are in it.
- Rows with fewer than 10,000 tokens are marked *(short)*.

| GPU | CPU | RAM | Model | Quant | Engine | GPU limit | tok/s | Wh / 1k tok | Tokens | WattLlama |
|---|---|---|---|---|---|---|---|---|---|---|
| *be the first* | | | | | | | | | | |

Sorted by GPU, then model. Numbers from different prompts and context sizes are not a lab
comparison, but with enough rows they show what to expect from a card.
