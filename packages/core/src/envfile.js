import { StoreEnvError } from "./errors.js";

// Parser and writer for .env files.
// The parser keeps going after a bad line and reports it, so the scanner can
// show every problem in one pass.

const KEY_LINE = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/;
const WRITABLE_KEY = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const PLAIN_VALUE = /^[A-Za-z0-9_\-.:/@+=,%~*?&;!^()[\]{}|<>]*$/;

const ESCAPES = { n: "\n", r: "\r", t: "\t", '"': '"', "\\": "\\", $: "$" };

const findClosingQuote = (text, quote) => {
  for (let i = 0; i < text.length; i++) {
    if (quote === '"' && text[i] === "\\") {
      i++;
      continue;
    }
    if (text[i] === quote) return i;
  }
  return -1;
};

const unescapeDouble = (text) =>
  text.replace(/\\(.)/g, (match, ch) => (ch in ESCAPES ? ESCAPES[ch] : match));

export const parseEnv = (text) => {
  const lines = String(text).replace(/^﻿/, "").split(/\r?\n/);
  const entries = [];
  const issues = [];
  const index = new Map();

  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const trimmed = lines[i].trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    // Only leading space is dropped here: a quoted value that continues on
    // the next line keeps the spaces at the end of its first line.
    const match = KEY_LINE.exec(lines[i].trimStart());
    if (!match) {
      issues.push({ type: "malformed", line: lineNo });
      continue;
    }

    const key = match[1];
    let rest = match[2];
    let value;

    if (rest.startsWith('"') || rest.startsWith("'") || rest.startsWith("`")) {
      const quote = rest[0];
      let buffer = rest.slice(1);
      const parts = [];
      let closed = false;
      for (;;) {
        const end = findClosingQuote(buffer, quote);
        if (end >= 0) {
          parts.push(buffer.slice(0, end));
          closed = true;
          break;
        }
        parts.push(buffer);
        i++;
        if (i >= lines.length) break;
        buffer = lines[i];
      }
      if (!closed) {
        issues.push({ type: "unterminated", line: lineNo, key });
        continue;
      }
      value = parts.join("\n");
      if (quote === '"') value = unescapeDouble(value);
    } else {
      const comment = rest.search(/\s#/);
      if (comment >= 0) rest = rest.slice(0, comment);
      value = rest.trim();
    }

    if (index.has(key)) {
      issues.push({ type: "duplicate", line: lineNo, key });
      entries[index.get(key)] = { key, value, line: lineNo };
    } else {
      index.set(key, entries.length);
      entries.push({ key, value, line: lineNo });
    }
  }

  return { entries, issues };
};

// dotenv compatible quoting. Each form below is read back exactly, both by
// parseEnv and by the dotenv package, and none of them is meant for a
// shell: a pulled file must never be sourced.
//
//   plain     KEY=value          only characters with no meaning to dotenv
//   single    KEY='value'        literal; no ' inside, no trailing backslash
//   backtick  KEY=`value`        literal; no ` inside, no trailing backslash
//   double    KEY="value"        \n and \r escaped; no " and no backslash inside
//   bare      KEY=a b\c          no #, no line break, no space at the ends
//
// A value that fits none of them is written with backslash escapes that
// parseEnv reads back exactly; other dotenv parsers keep the backslashes.
// isDotenvExact reports that case.

// Unquoted with spaces or backslashes inside: no #, no line break, no
// whitespace at either end and no quote at the start.
const BARE_VALUE = /^(?![\s'"`])[^#\r\n]*(?<!\s)$/;

const literalFits = (value, quote) => !value.includes(quote) && !value.endsWith("\\") && !value.includes("\r");

export const quoteStyle = (value) => {
  if (PLAIN_VALUE.test(value)) return "plain";
  if (literalFits(value, "'")) return "single";
  if (literalFits(value, "`")) return "backtick";
  if (!value.includes('"') && !value.includes("\\")) return "double";
  if (BARE_VALUE.test(value)) return "bare";
  return "escaped";
};

export const isDotenvExact = (value) => quoteStyle(String(value ?? "")) !== "escaped";

export const formatValue = (value) => {
  const text = String(value ?? "");
  switch (quoteStyle(text)) {
    case "plain":
    case "bare":
      return text;
    case "single":
      return `'${text}'`;
    case "backtick":
      return `\`${text}\``;
    case "double":
      return `"${text.replace(/\n/g, "\\n").replace(/\r/g, "\\r")}"`;
    default:
      return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t")}"`;
  }
};

export const serializeEnv = (entries, { header } = {}) => {
  const lines = [];
  if (header) {
    for (const line of header.split("\n")) lines.push(`# ${line}`.trimEnd());
    lines.push("");
  }
  for (const entry of entries) {
    // A name outside the parser's own rule could add lines to the file.
    if (typeof entry.key !== "string" || !WRITABLE_KEY.test(entry.key)) {
      throw new StoreEnvError("SE_UNSAFE_ENV", `Refused to write the key ${JSON.stringify(String(entry.key).slice(0, 64))}: it isn't a valid name. Nothing was written.`);
    }
    if (entry.comment) lines.push(`# ${String(entry.comment).replace(/[\r\n]+/g, " ")}`);
    lines.push(`${entry.key}=${formatValue(entry.value ?? "")}`);
  }
  return `${lines.join("\n")}\n`;
};

export const toMap = (entries) => new Map(entries.map((entry) => [entry.key, entry.value]));

export const isValidKey = (key) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key);
export const isConventionalKey = (key) => /^[A-Z_][A-Z0-9_]*$/.test(key);
