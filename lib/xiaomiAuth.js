'use strict';

const axios = require('axios');
const crypto = require('crypto');
const { URL } = require('url');

const USER_AGENT = 'okhttp/4.12.0';
const BASE_URL = 'https://account.xiaomi.com';
const SID = '18n_bbs_global';
const VERSION_CODE = '500418';
const VERSION_NAME = '5.4.18';

class XiaomiLoginError extends Error {}

class XiaomiEmailVerificationRequired extends Error {
  constructor(maskedEmail, attemptsLeft) {
    super(`Email verification required (${maskedEmail})`);
    this.maskedEmail = maskedEmail;
    this.attemptsLeft = attemptsLeft;
  }
}

/** Flat, domain-agnostic cookie store — mirrors the Kotlin FlatCookieJar / Python requests.Session. */
class FlatCookieJar {
  constructor() {
    this.store = new Map();
  }
  update(setCookieHeaders) {
    if (!setCookieHeaders) return;
    for (const raw of setCookieHeaders) {
      const first = raw.split(';')[0];
      const eq = first.indexOf('=');
      if (eq === -1) continue;
      const name = first.slice(0, eq).trim();
      const value = first.slice(eq + 1).trim();
      this.store.set(name, value);
    }
  }
  set(name, value) {
    this.store.set(name, value);
  }
  get(name) {
    return this.store.get(name);
  }
  remove(name) {
    this.store.delete(name);
  }
  header() {
    return Array.from(this.store.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
  }
}

function parseXiaomiJson(body) {
  const cleaned = body.startsWith('&&&START&&&') ? body.slice('&&&START&&&'.length) : body;
  return JSON.parse(cleaned);
}

function md5Upper(input) {
  return crypto.createHash('md5').update(input, 'utf8').digest('hex').toUpperCase();
}

function queryParams(urlStr) {
  const u = new URL(urlStr);
  const result = {};
  for (const [k, v] of u.searchParams.entries()) result[k] = v;
  return result;
}

class XiaomiAuthClient {
  constructor() {
    this.jar = new FlatCookieJar();
    this.deviceId = null;
  }

  /**
   * Sends a request WITHOUT following redirects, attaching the jar's Cookie
   * header and merging any Set-Cookie response headers back into the jar.
   * Returns { status, headers, data (string) }.
   */
  async _raw(method, url, { params, data, isForm } = {}) {
    const resp = await axios.request({
      method,
      url,
      params,
      data,
      maxRedirects: 0,
      validateStatus: () => true,
      responseType: 'text',
      transformResponse: (x) => x,
      headers: {
        'User-Agent': USER_AGENT,
        Cookie: this.jar.header(),
        ...(isForm ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
      },
    });
    this.jar.update(resp.headers['set-cookie']);
    return resp;
  }

  /** GET/POST that transparently follows redirects, returning { body, chain }
   *  where chain is the ordered list of {status,headers,url} responses (oldest -> newest),
   *  mirroring Python's `r.history + [r]` / OkHttp's priorResponse chain. */
  async _followed(method, url, opts = {}) {
    let currentUrl = url;
    const chain = [];
    // Avoid infinite redirect loops
    for (let i = 0; i < 10; i++) {
      const resp = await this._raw(method, currentUrl, i === 0 ? opts : {});
      chain.push({ status: resp.status, headers: resp.headers, url: currentUrl, body: resp.data });
      if (resp.status >= 300 && resp.status < 400 && resp.headers.location) {
        currentUrl = new URL(resp.headers.location, currentUrl).toString();
        method = 'get';
        continue;
      }
      return { body: resp.data, chain };
    }
    throw new XiaomiLoginError('Too many redirects.');
  }

  async _get(url, params) {
    const { body } = await this._followed('get', url, { params });
    return body;
  }

  async _postForm(url, data) {
    const body = new URLSearchParams(data).toString();
    const { body: respBody } = await this._followed('post', url, { data: body, isForm: true });
    return respBody;
  }

  async _postEmpty(url) {
    const { body } = await this._followed('post', url, { data: '' });
    return body;
  }

  /**
   * Steps 1-2 of the login flow. Throws XiaomiEmailVerificationRequired if
   * the account needs an emailed OTP — call sendEmailCode() then
   * verifyEmailCode() on the SAME client instance to finish.
   */
  async login(user, password) {
    const hash = md5Upper(password);

    const res1 = parseXiaomiJson(
      await this._get(`${BASE_URL}/pass/serviceLogin`, { sid: SID, _json: 'true' })
    );
    this.deviceId = this.jar.get('deviceId');
    if (!this.deviceId) {
      throw new XiaomiLoginError('Failed to obtain initial deviceId (unexpected server response).');
    }

    const data = { ...queryParams(res1.location), user, hash };
    const res2 = parseXiaomiJson(await this._postForm(`${BASE_URL}/pass/serviceLoginAuth2`, data));

    if (res2.code === 70016) {
      throw new XiaomiLoginError('Invalid username or password.');
    }

    if (res2.notificationUrl) {
      const url = res2.notificationUrl;
      if (['callback', 'SetEmail', 'BindAppealOrSafePhone'].some((s) => url.includes(s))) {
        throw new XiaomiLoginError(
          "This account requires a verification step this app doesn't support yet. " +
            'Please log in manually via the Mi Community app once, then try again.'
        );
      }

      this.jar.set('NativeUserAgent', Buffer.from(USER_AGENT).toString('base64'));
      const idParams = queryParams(url);
      await this._get(`${BASE_URL}/identity/list`, idParams);

      const emailRes = parseXiaomiJson(
        await this._get(`${BASE_URL}/identity/auth/verifyEmail`, { _json: 'true' })
      );
      const maskedEmail = emailRes.maskedEmail || '?';

      const quotaRes = parseXiaomiJson(
        await this._postForm(`${BASE_URL}/identity/pass/sms/userQuota`, {
          addressType: 'EM',
          contentType: '160040',
        })
      );
      const attemptsLeft = quotaRes.info || '?';

      throw new XiaomiEmailVerificationRequired(maskedEmail, attemptsLeft);
    }

    return this._finishLogin(res2);
  }

  /** Asks Xiaomi to email a one-time code. Call after catching XiaomiEmailVerificationRequired. */
  async sendEmailCode() {
    const res = parseXiaomiJson(await this._postEmpty(`${BASE_URL}/identity/auth/sendEmailTicket`));
    if (res.code === 0) return;
    if (res.code === 70022) throw new XiaomiLoginError('Too many codes sent. Please try again tomorrow.');
    throw new XiaomiLoginError(`Error sending code: ${JSON.stringify(res)}`);
  }

  /** Submits the OTP the user received by email and finishes the login. */
  async verifyEmailCode(ticket) {
    const vRes = parseXiaomiJson(
      await this._postForm(`${BASE_URL}/identity/auth/verifyEmail`, { ticket, trust: 'true' })
    );
    if (vRes.code === 70014) throw new XiaomiLoginError('Invalid verification code.');
    if (vRes.code !== 0) throw new XiaomiLoginError(`Verification error: ${JSON.stringify(vRes)}`);

    // Follow the redirect chain of vRes.location and pull the cookies set at the
    // second hop — mirrors r.history[1].cookies in the original Python/Kotlin ports.
    const { chain } = await this._followed('get', vRes.location);
    const hop = chain[1] || chain[chain.length - 1];
    this.jar.update(hop.headers['set-cookie']);
    this.jar.remove('pass_ua');

    const res3 = parseXiaomiJson(
      await this._get(`${BASE_URL}/pass/serviceLogin`, { _json: 'true', sid: SID })
    );
    return this._finishLogin(res3);
  }

  async _finishLogin(res) {
    const regionRes = parseXiaomiJson(await this._get(`${BASE_URL}/pass/user/login/region`));
    const region = regionRes.data.region;

    const { nonce, ssecurity } = res;
    const sign = crypto
      .createHash('sha1')
      .update(`nonce=${nonce}&${ssecurity}`, 'utf8')
      .digest('base64');
    const signedUrl = `${res.location}&clientSign=${encodeURIComponent(sign)}`;

    await this._get(signedUrl);
    const serviceToken = this.jar.get('new_bbs_serviceToken');
    if (!serviceToken) {
      throw new XiaomiLoginError('Could not obtain the final serviceToken.');
    }

    return {
      userId: res.userId,
      serviceToken,
      region,
      deviceId: this.deviceId || '',
    };
  }

  /** Builds the same Cookie header format used by the unlock-apply request. */
  static buildCookieHeader(account) {
    return `new_bbs_serviceToken=${account.serviceToken};versionCode=${VERSION_CODE};versionName=${VERSION_NAME};deviceId=${account.deviceId};`;
  }
}

module.exports = { XiaomiAuthClient, XiaomiLoginError, XiaomiEmailVerificationRequired };
