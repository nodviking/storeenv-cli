const UNITS = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };

// "24h", "7d", "30d", "2w" -> milliseconds. "never" -> null.
export const parseDuration = (text) => {
  const raw = String(text || "").trim().toLowerCase();
  if (!raw || raw === "never" || raw === "none") return null;
  const match = /^(\d+)\s*([mhdw])$/.exec(raw);
  if (!match) return undefined;
  return Number(match[1]) * UNITS[match[2]];
};

export const expiryFromNow = (text, now = Date.now()) => {
  const ms = parseDuration(text);
  if (ms === undefined) return undefined;
  return ms === null ? null : new Date(now + ms);
};

export const timeAgo = (value, now = Date.now()) => {
  const seconds = Math.max(0, Math.round((now - new Date(value).getTime()) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 60) return `${days}d ago`;
  const months = Math.round(days / 30);
  return months < 24 ? `${months}mo ago` : `${Math.round(months / 12)}y ago`;
};

export const timeUntil = (value, now = Date.now()) => {
  const seconds = Math.round((new Date(value).getTime() - now) / 1000);
  if (seconds <= 0) return "expired";
  const hours = Math.round(seconds / 3600);
  if (hours < 1) return `${Math.max(1, Math.round(seconds / 60))}m`;
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
};
