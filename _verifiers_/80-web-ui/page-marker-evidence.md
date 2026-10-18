---
title: Page Marker Regression Evidence
level: L0
version: 1.0.0
description: Records the minimap verifier migration from a static rail label to the served page hash contract.
status: verified
grounded_in:
  - source: markedPage in src/server/web.ts and the targeted minimap browser check
  - source: test/web.test.ts and the deployment and resizable-panel verifier hash assertions
---

# Page marker regression

The original minimap browser check failed after establishing at least 24 transcript rows and exactly
16 rail sections. Its remaining freshness assertion demanded the historical `rail-sections/` label,
although the served page carried a twelve-character SHA256 prefix.

`markedPage` computes that prefix from the built HTML's original bytes; `unbuilt` in source and `dist`
is the placeholder it replaces while serving. The deployment and resizable-panel checks already
judge this same contract. Restoring a static rail label would abandon actual page identity.

The corrected chat verifier hashes `dist/server/page.html` and requires exact equality with the served
marker. It still checks section counts, role counts, hover behaviour and jumping. A twelve-character
hash pattern alone would not detect a stale build and was not substituted for equality.

## Verification

The targeted headless browser test passed with no skips after the correction:

```bash
node --test --test-name-pattern 'the conversation minimap follows the reference' \
  _verifiers_/80-web-ui/check-chat-view.mjs
```

This establishes the corrected marker assertion and the minimap behaviour exercised by that test.
It is not a claim that the entire Web UI or deployment suite passes.
