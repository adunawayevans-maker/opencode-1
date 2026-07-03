#!/usr/bin/env node
const http = require("http");
const net = require("net");

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

function ingressRuntimeScript(ingressPath) {
  const basePath = ingressPath || "";

  return `(() => {\n`
    + `  const configuredBasePath = ${JSON.stringify(basePath)};\n`
    + `  const match = window.location.pathname.match(/^(\\/api\\/hassio_ingress\\/[^/]+)/);\n`
    + `  const basePath = configuredBasePath || (match ? match[1] : "");\n`
    + `  const absoluteBase = basePath ? window.location.origin + basePath : window.location.origin;\n`
    + `  window.__OPENCHAMBER_API_BASE_URL__ = absoluteBase;\n`
    + `  window.__OPENCHAMBER_LOCAL_ORIGIN__ = window.location.origin;\n`
    + `  window.__OPENCHAMBER_INGRESS_BASE_PATH__ = basePath;\n`
    + `})();\n`;
}

function transformHtml(html, ingressPath) {
  if (!ingressPath) return html;
  const baseHref = `${ingressPath}/`;
  let transformed = html.replace(
    /\s*<script\b[^>]*\bdata-ha-ingress-runtime\b[^>]*>[\s\S]*?<\/script>/g,
    ""
  );

  if (!transformed.includes("data-ha-ingress-base")) {
    transformed = transformed.replace(
      /<head([^>]*)>/i,
      `<head$1>\n    <base data-ha-ingress-base href="${escapeHtmlAttribute(baseHref)}">`
    );
  }

  if (!transformed.includes("data-ha-ingress-runtime")) {
    transformed = transformed.replace(
      /\s*<script type="module"/,
      `\n    <script data-ha-ingress-runtime src="${escapeHtmlAttribute(baseHref)}__openchamber_ingress_runtime.js"></script>\n    <script type="module"`
    );
  }

  return transformed.replace(/\b(href|src)="\/(assets\/[^"#?]+(?:[?#][^"]*)?)"/g, `$1="${ingressPath}/$2"`)
    .replace(/\bhref="\/(favicon[^"#?]*(?:[?#][^"]*)?)"/g, `href="${ingressPath}/$1"`)
    .replace(/\bhref="\/(apple-touch-icon[^"#?]*(?:[?#][^"]*)?)"/g, `href="${ingressPath}/$1"`);
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
    res.writeHead(200, {
      "content-type": "application/javascript; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end(ingressRuntimeScript(ingressPath));
    return;
  }

  const headers = { ...req.headers };
  headers.host = `${UPSTREAM_HOST}:${UPSTREAM_PORT}`;
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
    if (!contentType.includes("text/html")) {
      res.writeHead(upstreamRes.statusCode || 502, responseHeaders);
      upstreamRes.pipe(res);
      return;
    }

    const chunks = [];
    upstreamRes.on("data", (chunk) => chunks.push(chunk));
    upstreamRes.on("end", () => {
      const body = transformHtml(Buffer.concat(chunks).toString("utf8"), ingressPath);
      delete responseHeaders["content-length"];
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
