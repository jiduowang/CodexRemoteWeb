function reviewDiff(diffResult) {
  const findings = [];
  const diff = diffResult.diff || "";
  const lines = diff.split(/\r?\n/);

  lines.forEach((line, index) => {
    if (!line.startsWith("+") || line.startsWith("+++")) return;
    const content = line.slice(1);
    if (/console\.log\(/.test(content)) {
      findings.push(finding("medium", "Console logging added", "New console logging may leak runtime data or make production output noisy.", index + 1));
    }
    if (/\bTODO\b|\bFIXME\b/i.test(content)) {
      findings.push(finding("low", "Unresolved TODO/FIXME", "New unresolved task markers should be tracked or removed before finishing the change.", index + 1));
    }
    if (/password|api[_-]?key|secret/i.test(content) && /=|:/.test(content)) {
      findings.push(finding("high", "Possible secret in diff", "The added line looks like it may contain a credential or secret value.", index + 1));
    }
  });

  return {
    findings,
    summary: findings.length ? `${findings.length} finding(s) from local deterministic review.` : "No local deterministic review findings.",
    generatedAt: new Date().toISOString()
  };
}

function finding(severity, title, body, line) {
  return {
    id: `finding_${line}_${title.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`,
    severity,
    title,
    body,
    line
  };
}

module.exports = { reviewDiff };
