---
name: bivia
description: Make calibrated, typed decisions with confidence scores, source evidence, and honest abstention using the Bivia MCP server. Use when triaging, classifying, scoring risk/severity, selecting actions, locating supporting text spans, grounding objects in images, or deciding over numeric signals.
---

# Bivia Decision Engine

Use the `bivia` MCP tools whenever a task needs a **calibrated, structured decision** rather than an uncalibrated guess — especially for classification, triage, risk/severity scoring, compliance checks, routing, or evidence localization.

## Choosing the right tool

| Goal | Tool | Required inputs |
|---|---|---|
| Yes / no decision | `bivia_boolean` | `question`, `state?` |
| Pick one option from a list (routing, triage, next action) | `bivia_choice` | `question`, `choices[]`, `state?` |
| Numeric rating on a scale (risk, urgency, quality) | `bivia_score` | `question`, `range?: [min, max]`, `state?` |
| Multi-select: every option that applies (0, 1, or many) | `bivia_set` | `question`, `options[]`, `state?` |
| Quote exact supporting passages with character offsets | `bivia_span` | `question`, `state` |
| Auto-detect decision type when output shape isn't fixed | `bivia_decide` | `question`, `outcomes[]?`, `state?` |
| Locate objects in an image (`[0, 1000]` bounding boxes) | `bivia_ground` | `question`, `image: { url \| b64, mime }` |
| Decide over raw numeric / sensor signals | `bivia_ds` | `question`, `signals[]`, `options[]?`, `kind?` |

## Best practices

1. **Put facts in `state`, ask cleanly in `question`.**
   Keep `state` as plain text containing the relevant facts/excerpt, and keep `question` focused on the single decision to make.
2. **Respect honest abstention (`status: "abstained"` / `"unsure"`).**
   Abstention is a feature, not an error. Never override `"unsure"` by guessing:
   - First, check if you can gather more context and re-ask with a richer `state`.
   - If evidence is genuinely missing or conflicting, surface the abstention and probability distribution to the user.
3. **Use the full probability distribution for high-stakes calls.**
   Inspect `probability` / `distribution` (or `probabilities` for `bivia_set`, `levels` for `bivia_score`) to apply thresholds appropriate to the risk level rather than treating a 0.55 pick the same as a 0.97 pick.
4. **Pair decisions with evidence when auditability matters.**
   After `bivia_boolean` or `bivia_choice`, call `bivia_span` on the same `state` to return exact character offsets and quoted text supporting the answer.
5. **Handle authentication smoothly.**
   If a tool fails due to missing or expired credentials, call `bivia_auth_status` to inspect state, and guide the user through `bivia_login` (or `bivia_signup` if they don't have an account yet).
