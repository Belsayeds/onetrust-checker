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

const browser = await chromium.launch({ headless: true });

const page = await browser.newPage({
  viewport: { width: 1366, height: 768 }
});

const notes = [];
const apiCalls = [];
let capturedConfig = null;
let capturedConfigUrl = "";

page.on("response", async response => {
  const url = response.url();
  const request = response.request();

  apiCalls.push({
    url,
    method: request.method(),
    resourceType: request.resourceType(),
    status: response.status()
  });

  const looksLikeOtJson =
    /\/[a-f0-9-]{20,}\/[^/]+\.json/i.test(url) ||
    /\/consent\/[^/]+\.json/i.test(url) ||
    /cdn\.cookielaw\.org.*\.json/i.test(url);

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
      // Ignore non-JSON or unreadable response bodies.
    }
  }
});

await page.goto(normaliseUrl(targetUrl), {
  waitUntil: "domcontentloaded",
  timeout: 60000
});

await page.waitForTimeout(8000);

const stubScripts = await page.$$eval(
  'script[src*="otSDKStub.js"]',
  scripts =>
    scripts.map(script => ({
      src: script.src || "",
      dataDomainScript: script.getAttribute("data-domain-script") || "",
      id: script.id || "",
      async: script.async || false
    }))
);

if (stubScripts.length === 0) {
  notes.push("otSDKStub.js script tag was not found in the page HTML.");
}

if (stubScripts.length > 1) {
  notes.push(`Alert: otSDKStub.js was found ${stubScripts.length} times.`);
}

const dataDomainScriptValues = stubScripts
  .map(s => s.dataDomainScript)
  .filter(Boolean);

const result = {
  checkedUrl: normaliseUrl(targetUrl),
  checkedAt: new Date().toISOString(),

  otSDKStub: {
    found: stubScripts.length > 0,
    count: stubScripts.length,
    scripts: stubScripts,
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