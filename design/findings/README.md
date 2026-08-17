# Findings — what contact with GitHub taught us

Conclusions from the lab's protocols: measured behaviour and the decisions it forced. Each pairs with
the protocol that produced it, and each cites the delivery ids and response excerpts behind its
claims. The method and the raw evidence stay in the lab
([`packages/dev/lab/`](../../packages/dev/lab/README.md)); only conclusions live here.

| File | Protocol | Answers |
|---|---|---|
| [`storage-decision.md`](storage-decision.md) | 6.5 recovery and storage | Q15 — the minimum owned state, and SQLite as the technology |
| [`endpoint-permission-matrix.md`](endpoint-permission-matrix.md) | 6.1 auth · 6.4 adapter · 6.6 forks | Q16 — the adapter's operation list, the failure catalogue, the permission ceiling |
| [`read-after-write.md`](read-after-write.md) | 6.7 read-after-write | D46's required staleness measurement, and the freshness rule it decides |

**Corrected only by new measurement,** the same rule the fieldwork in [`../audit/`](../audit/README.md)
carries: if a finding turns out to be wrong, the correction is a new protocol run and a new decision
row, not an edit to what a decision appears to have rested on.

Four of the seven feasibility protocols produced no standalone file — installation auth, webhook
delivery, configuration, and forks landed directly as register rows (P9, D31, Q11, Q14).
