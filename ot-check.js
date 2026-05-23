import { chromium } from "playwright";
import fs from "fs";

const targetUrl = process.env.TARGET_URL;

if (!targetUrl) {
  throw new Error("TARGET_URL is required");
}

function normaliseUrl(url) {
  return url.startsWith("http") ? url : `https://${url}`;
}

function pickFields(configJson = {}) {
  return {
    AuthenticatedConsent: configJson.AuthenticatedConsent ?? "",
    BulkDomainCheckUrl: configJson.BulkDomainCheckUrl ?? "",
    CDNLocation: configJson.CDNLocation ?? "",
    CookieSPAEnabled: configJson.CookieSPAEnabled ?? "",
    CookieSameSiteNoneEnabled: configJson.CookieSameSiteNoneEnabled ?? "",
    CookieV2CSPEnabled: configJson.CookieV2CSPEnabled ?? "",
    DataLanguage: configJson.DataLanguage ?? "",
    DisclosureCDNUrl: configJson.DisclosureCDNUrl ?? "",
    Domain: configJson.Domain ?? "",
    EnvId: configJson.EnvId ?? "",
    GATrackAssignedCategory: configJson.GATrackAssignedCategory ?? "",
    GATrackToggle: configJson.GATrackToggle ?? "",
    GeoRuleGroupName: configJson.GeoRuleGroupName ?? "",
    GeolocationUrl: configJson.GeolocationUrl ?? "",
    GoogleData: configJson.GoogleData ?? {},
    GppData: configJson.GppData ?? {},
    Iab2V2Data: configJson.Iab2V2Data ?? {},
    IabData: configJson.IabData ?? {},
    IabV2Data: configJson.IabV2Data ?? {},
    IsSuppressBanner: configJson.IsSuppressBanner ?? "",
    IsSuppressPC: configJson.IsSuppressPC ?? "",
    LanguageDetectionByHtml: configJson.LanguageDetectionByHtml ?? "",
    LanguageDetectionEnabled: configJson.LanguageDetectionEnabled ?? "",
    MobileSDK: configJson.MobileSDK ?? "",
    MultiVariantTestingEnabled: configJson.MultiVariantTestingEnabled ?? "",
    OptanonDataJSON: configJson.OptanonDataJSON ?? "",
    PublisherCC: configJson.PublisherCC ?? "",
    RemoteActionsEnabled: configJson.RemoteActionsEnabled ?? "",
    RootDomainConsentEnabled: configJson.RootDomainConsentEnabled ?? "",
    RootDomainUrl: configJson.RootDomainUrl ?? "",
    RuleSet: Array.isArray(configJson.RuleSet)
      ? configJson.RuleSet.map(r => ({
          Id: r.Id ?? "",
          Name: r.Name ?? ""
        }))
      : [],
    ScriptDynamicLoadEnabled: configJson.ScriptDynamicLoadEnabled ?? "",
    ScriptType: configJson.ScriptType ?? "",
    SkipGeolocation: configJson.SkipGeolocation ?? "",
    TenantFeatures: {
      CookieV2BannerFocus: configJson.TenantFeatures?.CookieV2BannerFocus ?? "",
      CookieV2RejectAll: configJson.TenantFeatures?.CookieV2RejectAll ?? "",
      CookieV2TargetedTemplates: configJson.TenantFeatures?.CookieV2TargetedTemplates ?? ""
    },
    TenantGuid: configJson.TenantGuid ?? "",
    UseV2: configJson.UseV2 ?? "",
    Version: configJson.Version ?? "",
    WebFormIntegrationEnabled: configJson.WebFormIntegrationEnabled ?? "",
    WebFormSrcUrl: configJson.WebFormSrcUrl ?? "",
    WebFormWorkerUrl: configJson.WebFormWorkerUrl ?? ""
  };
}

const notes = [];
const apiCalls = [];
const otStubNetworkCalls = [];

let capturedConfig = null;
let capturedConfigUrl = "";

const browser = await chromium.launch({
  headless: true
});

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

  const looksLikeOtJson =
    lowerUrl.includes("cdn.cookielaw.org") &&
    lowerUrl.endsWith(".json");

  if (looksLikeOtJson && !capturedConfig) {
    try {
      const body = await response.text();
      const json = JSON.parse(body);

      if (
        json.TenantGuid ||
        json.EnvId ||
        json.Domain ||
        json.RuleSet ||
        json.TenantFeatures
      ) {
        capturedConfig = json;
        capturedConfigUrl = url;
      }
    } catch {
      // Ignore non-JSON response bodies.
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

if (!capturedConfig) {
  notes.push(
    "No OneTrust JSON config response was captured. The config may be blocked, delayed, loaded from a different CDN path, or require a specific region/session."
  );
}

await page.screenshot({
  path: "debug-screenshot.png",
  fullPage: true
});

fs.writeFileSync("debug-page.html", await page.content());

const result = {
  checkedUrl: normaliseUrl(targetUrl),
  checkedAt: new Date().toISOString(),

  otSDKStub: {
    found: stubScripts.length > 0 || otStubNetworkCalls.length > 0,
    domCount: stubScripts.length,
    networkCount: otStubNetworkCalls.length,
    scripts: stubScripts,
    networkCalls: otStubNetworkCalls,
    dataDomainScriptValues
  },

  capturedConfigUrl,

  TenantGuid: capturedConfig?.TenantGuid ?? "",
  EnvId: capturedConfig?.EnvId ?? "",
  Domain: capturedConfig?.Domain ?? "",

  config: pickFields(capturedConfig ?? {}),

  apiCalls,

  notes
};

fs.writeFileSync("ot-check-result.json", JSON.stringify(result, null, 2));

console.log(JSON.stringify(result, null, 2));

await browser.close();
