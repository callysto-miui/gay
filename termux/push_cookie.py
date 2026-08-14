#!/usr/bin/env python3
"""
push_cookie.py — Termux companion script
------------------------------------------
Runs on your Android phone (via Termux), where requests to Xiaomi's login
endpoints come from a genuine mobile IP + can be run right after using the
official Mi Community app — i.e. the network origin Xiaomi actually trusts.

It logs into your Xiaomi account locally, then POSTs the resulting cookie to
your deployed HyperOS AAU server's /api/cookie endpoint, so the server only
ever has to do the (less-strict) scheduled firing, never the login itself.

Setup on your phone:
    pkg install python
    pip install requests
    python push_cookie.py --user you@example.com --password *** \
        --server https://your-app.onrender.com --token YOUR_COOKIE_PUSH_TOKEN

Then automate it (pick one):
    - Termux:Boot + a cron-like scheduler (e.g. `termux-job-scheduler`) to
      re-run this daily so the pushed cookie stays fresh.
    - Just run it manually once a day/week before the unlock window opens —
      cookies are typically valid for a while, so this doesn't need to run
      right at midnight, only "recently enough."

--token should match the COOKIE_PUSH_TOKEN environment variable you set on
your Render service — without it, anyone who finds your server's URL could
push their own cookie into your scheduler.
"""

import argparse
import base64
import hashlib
import json
import sys
from urllib.parse import urlencode, urlparse, parse_qs

import requests

USER_AGENT = "okhttp/4.12.0"
BASE_URL = "https://account.xiaomi.com"
SID = "18n_bbs_global"
VERSION_CODE = "500418"
VERSION_NAME = "5.4.18"


class XiaomiLoginError(Exception):
    pass


class XiaomiEmailVerificationRequired(Exception):
    def __init__(self, masked_email, attempts_left):
        self.masked_email = masked_email
        self.attempts_left = attempts_left
        super().__init__(f"Email verification required ({masked_email})")


class XiaomiAuthClient:
    def __init__(self):
        self.session = requests.Session()
        self.session.headers.update({"User-Agent": USER_AGENT})
        self.device_id = None

    @staticmethod
    def _parse(body: str) -> dict:
        if body.startswith("&&&START&&&"):
            body = body[len("&&&START&&&"):]
        return json.loads(body)

    @staticmethod
    def _md5_upper(s: str) -> str:
        return hashlib.md5(s.encode("utf-8")).hexdigest().upper()

    @staticmethod
    def _query_params(url: str) -> dict:
        return {k: v[0] for k, v in parse_qs(urlparse(url).query).items()}

    def login(self, user: str, password: str):
        password_hash = self._md5_upper(password)

        r1 = self.session.get(f"{BASE_URL}/pass/serviceLogin", params={"sid": SID, "_json": "true"})
        res1 = self._parse(r1.text)
        self.device_id = self.session.cookies.get("deviceId")
        if not self.device_id:
            raise XiaomiLoginError("Failed to obtain initial deviceId.")

        data = self._query_params(res1["location"])
        data["user"] = user
        data["hash"] = password_hash

        r2 = self.session.post(f"{BASE_URL}/pass/serviceLoginAuth2", data=data)
        res2 = self._parse(r2.text)

        if res2.get("code") == 70016:
            raise XiaomiLoginError("Invalid username or password.")

        if "notificationUrl" in res2:
            url = res2["notificationUrl"]
            if any(x in url for x in ("callback", "SetEmail", "BindAppealOrSafePhone")):
                raise XiaomiLoginError(
                    "This account needs a verification step this script doesn't support. "
                    "Log in manually via the Mi Community app once, then retry."
                )

            self.session.cookies.set("NativeUserAgent", base64.b64encode(USER_AGENT.encode()).decode())
            id_params = self._query_params(url)
            self.session.get(f"{BASE_URL}/identity/list", params=id_params)

            email_res = self._parse(
                self.session.get(f"{BASE_URL}/identity/auth/verifyEmail", params={"_json": "true"}).text
            )
            masked_email = email_res.get("maskedEmail", "?")

            quota_res = self._parse(
                self.session.post(
                    f"{BASE_URL}/identity/pass/sms/userQuota",
                    data={"addressType": "EM", "contentType": "160040"},
                ).text
            )
            attempts_left = quota_res.get("info", "?")

            raise XiaomiEmailVerificationRequired(masked_email, attempts_left)

        return self._finish_login(res2)

    def send_email_code(self):
        res = self._parse(self.session.post(f"{BASE_URL}/identity/auth/sendEmailTicket").text)
        code = res.get("code", -1)
        if code == 0:
            return
        if code == 70022:
            raise XiaomiLoginError("Too many codes sent. Try again tomorrow.")
        raise XiaomiLoginError(f"Error sending code: {res}")

    def verify_email_code(self, ticket: str):
        v_res = self._parse(
            self.session.post(
                f"{BASE_URL}/identity/auth/verifyEmail", data={"ticket": ticket, "trust": "true"}
            ).text
        )
        code = v_res.get("code", -1)
        if code == 70014:
            raise XiaomiLoginError("Invalid verification code.")
        if code != 0:
            raise XiaomiLoginError(f"Verification error: {v_res}")

        r = self.session.get(v_res["location"])
        history = list(reversed(r.history)) + [r] if r.history else [r]
        hop = history[1] if len(history) > 1 else history[-1]
        self.session.cookies.update(hop.cookies)
        self.session.cookies.pop("pass_ua", None)

        res3 = self._parse(
            self.session.get(f"{BASE_URL}/pass/serviceLogin", params={"_json": "true", "sid": SID}).text
        )
        return self._finish_login(res3)

    def _finish_login(self, res: dict):
        region_res = self._parse(self.session.get(f"{BASE_URL}/pass/user/login/region").text)
        region = region_res["data"]["region"]

        nonce = res["nonce"]
        ssecurity = res["ssecurity"]
        sign = base64.b64encode(
            hashlib.sha1(f"nonce={nonce}&{ssecurity}".encode("utf-8")).digest()
        ).decode()
        signed_url = res["location"] + "&clientSign=" + urlencode({"": sign})[1:]

        self.session.get(signed_url)
        service_token = self.session.cookies.get("new_bbs_serviceToken")
        if not service_token:
            raise XiaomiLoginError("Could not obtain the final serviceToken.")

        return {
            "userId": res["userId"],
            "serviceToken": service_token,
            "region": region,
            "deviceId": self.device_id,
        }


def push_account(server: str, token: str, account: dict):
    url = server.rstrip("/") + "/api/cookie"
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    resp = requests.post(url, headers=headers, json={"account": account}, timeout=15)
    resp.raise_for_status()
    print(f"[Push] Sent to {url} -> {resp.status_code} {resp.json()}")


def main():
    parser = argparse.ArgumentParser(description="Log in to Xiaomi from this device, push the cookie to your server.")
    parser.add_argument("--user", required=True)
    parser.add_argument("--password", required=True)
    parser.add_argument("--server", required=True, help="e.g. https://your-app.onrender.com")
    parser.add_argument("--token", default="", help="COOKIE_PUSH_TOKEN configured on the server")
    args = parser.parse_args()

    auth = XiaomiAuthClient()
    try:
        account = auth.login(args.user, args.password)
    except XiaomiEmailVerificationRequired as e:
        print(f"[Login] Email verification required: {e.masked_email} ({e.attempts_left} attempt(s) left today)")
        auth.send_email_code()
        code = input("Enter the code you received by email: ").strip()
        account = auth.verify_email_code(code)
    except XiaomiLoginError as e:
        print(f"[Login] Error: {e}")
        sys.exit(1)

    print(f"[Login] Success! Account {account['userId']} ({account['region']}) authenticated.")
    push_account(args.server, args.token, account)


if __name__ == "__main__":
    main()
