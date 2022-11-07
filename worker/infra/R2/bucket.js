import {
  _valueToArray,
  parseOnlyIf,
  throwR2Error,
  validatePutOptions,
  testR2Conditional,
  validateKey,
  validateGetOptions,
  parseR2ObjectMetadata,
  parseHttpMetadata,
} from "../../utils";

var R2Object = class {
  key;
  version;
  size;
  etag;
  httpEtag;
  uploaded;
  httpMetadata;
  customMetadata;
  range;
  constructor(metadata) {
    this.key = metadata.key;
    this.version = metadata.version;
    this.size = metadata.size;
    this.etag = metadata.etag;
    this.httpEtag = metadata.httpEtag;
    this.uploaded = metadata.uploaded;
    this.httpMetadata = metadata.httpMetadata;
    this.customMetadata = metadata.customMetadata;
    this.range = metadata.range;
  }
  writeHttpMetadata(headers) {
    for (const [key, value] of Object.entries(this.httpMetadata)) {
      const camelToDash = key.replace(/([A-Z])/g, "-$1").toLowerCase();
      headers.set(camelToDash, value);
    }
  }
};
var R2ObjectBody = class extends R2Object {
  body;
  bodyUsed = false;
  constructor(metadata, value) {
    super(metadata);
    const setBodyUsed = () => {
      this.bodyUsed = true;
    };
    this.body = new ReadableStream({
      async pull(controller) {
        if (value.byteLength) {
          controller.enqueue(value);
        }
        controller.close();
        controller.byobRequest?.respond(0);
        setBodyUsed();
      },
    });
  }
  async arrayBuffer() {
    if (this.bodyUsed) {
      throw new TypeError("Body already used.");
    }
    return new ArrayBuffer(this.body);
  }
  async text() {
    let decoder = new TextDecoder();
    return decoder.decode(await this.arrayBuffer());
  }
  async json() {
    return JSON.parse(await this.text());
  }
  async blob() {
    const ab = await this.arrayBuffer();
    return new Blob([new Uint8Array(ab)]);
  }
};

export class R2Bucket {
  #storage;

  constructor(storage) {
    this.#storage = storage;
  }

  async #head(key) {
    // Validate key
    validateKey("HEAD", key);
    // Get value, returning null if not found
    const stored = await this.#storage.head(key);
    if (stored?.metadata === undefined) {
      return null;
    }
    const { metadata } = stored;
    parseR2ObjectMetadata(metadata);

    return new R2Object(metadata);
  }

  async head(key) {
    return this.#head(key);
  }

  async get(key, options) {
    options = options ?? {};
    // Validate key
    validateKey("GET", key);
    // Validate options
    validateGetOptions(options);
    // In the event that an onlyIf precondition fails, we return
    // the R2Object without the body. Otherwise return with body.
    const onlyIf = parseOnlyIf(options?.onlyIf) || null;
    const meta = await this.#head(key);
    // if bad metadata, return null
    if (meta === null || onlyIf === null) {
      return null;
    }
    // test conditional should it exist
    if (!testR2Conditional(onlyIf, meta) || meta?.size === 0) {
      return new R2Object(meta);
    }
    let stored = await this.#storage.get(key);
    if (!stored) {
      throwR2Error("GET", 400, "The requested range is not satisfiable.");
    }
    // if bad metadata, return null
    if (stored?.metadata === undefined) {
      return null;
    }
    const { value, metadata } = stored;
    // fix dates
    parseR2ObjectMetadata(metadata);
    return new R2ObjectBody(metadata, value);
  }

  async put(key, value, options = {}) {
    // Validate options
    validatePutOptions(options);
    let { onlyIf, httpMetadata, customMetadata } = options;
    onlyIf = parseOnlyIf(onlyIf);
    httpMetadata = parseHttpMetadata(httpMetadata);

    // Get meta, and if exists, run onlyIf condtional test
    const meta = (await this.#head(key)) ?? undefined;
    if (!testR2Conditional(onlyIf, meta)) return null;

    // Convert value to Uint8Array
    const toStore = await _valueToArray(value);

    // Validate value and metadata size
    if (toStore.byteLength > MAX_VALUE_SIZE) {
      throwR2Error(
        "PUT",
        400,
        `Value length of ${toStore.byteLength} exceeds limit of ${MAX_VALUE_SIZE}.`
      );
    }

    // build metadata
    const metadata = {
      key,
      size: toStore.byteLength,
      etag,
      httpEtag,
      uploaded,
      httpMetadata,
      customMetadata,
    };
    parseR2ObjectMetadata(metadata);
    await this.#storage.put(key, {
      value: toStore,
      metadata,
    });

    return new R2Object(metadata);
  }
}
