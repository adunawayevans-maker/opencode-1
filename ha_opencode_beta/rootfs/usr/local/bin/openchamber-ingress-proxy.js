#!/usr/bin/env node
const http = require("http");
const net = require("net");
const zlib = require("zlib");

const LISTEN_HOST = process.env.OPENCHAMBER_INGRESS_HOST || "0.0.0.0";
const LISTEN_PORT = Number.parseInt(process.env.OPENCHAMBER_INGRESS_PORT || "8099", 10);
const UPSTREAM_HOST = process.env.OPENCHAMBER_UPSTREAM_HOST || "127.0.0.1";
const UPSTREAM_PORT = Number.parseInt(process.env.OPENCHAMBER_UPSTREAM_PORT || "3010", 10);
const SUPERVISOR_INGRESS_IP = process.env.HA_INGRESS_PROXY_IP || "172.30.32.2";

function normalizeRemoteAddress(address) {
  if (!address) return "";
  if (address.startsWith("::ffff:")) return address.slice("::ffff:".length);
  if (address === "::1") return "127.0.0.1";
  return address;
}

function isAllowedRemote(address) {
  const normalized = normalizeRemoteAddress(address);
  return normalized === "127.0.0.1"
    || normalized === SUPERVISOR_INGRESS_IP
    || normalized.startsWith("127.");
}

function normalizeIngressPath(value) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!trimmed || !trimmed.startsWith("/")) return "";
  return trimmed;
}

function ingressPathFromRequest(req) {
  const headerValue = Array.isArray(req.headers["x-ingress-path"])
    ? req.headers["x-ingress-path"][0]
    : req.headers["x-ingress-path"];
  const fromHeader = normalizeIngressPath(headerValue);
  if (fromHeader) return fromHeader;

  const match = (req.url || "").match(/^(\/api\/hassio_ingress\/[^/?#]+)/);
  return match ? match[1] : "";
}

function stripIngressPath(url, ingressPath) {
  if (!ingressPath || !url.startsWith(ingressPath)) return url || "/";
  const stripped = url.slice(ingressPath.length);
  return stripped.startsWith("/") ? stripped : `/${stripped}`;
}

function forwardedProto(req) {
  const explicit = req.headers["x-forwarded-proto"];
  if (typeof explicit === "string" && explicit.trim()) {
    return explicit.split(",")[0].trim();
  }
  const origin = req.headers.origin;
  if (typeof origin === "string" && origin.trim()) {
    try {
      return new URL(origin).protocol.replace(/:$/, "");
    } catch {
      return "http";
    }
  }
  return "http";
}

function transformLocationHeader(value, ingressPath) {
  if (!ingressPath || typeof value !== "string" || !value.startsWith("/")) {
    return value;
  }
  if (value.startsWith(ingressPath)) return value;
  return `${ingressPath}${value}`;
}

function escapeHtmlAttribute(value) {
  return value.replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function noStoreHeaders(extra = {}) {
  return {
    ...extra,
    "cache-control": "no-store, no-cache, must-revalidate, proxy-revalidate",
    pragma: "no-cache",
    expires: "0",
  };
}

function transformRootAssetUrls(content, ingressPath) {
  const assetPath = ingressPath ? `${ingressPath}/assets/` : "assets/";
  return content
    .replace(/(["'`])\/assets\//g, `$1${assetPath}`)
    .replace(/url\((["]?)\/assets\//g, `url($1${assetPath}`)
    .replace(/url\((\')\/assets\//g, `url($1${assetPath}`)
    .replace(/assetsURL=function\((\w+)\)\{return"\/"\+\1\}/g, "assetsURL=function($1){return $1}")
    .replace(/("modulepreload",\w+=function\()(\w+)(\)\{return)"\/"\+\2(\},\w+=\{\})/g, "$1$2$3 $2$4");
}

function serviceWorkerResetScript() {
  return `self.addEventListener("install", (event) => {\n`
    + `  self.skipWaiting();\n`
    + `});\n`
    + `self.addEventListener("activate", (event) => {\n`
    + `  event.waitUntil((async () => {\n`
    + `    try {\n`
    + `      for (const key of await caches.keys()) {\n`
    + `        if (/openchamber|workbox|vite/i.test(key)) await caches.delete(key);\n`
    + `      }\n`
    + `    } catch {}\n`
    + `    try { await self.registration.unregister(); } catch {}\n`
    + `    try {\n`
    + `      const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });\n`
    + `      for (const client of clients) client.navigate(client.url);\n`
    + `    } catch {}\n`
    + `  })());\n`
    + `});\n`;
}

function ingressRuntimeScript(ingressPath) {
  const basePath = ingressPath || "";

  return `(() => {\n`
    + `  const configuredBasePath = ${JSON.stringify(basePath)};\n`
    + `  const match = window.location.pathname.match(/^(\\/api\\/hassio_ingress\\/[^/]+)/);\n`
    + `  const basePath = configuredBasePath || (match ? match[1] : "");\n`
    + `  const absoluteBase = basePath ? window.location.origin + basePath : window.location.origin;\n`
    + `  if (basePath && !document.querySelector("base[data-ha-ingress-base]")) {\n`
    + `    const base = document.createElement("base");\n`
    + `    base.setAttribute("data-ha-ingress-base", "");\n`
    + `    base.href = basePath.replace(/\\/+$/, "") + "/";\n`
    + `    document.head.prepend(base);\n`
    + `  }\n`
    + `  if (typeof window.process === "undefined") window.process = { env: {} };\n`
    + `  window.__OPENCHAMBER_API_BASE_URL__ = absoluteBase;\n`
    + `  window.__OPENCHAMBER_LOCAL_ORIGIN__ = window.location.origin;\n`
    + `  window.__OPENCHAMBER_INGRESS_BASE_PATH__ = basePath;\n`
    + `  window.__OPENCHAMBER_UPDATE_PWA_MANIFEST__ ||= () => {};\n`
    + `  window.__OPENCHAMBER_GET_PWA_INSTALL_NAME__ ||= () => "OpenChamber";\n`
    + `  window.__OPENCHAMBER_SET_PWA_INSTALL_NAME__ ||= (value) => value || "OpenChamber";\n`
    + `  window.__OPENCHAMBER_SET_PWA_ORIENTATION__ ||= (value) => value || "system";\n`
    + `  if (typeof navigator !== "undefined" && "serviceWorker" in navigator) {\n`
    + `    navigator.serviceWorker.getRegistrations().then((registrations) => {\n`
    + `      for (const registration of registrations) {\n`
    + `        const urls = [registration.scope, registration.active?.scriptURL, registration.waiting?.scriptURL, registration.installing?.scriptURL].filter(Boolean);\n`
    + `        const shouldRemove = urls.some((value) => {\n`
    + `          try {\n`
    + `            const url = new URL(value, window.location.href);\n`
    + `            return url.pathname === "/sw.js" || (basePath && (url.pathname === basePath || url.pathname.startsWith(basePath + "/"))) || url.pathname.includes("/api/hassio_ingress/");\n`
    + `          } catch {\n`
    + `            return false;\n`
    + `          }\n`
    + `        });\n`
    + `        if (shouldRemove) registration.unregister().catch(() => {});\n`
    + `      }\n`
    + `    }).catch(() => {});\n`
    + `  }\n`
    + `  if (basePath && typeof window.fetch === "function" && !window.__OPENCHAMBER_INGRESS_FETCH_PATCHED__) {\n`
    + `    window.__OPENCHAMBER_INGRESS_FETCH_PATCHED__ = true;\n`
    + `    const originalFetch = window.fetch.bind(window);\n`
    + `    const shouldPrefix = (pathname) => pathname === "/api" || pathname.startsWith("/api/") || pathname === "/auth" || pathname.startsWith("/auth/") || pathname === "/health";\n`
    + `    const rewriteInput = (input) => {\n`
    + `      const rawUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input?.url;\n`
    + `      if (typeof rawUrl !== "string" || rawUrl.length === 0) return null;\n`
    + `      try {\n`
    + `        const url = new URL(rawUrl, window.location.href);\n`
    + `        if (url.origin !== window.location.origin) return null;\n`
    + `        if (url.pathname === basePath || url.pathname.startsWith(basePath + "/")) return null;\n`
    + `        if (!shouldPrefix(url.pathname)) return null;\n`
    + `        url.pathname = basePath + url.pathname;\n`
    + `        return url.toString();\n`
    + `      } catch {\n`
    + `        return null;\n`
    + `      }\n`
    + `    };\n`
    + `    window.fetch = (input, init) => {\n`
    + `      const rewritten = rewriteInput(input);\n`
    + `      if (!rewritten) return originalFetch(input, init);\n`
    + `      if (input instanceof Request) return originalFetch(new Request(rewritten, input), init);\n`
    + `      return originalFetch(rewritten, init);\n`
    + `    };\n`
    + `  }\n`
    + `})();\n`;
}

function transformHtml(html, ingressPath) {
  const baseHref = ingressPath ? `${ingressPath}/` : "";
  const runtimeSrc = ingressPath ? `${baseHref}__openchamber_ingress_runtime.js` : "__openchamber_ingress_runtime.js";
  let transformed = html.replace(
    /\s*<script\b[^>]*\bdata-ha-ingress-runtime\b[^>]*>[\s\S]*?<\/script>/g,
    ""
  );

  transformed = transformed.replace(
    "const baseUrl = location.origin;",
    "const ingressBaseMatch = location.pathname.match(/^(\\/api\\/hassio_ingress\\/[^/]+)/);\n      const baseUrl = location.origin + (ingressBaseMatch ? ingressBaseMatch[1] : '');"
  );

  if (ingressPath && !transformed.includes("data-ha-ingress-base")) {
    transformed = transformed.replace(
      /<head([^>]*)>/i,
      `<head$1>\n    <base data-ha-ingress-base href="${escapeHtmlAttribute(baseHref)}">`
    );
  }

  if (!transformed.includes("data-ha-ingress-runtime")) {
    transformed = transformed.replace(
      /\s*<script type="module"/,
      `\n    <script data-ha-ingress-runtime src="${escapeHtmlAttribute(runtimeSrc)}"></script>\n    <script type="module"`
    );
  }

  transformed = transformed.replace(/\b(href|src)="\/(assets\/[^"#?]+(?:[?#][^"]*)?)"/g, (_match, attr, path) => {
    return `${attr}="${ingressPath ? `${ingressPath}/` : ""}${path}"`;
  }).replace(/\bhref="\/(favicon[^"#?]*(?:[?#][^"]*)?)"/g, (_match, path) => {
    return `href="${ingressPath ? `${ingressPath}/` : ""}${path}"`;
  }).replace(/\bhref="\/(apple-touch-icon[^"#?]*(?:[?#][^"]*)?)"/g, (_match, path) => {
    return `href="${ingressPath ? `${ingressPath}/` : ""}${path}"`;
  });

  return transformRootAssetUrls(transformed, ingressPath);
}

function transformJavaScript(content, ingressPath) {
  return transformRootAssetUrls(content, ingressPath)
    .replace(/if\("serviceWorker"in navigator\)\{/g, 'if(false&&"serviceWorker"in navigator){');
}

function transformCss(content, ingressPath) {
  return transformRootAssetUrls(content, ingressPath);
}

function decodeBody(buffer, contentEncoding) {
  const encoding = String(contentEncoding || "").trim().toLowerCase();
  if (!encoding || encoding === "identity") return buffer;
  if (encoding === "gzip") return zlib.gunzipSync(buffer);
  if (encoding === "deflate") return zlib.inflateSync(buffer);
  if (encoding === "br") return zlib.brotliDecompressSync(buffer);
  throw new Error(`Unsupported content encoding: ${contentEncoding}`);
}

function proxyRequest(req, res) {
  const remoteAddress = normalizeRemoteAddress(req.socket.remoteAddress || "");
  if (!isAllowedRemote(remoteAddress)) {
    res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
    res.end("Forbidden\n");
    return;
  }

  const ingressPath = ingressPathFromRequest(req);
  const upstreamPath = stripIngressPath(req.url || "/", ingressPath);

  if (upstreamPath.split("?", 1)[0] === "/__openchamber_ingress_runtime.js") {
    res.writeHead(200, noStoreHeaders({
      "content-type": "application/javascript; charset=utf-8",
    }));
    res.end(ingressRuntimeScript(ingressPath));
    return;
  }

  if (upstreamPath.split("?", 1)[0] === "/sw.js") {
    res.writeHead(200, noStoreHeaders({
      "content-type": "application/javascript; charset=utf-8",
      "service-worker-allowed": ingressPath ? `${ingressPath}/` : "/",
    }));
    res.end(serviceWorkerResetScript());
    return;
  }

  const headers = { ...req.headers };
  headers.host = `${UPSTREAM_HOST}:${UPSTREAM_PORT}`;
  headers["accept-encoding"] = "identity";
  headers["x-forwarded-host"] = req.headers["x-forwarded-host"] || req.headers.host || "";
  headers["x-forwarded-proto"] = forwardedProto(req);
  headers["x-forwarded-for"] = req.headers["x-forwarded-for"]
    ? `${req.headers["x-forwarded-for"]}, ${remoteAddress}`
    : remoteAddress;

  const upstreamReq = http.request({
    host: UPSTREAM_HOST,
    port: UPSTREAM_PORT,
    method: req.method,
    path: upstreamPath,
    headers,
  }, (upstreamRes) => {
    const responseHeaders = { ...upstreamRes.headers };
    if (responseHeaders.location) {
      responseHeaders.location = transformLocationHeader(responseHeaders.location, ingressPath);
    }

    const contentType = String(upstreamRes.headers["content-type"] || "");
    const isHtml = contentType.includes("text/html");
    const isJavaScript = /(?:application|text)\/javascript|\bmodule\b/.test(contentType);
    const isCss = contentType.includes("text/css");
    if (!isHtml && !isJavaScript && !isCss) {
      res.writeHead(upstreamRes.statusCode || 502, responseHeaders);
      upstreamRes.pipe(res);
      return;
    }

    const chunks = [];
    upstreamRes.on("data", (chunk) => chunks.push(chunk));
    upstreamRes.on("end", () => {
      const decoded = decodeBody(Buffer.concat(chunks), responseHeaders["content-encoding"]);
      const text = decoded.toString("utf8");
      const body = isHtml
        ? transformHtml(text, ingressPath)
        : isCss
          ? transformCss(text, ingressPath)
          : transformJavaScript(text, ingressPath);
      delete responseHeaders["content-length"];
      delete responseHeaders["content-encoding"];
      delete responseHeaders.etag;
      Object.assign(responseHeaders, noStoreHeaders());
      res.writeHead(upstreamRes.statusCode || 200, responseHeaders);
      res.end(body);
    });
  });

  upstreamReq.on("error", (error) => {
    res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
    res.end(`OpenChamber upstream unavailable: ${error.message}\n`);
  });

  req.pipe(upstreamReq);
}

function proxyUpgrade(req, socket, head) {
  const remoteAddress = normalizeRemoteAddress(req.socket.remoteAddress || "");
  if (!isAllowedRemote(remoteAddress)) {
    socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }

  const ingressPath = ingressPathFromRequest(req);
  const upstreamPath = stripIngressPath(req.url || "/", ingressPath);
  const headers = { ...req.headers };
  headers.host = `${UPSTREAM_HOST}:${UPSTREAM_PORT}`;
  headers["x-forwarded-host"] = req.headers["x-forwarded-host"] || req.headers.host || "";
  headers["x-forwarded-proto"] = forwardedProto(req);
  headers["x-forwarded-for"] = req.headers["x-forwarded-for"]
    ? `${req.headers["x-forwarded-for"]}, ${remoteAddress}`
    : remoteAddress;

  const upstreamSocket = net.connect(UPSTREAM_PORT, UPSTREAM_HOST, () => {
    upstreamSocket.write(`${req.method} ${upstreamPath} HTTP/${req.httpVersion}\r\n`);
    for (const [name, value] of Object.entries(headers)) {
      if (Array.isArray(value)) {
        for (const entry of value) upstreamSocket.write(`${name}: ${entry}\r\n`);
      } else if (value !== undefined) {
        upstreamSocket.write(`${name}: ${value}\r\n`);
      }
    }
    upstreamSocket.write("\r\n");
    if (head && head.length > 0) upstreamSocket.write(head);
    upstreamSocket.pipe(socket);
    socket.pipe(upstreamSocket);
  });

  upstreamSocket.on("error", () => {
    socket.write("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
    socket.destroy();
  });
}

const server = http.createServer(proxyRequest);
server.on("upgrade", proxyUpgrade);
server.listen(LISTEN_PORT, LISTEN_HOST, () => {
  console.log(`OpenChamber ingress proxy listening on ${LISTEN_HOST}:${LISTEN_PORT}`);
  console.log(`Forwarding to http://${UPSTREAM_HOST}:${UPSTREAM_PORT}`);
});
