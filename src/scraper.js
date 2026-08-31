import fs from 'node:fs/promises';
import { chromium } from 'playwright';
import pLimit from 'p-limit';
import OpenAI from 'openai';
import { GoogleGenAI } from '@google/genai';
import { encryptJson, decryptJson } from './vault.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const normalize = value => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : value;
const DEFAULT_UA = 'DZAD-metadata-scraper/3.0 (+authorized metadata collection)';
const USER_AGENTS = [
  DEFAULT_UA,
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/151 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/151 Safari/537.36'
];
const ACCEPT_LANGUAGES = ['fr-FR,fr;q=0.9,en;q=0.8', 'en-US,en;q=0.9', 'de-DE,de;q=0.9,en;q=0.8'];

const metric = () => ({ requests: 0, successes: 0, failures: 0, retries: 0, totalMs: 0, byError: { network: 0, parsing: 0, timeout: 0, http: 0 } });

function classifyError(error, status) {
  if (status) return status === 429 || status >= 500 ? 'http' : 'network';
  if (error?.name === 'TimeoutError' || /timeout/i.test(error?.message || '')) return 'timeout';
  if (/JSON|parse|selector|metadata/i.test(error?.message || '')) return 'parsing';
  return 'network';
}

function challengeDetected(text, url) {
  return /captcha|verify you are human|access denied|security check/i.test(`${url} ${text}`);
}

function parseJsonLd(html) {
  return [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)].flatMap(m => {
    try { const json = JSON.parse(m[1]); return Array.isArray(json) ? json : [json]; } catch { return []; }
  });
}

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
  const urls = [...html.matchAll(/<a[^>]+href=["']([^"']+)["'][^>]*>/gi)].map(m => {
    try { return new URL(m[1], galleryUrl).href; } catch { return null; }
  }).filter(Boolean);
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
      const cleaned = (response.text || '').replace(/^```(?:json)?\n?/i, '').replace(/```$/g, '').trim();
      return { ...candidate, ...JSON.parse(cleaned), aiProvider: 'gemini' };
    }
    const client = new OpenAI({ apiKey });
    const result = await client.chat.completions.create({ model: provider?.model || process.env.OPENAI_MODEL || 'gpt-4o-mini', messages: [{ role: 'user', content: prompt }] });
    const cleaned = (result.choices?.[0]?.message?.content || '').replace(/^```(?:json)?\n?/i, '').replace(/```$/g, '').trim();
    return { ...candidate, ...JSON.parse(cleaned), aiProvider: 'openai' };
  } catch (error) {
    return { ...candidate, aiError: error.message };
  }
}

async function loadSession(path) {
  try { return decryptJson(JSON.parse(await fs.readFile(path, 'utf8'))); } catch { return undefined; }
}

async function saveSession(path, state) {
  await fs.mkdir(new URL('.', `file://${path}`).pathname, { recursive: true }).catch(() => {});
  await fs.writeFile(path, JSON.stringify(encryptJson(state)), { mode: 0o600 });
}

function proxyPool(config) {
  return (config.proxies || process.env.SCRAPER_PROXIES || '').split(',').map(x => x.trim()).filter(Boolean);
}

function retryable(status, error) {
  return status === 429 || status === 503 || status === 502 || status === 504 || /ECONNRESET|ECONNREFUSED|ENOTFOUND|socket hang up/i.test(error?.message || '');
}

async function gotoWithRetry(page, url, config, stats, proxyIndex) {
  const maxRetries = Math.max(0, Number(config.maxRetries ?? 3));
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const started = Date.now(); stats.requests++;
    try {
      const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: config.timeoutMs || 30000 });
      const status = response?.status() || 200;
      stats.totalMs += Date.now() - started;
      if (retryable(status)) throw Object.assign(new Error(`HTTP ${status}`), { status });
      if (status >= 400) throw Object.assign(new Error(`HTTP ${status}`), { status });
      stats.successes++;
      return response;
    } catch (error) {
      stats.totalMs += Date.now() - started;
      const kind = classifyError(error, error.status);
      stats.byError[kind] = (stats.byError[kind] || 0) + 1;
      if (!retryable(error.status, error) || attempt === maxRetries) throw error;
      stats.retries++;
      if (proxyIndex) proxyIndex.rotate();
      const backoff = Math.min(Number(config.maxBackoffMs || 30000), Number(config.baseBackoffMs || 1000) * (2 ** attempt));
      await sleep(backoff * (0.8 + Math.random() * 0.4));
    }
  }
}

class ProxyIndex {
  constructor(values) { this.values = values; this.index = 0; }
  current() { return this.values[this.index % this.values.length]; }
  rotate() { if (this.values.length > 1) this.index = (this.index + 1) % this.values.length; }
}

async function createBrowserContext(browser, config, sessionState, proxy) {
  return browser.newContext({
    ...(sessionState ? { storageState: sessionState } : {}),
    ...(proxy ? { proxy: { server: proxy } } : {}),
    userAgent: config.userAgent || USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)],
    extraHTTPHeaders: { 'Accept-Language': config.acceptLanguage || ACCEPT_LANGUAGES[Math.floor(Math.random() * ACCEPT_LANGUAGES.length)] },
    locale: config.locale || 'fr-FR'
  });
}

export async function testScrape(config, progress = () => {}) {
  const startedAt = Date.now();
  const stats = metric();
  const proxies = proxyPool(config);
  const proxyIndex = new ProxyIndex(proxies.length ? proxies : [null]);
  const limit = pLimit(Math.min(3, Math.max(1, Number(config.concurrency || 2))));
  const result = { status: 'RUNNING', sourceGalleryUrl: config.galleryUrl, discoveredFromGallery: [], items: [], errors: [], metrics: stats, scraperVersion: '3.0.0' };
  let browser;
  try {
    browser = await chromium.launch({ headless: config.headless !== false });
  } catch (error) {
    return { ...result, status: 'FAILED', errors: [{ category: 'runtime', message: error.message }], metrics: stats };
  }

  let sessionState;
  if (config.storageStatePath) sessionState = await loadSession(config.storageStatePath);
  let context;
  try {
    context = await createBrowserContext(browser, config, sessionState, proxyIndex.current());
    const page = await context.newPage();
    await gotoWithRetry(page, config.galleryUrl, config, stats, proxyIndex);
    const galleryText = await page.locator('body').innerText().catch(() => '');
    if (challengeDetected(galleryText, page.url())) {
      result.status = 'CHALLENGE_REQUIRED';
      result.message = 'A human verification page was detected; the scraper will not attempt to bypass it.';
      return result;
    }
    const links = galleryLinks(await page.content(), config.galleryUrl).slice(0, config.test ? (config.testVideos || 3) : (config.maxVideos || 50));
    result.discoveredFromGallery = links;
    progress({ stage: 'gallery', found: links.length, metrics: { ...stats } });

    const scrapeOne = async (url, index) => {
      const localContext = context;
      const localPage = await localContext.newPage();
      try {
        await gotoWithRetry(localPage, url, config, stats, proxyIndex);
        const text = await localPage.locator('body').innerText().catch(() => '');
        if (challengeDetected(text, localPage.url())) throw Object.assign(new Error('Human verification detected'), { category: 'challenge' });
        let item = deterministic(await localPage.content(), localPage.url());
        if (config.ai?.enabled) item = await aiMap(item, text, config.ai);
        result.items.push({ ...item, sourceGalleryUrl: config.galleryUrl, sourceGalleryPage: config.galleryUrl, scrapedAt: new Date().toISOString() });
        progress({ stage: 'video', index: index + 1, total: links.length, metrics: { ...stats } });
      } catch (error) {
        stats.failures++;
        result.errors.push({ url, category: error.category || classifyError(error, error.status), status: error.status || 'FAILED', message: error.message });
      } finally {
        await localPage.close().catch(() => {});
      }
      const delay = Math.max(0, Number(config.delayMs ?? 1500));
      await sleep(delay * (0.75 + Math.random() * 0.5));
    };

    await Promise.all(links.map((url, index) => limit(() => scrapeOne(url, index))));
    result.status = result.errors.length && !result.items.length ? 'FAILED' : 'SUCCESS';
    return result;
  } finally {
    if (context && config.sessionOutputPath) {
      try { await saveSession(config.sessionOutputPath, await context.storageState()); } catch (error) { result.errors.push({ category: 'session', message: error.message }); }
    }
    await context?.close().catch(() => {});
    await browser.close().catch(() => {});
    stats.durationMs = Date.now() - startedAt;
    stats.successRate = stats.requests ? Number((stats.successes / stats.requests).toFixed(4)) : 0;
    stats.avgResponseMs = stats.requests ? Math.round(stats.totalMs / stats.requests) : 0;
  }
}
