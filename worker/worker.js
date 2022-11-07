addEventListener("fetch", (event) => {
  event.respondWith(
    handleRequest(event).catch(
      (err) => new Response(err.stack, { status: 500 })
    )
  );
});

import init, { process_image, convert_to_base64 } from "./wasm";
import compiledWasm from "./wasm/index_bg.wasm";
import { getParams, getMimeType, VALID_FORMATS } from "./utils";

async function handleRequest(event) {
  await init(compiledWasm);
  let req = event.request;
  let res;

  if (req.method !== "GET") {
    res = new Response("HTTP Method Not Allowed", {
      status: 405,
      statusText: "Method Not Allowed",
      headers: {
        Allow: "GET",
      },
    });
    res.headers.set("Content-type", "text/plain");
    res.headers.set("Allow", "GET");
    return res;
  }

  const reqUrl = new URL(req.url);
  // Construct the cache key from the cache URL
  const cacheKey = new Request(reqUrl, req);
  const cache = caches.default;
  res = await cache.match(cacheKey);
  if (res) {
    return res;
  }

  const params = getParams(req);

  if (params.errors.length) {
    res = new Response(params.errors.join("\r\n"), { status: 400 });
    res.headers.set("Content-type", "text/plain");
    return res;
  }
  let originReq = new Request(params.origin.toString(), req);
  const {
    hostname: originReqHostname,
    pathname: originReqPathname,
    href: originReqHref,
  } = new URL(originReq.url.toLowerCase());
  const pathnameBase64 = convert_to_base64(originReqPathname);
  const directoryLevelIdentifier = `${originReqHostname}/${pathnameBase64}`;
  const reqSearchParams = new URLSearchParams(params);
  reqSearchParams.delete("origin");
  const fileLevelIdentifier = reqSearchParams.toString();
  // R2 follows this naming convention:
  // R2
  // ├── sub.example1.com                       -----------> originReqHostname
  // │   ├── pathname-to-file-1(base64)         -----------> originReqPathname(directoryLevel)
  // │   │   ├── original                       -----------> file-level
  // │   │   ├── mode=fill&width=180&height=200
  // │   │   └── mode=fit&width=200&height=600
  // │   ├── pathname-to-file-2(base64)
  // │   │   ├── original
  // │   │   └── mode=fill&width=180&height=200
  // │   └── pathname-to-file-3(base64)
  // │       ├── original
  // │       ├── mode=fill&width=180&height=200
  // │       └── mode=fit&width=200&height=600
  // ├── example1.com
  // │   ├── pathname-to-file-4(base64)
  // │   │   ├── original
  // │   │   └── mode=fit&width=200&height=600
  // │   └── pathname-to-file-6(base64)
  // │       ├── original
  // │       └── mode=fit&width=200&height=600
  // └── example2.com
  //     └── pathname-to-file-7(base64)
  //         ├── original
  //         └── mode=fit&width=500&height=600

  console.log(
    `Response for request url: ${req.url} not present in cache. Checking R2 now.`
  );
  const objectKey = `${directoryLevelIdentifier}/${fileLevelIdentifier}`;
  const object = await IMG_BUCKET.get(objectKey);

  if (object && object.size !== 0) {
    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set("last-modified", object.uploaded.toUTCString());
    headers.set("etag", object.httpEtag);
    // Cache API respects Cache-Control headers. Setting s-max-age to 24 hours
    // will limit the response to be in cache for 24 hours max
    // Any changes made to the response here will be reflected in the cached value
    headers.append("Cache-Control", "public, max-age=0, s-maxage=86400");
    if (object.body) {
      res = new Response(object.body, {
        headers,
      });
      // Cache response
      event.waitUntil(cache.put(cacheKey, res.clone()));
    }

    return res;
  }

  console.log(
    `Response for request url: ${req.url} not present in R2. Fetching and caching request from remote.`
  );
  const r2Identifier = `${directoryLevelIdentifier}/original`;
  let [originRes] = await Promise.all([await IMG_BUCKET.get(r2Identifier)]);

  try {
    let originResToCache;
    if (!originRes) {
      originRes = await fetch(originReq);
      // Must use Response constructor to inherit all of response's fields
      originRes = new Response(originRes.body, originRes);
      originResToCache = originRes.clone();
    }

    const data = await originRes.arrayBuffer();
    const output = process_image(new Uint8Array(data), params);
    const output_format = output.slice(-1);
    res = new Response(output.slice(0, -1), { status: 200, ...res });
    res.headers.set("Content-type", getMimeType(VALID_FORMATS[output_format]));
    const teedOff = res.body.tee();
    const newCacheRes = new Response(teedOff[0], { status: 200, ...res });
    event.waitUntil(cache.put(cacheKey, newCacheRes));
    event.waitUntil(await IMG_BUCKET.put(objectKey, teedOff[1]));
    if (originResToCache) {
      event.waitUntil(cache.put(originReqHref, originResToCache));
      event.waitUntil(
        await IMG_BUCKET.put(r2Identifier, await data, {
          customMetadata: {
            originalFilename: originReqPathname,
          },
        })
      );
    }
  } catch (e) {
    const errorObject = {
      error: e.message,
    };
    res = new Response(JSON.stringify(errorObject), { status: 500 });
    res.headers.set("Content-type", "application/json;charset=UTF-8");
  }
  return res;
}
