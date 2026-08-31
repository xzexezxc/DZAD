import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import pLimit from 'p-limit';
import OpenAI from 'openai';
import { GoogleGenAI } from '@google/genai';
import { encryptJson, decryptJson } from './vault.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const normalize = value => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : value;
const USER_AGENTS = [
  'DZAD-metadata-scraper/3.0 (+authorized metadata collection)',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/151 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/151 Safari/537.36'
];
const ACCEPT_LANGUAGES = ['fr-FR,fr;q=0.9,en;q=0.8', 'en-US,en;q=0.9', 'de-DE,de;q=0.9,en;q=0.8'];
const metric = () => ({ requests: 0, successes: 0, failures: 0, retries: 0, totalMs: 0, durationMs: 0, avgResponseMs: 0, successRate: 0, byError: { network: 0, parsing: 0, timeout: 0, http: 0 } });

function classifyError(error, status) {
  if (status) return status === 429 || status >= 500 ? 'http' : 'network';
  if (error?.name === 'TimeoutError' || /timeout/i.test(error?.message || '')) return 'timeout';
  if (/JSON|parse|selector|metadata/i.test(error?.message || '')) return 'parsing';
  return 'network';
}
function challengeDetected(text, url) { return /captcha|verify you are human|access denied|security check|cf-chl-|challenge-platform/i.test(`${url} ${text}`); }
function parseJsonLd(html) { return [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)].flatMap(m => { try { const json = JSON.parse(m[1]); return Array.isArray(json) ? json : [json]; } catch { return []; } }); }
function deterministic(html, url) {
  const ld = parseJsonLd(html).find(x => /VideoObject|Movie|TVEpisode/i.test(x['@type'] || '')) || {};
  const meta = name => (html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${name}["'][^>]+content=["']([^"']+)`, 'i')) || [])[1];
  const title = normalize(ld.name || meta('og:title') || (html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || [])[1] || (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1]);
  const thumbnail = ld.thumbnailUrl || ld.image || meta('og:image');
  const description = normalize(ld.description || meta('description') || meta('og:description'));
  const people = Array.isArray(ld.actor) ? ld.actor.map(x => normalize(x.name || x)).filter(Boolean) : [];
  return { title, thumbnail, description, cast: people, duration: ld.duration, releaseDate: ld.uploadDate || ld.datePublished, canonicalUrl: ld.url || url, videoPageUrl: url, metadataSource: { title: ld.name ? 'json-ld' : 'og/title', thumbnail: ld.image ? 'json-ld' : 'og:image', description: ld.description ? 'json-ld' : 'meta' }, confidence: { title: title ? 0.99 : 0, thumbnail: thumbnail ? 0.96 : 0, description: description ? 0.82 : 0 } };
}
function galleryLinks(html, galleryUrl) {
  const origin = new URL(galleryUrl).origin;
  const urls = [...html.matchAll(/<a[^>]+href=["']([^"']+)["'][^>]*>/gi)].map(m => { try { return new URL(m[1], galleryUrl).href; } catch { return null; } }).filter(Boolean);
  return [...new Set(urls)].filter(url => new URL(url).origin === origin && url !== galleryUrl);
}

async function aiMap(candidate, evidence, provider) {
  const apiKey = provider?.apiKey || (provider?.name === 'gemini' ? process.env.GEMINI_API_KEY : process.env.OPENAI_API_KEY);
  if (!apiKey) return candidate;
  const prompt = `Map only missing/low-confidence metadata fields. Return strict JSON. Candidate: ${JSON.stringify(candidate)} Evidence: ${evidence.slice(0, 12000)}`;
  try {
    if (provider?.name === 'gemini') {
      const ai = new GoogleGenAI({ apiKey });
      const response = await ai.models.generateContent({ model: provider?.model || process.env.GEMINI_MODEL || 'gemini-2.5-flash', contents: prompt });
      return { ...candidate, ...JSON.parse((response.text || '').replace(/^```(?:json)?\n?/i, '').replace(/```$/g, '').trim()), aiProvider: 'gemini' };
    }
    const client = new OpenAI({ apiKey });
    const response = await client.chat.completions.create({ model: provider?.model || process.env.OPENAI_MODEL || 'gpt-4o-mini', messages: [{ role: 'user', content: prompt }] });
    return { ...candidate, ...JSON.parse((response.choices?.[0]?.message?.content || '').replace(/^```(?:json)?\n?/i, '').replace(/```$/g, '').trim()), aiProvider: 'openai' };
  } catch (error) { return { ...candidate, aiError: error.message }; }
}
async function loadSession(file) { try { return decryptJson(JSON.parse(await fs.readFile(file, 'utf8'))); } catch { return undefined; } }
async function saveSession(file, state) { await fs.mkdir(path.dirname(path.resolve(file)), { recursive: true }); await fs.writeFile(file, JSON.stringify(encryptJson(state)), { mode: 0o600 }); }

function oxylabsWebUnblocker(config) {
  const username = String(config.oxylabsUsername || process.env.OXYLABS_WEB_UNBLOCKER_USERNAME || '').trim();
  const password = String(config.oxylabsPassword || process.env.OXYLABS_WEB_UNBLOCKER_PASSWORD || '').trim();
  if (!username || !password) return null;
  const endpoint = String(config.oxylabsEndpoint || process.env.OXYLABS_WEB_UNBLOCKER_ENDPOINT || 'unblock.oxylabs.io:60000').trim();
  const geo = String(config.oxylabsGeoLocation || process.env.OXYLABS_GEO_LOCATION || 'France').trim();
  return { url: `http://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${endpoint}`, geo, sessionId: String(config.oxylabsSessionId || `dzad-${process.pid}-${Date.now()}`) };
}

function proxies(config) {
  const configured = Array.isArray(config.proxies) ? config.proxies : String(config.proxies || '').split(',');
  const webshare = String(config.webshareProxyUrls || process.env.WEBSHARE_PROXY_URLS || '').split(',');
  const fallback = String(process.env.SCRAPER_PROXIES || '').split(',');
  const oxylabs = oxylabsWebUnblocker(config)?.url || '';
  return [...new Set([...configured, ...webshare, ...fallback, oxylabs].map(x => x.trim()).filter(Boolean))];
}
function retryable(status, error) { return status === 429 || status === 502 || status === 503 || status === 504 || /ECONNRESET|ECONNREFUSED|ENOTFOUND|socket hang up/i.test(error?.message || ''); }
function createProxyPool(values) { let index = 0; return { current: () => values.length ? values[index % values.length] : undefined, rotate: () => { if (values.length > 1) index = (index + 1) % values.length; } }; }
function isOxylabsProxy(proxy, config) { return Boolean(proxy && proxy === oxylabsWebUnblocker(config)?.url); }
async function contextFor(browser, config, state, proxy) {
  const oxylabs = isOxylabsProxy(proxy, config) ? oxylabsWebUnblocker(config) : null;
  const extraHTTPHeaders = { 'Accept-Language': config.acceptLanguage || ACCEPT_LANGUAGES[Math.floor(Math.random() * ACCEPT_LANGUAGES.length)] };
  if (oxylabs) {
    extraHTTPHeaders['x-oxylabs-geo-location'] = oxylabs.geo;
    extraHTTPHeaders['X-Oxylabs-Session-Id'] = oxylabs.sessionId;
  }
  return browser.newContext({ ...(state ? { storageState: state } : {}), ...(proxy ? { proxy: { server: proxy } } : {}), ...(oxylabs ? { ignoreHTTPSErrors: true } : {}), userAgent: config.userAgent || USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)], extraHTTPHeaders, locale: config.locale || 'fr-FR' });
}
async function fetchPage(browser, config, url, state, pool, stats) {
  const maxRetries = Math.max(0, Number(config.maxRetries ?? 3));
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const started = Date.now(); stats.requests++;
    const context = await contextFor(browser, config, state, pool.current());
    const page = await context.newPage();
    try {
      const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: config.timeoutMs || 30000 });
      const status = response?.status() || 200;
      if (status >= 400) throw Object.assign(new Error(`HTTP ${status}`), { status });
      stats.successes++; stats.totalMs += Date.now() - started;
      return { context, page, status };
    } catch (error) {
      stats.totalMs += Date.now() - started;
      const kind = classifyError(error, error.status); stats.byError[kind]++;
      await context.close().catch(() => {});
      if (!retryable(error.status, error) || attempt === maxRetries) throw error;
      stats.retries++; pool.rotate();
      const backoff = Math.min(Number(config.maxBackoffMs || 30000), Number(config.baseBackoffMs || 1000) * (2 ** attempt));
      await sleep(backoff * (0.8 + Math.random() * 0.4));
    }
  }
}

export async function testScrape(config, progress = () => {}) {
  const startedAt = Date.now(); const stats = metric(); const pool = createProxyPool(proxies(config));
  const result = { status: 'RUNNING', sourceGalleryUrl: config.galleryUrl, discoveredFromGallery: [], items: [], errors: [], metrics: stats, scraperVersion: '3.2.0' };
  let browser;
  const headless = config.headless ?? (process.env.SCRAPER_HEADLESS !== 'false');
  try { browser = await chromium.launch({ headless, ...(headless ? {} : { slowMo: Number(config.slowMoMs || 50) }) }); }
  catch (error) { return { ...result, status: 'FAILED', errors: [{ category: 'runtime', message: error.message }] }; }
  const sessionState = config.storageStatePath ? await loadSession(config.storageStatePath) : undefined;
  let galleryContext;
  try {
    const fetched = await fetchPage(browser, config, config.galleryUrl, sessionState, pool, stats);
    galleryContext = fetched.context;
    const galleryPage = fetched.page; const galleryText = await galleryPage.locator('body').innerText().catch(() => '');
    if (challengeDetected(galleryText, galleryPage.url())) { result.status = 'CHALLENGE_REQUIRED'; result.message = 'A human verification page was detected; the scraper will not attempt to bypass it.'; return result; }
    const links = galleryLinks(await galleryPage.content(), config.galleryUrl).slice(0, config.test ? (config.testVideos || 3) : (config.maxVideos || 50));
    result.discoveredFromGallery = links; progress({ stage: 'gallery', found: links.length, metrics: { ...stats } });
    const limit = pLimit(Math.min(3, Math.max(1, Number(config.concurrency || 2))));
    await Promise.all(links.map((url, index) => limit(async () => {
      let itemContext;
      try {
        const fetchedItem = await fetchPage(browser, config, url, sessionState, pool, stats); itemContext = fetchedItem.context;
        const page = fetchedItem.page; const text = await page.locator('body').innerText().catch(() => '');
        if (challengeDetected(text, page.url())) throw Object.assign(new Error('Human verification detected'), { category: 'challenge' });
        let item = deterministic(await page.content(), page.url()); if (config.ai?.enabled) item = await aiMap(item, text, config.ai);
        result.items.push({ ...item, sourceGalleryUrl: config.galleryUrl, sourceGalleryPage: config.galleryUrl, scrapedAt: new Date().toISOString() });
        progress({ stage: 'video', index: index + 1, total: links.length, metrics: { ...stats } });
      } catch (error) {
        stats.failures++; result.errors.push({ url, category: error.category || classifyError(error, error.status), status: error.status || 'FAILED', message: error.message });
      } finally { await itemContext?.close().catch(() => {}); }
      const delay = Math.max(0, Number(config.delayMs ?? 1500)); await sleep(delay * (0.75 + Math.random() * 0.5));
    })));
    result.status = result.errors.length && !result.items.length ? 'FAILED' : 'SUCCESS'; return result;
  } finally {
    if (galleryContext && config.sessionOutputPath) { try { await saveSession(config.sessionOutputPath, await galleryContext.storageState()); } catch (error) { result.errors.push({ category: 'session', message: error.message }); } }
    await galleryContext?.close().catch(() => {}); await browser.close().catch(() => {});
    stats.durationMs = Date.now() - startedAt; stats.avgResponseMs = stats.requests ? Math.round(stats.totalMs / stats.requests) : 0; stats.successRate = stats.requests ? Number((stats.successes / stats.requests).toFixed(4)) : 0;
  }
}
