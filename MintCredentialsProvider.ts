import { mkdir, rm, writeFile, readFile } from 'fs/promises';
import { join } from 'path';
import puppeteer from 'puppeteer-core';

const CREDENTIALS_DIR = './credentials';
const API_KEY_FILE = join(CREDENTIALS_DIR, 'apiKey.txt');
const COOKIE_FILE = join(CREDENTIALS_DIR, 'cookie.txt');

interface Credentials {
  apiKey: string;
  cookie: string;
}

export default class MintCredentialsProvider {
  private credentials: Credentials | null = null;

  async clearCredentials() {
    await rm(API_KEY_FILE, { recursive: true });
    await rm(COOKIE_FILE, { recursive: true });
    this.credentials = null;
  }

  async getCredentials(): Promise<Credentials | null> {
    if (!this.credentials) {
      try {
        const apiKey = (await readFile(API_KEY_FILE)).toString();
        const cookie = (await readFile(COOKIE_FILE)).toString();
        this.credentials = { apiKey, cookie };
      } catch (e) {
        this.credentials = null;
      }
    }
    return this.credentials;
  }

  private async saveCredentials(credentials: Credentials) {
    this.credentials = credentials;
    await mkdir(CREDENTIALS_DIR, { recursive: true });
    await writeFile(API_KEY_FILE, credentials.apiKey);
    await writeFile(COOKIE_FILE, credentials.cookie);
  }

  async refreshCredentials() {
    this.credentials = null;
    console.log('Mint login required. Enter credentials in the browser...');
    const browser = await puppeteer.launch({
      headless: false,
      executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1080, height: 1024 });

    await page.goto('https://mint.intuit.com/');

    const signInSelector = 'a[data-identifier="sign-in"]';
    await page.waitForSelector(signInSelector);
    await page.click(signInSelector);

    await page.waitForSelector('#app-wrapper', { timeout: 3 * 60 * 1000 /* 3 mins */ });
    const cookies = await page.cookies();
    const cookie = cookies.map(({ name, value }) => `${name}=${value};`).join(' ');
    const apiKey = await page.evaluate(() => {
      // @ts-ignore
      return window.__shellInternal.appExperience.appApiKey;
    });

    await browser.close();

    await this.saveCredentials({ apiKey, cookie });

    console.log('Successfully retrieved Mint credentials.');
  }
}
