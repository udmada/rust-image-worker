addEventListener("fetch", (event) => {
  event.respondWith(
    handleRequest(event).catch(
      (err) => new Response(err.stack, { status: 500 })
    )
  );
});

import init, { process_image } from "./wasm";
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

  const cache = caches.default;
  res = await cache.match(req);
  if (res) {
    return res;
  }

  const params = getParams(req);

  if (params.errors.length) {
    res = new Response(params.errors.join("\r\n"), { status: 400 });
    res.headers.set("Content-type", "text/plain");
    return res;
  }

  console.log(
    `Response for request url: ${req.url} not present in cache. Fetching and caching request from remote.`
  );

  let originReq = new Request(params.origin.toString(), req);
  let originRes = await cache.match(originReq);

  try {
    let originResToCache;
    if (!originRes) {
      originRes = await fetch(originReq);
      originResToCache = originRes.clone();
    }

    const data = await originRes.arrayBuffer();
    const output = process_image(new Uint8Array(data), params);
    const output_format = output.slice(-1);

    res = new Response(output.slice(0, -1), { status: 200 });
    res.headers.set("Content-type", getMimeType(VALID_FORMATS[output_format]));
    res.headers.append("Cache-Control","public, max-age=0, s-maxage=86400")
    cache.put(req, res.clone());
    if (originResToCache) {
      cache.put(originReq, originResToCache);
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
