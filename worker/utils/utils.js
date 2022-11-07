const MAX_LIST_KEYS = 1_000;
const MAX_KEY_SIZE = 1024;
// https://developers.cloudflare.com/r2/platform/limits/ (5GB - 5MB)
const MAX_VALUE_SIZE = 5 * 1_000 * 1_000 * 1_000 - 5 * 1_000 * 1_000;
const UNPAIRED_SURROGATE_PAIR_REGEX =
  /^(?:[^\uD800-\uDBFF]|^)[\uDC00-\uDFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])$/;
function throwR2Error(method, status, message) {
  throw new Error(`R2 ${method} failed: (${status}) ${message}`);
}
export function parseHttpMetadata(httpMetadata) {
  if (httpMetadata === void(0)) {
    return {};
  }
  httpMetadata = { ...httpMetadata };
  const httpMetadataList = [
    "contentType",
    "contentLanguage",
    "contentDisposition",
    "contentEncoding",
    "cacheControl",
    "cacheExpiry",
  ];
  for (const key of Object.keys(httpMetadata)) {
    if (!httpMetadataList.includes(key)) {
      delete httpMetadata[key];
    }
  }
  return httpMetadata;
}
export function matchStrings(a, b) {
  if (typeof a === "string") return a === b;
  else return a.includes(b);
}
export function testR2Conditional(conditional, metadata) {
  const { etagMatches, etagDoesNotMatch, uploadedBefore, uploadedAfter } =
    conditional;
  if (metadata === void(0)) {
    return etagMatches === void(0) && uploadedAfter === void(0);
  }
  const { etag, uploaded } = metadata;
  const ifMatch = etagMatches ? matchStrings(etagMatches, etag) : null;
  if (ifMatch === false) return false;
  const ifNoneMatch = etagDoesNotMatch
    ? !matchStrings(etagDoesNotMatch, etag)
    : null;
  if (ifNoneMatch === false) return false;
  if (
    ifMatch !== true &&
    uploadedBefore !== void(0) &&
    uploaded > uploadedBefore
  ) {
    return false;
  }
  if (
    ifNoneMatch !== true &&
    uploadedAfter !== void(0) &&
    uploaded < uploadedAfter
  ) {
    return false;
  }
  return true;
}
export function parseHeaderArray(input) {
  if (!input.includes(",")) return stripQuotes(input);
  return input.split(",").map((x) => stripQuotes(x));
}
export function stripQuotes(input) {
  input = input.trim();
  if (input[0] === '"') input = input.slice(1);
  if (input[input.length - 1] === '"') input = input.slice(0, -1);
  return input;
}
export function parseOnlyIf(onlyIf) {
  if (onlyIf === undefined || onlyIf === void(0)) {
    return {};
  }
  if (typeof onlyIf.etagMatches === "string") {
    onlyIf.etagMatches = parseHeaderArray(onlyIf.etagMatches);
  } else if (Array.isArray(onlyIf.etagMatches)) {
    onlyIf.etagMatches = onlyIf.etagMatches.map((x) => stripQuotes(x));
  }
  if (typeof onlyIf.etagDoesNotMatch === "string") {
    onlyIf.etagDoesNotMatch = parseHeaderArray(onlyIf.etagDoesNotMatch);
  } else if (Array.isArray(onlyIf.etagDoesNotMatch)) {
    onlyIf.etagDoesNotMatch = onlyIf.etagDoesNotMatch.map((x) =>
      stripQuotes(x)
    );
  }
  if (typeof onlyIf.uploadedBefore === "string") {
    onlyIf.uploadedBefore = new Date(stripQuotes(onlyIf.uploadedBefore));
  }
  if (typeof onlyIf.uploadedAfter === "string") {
    onlyIf.uploadedAfter = new Date(stripQuotes(onlyIf.uploadedAfter));
  }
  return onlyIf;
}
export function parseR2ObjectMetadata(meta) {
  meta.uploaded = new Date(meta.uploaded);
  if (meta.httpMetadata.cacheExpiry) {
    meta.httpMetadata.cacheExpiry = new Date(meta.httpMetadata.cacheExpiry);
  }
}
export function validateKey(method, key) {
  // Check key isn't too long and exists outside regex
  const encoder = new TextEncoder();
  const keyLength = encoder.encode(key).byteLength;
  if (UNPAIRED_SURROGATE_PAIR_REGEX.test(key)) {
    throwR2Error(method, 400, "Key contains an illegal unicode value(s).");
  }
  if (keyLength >= MAX_KEY_SIZE) {
    throwR2Error(
      method,
      414,
      `UTF-8 encoded length of ${keyLength} exceeds key length limit of ${MAX_KEY_SIZE}.`
    );
  }
}
export function validateOnlyIf(onlyIf, method) {
  if (onlyIf === undefined || onlyIf instanceof Headers) return;
  if (typeof onlyIf !== "object") {
    throwR2Error(
      method,
      400,
      "onlyIf must be an object, a Headers instance, or undefined."
    );
  }

  // Check onlyIf variables
  const { etagMatches, etagDoesNotMatch, uploadedBefore, uploadedAfter } =
    onlyIf;
  if (
    etagMatches !== undefined &&
    !(typeof etagMatches === "string" || Array.isArray(etagMatches))
  ) {
    throwR2Error(method, 400, "etagMatches must be a string.");
  }
  if (
    etagDoesNotMatch !== undefined &&
    !(typeof etagDoesNotMatch === "string" || Array.isArray(etagDoesNotMatch))
  ) {
    throwR2Error(method, 400, "etagDoesNotMatch must be a string.");
  }
  if (uploadedBefore !== undefined && !(uploadedBefore instanceof Date)) {
    throwR2Error(method, 400, "uploadedBefore must be a Date.");
  }
  if (uploadedAfter !== undefined && !(uploadedAfter instanceof Date)) {
    throwR2Error(method, 400, "uploadedAfter must be a Date.");
  }
}
export function validateGetOptions(options) {
  const { onlyIf = {}, range = {} } = options;
  validateOnlyIf(onlyIf, "GET");
  if (typeof range !== "object") {
    throwR2Error("GET", 400, "range must either be an object or undefined.");
  }
  const { offset, length, suffix } = range;
  if (offset !== undefined) {
    if (typeof offset !== "number") {
      throwR2Error("GET", 400, "offset must either be a number or undefined.");
    }
    if (offset < 0) {
      throwR2Error(
        "GET",
        400,
        "Invalid range. Starting offset must be greater than or equal to 0."
      );
    }
  }
  if (length !== undefined && typeof length !== "number") {
    throwR2Error("GET", 400, "length must either be a number or undefined.");
  }
  if (suffix !== undefined && typeof suffix !== "number") {
    throwR2Error("GET", 400, "suffix must either be a number or undefined.");
  }
}
export function validateHttpMetadata(httpMetadata) {
  if (httpMetadata === undefined || httpMetadata instanceof Headers) return;
  if (typeof httpMetadata !== "object") {
    throwR2Error("PUT", 400, "httpMetadata must be an object or undefined.");
  }
  for (const [key, value] of Object.entries(httpMetadata)) {
    if (key === "cacheExpiry") {
      if (!(value instanceof Date) && value !== undefined) {
        throwR2Error(
          "PUT",
          400,
          "cacheExpiry's value must be a Date or undefined."
        );
      }
    } else {
      if (typeof value !== "string" && value !== undefined) {
        throwR2Error(
          "PUT",
          400,
          `${key}'s value must be a string or undefined.`
        );
      }
    }
  }
}
export function validatePutOptions(options) {
  const { onlyIf = {}, httpMetadata, customMetadata, md5 } = options;

  validateOnlyIf(onlyIf, "PUT");
  validateHttpMetadata(httpMetadata);

  if (customMetadata !== undefined) {
    if (typeof customMetadata !== "object") {
      throwR2Error(
        "PUT",
        400,
        "customMetadata must be an object or undefined."
      );
    }
    for (const value of Object.values(customMetadata)) {
      if (typeof value !== "string") {
        throwR2Error("PUT", 400, "customMetadata values must be strings.");
      }
    }
  }

  if (
    md5 !== undefined &&
    !(md5 instanceof ArrayBuffer) &&
    typeof md5 !== "string"
  ) {
    throwR2Error(
      "PUT",
      400,
      "md5 must be a string, ArrayBuffer, or undefined."
    );
  }
}
export async function _valueToArray(value) {
  const encoder = new TextEncoder();
  if (typeof value === "string") {
    return encoder.encode(value);
  } else if (value instanceof ReadableStream) {
    // @ts-expect-error @types/node stream/consumers doesn't accept ReadableStream
    return new Uint8Array(await arrayBuffer(value));
  } else if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  } else if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  } else if (value === null) {
    return new Uint8Array();
  } else if (value instanceof Blob) {
    return new Uint8Array(await value.arrayBuffer());
  } else {
    throw new TypeError(
      "R2 put() accepts only nulls, strings, Blobs, ArrayBuffers, ArrayBufferViews, and ReadableStreams as values."
    );
  }
}
export function getParams(req) {
  const errors = [];
  const params = {
    bg: [],
    dx: 0,
    dy: 0,
    errors,
    format: "",
    height: 0,
    mode: "",
    origin: "",
    quality: 90,
    scale: 1,
    width: 0,
  };

  const reqUrl = new URL(req.url);
  const searchParams = reqUrl.searchParams;

  const format = getUrlExt(reqUrl);
  if (format) {
    params.format = format;
    if (!VALID_FORMATS.includes(params.format)) {
      errors.push(
        `image .extension must be one of ${format} ${VALID_FORMATS.join(", ")}`
      );
    }
  }

  if (searchParams.has("quality")) {
    params.quality = parseInt(searchParams.get("quality"), 10);
    if (params.quality > 100 || params.quality < 40) {
      errors.push("quality must be a number between 40 and 100");
    }
  }

  if (searchParams.has("origin")) {
    try {
      params.origin = new URL(searchParams.get("origin"));
    } catch (_) {}
  }

  if (!params.origin) {
    errors.push("origin must be a valid image URL");
  }

  if (searchParams.has("width")) {
    params.width = parseInt(searchParams.get("width"), 10);
    if (!(params.width > -1)) {
      errors.push("width must be a positive number");
    }
  }

  if (searchParams.has("height")) {
    params.height = parseInt(searchParams.get("height"), 10);
    if (!(params.height > -1)) {
      errors.push("height must be a positive number");
    }
  }

  if (!(params.width || params.height)) {
    errors.push("width and/or height must be provided");
  }

  if (searchParams.has("dx")) {
    params.dx = parseFloat(searchParams.get("dx"));
    if (!(params.dx >= -1 || params.dx <= 1)) {
      errors.push("dx must be a number between -1.0 and 1.0 (default: 0)");
    }
  }

  if (searchParams.has("dy")) {
    params.dy = parseFloat(searchParams.get("dy"));
    if (!(params.dy >= -1 || params.dy <= 1)) {
      errors.push("dy must be between -1.0 and 1.0 (default: 0)");
    }
  }

  if (searchParams.has("scale")) {
    params.scale = parseFloat(searchParams.get("scale"));
    if (!(params.scale > 0 || params.scale <= 10)) {
      errors.push("scale must be a non-zero number up to 10 (default: 1)");
    }
  }

  if (searchParams.has("mode")) {
    params.mode = String(searchParams.get("mode").toLowerCase());
  }

  if (!VALID_MODES.includes(params.mode)) {
    errors.push(`mode must be one of ${VALID_MODES.join(", ")}`);
  }

  if (searchParams.has("bg")) {
    const bg = getColor(String(searchParams.get("bg")).toLowerCase());
    if (bg) {
      params.bg = bg;
    } else {
      errors.push("bg must be a valid hex color between 000 and ffffff");
    }
  }

  return params;
}

function getUrlExt(url) {
  const extMatch = url.pathname.match(/\.(\w+)$/);
  return extMatch && extMatch[1].toLowerCase();
}

function getColor(hexStr) {
  if (hexStr.length === 3) {
    hexStr = hexStr
      .split("")
      .map((c) => c + c)
      .join("");
  }
  if (hexStr.length === 6) {
    const output = [];
    for (let i = 0; i < 3; i++) {
      const hex = parseInt(hexStr.slice(0, 2), 16);
      if (hex === NaN) {
        return;
      }
      output.push(hex);
    }
    return output;
  }
}

export function getMimeType(format) {
  return (
    {
      png: "image/png",
      jpg: "image/jpeg",
    }[format] || "application/octet-stream"
  );
}
export const VALID_FORMATS = ["png", "jpg", "jpeg"];
export const VALID_MODES = ["fill", "fit", "limit"];