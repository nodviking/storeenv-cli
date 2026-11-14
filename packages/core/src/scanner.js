// The secret scanner looks at env files before they are pushed.
// Findings never contain a full value: only a short recognisable prefix.

import { isConventionalKey, parseEnv } from "./envfile.js";

export const PROVIDERS = [
  { id: "aws", label: "AWS access key", pattern: /^(AKIA|ASIA)[0-9A-Z]{16}$/, live: true, rotateUrl: "https://console.aws.amazon.com/iam/home#/security_credentials" },
  { id: "stripe", label: "Stripe live key", pattern: /^(sk|rk)_live_[0-9A-Za-z]{10,}$/, live: true, rotateUrl: "https://dashboard.stripe.com/apikeys" },
  { id: "stripe-test", label: "Stripe test key", pattern: /^(sk|rk)_test_[0-9A-Za-z]{10,}$/, live: false, rotateUrl: "https://dashboard.stripe.com/test/apikeys" },
  { id: "razorpay", label: "Razorpay live key", pattern: /^rzp_live_[0-9A-Za-z]{6,}$/, live: true, rotateUrl: "https://dashboard.razorpay.com/app/keys" },
  { id: "openai", label: "OpenAI API key", pattern: /^sk-(proj-|svcacct-)?[A-Za-z0-9_-]{20,}$/, live: true, rotateUrl: "https://platform.openai.com/api-keys" },
  { id: "anthropic", label: "Anthropic API key", pattern: /^sk-ant-[A-Za-z0-9_-]{20,}$/, live: true, rotateUrl: "https://console.anthropic.com/settings/keys" },
  { id: "google", label: "Google or Firebase API key", pattern: /^AIza[0-9A-Za-z_-]{35}$/, live: true, rotateUrl: "https://console.cloud.google.com/apis/credentials" },
  { id: "github", label: "GitHub token", pattern: /^(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}$|^github_pat_[A-Za-z0-9_]{30,}$/, live: true, rotateUrl: "https://github.com/settings/tokens" },
  { id: "slack", label: "Slack token", pattern: /^xox[baprs]-[A-Za-z0-9-]{10,}$/, live: true, rotateUrl: "https://api.slack.com/apps" },
  { id: "sendgrid", label: "SendGrid API key", pattern: /^SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}$/, live: true, rotateUrl: "https://app.sendgrid.com/settings/api_keys" },
  { id: "twilio", label: "Twilio API key", pattern: /^SK[0-9a-f]{32}$/, live: true, rotateUrl: "https://console.twilio.com/" },
  { id: "mongodb", label: "MongoDB connection string with a password", pattern: /^mongodb(\+srv)?:\/\/[^:@/\s]+:[^@/\s]+@/, live: true, rotateUrl: "https://cloud.mongodb.com/" },
  { id: "postgres", label: "Postgres connection string with a password", pattern: /^postgres(ql)?:\/\/[^:@/\s]+:[^@/\s]+@/, live: true },
  { id: "redis", label: "Redis connection string with a password", pattern: /^rediss?:\/\/[^@/\s]*:[^@/\s]+@/, live: true },
  { id: "jwt", label: "JSON Web Token", pattern: /^eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+$/, live: true },
  { id: "private-key", label: "Private key (PEM)", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, live: true },
];

const PLACEHOLDERS = /^(changeme|change_me|your[_-].*|xxx+|todo|replace[_-]?me|example|<.*>|\.\.\.)$/i;

export const detectProvider = (value) => PROVIDERS.find((provider) => provider.pattern.test(String(value || "").trim())) || null;

export const looksLikeSecret = (value) => {
  const text = String(value || "").trim();
  if (detectProvider(text)) return true;
  return text.length >= 24 && /[A-Za-z]/.test(text) && /[0-9]/.test(text) && !/\s/.test(text) && !/^https?:\/\/[^@]*$/.test(text);
};

// A short, safe hint such as "rzp_live_..." for messages.
export const safePrefix = (value) => {
  const text = String(value || "");
  const match = /^[A-Za-z]+[_-](?:[A-Za-z]+[_-])?/.exec(text);
  if (match && match[0].length <= 12) return `${match[0]}...`;
  const scheme = /^[a-z+]+:\/\//.exec(text);
  if (scheme) return `${scheme[0]}...`;
  return `${text.slice(0, 4)}...`;
};

// Returns findings: { level: "error" | "warn" | "info", type, file, line, key, message, provider, rotateUrl }
export const scan = (text, { file = ".env" } = {}) => {
  const { entries, issues } = parseEnv(text);
  const findings = [];

  for (const issue of issues) {
    if (issue.type === "malformed") {
      findings.push({ level: "error", type: "malformed", file, line: issue.line, message: `${file} line ${issue.line} isn't KEY=value` });
    } else if (issue.type === "unterminated") {
      findings.push({ level: "error", type: "unterminated", file, line: issue.line, key: issue.key, message: `${file} line ${issue.line}: ${issue.key} has a quote that never closes` });
    } else if (issue.type === "duplicate") {
      findings.push({ level: "warn", type: "duplicate", file, line: issue.line, key: issue.key, message: `${file} line ${issue.line}: duplicate key ${issue.key} (last value wins)` });
    }
  }

  for (const entry of entries) {
    const base = { file, line: entry.line, key: entry.key };
    if (!isConventionalKey(entry.key)) {
      findings.push({ ...base, level: "info", type: "key-style", message: `${entry.key} isn't UPPER_SNAKE_CASE` });
    }
    if (entry.value === "") {
      findings.push({ ...base, level: "info", type: "empty", message: `${entry.key} has an empty value` });
      continue;
    }
    if (PLACEHOLDERS.test(entry.value)) {
      findings.push({ ...base, level: "info", type: "placeholder", message: `${entry.key} looks like a placeholder` });
      continue;
    }
    const provider = detectProvider(entry.value);
    if (provider) {
      findings.push({
        ...base,
        level: provider.live ? "warn" : "info",
        type: "provider-key",
        provider: provider.id,
        rotateUrl: provider.rotateUrl,
        message: `${entry.key} looks like a ${provider.label} (${safePrefix(entry.value)})`,
      });
    }
  }

  return findings;
};

export const hasBlockingFindings = (findings) => findings.some((finding) => finding.level === "error");
