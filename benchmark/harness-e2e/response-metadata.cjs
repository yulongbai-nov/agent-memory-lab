"use strict";
const statuses = new Set([
  "completed",
  "incomplete",
  "failed",
  "cancelled",
  "in_progress",
  "queued",
]);
const reasons = new Set(["max_output_tokens", "content_filter"]);
const errors = new Set([
  "server_error",
  "rate_limit_exceeded",
  "model_not_found",
  "invalid_request_error",
  "insufficient_quota",
  "timeout",
  "authentication_error",
]);
function bounded(value, known) {
  if (value == null) return null;
  return typeof value === "string" && known.has(value) ? value : "other";
}
function numericTree(value, depth = 0) {
  if (!value || typeof value !== "object" || Array.isArray(value) || depth > 2)
    return {};
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => /^[a-z_]{1,40}$/.test(key))
      .flatMap(([key, v]) =>
        Number.isSafeInteger(v) && v >= 0
          ? [[key, v]]
          : v && typeof v === "object" && !Array.isArray(v) && depth < 2
            ? [[key, numericTree(v, depth + 1)]]
            : [],
      ),
  );
}
function safeMetadata(response) {
  return {
    providerStatus: bounded(response?.status, statuses),
    incompleteReason: bounded(response?.incomplete_details?.reason, reasons),
    errorCode: bounded(response?.error?.code, errors),
    usage:
      response?.usage &&
      typeof response.usage === "object" &&
      !Array.isArray(response.usage)
        ? numericTree(response.usage)
        : null,
  };
}
module.exports = { safeMetadata };
