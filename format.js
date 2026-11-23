// Result formatting shared by the MCP tools. Turns a Bivia response envelope into short, honest text
// (never fabricates; surfaces abstention). The API itself is called through @articul8/bivia.

function confidence(res) {
  return typeof res.probability === "number"
    ? ` (confidence ${res.probability.toFixed(2)})`
    : "";
}

/** True when the model declined (status:"abstained" or value:null). */
export function isAbstained(res) {
  return !res || res.status === "abstained" || res.value == null;
}

/** One-line (or short multi-line) human answer. */
export function formatAnswer(res) {
  if (!res) return "No response.";
  if (isAbstained(res)) {
    const reason = res.abstain_reason ? ` — ${res.abstain_reason}` : "";
    return `unsure — the model declined (abstained)${reason}`;
  }

  const type = res.type;
  const v = res.value;

  if (type === "span") {
    if (!Array.isArray(v) || v.length === 0) return "no evidence span found";
    return v
      .map((s) => `• "${s.text}" [${s.start}-${s.end}]`)
      .join("\n");
  }

  if (type === "ground" || type === "video_ground") {
    if (!Array.isArray(v) || v.length === 0)
      return "no regions found (empty — check /capabilities if unexpected)";
    return v
      .map((r) => `• ${r.label}: box [${(r.box || []).join(", ")}]`)
      .join("\n");
  }

  // set → array of chosen options; boolean/choice/score/decide/ds → scalar.
  if (Array.isArray(v)) return `${v.join(", ")}${confidence(res)}`;
  return `${v}${confidence(res)}`;
}

/** The full calibrated distribution, as aligned percentage lines. */
export function formatDistribution(res) {
  if (!res) return "";
  const dist = res.distribution || res.levels || res.probabilities;
  if (!dist || typeof dist !== "object") return "";
  const entries = Object.entries(dist).sort((a, b) => Number(b[1]) - Number(a[1]));
  if (entries.length === 0) return "";
  return entries
    .map(([k, val]) => `  ${k}: ${(Number(val) * 100).toFixed(1)}%`)
    .join("\n");
}
