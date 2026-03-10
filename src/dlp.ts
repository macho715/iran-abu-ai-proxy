export type DlpSeverity = "none" | "low" | "medium" | "high" | "critical";

export type DlpRule = {
  id: string;
  severity: Exclude<DlpSeverity, "none">;
  pattern: RegExp;
  description: string;
  redactWith?: string;
};

export type DlpFinding = {
  ruleId: string;
  severity: Exclude<DlpSeverity, "none">;
  description: string;
  matchedTextPreview: string;
};

export type DlpMessage = {
  role: string;
  content: string;
};

export type DlpMessageScan = {
  index: number;
  findings: DlpFinding[];
  originalContent: string;
  sanitizedContent: string;
};

export type DlpPolicy = {
  sanitizeAtOrAbove: Exclude<DlpSeverity, "none">;
  blockAtOrAbove: Exclude<DlpSeverity, "none">;
  includeEntropyRule: boolean;
};

export type DlpScanResult = {
  status: "allow" | "sanitize" | "block";
  highestSeverity: DlpSeverity;
  messageScans: DlpMessageScan[];
  findings: DlpFinding[];
};

const DEFAULT_REDACT = "[REDACTED]";
const SEVERITY_ORDER: Record<DlpSeverity, number> = {
  none: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

const DEFAULT_POLICY: DlpPolicy = {
  sanitizeAtOrAbove: "medium",
  blockAtOrAbove: "high",
  includeEntropyRule: true,
};

const DEFAULT_RULES: DlpRule[] = [
  {
    id: "openai_sk",
    severity: "critical",
    pattern: /\bsk-[A-Za-z0-9_-]{12,}\b/g,
    description: "OpenAI style API key detected.",
  },
  {
    id: "github_pat",
    severity: "critical",
    pattern: /\b(?:ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
    description: "GitHub personal access token detected.",
  },
  {
    id: "bearer_token",
    severity: "high",
    pattern: /\bBearer\s+[A-Za-z0-9._\-+=]{18,}\b/gi,
    description: "Bearer token detected.",
  },
  {
    id: "private_key",
    severity: "critical",
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]+?-----END [A-Z ]*PRIVATE KEY-----/g,
    description: "Private key block detected.",
    redactWith: "[REDACTED_PRIVATE_KEY]",
  },
  {
    id: "password_assignment",
    severity: "high",
    pattern: /\b(?:password|passwd|secret|api[_-]?key|token)\b\s*[:=]\s*["']?[^,\s"']{6,}/gi,
    description: "Credential assignment detected.",
  },
  {
    id: "email",
    severity: "medium",
    pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
    description: "Email address detected.",
  },
  {
    id: "phone_number",
    severity: "medium",
    pattern: /\b(?:\+?\d[\d\-() ]{8,}\d)\b/g,
    description: "Phone number detected.",
  },
];

function shouldApplyThreshold(
  severity: Exclude<DlpSeverity, "none">,
  threshold: Exclude<DlpSeverity, "none">,
): boolean {
  return SEVERITY_ORDER[severity] >= SEVERITY_ORDER[threshold];
}

function maxSeverity(left: DlpSeverity, right: DlpSeverity): DlpSeverity {
  return SEVERITY_ORDER[left] >= SEVERITY_ORDER[right] ? left : right;
}

function maskPreview(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= 8) {
    return "***";
  }
  return `${trimmed.slice(0, 4)}...${trimmed.slice(-3)}`;
}

function escapeRegexLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function shannonEntropy(value: string): number {
  const frequencies = new Map<string, number>();
  for (const char of value) {
    frequencies.set(char, (frequencies.get(char) ?? 0) + 1);
  }
  let entropy = 0;
  for (const count of frequencies.values()) {
    const probability = count / value.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy;
}

function detectHighEntropy(content: string): DlpFinding[] {
  const candidates = content.match(/[A-Za-z0-9+/_=-]{24,}/g) ?? [];
  const findings: DlpFinding[] = [];
  for (const token of candidates) {
    const diversity =
      Number(/[A-Z]/.test(token)) +
      Number(/[a-z]/.test(token)) +
      Number(/\d/.test(token)) +
      Number(/[+/_=-]/.test(token));
    if (diversity < 3 || shannonEntropy(token) < 3.5) {
      continue;
    }
    findings.push({
      ruleId: "entropy_token",
      severity: "high",
      description: "High-entropy token-like string detected.",
      matchedTextPreview: maskPreview(token),
    });
  }
  return findings;
}

function scanByRules(content: string, rules: DlpRule[]): DlpFinding[] {
  const findings: DlpFinding[] = [];
  for (const rule of rules) {
    const pattern = new RegExp(rule.pattern.source, rule.pattern.flags);
    const matches = content.match(pattern) ?? [];
    for (const match of matches) {
      findings.push({
        ruleId: rule.id,
        severity: rule.severity,
        description: rule.description,
        matchedTextPreview: maskPreview(match),
      });
    }
  }
  return findings;
}

function sanitizeContent(content: string, rules: DlpRule[], policy: DlpPolicy): string {
  let next = content;
  for (const rule of rules) {
    if (!shouldApplyThreshold(rule.severity, policy.sanitizeAtOrAbove)) {
      continue;
    }
    next = next.replace(rule.pattern, rule.redactWith ?? DEFAULT_REDACT);
  }
  if (!policy.includeEntropyRule) {
    return next;
  }
  const candidates = content.match(/[A-Za-z0-9+/_=-]{24,}/g) ?? [];
  for (const token of candidates) {
    if (shannonEntropy(token) < 3.5) {
      continue;
    }
    next = next.replace(new RegExp(escapeRegexLiteral(token), "g"), DEFAULT_REDACT);
  }
  return next;
}

export function scanMessagesForDlp(
  messages: DlpMessage[],
  opts?: {
    rules?: DlpRule[];
    policy?: Partial<DlpPolicy>;
  },
): DlpScanResult {
  const rules = opts?.rules?.length ? opts.rules : DEFAULT_RULES;
  const policy: DlpPolicy = {
    ...DEFAULT_POLICY,
    ...(opts?.policy ?? {}),
  };

  const findings: DlpFinding[] = [];
  const messageScans: DlpMessageScan[] = [];
  let highestSeverity: DlpSeverity = "none";

  for (const [index, message] of messages.entries()) {
    const content = String(message.content ?? "");
    const combinedFindings = [
      ...scanByRules(content, rules),
      ...(policy.includeEntropyRule ? detectHighEntropy(content) : []),
    ];
    for (const finding of combinedFindings) {
      findings.push(finding);
      highestSeverity = maxSeverity(highestSeverity, finding.severity);
    }
    messageScans.push({
      index,
      findings: combinedFindings,
      originalContent: content,
      sanitizedContent: sanitizeContent(content, rules, policy),
    });
  }

  let status: DlpScanResult["status"] = "allow";
  if (findings.some((finding) => shouldApplyThreshold(finding.severity, policy.blockAtOrAbove))) {
    status = "block";
  } else if (
    findings.some((finding) => shouldApplyThreshold(finding.severity, policy.sanitizeAtOrAbove))
  ) {
    status = "sanitize";
  }

  return {
    status,
    highestSeverity,
    messageScans,
    findings,
  };
}
