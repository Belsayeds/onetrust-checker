import { chromium } from "playwright";
import fs from "fs";

const targetUrl = process.env.TARGET_URL;

if (!targetUrl) {
  throw new Error("TARGET_URL is required");
}

function normaliseUrl(url) {
  return url.startsWith("http") ? url : `https://${url}`;
}

function cleanUdid(udid = "") {
  return udid.replace("-test", "");
}

function isTestScript(udid = "") {
  return udid.toLowerCase().endsWith("-test");
}

const notes = [];
const apiCalls = [];
const jsonResponses = [];
const otStubNetworkCalls = [];

let accessDenied = false;

const browser = await chromium.launch({ headless: true });

const page = await browser.newPage({
  viewport: { width: 1366, height: 768 },
  userAgent:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
});

page.on("request", request => {
  const url = request.url();

  if (url.toLowerCase().includes("otsdkstub.js")) {
    otStubNetworkCalls.push({
      url,
      method: request.method(),
      resourceType: request.resourceType()
    });
  }
});

page.on("response", async response => {
  const url = response.url();
  const request = response.request();

  apiCalls.push({
    url,
    method: request.method(),
    resourceType: request.resourceType(),
    status: response.status()
  });

  const lowerUrl = url.toLowerCase();

  const isPotentialOneTrustJson =
    lowerUrl.includes("cdn.cookielaw.org") &&
    lowerUrl.includes(".json");

  if (isPotentialOneTrustJson) {
    try {
      const text = await response.text();

      jsonResponses.push({
        url,
        status: response.status(),
        bodyText: text
      });
    } catch {
      notes.push(`Could not read JSON response body: ${url}`);
    }
  }
});

try {
  await page.goto(normaliseUrl(targetUrl), {
    waitUntil: "domcontentloaded",
    timeout: 60000
  });

  await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {
    notes.push("Network did not become idle within 30 seconds.");
  });

  await page.waitForTimeout(15000);
} catch (error) {
  notes.push(`Page navigation issue: ${error.message}`);
}

const bodyText = await page.locator("body").innerText().catch(() => "");

if (
  bodyText.includes("Access Denied") ||
  bodyText.includes("You don't have permission to access") ||
  page.url().includes("errors.edgesuite.net")
) {
  accessDenied = true;
  notes.push("Access denied by CDN/WAF. Playwright could not access the real page.");
}

const allFrameScripts = [];

for (const frame of page.frames()) {
  try {
    const scripts = await frame.locator("script").evaluateAll(nodes =>
      nodes.map(script => ({
        frameUrl: window.location.href,
        src: script.src || "",
        id: script.id || "",
        dataDomainScript: script.getAttribute("data-domain-script") || "",
        outerHTML: script.outerHTML || ""
      }))
    );

    allFrameScripts.push(...scripts);
  } catch {
    notes.push(`Could not inspect scripts in frame: ${frame.url()}`);
  }
}

const stubScripts = allFrameScripts.filter(script => {
  const src = script.src.toLowerCase();
  const outerHTML = script.outerHTML.toLowerCase();

  return src.includes("otsdkstub.js") || outerHTML.includes("otsdkstub.js");
});

const dataDomainScriptValues = stubScripts
  .map(script => script.dataDomainScript)
  .filter(Boolean);

const primaryUdid = dataDomainScriptValues[0] || "";
const productionUdid = cleanUdid(primaryUdid);
const usingTestScript = isTestScript(primaryUdid);

let capturedConfig = null;
let capturedConfigUrl = "";

for (const item of jsonResponses) {
  const lowerUrl = item.url.toLowerCase();

  const urlMatchesUdid =
    primaryUdid &&
    (
      lowerUrl.includes(primaryUdid.toLowerCase()) ||
      lowerUrl.includes(productionUdid.toLowerCase())
    );

  if (!urlMatchesUdid) {
    continue;
  }

  try {
    capturedConfig = JSON.parse(item.bodyText);
    capturedConfigUrl = item.url;
    break;
  } catch {
    notes.push(`Matched UDID JSON URL but could not parse body as JSON: ${item.url}`);
  }
}

if (!capturedConfig && productionUdid) {
  notes.push(
    `No matching UDID JSON response was captured for UDID: ${primaryUdid}.`
  );
}

if (stubScripts.length === 0 && otStubNetworkCalls.length === 0) {
  notes.push("otSDKStub.js was not found in DOM scripts or network calls.");
}

if (stubScripts.length === 0 && otStubNetworkCalls.length > 0) {
  notes.push(
    "otSDKStub.js was found in network calls but not in DOM scripts. It may be dynamically loaded or removed after execution."
  );
}

if (stubScripts.length > 1 || otStubNetworkCalls.length > 1) {
  notes.push(
    `Alert: otSDKStub.js triggered more than once. DOM count: ${stubScripts.length}, network count: ${otStubNetworkCalls.length}.`
  );
}

await page.screenshot({
  path: "debug-screenshot.png",
  fullPage: true
});

fs.writeFileSync("debug-page.html", await page.content());

fs.writeFileSync(
  "debug-json-responses.json",
  JSON.stringify(jsonResponses, null, 2)
);

const result = {
  checkedUrl: normaliseUrl(targetUrl),
  checkedAt: new Date().toISOString(),

  accessDenied,

  otSDKStub: {
    found: stubScripts.length > 0 || otStubNetworkCalls.length > 0,
    domCount: stubScripts.length,
    networkCount: otStubNetworkCalls.length,
    scripts: stubScripts,
    networkCalls: otStubNetworkCalls,
    dataDomainScriptValues,
    primaryUdid,
    productionUdid,
    usingTestScript,
    scriptEnvironment: primaryUdid
      ? usingTestScript
        ? "test"
        : "production"
      : "unknown"
  },

  capturedConfigUrl,

  TenantGuid: capturedConfig?.TenantGuid ?? "",
  EnvId: capturedConfig?.EnvId ?? "",
  Domain: capturedConfig?.Domain ?? "",

  config: capturedConfig ?? {},

  apiCalls,

  notes
};

fs.writeFileSync("ot-check-result.json", JSON.stringify(result, null, 2));

console.log(JSON.stringify(result, null, 2));

await browser.close();
