// IntentLock Policy Engine — deterministic, never delegated to an LLM.
// Every candidate the agents propose and every payment the backend creates
// passes through evaluate(). The LLM can only *explain*; it cannot override.

export const DEFAULT_POLICY = {
  maxPerItem: 150,          // USD hard cap per purchase
  totalBudget: 300,         // USD cap across all captured payments in this session
  allowedCategories: [],    // empty = any category
  blockedMerchants: [],
  minMerchantRating: 3.5,   // 0-5
  maxRiskScore: 60,         // 0-100 (Trust Agent output)
  requireApproval: true,    // human gate is always on; kept for display
};

export function normalizePolicy(p = {}) {
  const out = { ...DEFAULT_POLICY, ...p };
  out.maxPerItem = Math.max(0, Number(out.maxPerItem) || 0);
  out.totalBudget = Math.max(0, Number(out.totalBudget) || 0);
  out.minMerchantRating = Math.min(5, Math.max(0, Number(out.minMerchantRating) || 0));
  out.maxRiskScore = Math.min(100, Math.max(0, Number(out.maxRiskScore) || 0));
  out.allowedCategories = toList(out.allowedCategories);
  out.blockedMerchants = toList(out.blockedMerchants);
  out.requireApproval = true; // cannot be disabled
  return out;
}

function toList(v) {
  if (Array.isArray(v)) return v.map(s => String(s).trim().toLowerCase()).filter(Boolean);
  return String(v || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
}

/**
 * @param candidate {price, category, merchant, merchantRating, riskScore}
 * @param policy normalized policy
 * @param spent USD already captured in this session
 * @returns {allowed, violations[]}
 */
export function evaluate(candidate, policy, spent = 0) {
  const v = [];
  const price = round2(candidate.finalPrice ?? candidate.price);
  if (price > policy.maxPerItem)
    v.push({ rule: 'maxPerItem', msg: `$${price} exceeds per-item limit of $${policy.maxPerItem}` });
  if (round2(spent + price) > policy.totalBudget)
    v.push({ rule: 'totalBudget', msg: `$${price} would bring total to $${round2(spent + price)}, over budget $${policy.totalBudget}` });
  if (policy.allowedCategories.length && !policy.allowedCategories.includes(String(candidate.category).toLowerCase()))
    v.push({ rule: 'allowedCategories', msg: `category "${candidate.category}" not in allowed list` });
  if (policy.blockedMerchants.includes(String(candidate.merchant).toLowerCase()))
    v.push({ rule: 'blockedMerchants', msg: `merchant "${candidate.merchant}" is blocked` });
  if ((candidate.merchantRating ?? 0) < policy.minMerchantRating)
    v.push({ rule: 'minMerchantRating', msg: `merchant rating ${candidate.merchantRating} below minimum ${policy.minMerchantRating}` });
  if (candidate.riskScore != null && candidate.riskScore > policy.maxRiskScore)
    v.push({ rule: 'maxRiskScore', msg: `risk score ${candidate.riskScore} above limit ${policy.maxRiskScore}` });
  return { allowed: v.length === 0, violations: v };
}

export const round2 = n => Math.round(Number(n) * 100) / 100;
