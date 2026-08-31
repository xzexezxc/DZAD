import readline from 'node:readline';
import { testScrape } from './scraper.js';

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

for await (const line of rl) {
  if (!line.trim()) continue;
  let message;
  try {
    message = JSON.parse(line);
    if (message.type !== 'scrape' || !message.id) throw new Error('Invalid worker message');
    const config = { ...(message.config || {}) };
    delete config.signal;
    const result = await testScrape(config, progress => {
      process.stdout.write(`${JSON.stringify({ type: 'progress', id: message.id, progress })}\n`);
    });
    process.stdout.write(`${JSON.stringify({ type: 'result', id: message.id, result })}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ type: 'error', id: message?.id || null, error: { name: error.name, message: error.message } })}\n`);
  }
}
