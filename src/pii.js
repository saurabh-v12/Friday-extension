// DOM-level PII detector (Task 2.1).
//
// Runs on the structured element list produced by content.js — never on raw
// DOM. The snapshot already masks password and sensitive-autocomplete
// values, so this module is safe to import into the service worker (no DOM
// access needed).
//
// Kinds covered: password, email, name, phone, cc, aadhaar, pan, ssn, otp,
// dob. Detection combines four signals per element:
//   1. input `type` (password/email/tel)  — highest precision
//   2. `autocomplete` attribute (HTML spec tokens)
//   3. label / id / accessible-name keyword match
//   4. value regex (only when the value is a plain string, not a mask)

export const PII_KIND = Object.freeze({
  PASSWORD: "password",
  EMAIL: "email",
  NAME: "name",
  PHONE: "phone",
  CC: "cc",
  AADHAAR: "aadhaar",
  PAN: "pan",
  SSN: "ssn",
  OTP: "otp",
  DOB: "dob",
});

export const PATTERNS = Object.freeze({
  email: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/,
  // Aadhaar: 12 digits, optionally split 4-4-4 by space or hyphen.
  aadhaar: /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/,
  // PAN: five letters + four digits + one letter.
  pan: /\b[A-Z]{5}\d{4}[A-Z]\b/,
  ssn: /\b\d{3}-\d{2}-\d{4}\b/,
  cc: /\b(?:\d[ -]?){13,19}\b/,
  phoneIn: /\b(?:\+?91[-\s]?)?[6-9]\d{9}\b/,
  phoneUs: /\b(?:\+?1[-\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/,
});

// Standard HTML autocomplete tokens → PII kind.
const AUTOCOMPLETE_MAP = Object.freeze({
  "current-password": PII_KIND.PASSWORD,
  "new-password": PII_KIND.PASSWORD,
  "one-time-code": PII_KIND.OTP,
  "email": PII_KIND.EMAIL,
  "name": PII_KIND.NAME,
  "given-name": PII_KIND.NAME,
  "family-name": PII_KIND.NAME,
  "additional-name": PII_KIND.NAME,
  "honorific-prefix": PII_KIND.NAME,
  "cc-number": PII_KIND.CC,
  "cc-csc": PII_KIND.CC,
  "cc-name": PII_KIND.NAME,
  "cc-exp": PII_KIND.CC,
  "tel": PII_KIND.PHONE,
  "tel-national": PII_KIND.PHONE,
  "bday": PII_KIND.DOB,
  "bday-day": PII_KIND.DOB,
  "bday-month": PII_KIND.DOB,
  "bday-year": PII_KIND.DOB,
});

// Label / id / name keyword rules. Order doesn't matter — every rule that
// matches contributes a hit (but duplicates on `kind` are suppressed).
const LABEL_RULES = [
  { rx: /\b(?:password|passwd|pwd|passphrase)\b/i, kind: PII_KIND.PASSWORD },
  { rx: /\b(?:email|e-?mail)\b/i, kind: PII_KIND.EMAIL },
  { rx: /\b(?:first[-_\s]?name|last[-_\s]?name|full[-_\s]?name|given[-_\s]?name|family[-_\s]?name|surname|fname|lname|user[-_\s]?name)\b/i, kind: PII_KIND.NAME },
  { rx: /\b(?:phone|mobile|tel|contact[-_\s]?no|whatsapp)\b/i, kind: PII_KIND.PHONE },
  { rx: /\b(?:aadhaar|aadhar|uidai)\b/i, kind: PII_KIND.AADHAAR },
  { rx: /\bpan(?:[-_\s]?(?:card|no|number))?\b/i, kind: PII_KIND.PAN },
  { rx: /\b(?:ssn|social[-_\s]?security)\b/i, kind: PII_KIND.SSN },
  { rx: /\b(?:cc[-_\s]?num|card[-_\s]?num|credit[-_\s]?card|card[-_\s]?number|cvv|cvc)\b/i, kind: PII_KIND.CC },
  { rx: /\b(?:otp|one[-_\s]?time[-_\s]?code|verification[-_\s]?code|auth[-_\s]?code)\b/i, kind: PII_KIND.OTP },
  { rx: /\b(?:dob|birth[-_\s]?date|date[-_\s]?of[-_\s]?birth|birthday)\b/i, kind: PII_KIND.DOB },
];

function addHit(list, kind, source, evidence) {
  if (list.some((h) => h.kind === kind && h.source === source)) return;
  list.push({ kind, source, evidence });
}

// Redact a matched value to short evidence — never echo the raw PII back
// to the caller (defeats the point of detection). Keep enough character
// shape to be recognisable in the receipt.
function redactEvidence(kind, val) {
  if (kind === PII_KIND.EMAIL) {
    // "foo@bar.com" → "f***@bar.com"
    const m = val.match(PATTERNS.email);
    if (!m) return "***@***";
    const [local, domain] = m[0].split("@");
    return `${local[0] || "*"}***@${domain}`;
  }
  if (kind === PII_KIND.AADHAAR) return "****-****-****";
  if (kind === PII_KIND.PAN) return "*****####*";
  if (kind === PII_KIND.SSN) return "***-**-****";
  if (kind === PII_KIND.CC) return "**** **** **** ####";
  if (kind === PII_KIND.PHONE) return "*** *** ****";
  return "***";
}

// Detect PII kinds for a single snapshot element. Returns an array of hits:
//   `[{kind, source, evidence}]`
// where `source` is one of: "type" | "autocomplete" | "label" | "value".
export function detectElementPii(el) {
  if (!el) return [];
  const hits = [];
  const tag = el.tag;
  const type = (el.type || "").toLowerCase();
  const ac = (el.autocomplete || "").toLowerCase();

  // 1) Input type — highest precision.
  if (tag === "input") {
    if (type === "password") addHit(hits, PII_KIND.PASSWORD, "type", "input[type=password]");
    else if (type === "email") addHit(hits, PII_KIND.EMAIL, "type", "input[type=email]");
    else if (type === "tel") addHit(hits, PII_KIND.PHONE, "type", "input[type=tel]");
  }

  // 2) autocomplete attribute (HTML spec tokens).
  if (ac) {
    // Autocomplete can be a token list like "shipping given-name" — split.
    for (const tok of ac.split(/\s+/)) {
      const kind = AUTOCOMPLETE_MAP[tok];
      if (kind) addHit(hits, kind, "autocomplete", `autocomplete="${tok}"`);
    }
  }

  // 3) Label / id / accessible-name keyword match.
  const hay = `${el.name || ""} ${el.id || ""}`.trim();
  if (hay) {
    for (const { rx, kind } of LABEL_RULES) {
      if (rx.test(hay)) addHit(hits, kind, "label", hay.slice(0, 80));
    }
  }

  // 4) Value regex — skip mask/truncation descriptors.
  const val = el.value;
  if (typeof val === "string" && val.length >= 4) {
    if (PATTERNS.email.test(val)) addHit(hits, PII_KIND.EMAIL, "value", redactEvidence(PII_KIND.EMAIL, val));
    if (PATTERNS.aadhaar.test(val)) addHit(hits, PII_KIND.AADHAAR, "value", redactEvidence(PII_KIND.AADHAAR, val));
    if (PATTERNS.pan.test(val)) addHit(hits, PII_KIND.PAN, "value", redactEvidence(PII_KIND.PAN, val));
    if (PATTERNS.ssn.test(val)) addHit(hits, PII_KIND.SSN, "value", redactEvidence(PII_KIND.SSN, val));
    if (PATTERNS.cc.test(val)) addHit(hits, PII_KIND.CC, "value", redactEvidence(PII_KIND.CC, val));
    if (PATTERNS.phoneIn.test(val) || PATTERNS.phoneUs.test(val)) {
      addHit(hits, PII_KIND.PHONE, "value", redactEvidence(PII_KIND.PHONE, val));
    }
  }

  return hits;
}

// Scan an entire snapshot's elements list. Returns:
//   { hits: [...], counts: {kind: N}, total: N }
export function detectDomPii(elements) {
  if (!Array.isArray(elements)) return { hits: [], counts: {}, total: 0 };
  const hits = [];
  const counts = {};
  for (const el of elements) {
    const kinds = detectElementPii(el);
    if (!kinds.length) continue;
    hits.push({
      fid: el.fid,
      tag: el.tag,
      type: el.type,
      role: el.role,
      name: el.name,
      bbox: el.bbox,
      kinds,
    });
    for (const k of kinds) counts[k.kind] = (counts[k.kind] || 0) + 1;
  }
  return { hits, counts, total: hits.length };
}
