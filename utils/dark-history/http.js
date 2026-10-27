// Default HTTP client for the Dark History modules. Every module takes an injectable client
// ({ getJson(url, params), getBuffer(url) }) so tests run offline against recorded fixtures.
const axios = require('axios');

// Wikimedia asks every client to identify itself with a contact URL or address: set WIKIMEDIA_CONTACT in .env.
const USER_AGENT = `ShortsPipelineBot/1.0 (${process.env.WIKIMEDIA_CONTACT || 'set WIKIMEDIA_CONTACT'})`;
const MIN_GAP_MS = 250; // Wikimedia asks for polite, serial access
let last = 0;

async function polite() {
  const wait = last + MIN_GAP_MS - Date.now();
  if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
  last = Date.now();
}

// A rate limit (429) or a server error (5xx) is retried after the wait the server asks for (Retry-After, at most 30 s) or 2, 4, 8 s; then the error goes on.
async function withBackoff(request, { retries = 3, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await request();
    } catch (error) {
      const status = error?.response?.status;
      if (attempt >= retries || !(status === 429 || (status >= 500 && status < 600))) throw error;
      const asked = Number(error.response.headers?.['retry-after']);
      await sleep(Math.min(30000, Number.isFinite(asked) && asked > 0 ? asked * 1000 : 2000 * 2 ** attempt));
    }
  }
}

const defaultHttp = {
  async getJson(url, params) {
    return withBackoff(async () => {
      await polite();
      const { data } = await axios.get(url, { params, headers: { 'User-Agent': USER_AGENT }, timeout: 20000 });
      return data;
    });
  },
  async getBuffer(url) {
    await polite();
    const { data } = await axios.get(url, { responseType: 'arraybuffer', headers: { 'User-Agent': USER_AGENT }, timeout: 60000, maxContentLength: 40e6 });
    return Buffer.from(data);
  }
};

module.exports = { defaultHttp, USER_AGENT, withBackoff };
